import type { LanguageModel } from 'ai'

import { resolveModelId } from '../../config/index.js'
import { createLoopState } from '../loop-state.js'
import type { LoopState } from '../loop-state.js'
import { agentLoop } from '../loop.js'
import { buildSubAgentSystemPrompt } from '../system-prompt.js'
import type { AgentCallbacks, AgentOptions, TokenUsage, ToolFilter } from '../../types/index.js'
import type { SubAgentRegistry } from './registry.js'
import type { SubAgentDefinition } from './types.js'

export interface RunSubAgentArgs {
  parentState: LoopState
  parentOptions: AgentOptions
  callbacks: AgentCallbacks
  toolCallId: string
  agentName: string
  description: string
  prompt: string
  knowledgeContext: string
  isGitRepo: boolean
}

export interface RunSubAgentResult {
  resultText: string
  tokenUsage: TokenUsage
  turnCount: number
  toolCallCount: number
  durationMs: number
  aborted: boolean
}

function extractFinalText(messages: LoopState['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant') continue

    if (typeof msg.content === 'string') return msg.content.trim()
    if (!Array.isArray(msg.content)) continue

    const text = (msg.content as Array<{ type?: string; text?: string }>)
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim()

    if (text) return text
  }

  return ''
}

function resolveSubModel(
  agentDef: SubAgentDefinition,
  parentOptions: AgentOptions,
  parentModel: LanguageModel,
): LanguageModel {
  if (!agentDef.model || !parentOptions.modelRegistry) return parentModel

  const resolvedId = resolveModelId(agentDef.model)
  if (!resolvedId) return parentModel

  try {
    return parentOptions.modelRegistry.languageModel(resolvedId as `${string}:${string}`)
  } catch {
    return parentModel
  }
}

function buildToolFilter(agentDef: SubAgentDefinition, parentPermissionMode: string): ToolFilter {
  const deny = [...(agentDef.disallowedTools ?? []), 'task']

  if (parentPermissionMode === 'plan' && agentDef.name === 'general-purpose') {
    deny.push('writeFile', 'edit')
  }

  const filter: ToolFilter = { deny }
  if (agentDef.tools && !agentDef.tools.includes('*')) {
    filter.allow = agentDef.tools
  }

  return filter
}

