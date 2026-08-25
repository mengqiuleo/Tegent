// 文本文件以"带行号的字符串"返回 —— 这是各家 agent 模型训练时使用的格式。
// 二进制文件（图片、PDF）则返回 AI-SDK 的 `content` 型工具结果：支持内联媒体的服务商因此能收到规范的 `image-data` / `file-data` 分块，而不是塞在文本字符串里的一坨 base64。

// 工具本身不按服务商能力分支 —— 那会把工具层和"当前激活的模型"耦合在一起。做法是：所有二进制结果一律以 content 分块发出，由 provider 兼容层在它们到达不支持的服务商之前剥掉（并回退为 OCR 文本）。
import fs from 'node:fs/promises'
import path from 'node:path'

import { tool } from 'ai'

import { z } from 'zod'

import { classifyFile } from '../agent/file-ingest.js'
import { mediaTypeFor } from '../utils/media-type.js'
import { formatToolError } from '../utils/tool-errors.js'

/** 不带参数调用 readFile 时的默认行数上限。与 Claude Code 的
 *  MAX_LINES_TO_READ 对齐，经验取值：2000 行是"略读整个文件"的合理
 *  天花板，再大的文件几乎总是应该先用 grep 定位再读。最初是 500，
 *  后来观察到 500 会迫使"读完整个模块"这种合法请求产生太多往返
 *  （同等覆盖范围下调用次数约为 CC 的 4 倍），于是调大。 */
const LARGE_FILE_LINE_THRESHOLD = 2000

/** 单次工具结果负载的字节上限。与 file-ingest.ts 中 @-附件 的摄取上限、
 *  以及 Claude Code Read 工具 25K token 的默认值同量级（约 100 KB 英文 /
 *  约 75 KB 中文；256 KB 留了余量）。它同时约束两种情况：默认的"读开头"
 *  和显式的 offset/limit —— 没有这层保险，模型对几 MB 的文件传
 *  `limit: 90000` 就会把整个文件灌进上下文，下一轮直接报
 *  context_length_exceeded。CC 通过 `validateContentTokens` 维护
 *  同一个不变量。 */
const MAX_READ_BYTES = 256 * 1024

async function readTextResult(filePath: string, offset?: number, limit?: number): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8')
  const lines = content.split('\n')
  const totalLines = lines.length

  const userSpecifiedRange = offset != null || limit != null

  let start: number
  let end: number
  let isHeadTruncation = false
  if (userSpecifiedRange) {
    start = (offset ?? 1) - 1
    end = limit ? start + limit : lines.length
  } else if (totalLines > LARGE_FILE_LINE_THRESHOLD) { // 无参数且是大文件 → 只取开头 2000 行
    start = 0
    end = LARGE_FILE_LINE_THRESHOLD
    isHeadTruncation = true
  } else { // 无参数且是小文件 → 全量返回
    start = 0
    end = lines.length
  }
  const sliced = lines.slice(start, end)

  const formatted: string[] = []
  let bytes = 0
  for (let i = 0; i < sliced.length; i++) {
    const numbered = `${start + i + 1}\t${sliced[i]}`
    const addedBytes = Buffer.byteLength(numbered, 'utf-8') + (formatted.length > 0 ? 1 : 0)
    if (bytes + addedBytes > MAX_READ_BYTES && formatted.length > 0) break
    formatted.push(numbered)
    bytes += addedBytes
  }
  const includedLines = formatted.length
  const body = formatted.join('\n')

  if (isHeadTruncation) {
    const note = includedLines < sliced.length ? ` (further capped at ${MAX_READ_BYTES / 1024} KB)` : ''
    return (
      body +
      `\n\n[readFile: showing first ${includedLines}/${totalLines} lines${note}. ` +
      `Call readFile again with offset/limit to view other ranges, or use grep to find specific symbols. ` +
      `For whole-file analysis of very large files, consider delegating to a sub-agent via the task tool — ` +
      `each sub-agent reads in isolated context and returns only a summary.]`
    )
  }
  if (includedLines < sliced.length) {
    const nextOffset = start + includedLines + 1
    return (
      body +
      `\n\n[readFile: output capped at ${MAX_READ_BYTES / 1024} KB; ` +
      `returned ${includedLines}/${sliced.length} requested lines (lines ${start + 1}-${start + includedLines}). ` +
      `Call readFile again with offset=${nextOffset} for the next chunk, or narrow the range.]`
    )
  }
  return body
}

export const readFile = tool({
  description: `Read a file from the local filesystem. Assume this tool can read all files on the machine.

Usage:
- The filePath parameter must be an absolute path, not a relative path.
- You can optionally specify offset and limit (especially handy for long files), but it's recommended to read the whole file first.
- Results are returned with line numbers starting at 1.
- This tool can read images (PNG, JPG, etc.) and PDFs — their content is presented inline.
- This tool can only read files, not directories. To list a directory, use listDir or shell with ls.
- If a file path is provided by the user, assume it is valid.`,
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    offset: z.number().optional().describe('Start line (1-based, text files only)'),
    limit: z.number().optional().describe('Max lines to read (text files only)'),
  }),
  execute: async ({ filePath, offset, limit }, { toolCallId }) => {
    try {
      // TODO: 进度上报
      const kind = await classifyFile(filePath).catch(() => 'text' as const)

      if (kind === 'image') {
        const buffer = await fs.readFile(filePath)
        return {
          type: 'content',
          value: [
            { type: 'text', text: `Loaded image: ${filePath}` },
            {
              type: 'image-data',
              data: buffer.toString('base64'),
              mediaType: mediaTypeFor(filePath),
            },
          ],
        }
      }

      if (kind === 'pdf') {
        const buffer = await fs.readFile(filePath)
        return {
          type: 'content',
          value: [
            { type: 'text', text: `Loaded PDF: ${filePath}` },
            {
              type: 'file-data',
              data: buffer.toString('base64'),
              mediaType: 'application/pdf',
              filename: path.basename(filePath),
            },
          ],
        }
      }

      return await readTextResult(filePath, offset, limit)
    } catch (err) {
      return formatToolError('reading file', err)
    }
  },
})
