import type { ModelMessage } from 'ai'

import { toolResultMessage } from './messages.js'
import { truncateToolResult } from './tools.js'

export function truncateToolResultsInMessages(messages: ModelMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; output?: { type?: string; value?: unknown } }>) {
      if (part.type !== 'tool-result') continue
      if (part.output?.type === 'text' && typeof part.output.value === 'string') {
        part.output.value = truncateToolResult(part.output.value)
      }
    }
  }
}

export function repairOrphanToolCalls(messages: ModelMessage[]): void {
  const resultIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part.type === 'tool-result' && part.toolCallId) resultIds.add(part.toolCallId)
    }
  }

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string; toolName?: string }>) {
      if (part.type !== 'tool-call' || !part.toolCallId || resultIds.has(part.toolCallId)) continue
      messages.push(toolResultMessage(part.toolCallId, part.toolName ?? 'unknown', 'Error: orphan tool call repaired'))
      resultIds.add(part.toolCallId)
    }
  }
}
