
/** 这些子串说明请求超过了模型上下文窗口。 */
const CONTEXT_TOO_LONG_PATTERNS = [
  'maximum context length',
  'context_length_exceeded',
  'token limit',
  'prompt is too long',
  'prompt_too_long',
  'input tokens',
  'context window',
] as const

// 这个文件把 provider/AI SDK 抛出来的各种错误归类成用户能看懂的提示。
// classifyApiError() 是主入口：先抽 HTTP 状态码和真实 provider message，
// 再按“不可重试配置问题 / 可重试网络限流 / 上下文过长”等场景给出恢复建议。

/** 从 "status code 400"、"(400)" 或 "400 ..." 这类文本里提取 HTTP 状态码。 */
export function extractHttpStatus(msg: string): number {
  // provider/SDK 的错误格式不统一，所以同时兼容几种常见状态码写法。
  const match = msg.match(/\bstatus(?:\s+code)?\s+(\d{3})\b/i) ?? msg.match(/\((\d{3})\)/) ?? msg.match(/^(\d{3})\s/)
  return match ? Number(match[1]) : 0
}

/** 判断错误是否表示请求超过上下文窗口。
 *  也匹配 HTTP 413，因为 permanentErrorFetch 会把上下文溢出响应重写成 413，
 *  让 SDK 把它视为不可重试错误。 */
export function isContextTooLongError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  // 413 在 fetch shim 里也被用来标记 prompt/context overflow。
  if (extractHttpStatus(msg) === 413) return true
  for (const pattern of CONTEXT_TOO_LONG_PATTERNS) {
    if (msg.includes(pattern)) return true
  }
  return false
}

export interface ClassifiedError {
  message: string
  retryable: boolean
}

// ---- 错误形状判断 ----
// 每个 predicate 对应一种 provider 失败模式。拆成具名函数可以让 classifyApiError 更好读，
// 也方便单测直接断言某个具体场景。

/** 判断是否是 DeepSeek reasoning_content 缺失错误。
 *  DeepSeek reasoner / deepseek-v4 thinking 在工具调用链里要求 assistant 历史消息带 reasoning_content。
 *  如果 SDK 或兼容层把这个字段序列化丢了，provider 会拒绝请求；这类问题通常不能靠重试恢复。 */
function isReasoningContentError(msg: string): boolean {
  // DeepSeek thinking/tool-call 链路的专门兼容错误。
  // DeepSeek Reasoner 在工具调用链里要求 assistant 消息带 reasoning_content。
  return msg.includes('Missing `reasoning_content`') || msg.includes('reasoning_content')
}

/** 判断是否是本地没有配置 API key 的错误。
 *  匹配 AI SDK/provider 常见的 "API key is missing" 或环境变量名提示。
 *  这是配置问题，不是 provider 临时故障，所以 classifyApiError 会标记为不可重试。 */
function isMissingApiKeyError(msg: string): boolean {
  return msg.includes('API key is missing') || msg.includes('API_KEY')
}

/** 判断是否是认证失败错误。
 *  典型信号是 HTTP 401、"Unauthorized" 或 "Invalid API Key"。
 *  这通常表示 key 错误、过期、被撤销，或当前 provider/model 使用了不匹配的 key。 */
function isUnauthorizedError(msg: string, status: number): boolean {
  return status === 401 || msg.includes('Unauthorized') || msg.includes('Invalid API Key')
}

/** 判断是否是余额或额度不足错误。
 *  不同 provider 对余额不足的 wording 差异很大，所以这里同时匹配 402、
 *  insufficient balance/quota、exceeded current quota、please recharge 等常见文本。
 *  这类错误需要充值、换账号或切 provider，自动重试没有意义。 */
function isInsufficientBalanceError(msg: string, status: number): boolean {
  if (status === 402) return true
  // provider 对余额/额度不足的说法很不统一。这里用宽松大小写匹配，
  // 避免把 Moonshot 之类的余额错误误判成 429 限流并无意义重试多次。
  const lower = msg.toLowerCase()
  return (
    lower.includes('insufficient balance') ||
    lower.includes('insufficient_balance') ||
    lower.includes('insufficient_quota') ||
    lower.includes('insufficient quota') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('exceeded_current_quota') ||
    lower.includes('suspended due to insufficient') ||
    lower.includes('please recharge')
  )
}

/** 判断是否是权限不足错误。
 *  典型信号是 HTTP 403 或 "Forbidden"。
 *  这表示 API key 可能有效，但账号没有权限访问当前模型、接口、组织或 region。 */
