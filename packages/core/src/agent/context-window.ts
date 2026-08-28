import type { ModelMessage } from 'ai'

/**
 * 当上下文用量超过模型上下文窗口的这个比例时触发压缩。
 *
 * 这里有两处检查会使用它：
 * 1. 每轮结束后：基于 API 返回的真实 input token 数判断。
 *    这是最可靠的信号，因为它来自 provider 实际计数。
 * 2. 每次 API 调用前：基于字符数做保守估算，作为兜底安全网。
 *    估算会因为工具输出、非 ASCII 文本、不同 tokenizer 而漂移，
 *    所以这里用偏保守的倍率，让估算略微高估。
 *    它能覆盖“单轮里读了超大文件，真实 usage 还没返回前就已经逼近限制”的场景。
 */
export const COMPRESSION_TRIGGER_RATIO = 0.8

/**
 * 预调用估算用的粗略“字符/token”比例。
 *
 * 英文普通文本通常约 4 字符/token；CJK 和代码可能更低。
 * 这里用 3.0，偏激进，会略微高估 token 数，
 * 让压缩兜底更早触发，而不是等到真实 API limit 被打爆。
 */
const CHARS_PER_TOKEN_ESTIMATE = 3.0

/** 当模型级和 provider 级 lookup 都没命中时使用的默认上下文窗口。 */
const DEFAULT_CONTEXT_WINDOW = 128000

/** 按具体模型记录的上下文窗口大小，单位 token。 */
const MODEL_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  // Anthropic
  ['anthropic:claude-opus-4-7', 1000000],
  ['anthropic:claude-sonnet-4-6', 1000000],
  ['anthropic:claude-haiku-4-5', 200000],
  // OpenAI
  ['openai:gpt-4.1', 1047576],
  ['openai:gpt-4.1-mini', 1047576],
  ['openai:gpt-4.1-nano', 1047576],
  ['openai:o3', 200000],
  ['openai:o4-mini', 200000],
  // Google
  ['google:gemini-2.5-pro', 1000000],
  ['google:gemini-2.5-flash', 1000000],
  // DeepSeek
  ['deepseek:deepseek-v4-flash', 1000000],
  ['deepseek:deepseek-v4-pro', 1000000],
  // Alibaba：按 DashScope 文档，qwen-turbo 和 qwen3-coder-plus 扩展到 1M；
  // qwen-max 仍是 32k（需要 256k 时用 qwen3-max）。值参考：
  // https://help.aliyun.com/zh/model-studio/models
  ['alibaba:qwen-turbo', 1000000],
  ['alibaba:qwen-plus', 131072],
  ['alibaba:qwen-max', 32768],
  ['alibaba:qwen3-max', 262144],
  ['alibaba:qwen3-coder-plus', 1000000],
  ['alibaba:qwq-plus', 131072],
  // xAI
  ['xai:grok-3', 131072],
  ['xai:grok-3-mini', 131072],
  // Zhipu
  ['zhipu:glm-4-plus', 128000],
  // Moonshot
  ['moonshotai:kimi-k2.5', 131072],
])

/** provider 级默认上下文窗口。具体模型没命中时退到这里。 */
const PROVIDER_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['anthropic', 1000000],
  ['openai', 128000],
  ['google', 1000000],
  ['deepseek', 1000000],
  ['alibaba', 128000],
  ['xai', 128000],
  ['zhipu', 128000],
  ['moonshotai', 128000],
])

/** 根据 `provider:model` 形式的 modelId 解析上下文窗口大小，单位 token。 */
export function getContextWindow(modelId: string): number {
  // 先查精确模型名，例如 `openai:gpt-4.1`。
  const exact = MODEL_CONTEXT_WINDOWS.get(modelId)

  // 如果精确命中，就直接返回该模型的上下文窗口。
  if (exact !== undefined) return exact

  // 没有精确命中时，从 `provider:model` 里取冒号前的 provider。
  // split 结果至少有一个元素，`?? ''` 只是满足 noUncheckedIndexedAccess；
  // 空串不会命中任何 provider，仍会退到 DEFAULT_CONTEXT_WINDOW。
  const provider = modelId.split(':')[0] ?? ''

  // 再查 provider 默认值；如果 provider 也未知，就退回全局默认窗口。
  return PROVIDER_CONTEXT_WINDOWS.get(provider) ?? DEFAULT_CONTEXT_WINDOW
}

/** 给定模型达到多少 token 后触发压缩。 */
export function getCompressionThreshold(modelId: string): number {
  // 压缩阈值 = 上下文窗口 * 触发比例；Math.floor 保证返回整数 token。
  return Math.floor(getContextWindow(modelId) * COMPRESSION_TRIGGER_RATIO)
}

/**
 * 按模型限制 max_tokens，也就是单次回复最大输出 token。
 *
 * 某些 provider 不会静默 clamp 超大值，而是直接拒绝请求。
 * 对没有显式记录的模型，使用较高默认值，让 AI SDK 对已知 provider 自己 clamp。
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16384
const MODEL_MAX_OUTPUT_TOKENS: ReadonlyMap<string, number> = new Map([
  // DeepSeek V4：flash 和 pro 都宣称最多 384K 输出。
  // 这里保守限制到 131072，既够大，也能避开边缘 400。
  ['deepseek:deepseek-v4-flash', 131072],
  ['deepseek:deepseek-v4-pro', 131072],
  // Alibaba：qwen-turbo 超过 16384 会拒绝；
  // 其它 Qwen3 模型支持 32768（非 thinking）/ 81920（thinking）。
  // 这里按非 thinking 上限发，保证请求稳定成功。
  // qwen-max 只有 32k 上下文，所以输出上限也要明显低于它。
  ['alibaba:qwen-turbo', 16384],
  ['alibaba:qwen-plus', 32000],
  ['alibaba:qwen-max', 8192],
  ['alibaba:qwen3-max', 32000],
  ['alibaba:qwen3-coder-plus', 32000],
  ['alibaba:qwq-plus', 32000],
])

/** 解析实际发给 provider 的 max_tokens 上限。 */
export function getMaxOutputTokens(modelId: string): number {
  // 有模型级特殊限制就用特殊限制；否则用默认输出上限。
  return MODEL_MAX_OUTPUT_TOKENS.get(modelId) ?? DEFAULT_MAX_OUTPUT_TOKENS
}

/**
 * 用消息文本字符数估算总 token 数。
 *
 * 这是有意偏保守的高估安全网：目标是在真实 API 限制命中前提前触发压缩。
 * 这里只统计字符串 content 和 part.text；图片/文件这类二进制内容会在其它层处理或降级。
 */
export function estimateTokenCount(messages: ModelMessage[]): number {
  // 先累加所有可见文本字符数，再用 CHARS_PER_TOKEN_ESTIMATE 换算成 token。
  let chars = 0

  // 遍历对话里的每条消息。
  for (const msg of messages) {
    // 最简单的消息 content 是字符串，直接累加字符串长度。
    if (typeof msg.content === 'string') {
      chars += msg.content.length
    } else if (Array.isArray(msg.content)) {
      // 多模态/工具消息 content 可能是 part 数组；这里只统计其中的 text 字段。
      for (const part of msg.content as Array<{ type: string; text?: string }>) {
        // 只有 text 真的是字符串才计入；其它结构化字段保守忽略。
        if (typeof part.text === 'string') chars += part.text.length
      }
    }
  }

  // 用偏保守的字符/token 比例换算，并向上取整，避免低估。
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE)
}
