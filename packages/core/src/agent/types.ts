import type { LanguageModel } from 'ai'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  currentContextTokens: number
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  activeForm: string
  status: TodoStatus
}

export interface CheckpointEntry {
  id: string
  messageCount: number
  createdAt: string
}

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onToolCall: (toolCallId: string, toolName: string, input: Record<string, unknown>) => void
  onToolProgress: (toolCallId: string, message: string) => void
  onToolResult: (toolCallId: string, result: string, isError?: boolean) => void
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }) => Promise<'yes' | 'always' | 'no'>
  onShellOutput: (chunk: string) => void
  onUsageUpdate: (usage: TokenUsage) => void
  onContextCompressed: (summary: string) => void
  onCompressionProgress?: (description: string) => void
  onError: (error: Error) => void
  onMemoryWrite?: (notice: string) => void
}

export interface AgentOptions {
  modelId: string
  trustMode: boolean
  maxTurns?: number
  permissionMode?: PermissionMode
  systemPromptExtra?: string
  abortSignal?: AbortSignal
}

export type LanguageModelLike = LanguageModel
