import { zhipu } from 'zhipu-ai-provider'

import { createAlibaba } from '@ai-sdk/alibaba'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createMoonshotAI } from '@ai-sdk/moonshotai'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createXai } from '@ai-sdk/xai'
import { createProviderRegistry } from 'ai'

import { getProviderOptions } from '../config/index.js'

export function createModelRegistry() {
  const opts = getProviderOptions()
  const providers: Record<string, any> = {}

  if (opts.anthropic) providers.anthropic = createAnthropic({ fetch: permanentErrorFetch })
  if (opts.openai) providers.openai = createOpenAI({ fetch: permanentErrorFetch })
  if (opts.google) providers.google = createGoogleGenerativeAI({ fetch: permanentErrorFetch })
  if (opts.xai) providers.xai = createXai({ fetch: permanentErrorFetch })
  if (opts.deepseek) providers.deepseek = createDeepSeek({ fetch: deepseekReasoningFetch })
  if (opts.alibaba) {
    providers.alibaba = createAlibaba({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      fetch: permanentErrorFetch,
    })
  }
  if (opts.zhipu) providers.zhipu = zhipu
  if (opts.moonshotai) providers.moonshotai = createMoonshotAI({ fetch: permanentErrorFetch })

  // 自定义 OpenAI 兼容 provider：需要同时配置 API key 和 base URL 才注册。
  if (opts.custom.apiKey && opts.custom.baseURL) {
    providers.custom = createOpenAICompatible({
      name: 'custom',
      apiKey: opts.custom.apiKey,
      baseURL: opts.custom.baseURL,
      fetch: permanentErrorFetch,
    })
  }

  return createProviderRegistry(providers)
}

/**
 * 在请求到达 DeepSeek V4 之前，给请求体里的每条 assistant 消息补上
 * `reasoning_content: ""`。
 *
 * 上游 `@ai-sdk/deepseek` 的消息转换器
 * （convert-to-deepseek-chat-messages.ts）会移除最后一条 user 消息之前所有
 * assistant 消息里的 `reasoning_content`。这对 deepseek-reasoner（R1）是正确的，
 * 因为 R1 明确禁止把 reasoning 内容传回去；但对 deepseek-v4-* 是错误的，
 * 因为 V4 要求 thinking 模式下必须把这个字段传回 API。缺少它时，第二轮请求会 400，
 * 报错大意是：“thinking mode 下必须把 reasoning_content 传回 API”。
 *
 * 这个兼容层只作用于 v4，避免破坏 R1 的官方行为。等上游 SDK 能按模型区分后，
 * 这里就可以删除。
 */
const deepseekReasoningFetch: typeof fetch = async (input, init) => {
  // 继续走 permanentErrorFetch，让 DeepSeek 请求同时获得两个处理：
  // 1. V4 的 reasoning_content 补字段；
  // 2. 账单等永久错误的快速失败改写。
  if (!init?.body || typeof init.body !== 'string') return permanentErrorFetch(input, init)

  try {
    const body = JSON.parse(init.body) as { model?: string; messages?: Array<Record<string, unknown>> }
    if (typeof body.model === 'string' && body.model.includes('deepseek-v4') && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.role === 'assistant' && msg.reasoning_content == null) {
          msg.reasoning_content = ''
        }
      }
      return permanentErrorFetch(input, { ...init, body: JSON.stringify(body) })
    }
  } catch {

  }

  return permanentErrorFetch(input, init)
}

/**
 * “响应体关键词”到“不可重试 HTTP 状态码”的映射。
 *
 * AI SDK 的 `APICallError` 会把 408 / 409 / 429 / 5xx 标记成
 * `isRetryable: true`；除此以外的 4xx 通常都不可重试。下面每一类都用于捕获
 * “重试也永远不会成功”的错误，但一些 provider 会错误地用可重试状态码返回它们
 * （最常见的是 Moonshot 用 429 表示余额不足）。这里把它们改写成语义更准确的
 * 目标状态码，让下游 `classifyApiError` 只看状态码也能给出正确恢复提示。
 *
 * 顺序很重要：第一个匹配到的类别会胜出。余额 / 上下文长度这些更具体的错误应排在
 * 内容安全 / 鉴权之前，避免被较宽泛的关键词提前截走。
 */
type PermanentErrorMatcher = string | RegExp