function isForbiddenError(msg: string, status: number): boolean {
  return status === 403 || msg.includes('Forbidden')
}

/** 判断是否是 max_tokens / maxOutputTokens 配置超过模型上限。
 *  provider 往往会返回 Invalid max_tokens、Range of max_tokens、InvalidParameter 等错误。
 *  这里还做了兜底：只要同时出现 max_tokens 和 invalid/range，就归类为输出 token 上限配置错误。 */
function isMaxTokensError(msg: string): boolean {
  if (msg.includes('Invalid max_tokens') || msg.includes('Range of max_tokens') || msg.includes('InvalidParameter')) {
    return true
  }
  // 兜底：只要同时提到 max_tokens 和 invalid/range，就归为 max_tokens 配置错误。
  if (!msg.includes('max_tokens')) return false
  return /invalid|range/i.test(msg)
}

/** 判断是否是模型服务暂不可用。
 *  典型信号是 HTTP 503、"Service Unavailable" 或 provider 返回 overloaded。
 *  走到 classifyApiError 时，AI SDK 通常已经按 maxRetries 重试过；
 *  因此这里更偏向提示用户切换模型，而不是继续无限重试。 */
function isServiceUnavailableError(msg: string, status: number): boolean {
  return status === 503 || msg.includes('Service Unavailable') || msg.includes('overloaded')
}

/** provider 的安全/内容审核过滤器拦截了请求。
 *  permanentErrorFetch 会把匹配 body 重写成 HTTP 422，所以单看 status 也能命中；
 *  pattern 兜底用于其它入口或其它 provider 的不同 wording。 */
function isContentPolicyError(msg: string, status: number): boolean {
  if (status === 422) return true
  const lower = msg.toLowerCase()
  return (
    lower.includes('content_policy_violation') ||
    lower.includes('content_filter_triggered') ||
    lower.includes('content_filter') ||
    lower.includes('content_policy') ||
    lower.includes('input_blocked') ||
    lower.includes('harmful_content') ||
    lower.includes('safety_violation')
  )
}

/** provider 不认识该模型 ID：可能拼错、已下线，或账号没有权限。
 *  permanentErrorFetch 会把匹配 body 的某些 5xx/429 归一成 404；
 *  pattern 列表则覆盖那些本来就返回 404 且 body 有描述的 provider。 */
function isModelNotFoundError(msg: string, status: number): boolean {
  if (status === 404) return true
  const lower = msg.toLowerCase()
  // OpenAI 可能把模型名插在 "model" 和 "does not exist" 中间，
  // 所以这里要求两个 token 都出现，而不是匹配完整短语。
  if (lower.includes('model') && lower.includes('does not exist')) return true
  return lower.includes('model_not_found') || lower.includes('model not found') || lower.includes('unknown model')
}

/** 判断是否是限流错误。
 *  典型信号是 HTTP 429 或错误文本里包含 rate limit。
 *  限流通常会随着时间窗口恢复，所以 classifyApiError 会把它标记为 retryable。 */
function isRateLimitedError(msg: string, status: number): boolean {
  return status === 429 || /rate limit/i.test(msg)
}

/** 判断是否是本机到 provider 之间的网络错误。
 *  当前匹配 timeout、ETIMEDOUT、ECONNRESET 这几类常见瞬时传输失败。
 *  网络抖动可能下一次请求就恢复，所以 classifyApiError 会把它标记为 retryable。 */
function isNetworkError(msg: string): boolean {
  return msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')
}

/** 判断是否是 AI SDK 的响应结构校验错误。
 *  当 provider 返回的内容不符合 AI SDK 预期 schema 时，SDK 会抛 AI_TypeValidationError
 *  或带有 "Type validation failed" 的错误文本。
 *  这类错误经常包着 provider 的真实错误 message，所以 classifyApiError 会优先展示抽取后的 msg。 */
function isTypeValidationError(err: unknown, msg: string): boolean {
  return (
    (err instanceof Error && err.constructor.name === 'AI_TypeValidationError') ||
    msg.includes('Type validation failed')
  )
}

/** 消息历史里的 tool_call/tool_result 配对不合法，被 provider 拒绝。
 *  DeepSeek 最常见，但 OpenAI 等也有类似 wording。
 *  runTurn 里的 repairOrphanToolCalls 正常应防住它；如果仍泄漏出来，
 *  就给用户一个可行动提示，而不是原始 provider dump。 */
function isMalformedToolHistoryError(msg: string): boolean {
  return (
    msg.includes("Messages with role 'tool' must be a response to a preceding message with 'tool_calls'") ||
    msg.includes('tool_calls and tool_call_ids') ||
    msg.includes('tool_call_id')
  )
}

