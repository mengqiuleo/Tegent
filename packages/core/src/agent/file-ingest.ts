
// 用户 prompt 里如果通过 @path 或裸绝对路径引用文件，这里会把每个引用解析成 AI SDK content part：
//
//   text / code     -> 带文件正文的 TextPart
//   PDF             -> 本地抽取文本后的 TextPart，避免浪费 token 传二进制
//   docx/xlsx/pptx  -> 通过 officeparser/mammoth/xlsx 抽取文本后的 TextPart
//   image           -> 多模态 provider 用 ImagePart；DeepSeek 等 text-only provider 用 OCR TextPart
//
// 即使 provider 支持多模态，只要能本地抽出 PDF 文本，也故意不把 PDF 当 FilePart 发。
// 一个 100 页文本 PDF 会变成几 KB prompt，而不是渲染页面后消耗成千上万 token。
import fs from 'node:fs/promises'
import path from 'node:path'

import type { FilePart, ImagePart, TextPart } from 'ai'

import type { ProviderCapabilities } from '../providers/capabilities.js'
import { USER_TEGENT_DIR } from '../utils.js'
import { mediaTypeFor } from '../utils/media-type.js'
import { captionImage, pickVisionProvider } from './vision-fallback.js'

// 这个文件把用户输入里的 @file 或裸绝对路径转换成 AI SDK user message content。
// 文本/Office/PDF 会优先在本地提取成 TextPart，图片会根据 provider 能力决定：
// 能看图就传 ImagePart，不能看图就先尝试视觉子代理生成描述，再退回本地 OCR。
// 大文件不会直接塞进 prompt，而是给模型一段提示，让它用 readFile/grep/task 分块处理。

/** tesseract.js 的语言模型权重缓存目录。
 *  eng.traineddata 和 chi_sim.traineddata 加起来约 7.6 MB。
 *  如果不指定，worker 会写到 process.cwd()，导致用户每个项目都重新下载，
 *  还会让未追踪的二进制文件出现在 git status 里。
 *  统一放到 ~/.tegent/tessdata/ 后，同一台机器上的所有项目共享一次下载成本。 */
