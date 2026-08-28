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
