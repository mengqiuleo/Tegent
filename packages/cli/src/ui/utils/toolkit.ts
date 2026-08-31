import type { ModelMessage } from '@tegent/core'


/**
 * 从最近一条 assistant 消息中提取文本。
 *
 * @param messages - agent loop 中的模型消息列表。
 * @returns 最近 assistant 消息里的文本内容；没有可用文本时返回空字符串。
 *
 * 这是一个兜底方案。
 * 某些 reasoning provider 可能不发送 text-delta 事件，
 * 但最终响应消息里仍包含文本片段，此函数用于把那部分文本展示出来。
 */
export function extractLastAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] // 从后往前读取消息，优先找到最近的 assistant 回复。
    if (msg.role !== 'assistant') continue // 只关心 assistant 消息，其它角色跳过。
    const content = msg.content // 读取 assistant 消息内容。
    if (typeof content === 'string') return content // 字符串内容可直接返回。
    if (!Array.isArray(content)) return '' // 非数组且非字符串的内容无法提取文本。
    const parts: string[] = [] // 收集数组内容中的 text 片段。
    for (const part of content as Array<{ type: string; text?: string }>) {
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text) // 只拼接显式 text 片段。
      }
    }
    return parts.join('') // 同一条 assistant 消息内的文本片段按顺序拼接。
  }
  return '' // 没有 assistant 消息时返回空字符串。
}



/**
 * 把时间戳格式化成适合选择器阅读的相对时间。
 *
 * 输出类似 `5m ago`、`2h ago`、`3d ago`；超过天级展示范围后回退成日期。
 * 会话选择器会把它放在每条预览旁边，相比 ISO 时间戳更适合快速扫出
 * “我上周做的那条会话”。
 *
 * @param epochMs - 毫秒级时间戳。
 * @returns 相对时间或日期字符串。
 */
export function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 48) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 14) return `${days}d ago`
  return new Date(epochMs).toISOString().slice(0, 10)
}