async function tesseractCacheDir(): Promise<string> {
  const dir = path.join(USER_TEGENT_DIR, 'tessdata')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** 从文件引用解析出的 content part。
 *  类型和 AI SDK 用户消息 content 数组接受的类型一致，调用方可以直接拼进 UserModelMessage。 */
export type IngestedPart = TextPart | ImagePart | FilePart

// 文件粗分类，决定后续走文本读取、图片、PDF、Office 还是兜底路径。
export type FileKind = 'text' | 'image' | 'pdf' | 'office' | 'unknown'

/** 用户指向的路径，可能来自 @file，也可能来自裸绝对路径。 */
export interface FileReference {
  /** 用户输入中的原始 token，用于回显/UI。 */
  raw: string
  /** 解析后的绝对路径。 */
  absolutePath: string
}

/** 这些扩展名无需额外检查，直接按内联文本处理。顺序无意义，只用于 membership 判断。 */
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.mdx',
  '.rst',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
  '.cfg',
  '.conf',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.hpp',
  '.cs',
  '.php',
  '.pl',
  '.lua',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.sql',
  '.graphql',
  '.gql',
  '.proto',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.vue',
  '.svelte',
  '.xml',
  '.svg',
  '.dockerfile',
  '.makefile',
  '.gitignore',
  '.editorconfig',
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'])

/** 单个内联文件最多能给用户消息贡献多少字节。
 *  超过后不塞正文，而是替换成帮助提示。256 KB 对齐 Claude Code 的 Read 工具默认值：
 *  足够容纳常见配置和源码文件，又能防止多文件粘贴直接撑爆 1M 上下文窗口。
 *
 *  没有这个上限时，@really-large-file.txt 或 D:\novels\book.txt 这类裸路径会把整文件
 *  静默塞进用户消息。buildUserContent 绕过了 readFile 工具每次调用的行数保护，
 *  模型甚至没机会反应，请求会直接在 API 处以 context_length_exceeded 失败。
 *  有了上限后，模型会看到一段短提示，再自己用 readFile offset/limit 或 grep 缩小范围。 */
export const MAX_INGEST_BYTES = 256 * 1024

function formatBytes(bytes: number): string {
  // 给用户/模型看的体积格式，避免直接展示大整数。
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** 附件太大无法内联时，替换给用户/模型看的提示。
 *  语义接近 Claude Code 的 MaxFileReadTokenExceededError，但额外加了子代理出路。
 *  对“总结整本小说”“审查整份日志”这类任务，父 agent 分块 readFile 会很快烧掉上下文，
 *  因为每个 tool_result 都会留在父上下文里。交给子代理后，父上下文只保留最终摘要。 */
function tooLargeMessage(filePath: string, sizeBytes: number): string {
  return (
    `[File ${filePath} is too large to inline (${formatBytes(sizeBytes)}, ` +
    `cap ${formatBytes(MAX_INGEST_BYTES)}). ` +
    `Use the readFile tool with offset/limit to read specific portions, ` +
    `or grep to search for specific content. ` +
    `For whole-file analysis (summarization, full review), prefer delegating to ` +
    `a sub-agent via the task tool — each sub-agent reads in isolated context ` +
    `and returns only its conclusions, keeping the parent context lean.]`
  )
}

/** 先按扩展名分类；扩展名缺失或不认识时，再退回 magic-byte 检测。 */
export async function classifyFile(filePath: string): Promise<FileKind> {
  const ext = path.extname(filePath).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (OFFICE_EXTENSIONS.has(ext)) return 'office'
  if (ext === '.pdf') return 'pdf'

  try {
    const { fileTypeFromFile } = await import('file-type')
    const detected = await fileTypeFromFile(filePath)
    if (!detected) return 'text' // 空 signature 时假定为纯文本。
    if (detected.mime.startsWith('image/')) return 'image'
    if (detected.mime === 'application/pdf') return 'pdf'
    if (detected.mime.includes('officedocument') || detected.mime.includes('opendocument')) return 'office'
    if (detected.mime.startsWith('text/')) return 'text'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 从用户 prompt 中提取纯文本文件引用。支持两种语法：
 *
 *   1. `@path`：@ 前缀表示显式附件，遇到空白停止。支持 Windows 绝对路径和 POSIX 绝对路径。
 *
 *   2. 裸绝对路径：类似 `C:\...`、`D:\...`，或以 `/` 开头、包含路径分隔符且带扩展名的 token。
 *      它比 @-mention 保守，只匹配明确像路径的 token，避免误吃 regex/SQL 等内容。
 *
 * 按绝对路径去重，所以同一文件被引用两次也只会 ingest 一次。
 */
export function extractFileReferences(input: string): FileReference[] {
  const refs = new Map<string, FileReference>()

  // @path：一个 token，遇到空白停止。@ 必须在行首或前面是空白，
  // 避免误吃 `@user@host` 这类类似邮箱的 token。
  const atRegex = /(?:^|\s)@((?:[A-Za-z]:[\\/]|[\\/])[^\s]+|[^\s@][^\s]*)/g
  for (const m of input.matchAll(atRegex)) {
    const raw = m[1] ?? ''
    if (!raw) continue
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(raw)
    refs.set(abs, { raw: `@${raw}`, absolutePath: abs })
  }

  // 裸绝对路径：要求有分隔符和扩展名，避免匹配 `fs.readFile` 这类代码片段。
  // 只支持 Windows 盘符路径和 POSIX 根路径。
  const bareRegex = /(?:^|\s)((?:[A-Za-z]:[\\/]|\/)[^\s]*\.[A-Za-z0-9]{1,8})/g
  for (const m of input.matchAll(bareRegex)) {
    const raw = m[1] ?? ''
    if (!raw) continue
    const abs = path.normalize(raw)
    if (!refs.has(abs)) refs.set(abs, { raw, absolutePath: abs })
  }

  return [...refs.values()]
}

/** 把文件读成带行号的文本块。
 *  格式和 read-file 工具输出一致，这样无论文件是预先内联还是按需读取，
 *  模型看到的表示都一致。 */
async function readTextFile(filePath: string): Promise<string> {
  // 加行号后，模型在后续 edit/readFile 时更容易定位具体位置。
  const content = await fs.readFile(filePath, 'utf-8')
  const lines = content.split('\n')
  return lines.map((line, i) => `${i + 1}\t${line}`).join('\n')
}

/** 从 PDF 中抽取纯文本。
 *  使用 pdf-parse 的 v2 class API（PDFParse.getText）。
 *  失败时返回空字符串，由调用方决定是否退回 OCR。 */
async function extractPdfText(filePath: string): Promise<string> {
  try {
    const { PDFParse } = await import('pdf-parse')
    const buffer = await fs.readFile(filePath)
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getText()
      return result.text ?? ''
    } finally {
      await parser.destroy().catch(() => {})
    }
  } catch {
    return ''
  }
}

/** 从 Office 文档中抽取文本。
 *  .docx 走 mammoth，语义抽取质量更好；.xlsx 走 SheetJS，每个 sheet 转 CSV；
 *  其它类型走 officeparser。 */
async function extractOfficeText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()
  try {
    if (ext === '.docx') {
      // mammoth 对 docx 的语义文本抽取比通用 parser 更干净。
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ path: filePath })
      return result.value
    }
    if (ext === '.xlsx') {
      // xlsx 转成按 sheet 分隔的 CSV，模型最容易扫表格内容。
      const XLSX = await import('xlsx')
      const wb = XLSX.readFile(filePath)
      const parts: string[] = []
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName]
        if (!sheet) continue
        parts.push(`--- Sheet: ${sheetName} ---\n${XLSX.utils.sheet_to_csv(sheet)}`)
      }
      return parts.join('\n\n')
    }
    // .pptx、.odt、.ods、.odp 由 officeparser 处理。
    const { OfficeParser } = await import('officeparser')
    const ast = await OfficeParser.parseOffice(filePath)
    return ast.toText()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `[Failed to extract text from ${path.basename(filePath)}: ${msg}]`
  }
}