const PERMANENT_ERROR_CATEGORIES: ReadonlyArray<{
  status: number
  statusText: string
  patterns: readonly PermanentErrorMatcher[]
}> = [
  {
    // 402 Payment Required：账号余额不足或额度耗尽。
    // 真实例子：Moonshot 会用 HTTP 429 返回包含
    // `insufficient balance`、`please recharge`、`exceeded_current_quota_error`
    // 的错误体。DeepSeek 会用 HTTP 400 返回 "Insufficient Balance"；
    // 400 本身已经不可重试，改写成 402 只是为了统一状态码，让错误分类器给出一致提示。
    status: 402,
    statusText: 'Payment Required',
    patterns: [
      'insufficient balance',
      'insufficient_balance',
      'insufficient_quota',
      'insufficient quota',
      'exceeded_current_quota',
      'exceeded your current quota',
      'suspended due to insufficient',
      'please recharge',
    ],
  },
  {
    // 413 Payload Too Large：prompt 超过模型上下文窗口。
    // 同一份 prompt 继续重试仍然会超长，只能通过 /compact、/clear 或切换更大上下文模型解决。
    status: 413,
    statusText: 'Payload Too Large',
    patterns: [
      'context_length_exceeded',
      'context length exceeded',
      'maximum context length',
      'prompt is too long',
      'prompt_too_long',
      'context window',
    ],
  },
  {
    // 422 Unprocessable Entity：provider 的安全过滤器拦截了请求或响应。
    // 同样内容重试通常会得到同样拦截，需要用户改写内容或换模型。
    status: 422,
    statusText: 'Unprocessable Entity',
    patterns: [
      'content_policy_violation',
      'content_filter_triggered',
      'content_filter',
      'content_policy',
      'input_blocked',
      'harmful_content',
      'unsafe content',
      'safety_violation',
    ],
  },
  {
    // 401 Unauthorized：鉴权相关失败。
    // 有些上游代理或网关配置异常时，会把这类错误包装成 5xx 或 429。
    // 如果 API key 本身无效，用同一个 key 重试没有意义。
    status: 401,
    statusText: 'Unauthorized',
    patterns: [
      'invalid api key',
      'invalid_api_key',
      'incorrect api key',
      'api key not found',
      'api_key_invalid',
      'expired api key',
    ],
  },
  {
    // 404 Not Found：模型 ID 写错、已废弃，或当前账号未开通。
    // 有些 provider 遇到无法识别的模型别名时会返回 5xx 而不是 404，这里统一改写。
    // 其中正则用于匹配 OpenAI 的 “model ... does not exist” 类错误，
    // 因为具体模型名会夹在 model 和 does not exist 两段文字之间。
    status: 404,
    statusText: 'Not Found',
    patterns: ['model_not_found', 'model not found', 'unknown model', /\bmodel\b[^]*?\bdoes not exist\b/],
  },
] as const

/**
 * 拦截上游错误响应（4xx / 5xx）：如果响应体描述的是永久失败，但 HTTP 状态码
 * 却落在 SDK 会重试的范围内，就在 AI SDK 解析之前把状态码改成不可重试的 4xx。
 *
 * SDK 的 `APICallError` 构造函数会根据状态码计算 `isRetryable`：
 * {408, 409, 429, 5xx} 会被认为可重试，其他 4xx 会被认为不可重试。
 * 所以提前改写后，SDK 的 `_retryWithExponentialBackoff` 会在第一次失败就停止，
 * 不会在“重试也无法解决”的问题上多等约 30 秒，最后还包一层 `RetryError`。
 *
 * 注意这里完全依赖响应体关键词判断：没有匹配关键词的错误响应会原样透传，
 * 这样真正的限流、网络抖动、临时 5xx 仍然能享受 SDK 的正常重试。
 * 成功响应（状态码 < 400）绝不读取 body，避免消费掉 SDK 后面要解析的 SSE 流。
 */
const permanentErrorFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  // 流式成功响应不能读取 body；否则会提前消费掉 SDK 即将解析的 SSE stream。
  if (response.status < 400) return response

  const text = await response
    .clone()
    .text()
    .catch(() => '')
  if (!text) return response

  const lower = text.toLowerCase()
  for (const category of PERMANENT_ERROR_CATEGORIES) {
    const hit = category.patterns.some((p) => (typeof p === 'string' ? lower.includes(p) : p.test(lower)))
    if (!hit) continue
    if (response.status === category.status) return response
    // 保留原始响应体：SDK 的错误解析器仍会从里面提取 provider 的 message 字段，
    // 下游 classifyApiError 也能据此给出更友好的恢复提示。
    return new Response(text, {
      status: category.status,
      statusText: category.statusText,
      headers: response.headers,
    })
  }
  return response
}
