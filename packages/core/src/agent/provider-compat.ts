import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { capabilitiesOf } from '../providers/capabilities.js'
import { ocrImage } from './file-ingest.js'

// 这个文件集中处理 provider 的兼容性差异。目前只剩一类：
// 某些 provider 不能接收图片/PDF，就在发请求前把二进制内容降级成 OCR 文本或占位说明。
//
// （历史上的 DeepSeek V4 reasoning_content 注入补丁已移除：升级到 @ai-sdk/deepseek@3.0.37 后，
//   上游 converter 对 V4 模型会自动产出 `reasoning_content: ""`，覆盖了同样的场景。）

// ---- 针对 text-only provider 的 Image/PDF 降级 ----
//
// 如果当前 provider 不能接收 image/file part（目前 DeepSeek，以及默认 custom），
// 就遍历下一轮要发送的所有消息，把二进制 part 替换成 provider 能接受的内容。
//
// 两类降级：
//   - 用户消息：ImagePart / FilePart 替换成 OCR 后的 TextPart。
//   - 工具结果消息：content 数组里的 image-data 条目替换成 OCR 后的 text 条目。
//
// OCR 在本地通过 tesseract.js 执行。结果按内容 hash 缓存，避免同一张图跨轮重复 OCR。

type MaybeOutput = { type?: string; value?: unknown; filename?: string }

// OCR 缓存按内容摘要命中，不按路径命中；同一张图换路径也不会重复 OCR。
// 限制 OCR 缓存大小，避免长会话处理很多不同图片时堆内存无限增长。
// Map 保留插入顺序，所以读取 keys().next() 就能拿到最旧项，这就是这里的轻量 LRU。
// 命中后 delete + set 会把该项移动到最新位置。
const OCR_CACHE_LIMIT = 50
const ocrCache = new Map<string, string>() // 进程内存缓存，最多保留 50 张图片的 OCR 结果。CLI 进程重启后，这个缓存就没了。

function ocrCacheGet(key: string): string | undefined {
  // Map 删除后再 set，等价于把命中项移动到最新位置。
  const hit = ocrCache.get(key)
  if (hit === undefined) return undefined
  // touch：移动到最新位置。
  ocrCache.delete(key)
  ocrCache.set(key, hit)
  return hit
}

function ocrCacheSet(key: string, value: string): void {
  // 超出上限时删掉最早插入的 key，实现一个轻量 LRU。
  if (ocrCache.has(key)) ocrCache.delete(key)
  ocrCache.set(key, value)
  if (ocrCache.size > OCR_CACHE_LIMIT) {
    const oldest = ocrCache.keys().next().value
    if (oldest !== undefined) ocrCache.delete(oldest)
  }
}

/**
 * 拿图片 Buffer，跑本地 OCR，返回识别文本。Buffer → OCR 文本。
 * @param buffer 
 * @returns 
 */
