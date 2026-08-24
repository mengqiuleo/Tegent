// 这个文件把 provider/AI SDK 抛出来的各种错误归类成用户能看懂的提示。
// classifyApiError() 是主入口：先抽 HTTP 状态码和真实 provider message，
// 再按“不可重试配置问题 / 可重试网络限流 / 上下文过长”等场景给出恢复建议。

/** 说明请求超过了模型上下文窗口。 */
const CONTEXT_TOO_LONG_PATTERNS = [
  'maximum context length',
  'context_length_exceeded',
  'token limit',
  'prompt is too long',
  'prompt_too_long',
  'input tokens',
  'context window',
] as const

/** 判断错误是否表示请求超过上下文窗口。
 *  也匹配 HTTP 413，因为 permanentErrorFetch 会把上下文溢出响应重写成 413，
 *  让 SDK 把它视为不可重试错误。 */
export function isContextTooLongError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (/\b413\b/.test(msg)) return true
  return CONTEXT_TOO_LONG_PATTERNS.some((pattern) => msg.includes(pattern))
}

/** 分类 API 错误，并返回用户友好的恢复提示。 */
export function classifyApiError(err: unknown): { message: string; retryable: boolean } {
  if (isContextTooLongError(err)) {
    return {
      message: 'Context too long. The loop will try compression before retrying this turn.',
      retryable: false,
    }
  }
  return {
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  }
}
