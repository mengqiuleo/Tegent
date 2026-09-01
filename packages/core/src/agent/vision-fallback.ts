// 当用户附图，但当前模型不能原生看图时（目前 DeepSeek，以及默认 custom），
// 自动借用另一个已配置且支持视觉的 provider，把它当作图片描述子代理。
// 生成的 caption 会作为 TextPart 注入用户消息，让主模型看到图片描述，而不是接收二进制。
//
// DeepSeek 用户过去只能用本地 tesseract OCR。OCR 处理代码截图还行，
// 但对 UI mockup、图表、照片几乎不够用。很多配置 DeepSeek 的用户同时也有
// Gemini 或 GLM-4V-Flash 这类免费/低价视觉 provider 的 key；
// 自动复用它们后，用户每次贴截图前就不必手动 /model 切换了。
import fs from 'node:fs/promises'
import path from 'node:path'

import { generateText } from 'ai'

import { getAvailableProviders } from '../config/index.js'
import { createModelRegistry } from '../providers/registry.js'

import { LruCache } from '../utils/lru-cache.js'
import { mediaTypeFor } from '../utils/media-type.js'

// 当主模型不能看图时，这里会自动挑一个已配置的视觉模型做“图片描述子代理”。
// 生成的描述会作为 TextPart 注入给主模型。这样 DeepSeek/custom 这类文本模型
// 也能处理截图、设计稿、照片等任务；没有视觉 provider 时再退回本地 OCR。

export interface VisionProvider {
  /** provider id，例如 "google" / "zhipu"。 */
  provider: string
  /** 传给 AI SDK registry 的完整 <provider>:<model> id。 */
  modelId: string
  /** UI notice 里展示的短标签，例如 "Gemini 2.5 Flash"。 */
  label: string
}

/** 每个 provider 对应一个视觉模型 id 和展示标签。
 *  这里优先选择便宜/免费档，因为目标是快速生成 caption，不是深度分析。 */
const VISION_MODELS: Record<string, { modelId: string; label: string }> = {
  google: { modelId: 'google:gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  zhipu: { modelId: 'zhipu:glm-4v-flash', label: 'GLM-4V Flash' },
  alibaba: { modelId: 'alibaba:qwen-vl-plus', label: 'Qwen-VL Plus' },
  openai: { modelId: 'openai:gpt-4o-mini', label: 'GPT-4o Mini' },
  anthropic: { modelId: 'anthropic:claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  moonshotai: {
    modelId: 'moonshotai:moonshot-v1-32k-vision-preview',
    label: 'Moonshot Vision Preview',
  },
  xai: { modelId: 'xai:grok-2-vision-1212', label: 'Grok 2 Vision' },
}

/** 选择视觉子代理时的 provider 尝试顺序。
 *  免费档和按图便宜的模型排前面，重型旗舰排后面。
 *  Gemini 2.5 Flash 放第一是因为免费额度大且免费价位能力强。
 *  GLM-4V-Flash 放第二是因为它真正免费，并且在中国网络环境下更容易访问。 */
const VISION_PRIORITY = ['google', 'zhipu', 'alibaba', 'openai', 'anthropic', 'moonshotai', 'xai']

/**
 * 根据用户已配置的 key 选择最佳可用视觉子代理。
 * 如果没有任何支持视觉的 provider 有 key，就返回 null，调用方应退回本地 OCR。
 */
export function pickVisionProvider(): VisionProvider | null {
  // 按优先级找第一个“用户已经配置了 key”的视觉 provider。
  const available = new Set(getAvailableProviders())
  for (const provider of VISION_PRIORITY) {
    if (!available.has(provider)) continue
    const model = VISION_MODELS[provider]
    if (!model) continue
    return { provider, modelId: model.modelId, label: model.label }
  }
  return null
}

/** 内存缓存：同一张图片在同一会话里重复附加时，不要重复消耗子代理 token。
 *  key 是 `${providerId}:${file size}:${first-64-bytes-base64}`，
 *  和 provider-compat.ts 的 OCR 缓存使用同样便宜且抗碰撞的策略。 */
const captionCache = new LruCache<string>({ maxEntries: 50 })

async function cacheKey(filePath: string, providerModelId: string): Promise<string> {
  // key 里包含 providerModelId：同一张图给不同视觉模型生成的 caption 不一定一样。
  const buffer = await fs.readFile(filePath)
  return `${providerModelId}:${buffer.length}:${buffer.subarray(0, 64).toString('base64')}`
}

/**
 * 通过选中的视觉子代理生成图片文字描述。
 * prompt 会要求它同时输出可见文字和视觉元素（布局、颜色、组件等）。
 * OCR 只能抓文字，所以我们希望 caption 能覆盖 OCR 本应提供的内容，并补上视觉信息。
 */
export async function captionImage(filePath: string, sub: VisionProvider): Promise<string> {
  const key = await cacheKey(filePath, sub.modelId)
  const cached = captionCache.get(key)
  if (cached != null) {
    return cached
  }

  const buffer = await fs.readFile(filePath)
  const registry = createModelRegistry()
  // registry.languageModel() 的类型是 `${string}:${string}`，
  // 但 VISION_MODELS 里的条目是普通 string。这里在边界处 cast；
  // 两端都由我们控制，并且每个条目都是 "provider:model" 格式。
  const model = registry.languageModel(sub.modelId as `${string}:${string}`)


  const { text } = await generateText({
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Describe this image in detail so a text-only AI can act on it. ' +
              'Include: (1) any visible text transcribed verbatim, ' +
              '(2) UI elements, layout, and visual hierarchy, ' +
              '(3) colors, icons, shapes, and other visual details, ' +
              '(4) inferred purpose or context. ' +
              'Be thorough and specific. Output plain text only — no markdown formatting.',
          },
          { type: 'image', image: buffer, mediaType: mediaTypeFor(filePath) },
        ],
      },
    ],
  })

  const caption = text.trim()
  captionCache.set(key, caption)
  return caption
}