export async function runSubAgent(args: RunSubAgentArgs, parentModel: LanguageModel): Promise<RunSubAgentResult> {
  const {
    parentState,
    parentOptions,
    callbacks,
    toolCallId,
    agentName,
    description,
    prompt,
    knowledgeContext,
    isGitRepo,
  } = args
  const startTime = Date.now()

  const registry = parentOptions.subAgentRegistry as SubAgentRegistry | undefined
  if (!registry) {
    return emptyResult('[Sub-agent system not initialized]')
  }

  const agentDef = registry.get(agentName)
  if (!agentDef) {
    return emptyResult(`[Sub-agent '${agentName}' not found. Available: ${registry.names().join(', ')}]`)
  }

  callbacks.onSubAgentEvent?.({ kind: 'start', toolCallId, agentName, description, prompt })

  const subModel = resolveSubModel(agentDef, parentOptions, parentModel)
  const subModelId = agentDef.model ? (resolveModelId(agentDef.model) ?? parentOptions.modelId) : parentOptions.modelId
  const subState = createLoopState('default')
  subState.systemPromptCache = buildSubAgentSystemPrompt({
    agentPrompt: agentDef.prompt,
    knowledgeContext,
    isGitRepo,
  })

  const subOptions: AgentOptions = {
    ...parentOptions,
    modelId: subModelId,
    maxTurns: agentDef.maxTurns,
    toolFilter: buildToolFilter(agentDef, parentState.permissionMode),
    permissionMode: 'default',
  }
  // 子代理不能再派生子代理
  delete subOptions.subAgentRegistry

  const subCallbacks: AgentCallbacks = {
    onTextDelta: (delta) => callbacks.onSubAgentEvent?.({ kind: 'text-delta', toolCallId, delta }),
    onToolCall: (_subToolCallId, subToolName, subInput) => {
      callbacks.onSubAgentEvent?.({ kind: 'tool-call', toolCallId, subToolName, subInput })
      callbacks.onToolProgress(toolCallId, `${subToolName}: ${previewInput(subInput)}`)
    },
    onToolProgress: (_subToolCallId, message) => callbacks.onToolProgress(toolCallId, message),
    onToolResult: (subToolCallId, result, isError) => {
      callbacks.onSubAgentEvent?.({
        kind: 'tool-result',
        toolCallId,
        subToolName: subToolCallId,
        resultPreview: result.length > 200 ? result.slice(0, 197) + '...' : result,
        durationMs: 0,
        isError: isError ?? false,
      })
    },
    onAskUser: callbacks.onAskUser,
    onPlanApprovalRequest: callbacks.onPlanApprovalRequest,
    onAskPermission: callbacks.onAskPermission,
    onPlanModeChange: () => {},
    onShellOutput: callbacks.onShellOutput,
    onUsageUpdate: () => {},
    onContextCompressed: () => {},
    onError: callbacks.onError,
    onTodosUpdate: () => {}
  }

  try {
    const { state: finalSubState, turnCount } = await agentLoop(prompt, subModel, subOptions, subCallbacks, subState)
    const finalText = extractFinalText(finalSubState.messages)
    const toolCallCount = countToolCalls(finalSubState.messages)
    const durationMs = Date.now() - startTime
    const resultText = finalText || '[Sub-agent completed without producing a final response]'

    parentState.tokenUsage.inputTokens += finalSubState.tokenUsage.inputTokens
    parentState.tokenUsage.outputTokens += finalSubState.tokenUsage.outputTokens
    parentState.tokenUsage.totalTokens = parentState.tokenUsage.inputTokens + parentState.tokenUsage.outputTokens
    parentState.tokenUsage.cacheReadTokens += finalSubState.tokenUsage.cacheReadTokens
    parentState.tokenUsage.cacheCreationTokens += finalSubState.tokenUsage.cacheCreationTokens
    callbacks.onUsageUpdate(parentState.tokenUsage)

    callbacks.onSubAgentEvent?.({
      kind: 'end',
      toolCallId,
      finalText: resultText,
      tokenUsage: finalSubState.tokenUsage,
      turnCount,
      durationMs,
      aborted: false,
    })

    return {
      resultText: `<task_result>\n${resultText}\n</task_result>`,
      tokenUsage: finalSubState.tokenUsage,
      turnCount,
      toolCallCount,
      durationMs,
      aborted: false,
    }
  } catch (err) {
    const durationMs = Date.now() - startTime
    const aborted = isAbortError(err, parentOptions.abortSignal)
    const partial = extractFinalText(subState.messages)
    const resultText = aborted
      ? partial
        ? `[Sub-agent interrupted by user]\n\nPartial output:\n${partial}`
        : '[Sub-agent interrupted by user]'
      : `[Sub-agent failed: ${err instanceof Error ? err.message : String(err)}]`

    callbacks.onSubAgentEvent?.({
      kind: 'end',
      toolCallId,
      finalText: resultText,
      tokenUsage: subState.tokenUsage,
      turnCount: 0,
      durationMs,
      aborted,
    })

    return {
      resultText,
      tokenUsage: subState.tokenUsage,
      turnCount: 0,
      toolCallCount: countToolCalls(subState.messages),
      durationMs,
      aborted,
    }
  }
}

function emptyResult(resultText: string): RunSubAgentResult {
  return {
    resultText,
    tokenUsage: zeroUsage(),
    turnCount: 0,
    toolCallCount: 0,
    durationMs: 0,
    aborted: false,
  }
}

function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || /aborted|AbortError/i.test(err.message)
}

function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    currentContextTokens: 0,
  }
}

function countToolCalls(messages: LoopState['messages']): number {
  let count = 0
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string }>) {
      if (part.type === 'tool-call') count++
    }
  }
  return count
}

function previewInput(input: Record<string, unknown>): string {
  const value =
    (input.filePath as string) ??
    (input.command as string) ??
    (input.pattern as string) ??
    (input.query as string) ??
    (input.dirPath as string) ??
    ''

  return value.length > 80 ? value.slice(0, 77) + '...' : value
}