/** 从 "Anthropic API key is missing" 里抽出 "Anthropic"。 */
function extractProviderName(msg: string): string {
  const m = msg.match(/^(\w+)\s+API key/i)
  return m ? m[1]! : 'Provider'
}

/**
 * 从 AI SDK 错误里提取更有意义的 message。
 * TypeValidationError 常见于 provider 返回了非标准 JSON，例如 Alibaba 返回错误对象而非 SSE stream。
 * 真正的 provider message 往往藏在 `.value` 里；取出来后 classifyApiError 才能按真实错误匹配。
 */
function extractErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const msg = err.message
  // 有些 provider 把真正错误包在 TypeValidationError.value.error.message 里。
  const val = (err as unknown as Record<string, unknown>).value
  if (val && typeof val === 'object') {
    const inner = (val as Record<string, unknown>).error
    if (inner && typeof inner === 'object') {
      const innerMsg = (inner as Record<string, string>).message
      if (typeof innerMsg === 'string') return innerMsg
    }
  }
  return msg
}

/** 分类 API 错误，并返回用户友好的恢复提示。 */
export function classifyApiError(err: unknown): ClassifiedError {
  const msg = extractErrorMessage(err)
  const status = extractHttpStatus(msg)

  // 顺序很重要：越具体、越不可重试的错误越靠前，避免被 429/网络等宽泛规则抢走。
  if (isContextTooLongError(err)) {
    return {
      message:
        "Context too long — the conversation exceeded the model's token limit. Try /compact to compress context, or /clear to start fresh.",
      retryable: false,
    }
  }
  if (isReasoningContentError(msg)) {
    return {
      message:
        'DeepSeek Reasoner requires reasoning_content in assistant messages during tool-call chains. This is usually an SDK compatibility issue — please report it.',
      retryable: false,
    }
  }
  if (isMissingApiKeyError(msg)) {
    const provider = extractProviderName(msg)
    return {
      message: `${provider} API key is not set. Please set the corresponding environment variable (e.g. ${provider.toUpperCase()}_API_KEY).`,
      retryable: false,
    }
  }
  if (isUnauthorizedError(msg, status)) {
    return {
      message: 'API authentication failed (401). Please check your API key with /model or reconfigure with `xc init`.',
      retryable: false,
    }
  }
  if (isInsufficientBalanceError(msg, status)) {
    return {
      message:
        'API account balance insufficient (402). Top up your provider account, or switch to a different provider with /model.',
      retryable: false,
    }
  }
  if (isForbiddenError(msg, status)) {
    return {
      message: 'API access forbidden (403). Your API key may not have permission for this model.',
      retryable: false,
    }
  }
  if (isModelNotFoundError(msg, status)) {
    return {
      message:
        'Model not found (404). The id may be wrong, deprecated, or not enabled for your account. Switch with /model.',
      retryable: false,
    }
  }
  if (isContentPolicyError(msg, status)) {
    return {
      message:
        "Content blocked by the provider's safety filter (422). Rephrase the request or try a different model with /model.",
      retryable: false,
    }
  }
  if (isMaxTokensError(msg)) {
    return {
      message:
        "The configured max_tokens exceeds this model's limit. Try switching to a different model with /model, or report this issue so we can add the correct ceiling.",
      retryable: false,
    }
  }
  if (isServiceUnavailableError(msg, status)) {
    return {
      message: 'Model service unavailable (503). Try switching to a different model with /model.',
      retryable: false,
    }
  }
  if (isRateLimitedError(msg, status)) {
    return {
      message:
        'Rate limited (429). Waiting for retry... (AI SDK handles exponential backoff automatically with maxRetries: 3)',
      retryable: true,
    }
  }
  if (isNetworkError(msg)) {
    return {
      message: `Network error: ${msg}. Retrying...`,
      retryable: true,
    }
  }
  // AI SDK TypeValidationError 表示 provider 返回了非标准响应。
  // 展示 provider 的真实 message，而不是原始 Zod validation dump。
  if (isTypeValidationError(err, msg)) {
    return {
      message: `Provider returned an error: ${msg}. Try a different model with /model.`,
      retryable: false,
    }
  }
  if (isMalformedToolHistoryError(msg)) {
    return {
      message:
        'Conversation history has an orphan tool call (model emitted a malformed tool input that the SDK rejected). The next turn will auto-repair, but if this keeps happening you can /clear to reset the conversation.',
      retryable: false,
    }
  }

  return { message: msg, retryable: false }
}