/** 通过 tesseract.js 对图片做 OCR。
 *  首次调用会加载中文和英文语言包，之后缓存在内存里。
 *  准确率有限，尤其是手写字或风格化文字；主要用于不能原生看图的 provider 的文本抽取兜底。 */
export async function ocrImage(filePath: string): Promise<string> {
  try {
    // worker 每次用完即 terminate，避免长期 CLI 会话里残留 OCR 子资源。
    const { createWorker } = await import('tesseract.js')
    const worker = await createWorker(['eng', 'chi_sim'], 1, {
      cachePath: await tesseractCacheDir(),
    })
    try {
      const { data } = await worker.recognize(filePath)
      return data.text ?? ''
    } finally {
      await worker.terminate()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `[OCR failed: ${msg}]`
  }
}

/** 先把 PDF 栅格化，再逐页 OCR。
 *  用于扫描版 PDF，也就是 pdf-parse 几乎抽不到文本的情况。
 *  栅格化使用 pdf-parse 自带的 getScreenshot（底层是 pdfjs），
 *  因此不需要额外 pdf-to-img 依赖。 */
async function ocrPdf(filePath: string): Promise<string> {
  try {
    const { PDFParse } = await import('pdf-parse')
    const buffer = await fs.readFile(filePath)
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    let screenshots: { pages: Array<{ pageNumber: number; data?: Uint8Array }> }
    try {
      screenshots = (await parser.getScreenshot({ scale: 2, imageBuffer: true })) as typeof screenshots
    } finally {
      await parser.destroy().catch(() => {})
    }

    const { createWorker } = await import('tesseract.js')
    const worker = await createWorker(['eng', 'chi_sim'], 1, {
      cachePath: await tesseractCacheDir(),
    })
    try {
      const out: string[] = []
      for (const page of screenshots.pages) {
        if (!page.data) continue
        const { data } = await worker.recognize(Buffer.from(page.data))
        out.push(`--- Page ${page.pageNumber} ---\n${data.text ?? ''}`)
      }
      return out.join('\n\n')
    } finally {
      await worker.terminate()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `[PDF OCR failed: ${msg}]`
  }
}

/**
 * 根据当前 provider 的多模态能力，把单个文件引用解析成一个或多个 content part。
 *
 * 约定：
 *  - 文本、Office、可抽文本 PDF 都折叠成单个 TextPart；这是最便宜且所有 provider 都支持的路径。
 *  - 图片：provider 能看图就用 ImagePart，否则用带说明的 OCR TextPart。
 *  - 扫描版 PDF：provider 支持 PDF 时用 FilePart，否则用 OCR TextPart。
 *  - 缺失或不可读文件会返回带错误信息的 TextPart，让模型能承认失败，而不是静默忽略。
 */
export async function ingestFile(
  ref: FileReference,
  caps: ProviderCapabilities,
  onNotice?: (msg: string) => void,
): Promise<IngestedPart[]> {
  let kind: FileKind
  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    // 先 stat 再 classify：大小限制和可读性错误都在入口统一处理。
    stats = await fs.stat(ref.absolutePath)
    kind = await classifyFile(ref.absolutePath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [{ type: 'text', text: `[Cannot read ${ref.raw}: ${msg}]` }]
  }

  if (kind === 'text' || kind === 'unknown') {
    // unknown 当作 text 试读；读失败会返回错误 TextPart，不会静默丢附件。
    // 对文本文件来说，磁盘字节数基本就是内联文本大小上界。
    // 行号包装开销不到 1%，所以先检查大小，避免把多 MB 文件读进内存后又丢掉。
    if (stats.size > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size) }]
    }
    try {
      const body = await readTextFile(ref.absolutePath)
      return [{ type: 'text', text: `<<file path="${ref.absolutePath}">>\n${body}\n<</file>>` }]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [{ type: 'text', text: `[Failed to read ${ref.raw}: ${msg}]` }]
    }
  }

  if (kind === 'office') {
    // Office 文件通常先提取文本再判断大小，因为二进制体积和文本体积差异很大。
    const text = await extractOfficeText(ref.absolutePath)
    // Office 二进制通常比抽出的文本大很多，因为有压缩和媒体资源。
    // 因此在抽取后检查文本大小；书长度的 .docx 仍可能超过上限。
    const textBytes = Buffer.byteLength(text, 'utf-8')
    if (textBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, textBytes) }]
    }
    return [{ type: 'text', text: `<<file path="${ref.absolutePath}" kind="office">>\n${text}\n<</file>>` }]
  }

  if (kind === 'pdf') {
    // PDF 优先本地抽文本；只有扫描版且 provider 支持 PDF 时才传 FilePart。
    const extracted = await extractPdfText(ref.absolutePath)
    // 启发式：真正的文本 PDF 至少能抽出几百个字符；
    // 扫描版 PDF 通常只得到空字符串或少量零散字符。
    if (extracted.trim().length > 200) {
      const textBytes = Buffer.byteLength(extracted, 'utf-8')
      if (textBytes > MAX_INGEST_BYTES) {
        return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, textBytes) }]
      }
      return [{ type: 'text', text: `<<file path="${ref.absolutePath}" kind="pdf-text">>\n${extracted}\n<</file>>` }]
    }
    // 扫描版 / 图片型 PDF。
    if (caps.pdf) {
      try {
        const buffer = await fs.readFile(ref.absolutePath)
        return [{ type: 'file', data: buffer, mediaType: 'application/pdf', filename: path.basename(ref.absolutePath) }]
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return [{ type: 'text', text: `[Failed to attach PDF ${ref.raw}: ${msg}]` }]
      }
    }
    // DeepSeek + 扫描版 PDF：本地 OCR。
    const ocr = await ocrPdf(ref.absolutePath)
    const ocrBytes = Buffer.byteLength(ocr, 'utf-8')
    if (ocrBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, ocrBytes) }]
    }
    return [
      {
        type: 'text',
        text: `<<file path="${ref.absolutePath}" kind="pdf-ocr">>\n${ocr}\n<</file>>\n[Note: this PDF was OCR'd locally because the current model does not support PDF input; accuracy is limited.]`,
      },
    ]
  }

  if (caps.image) {
    try {
      const buffer = await fs.readFile(ref.absolutePath)
      return [
        { type: 'text', text: `<<file path="${ref.absolutePath}" kind="image">>` },
        { type: 'image', image: buffer, mediaType: mediaTypeFor(ref.absolutePath) },
      ]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [{ type: 'text', text: `[Failed to attach image ${ref.raw}: ${msg}]` }]
    }
  }

  // text-only provider（DeepSeek、custom）：如果其它多模态 provider 配了 key，
  // 优先用视觉子代理。caption 能覆盖文字和视觉内容，OCR 只能抓文字。
  // 没有子代理或子代理失败时，再退回 OCR。
  const sub = pickVisionProvider()
  if (sub) {
    // 文本模型看不了图时，优先借已配置的视觉模型生成描述，比 OCR 更懂布局/颜色/组件。
    try {
      const caption = await captionImage(ref.absolutePath, sub)
      onNotice?.(`Captioned image via ${sub.modelId}`)
      return [
        {
          type: 'text',
          text: `<<file path="${ref.absolutePath}" kind="image-caption" via="${sub.modelId}">>\n${caption}\n<</file>>\n[Note: the current model cannot see images. The above description was generated by ${sub.label} (vision sub-agent), not the current model. For complex visual tasks, /model switch to a vision-capable model and ask follow-ups directly.]`,
        },
      ]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onNotice?.(`Vision sub-agent (${sub.label}) failed: ${msg} — falling back to OCR`)
    }
  }

  // DeepSeek + 图片且无子代理（或子代理失败）：OCR。
  // 明确告诉模型这不是视觉理解，避免它自信描述颜色/布局等不可见内容。
  const ocr = await ocrImage(ref.absolutePath)
  return [
    {
      type: 'text',
      text: `<<file path="${ref.absolutePath}" kind="image-ocr">>\n${ocr}\n<</file>>\n[Note: the current model cannot natively see images. Only OCR text is available; visual content (layout, diagrams, photos) is NOT visible.]`,
    },
  ]
}

/**
 * 组装用户消息的 content parts：原始文本在前，随后是每个文件 ingest 出的一个或多个 part。
 * 没引用文件时返回纯 string，让简单 prompt 继续走 string 快路径，
 * 保持现有 provider 行为和缓存语义不变。
 */
export async function buildUserContent(
  text: string,
  caps: ProviderCapabilities,
  onNotice?: (msg: string) => void,
): Promise<string | Array<TextPart | ImagePart | FilePart>> {
  const refs = extractFileReferences(text)
  if (refs.length === 0) return text

  const parts: IngestedPart[] = [{ type: 'text', text }]
  for (const ref of refs) {
    const ingested = await ingestFile(ref, caps, onNotice)
    parts.push(...ingested)
  }
  return parts
}