async function ocrBuffer(buffer: Buffer): Promise<string> {
  // 用长度 + 前 64 字节构造便宜摘要，足够区分会话里的常见图片。
  const key = `${buffer.length}:${buffer.subarray(0, 64).toString('base64')}`
  const cached = ocrCacheGet(key) // 如果有缓存，就直接用缓存的，不再通过 OCR 生成新的
  if (cached != null) return cached

  // tesseract.js 接受 path、URL 或 Buffer。Buffer 理论上可用，但某些版本有边缘问题；
  // 写入临时文件再识别最稳。
  const tmp = path.join(os.tmpdir(), `xcc-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  try {
    await fs.writeFile(tmp, buffer)
    const text = await ocrImage(tmp)
    ocrCacheSet(key, text)
    return text
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

/**
 * 把 AI SDK 的 ImagePart 统一转成 Buffer。
 * @param part 
 * @returns 
 */
function imagePartToBuffer(part: { image: unknown; mediaType?: string }): Buffer | null {
  // AI SDK 的 ImagePart 可能是 Buffer、Uint8Array、base64 或 data URL，这里统一转成 Buffer。
  const img = part.image
  if (Buffer.isBuffer(img)) return img // 本来就是 Buffer，直接返回
  if (img instanceof Uint8Array) return Buffer.from(img) // Uint8Array 转成 Node Buffer
  if (typeof img === 'string') {
    // 可能是 base64，也可能是 data URL；如果有 `data:...;base64,` 前缀就先剥掉。
    const commaIdx = img.indexOf(',')
    const data = img.startsWith('data:') && commaIdx > 0 ? img.slice(commaIdx + 1) : img
    try {
      return Buffer.from(data, 'base64')
    } catch {
      return null
    }
  }
  return null
}

/**
 * 如果当前 provider 不支持图片或 PDF，就在发给模型前，把图片/PDF 这类二进制 part 改写成纯文本，避免 provider 拒收。
 * 原地移除会话历史里的二进制 content part，避免下一次 streamText 发给不支持二进制的 provider 后 400。
 * 图片会替换成带兜底说明的 OCR 文本，让模型知道自己看到的是文本，而不是原始图片。
 */
export async function downgradeBinaryPartsForProvider(messages: ModelMessage[], modelId: string): Promise<void> {
  const caps = capabilitiesOf(modelId)
  if (caps.image && caps.pdf) return

  // 直接改 messages：这是发给 streamText 前的最后兼容层，不需要复制整段历史。
  for (const msg of messages) {
    // 用户消息：content 可能是 TextPart | ImagePart | FilePart 数组。
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const rewritten: typeof msg.content = []
      for (const part of msg.content) {
        if (part.type === 'image' && !caps.image) {
          // 用户消息里的图片不能发给 text-only provider，于是替换成 OCR 文本。
          const buffer = imagePartToBuffer(part as { image: unknown; mediaType?: string })
          const text = buffer ? await ocrBuffer(buffer) : '[image omitted]'
          rewritten.push({
            type: 'text',
            text: `[Image replaced by local OCR — the current model cannot natively see images. Visual content is NOT visible.]\n${text}`,
          })
          continue
        }
        if (part.type === 'file' && !caps.pdf) {
          // PDF/文件输入不被当前 provider 支持时，用明确文本说明替代二进制。
          rewritten.push({
            type: 'text',
            text: `[File omitted: ${(part as { filename?: string }).filename ?? 'unknown'} — current model does not accept file attachments.]`,
          })
          continue
        }
        rewritten.push(part)
      }
      ;(msg as { content: typeof rewritten }).content = rewritten
      continue
    }

    // 工具结果消息：content 总是 tool-result part 数组。
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue
        const output = (part as { output?: MaybeOutput }).output
        if (!output || output.type !== 'content' || !Array.isArray(output.value)) continue

        const rewritten: unknown[] = []
        for (const entry of output.value as Array<{
          type: string
          data?: string
          mediaType?: string
          text?: string
          filename?: string
        }>) {
          if (entry.type === 'image-data' && !caps.image) {
            // 工具结果里的 image-data 也要降级，否则下一轮重放历史时仍会 400。
            const data = entry.data ?? ''
            let text = '[image omitted]'
            try {
              const buffer = Buffer.from(data, 'base64')
              text = await ocrBuffer(buffer)
            } catch {
            }
            rewritten.push({
              type: 'text',
              text: `[Image replaced by local OCR — the current model cannot natively see images.]\n${text}`,
            })
            continue
          }
          if ((entry.type === 'file-data' || entry.type === 'file-url' || entry.type === 'file-id') && !caps.pdf) {
            // 文件型 tool-result 同理：保留“有附件但已省略”的事实，去掉 provider 不接受的 payload。
            rewritten.push({
              type: 'text',
              text: `[File attachment omitted (${entry.filename ?? entry.mediaType ?? 'binary'}) — current model does not accept file attachments.]`,
            })
            continue
          }
          rewritten.push(entry)
        }
        ;(output as MaybeOutput).value = rewritten
      }
    }
  }
}
