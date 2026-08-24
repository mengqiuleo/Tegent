import type { ModelMessage } from 'ai'

import type { CheckpointEntry, PermissionMode, TodoItem, TokenUsage } from './types.js'

export interface LoopState {
  messages: ModelMessage[]
  tokenUsage: TokenUsage
  lastInputTokens: number
  sessionId: string
  startedAt: string
  filesModified: Set<string>
  recentToolCalls: Array<{ toolName: string; hash: string }>
  systemPromptCache: string | null
  permissionMode: PermissionMode
  currentPlanPath: string | null
  taskSlug: string
  todos: TodoItem[]
  checkpoints: CheckpointEntry[]
  persistedMessageCount: number
  prevTurnCacheRead: number
  expectCacheMiss: boolean
  knowledgeContext?: string
  isGitRepo?: boolean
}

function generateSessionId(now: Date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  )
}

export function createLoopState(initialMode: PermissionMode = 'default'): LoopState {
  return {
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 0,
    },
    lastInputTokens: 0,
    sessionId: generateSessionId(),
    startedAt: new Date().toISOString(),
    filesModified: new Set(),
    recentToolCalls: [],
    systemPromptCache: null,
    permissionMode: initialMode,
    currentPlanPath: null,
    taskSlug: '',
    todos: [],
    checkpoints: [],
    persistedMessageCount: 0,
    prevTurnCacheRead: 0,
    expectCacheMiss: false,
  }
}
