import type { TokenUsage } from '../../core/src/index.js'

export type Check =
  | { type: 'answerContains'; values: string[] }
  | { type: 'fileEquals'; path: string; content: string }
  | { type: 'jsonPathEquals'; path: string; pathExpr: string; value: unknown }
  | { type: 'command'; command: string; timeoutMs?: number }
  | { type: 'onlyFiles'; paths: string[] }

export type EvalTask = {
  id: string
  name: string
  prompt: string
  fixture?: string
  files?: Record<string, string>
  checks: Check[]
  tags?: string[]
}

export type ToolTrace = {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
}

export type EvalTrace = {
  text: string
  tools: ToolTrace[]
  errors: string[]
  usage?: TokenUsage
}

export type CheckResult = {
  type: Check['type']
  passed: boolean
  message: string
}

export type EvalResult = {
  id: string
  name: string
  modelId: string
  success: boolean
  durationMs: number
  turnCount: number
  changedFiles: string[]
  checks: CheckResult[]
  toolCalls: number
  usage?: TokenUsage
  errors: string[]
  finalText: string
  trace: EvalTrace
  workspacePath?: string
}

export type RunOptions = {
  modelId?: string
  taskId?: string
  maxTurns: number
  keepWorkspaces: boolean
}
