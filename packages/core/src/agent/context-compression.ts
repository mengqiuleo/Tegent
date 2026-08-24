import type { LanguageModel, ModelMessage } from 'ai'

import type { LoopState } from './loop-state.js'
import type { AgentCallbacks } from '../types/index.js'

function estimateTokens(messages: ModelMessage[]): number {
  const text = messages.map((m) => JSON.stringify(m)).join('\n')
  return Math.ceil(text.length / 4)
}

function summarizeMessage(msg: ModelMessage): string {
  const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
  return `${msg.role}: ${raw.slice(0, 600)}`
}

function compressMessagesInPlace(state: LoopState, callbacks: AgentCallbacks): boolean {
  if (state.messages.length <= 6) return false

  const oldMessages = state.messages.slice(0, -4)
  const recentMessages = state.messages.slice(-4)
  const summary = '[compressed conversation summary]\n' + oldMessages.map(summarizeMessage).join('\n').slice(0, 8_000)

  state.messages = [{ role: 'user', content: summary }, ...recentMessages]
  state.persistedMessageCount = state.messages.length
  state.expectCacheMiss = true
  callbacks.onContextCompressed(summary)
  return true
}

export function getCompressionThreshold(modelId: string): number {
  if (modelId.includes('mini')) return 24_000
  return 96_000
}

export async function checkAndCompressContext(
  state: LoopState,
  _model: LanguageModel,
  threshold: number,
  callbacks: AgentCallbacks,
): Promise<boolean> {
  if (estimateTokens(state.messages) < threshold) return false
  callbacks.onCompressionProgress?.('Compressing old conversation context')
  return compressMessagesInPlace(state, callbacks)
}

export async function handleContextTooLong(
  state: LoopState,
  _model: LanguageModel,
  callbacks: AgentCallbacks,
): Promise<boolean> {
  callbacks.onCompressionProgress?.('Provider rejected context; compressing and retrying')
  return compressMessagesInPlace(state, callbacks)
}
