import fs from 'node:fs/promises'
import path from 'node:path'

import { streamText } from 'ai'
import type { LanguageModel, ToolSet, UserContent } from 'ai'

import { classifyApiError, isContextTooLongError } from './api-errors.js'
import { checkAndCompressContext, getCompressionThreshold, handleContextTooLong } from './context-compression.js'
import { createLoopState } from './loop-state.js'
import type { LoopState } from './loop-state.js'
import { runMemoryExtractor } from './memory-extractor.js'
import { appendHeader, appendUsage, flushPendingMessages } from './session-store.js'
import type { StreamResult } from './stream-utils.js'
import { drainStreamResult } from './stream-utils.js'
import { buildSystemPrompt } from './system-prompt.js'
import { processToolCalls } from './tool-execution.js'
import { repairOrphanToolCalls, truncateToolResultsInMessages } from './tool-result-sanitize.js'
import { toolRegistry, truncateToolResult } from './tools.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'

export type { LoopState } from './loop-state.js'

export interface AgentLoopResult {
  state: LoopState
  turnCount: number
}

// 把用户输入里的多段内容拼成普通文本，方便拿来生成 slug。
function userContentToText(content: UserContent): string {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ')
  }

  return ''
}

// 把 streamText 的流式输出逐个分发给 UI。
async function streamChunksToUI(result: StreamResult, callbacks: AgentCallbacks): Promise<void> {
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'error') {
      // AI SDK 不会直接在迭代器里 throw，这里手动抛出去，外层才能拿到真实错误。
      throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
    }

    if (chunk.type === 'text-delta') {
      callbacks.onTextDelta(chunk.text ?? '')
      continue
    }

    if (chunk.type === 'tool-call') {
      callbacks.onToolCall(chunk.toolCallId ?? '', chunk.toolName ?? '', (chunk.input ?? {}) as Record<string, unknown>)
      continue
    }

    if (chunk.type === 'tool-result') {
      const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output ?? '')
      callbacks.onToolResult(chunk.toolCallId ?? '', truncateToolResult(raw))
    }
  }
}

// 把一次请求的 response 和 usage 合并回会话状态。
async function collectTurnResponse(
  result: StreamResult,
  state: LoopState,
  modelId: string,
  callbacks: AgentCallbacks,
): Promise<string> {
  const response = await result.response

  // 自动执行的只读工具会把结果塞进 response.messages，这里统一截断一下。
  truncateToolResultsInMessages(response.messages)
  state.messages.push(...response.messages)

  const usage = await result.usage
  if (usage) {
    state.tokenUsage.inputTokens += usage.inputTokens ?? 0
    state.tokenUsage.outputTokens += usage.outputTokens ?? 0
    state.tokenUsage.cacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0
    state.tokenUsage.cacheCreationTokens += usage.inputTokenDetails?.cacheWriteTokens ?? 0
    state.tokenUsage.totalTokens = state.tokenUsage.inputTokens + state.tokenUsage.outputTokens
    state.tokenUsage.currentContextTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    state.lastInputTokens = usage.inputTokens ?? state.lastInputTokens
    callbacks.onUsageUpdate(state.tokenUsage)
    void appendUsage(state, modelId)
  }

  return await result.finishReason
}

// 这一轮跑完之后，主循环可能继续，也可能直接结束。
type TurnOutcome =
  | { kind: 'done'; finishReason: string; result: StreamResult }
  | { kind: 'error' }
  | { kind: 'retry' }
  | { kind: 'aborted' }

// 统一识别 AbortError，避免每个分支都重复写一遍。
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || /aborted|AbortError/i.test(err.message)
}

// 跑一轮 streamText，负责把流、错误、压缩兜底这些细节包起来。
async function runTurn(
  state: LoopState,
  model: LanguageModel,
  options: AgentOptions,
  systemPrompt: string,
  callbacks: AgentCallbacks,
  turn: number,
): Promise<TurnOutcome> {
  // 先修复孤立的 tool call，避免下一次请求体不合法。
  repairOrphanToolCalls(state.messages)

  let result: StreamResult
  try {
    result = streamText({
      model,
      system: systemPrompt,
      messages: state.messages,
      // AI SDK v7 的 ToolSet 联合类型与 exactOptionalPropertyTypes 不兼容
      //（无 execute 的工具既不能赋值也不能直接断言），只能走双重断言绕过。
      tools: toolRegistry as unknown as ToolSet,
      maxRetries: 3,
      // exactOptionalPropertyTypes 下不能显式传 undefined，用条件展开。
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    }) as unknown as StreamResult
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }

  // 先把结果的 Promise 都挂上 catch，避免 Node 误报未处理拒绝。
  drainStreamResult(result)

  try {
    await streamChunksToUI(result, callbacks)
  } catch (err) {
    drainStreamResult(result)
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    if (isContextTooLongError(err)) {
      const compressed = await handleContextTooLong(state, model, callbacks)
      if (compressed) return { kind: 'retry' }
    }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }

  try {
    const finishReason = await collectTurnResponse(result, state, options.modelId, callbacks)
    return { kind: 'done', finishReason, result }
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }
}

// 只要仓库里有 `.git`，就认为当前工作区是 git 仓库。
async function isGitRepo(): Promise<boolean> {
  return fs
    .stat(path.join(process.cwd(), '.git'))
    .then(() => true)
    .catch(() => false)
}

// 给第一条用户输入做一个简短 slug，方便写 session 文件名。
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}


export async function agentLoop(
  userMessage: UserContent,
  model: LanguageModel,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  existingState?: LoopState,
): Promise<AgentLoopResult> {
  // 第一次进来就创建新状态，后续提交沿用同一份 state。
  const state = existingState ?? createLoopState(options.permissionMode ?? 'default')

  // 把本轮用户消息压进消息历史，后面的所有循环都基于它展开。
  state.messages.push({ role: 'user', content: userMessage })

  // 只从首次用户输入里提取 slug，后面不会再改。
  const taskText = userContentToText(userMessage)
  if (!state.taskSlug) state.taskSlug = slugify(taskText)

  // 这些信息只要会话不结束就不会变，所以只查一次。
  const gitRepo = await isGitRepo()
  state.isGitRepo = gitRepo
  state.knowledgeContext = ''

  // session header 写入文件是旁路操作，不阻塞主循环。
  void appendHeader(state, options.modelId, taskText)

  // 系统提示词只建一次，保证前缀稳定，便于缓存命中。
  if (!state.systemPromptCache) {
    state.systemPromptCache = buildSystemPrompt({
      knowledgeContext: state.knowledgeContext,
      modelId: options.modelId,
      isGitRepo: gitRepo,
      systemPromptExtra: options.systemPromptExtra,
    })
  }

  const compressionThreshold = getCompressionThreshold(options.modelId)
  const MAX_CONTINUATIONS = 3
  let continuationAttempts = 0
  let completedNormally = false
  let turn = 0

  // 主循环：调用模型 -> 处理结果 -> 决定继续还是退出。
  while (options.maxTurns === undefined || turn < options.maxTurns) {
    turn++

    // 把上一轮还没刷的消息先写掉，再检查上下文是否太大。
    void flushPendingMessages(state)
    await checkAndCompressContext(state, model, compressionThreshold, callbacks)

    const outcome = await runTurn(state, model, options, state.systemPromptCache, callbacks, turn)

    // 先处理错误和中断，这些分支都直接退出或重试。
    if (outcome.kind === 'error' || outcome.kind === 'aborted') break
    if (outcome.kind === 'retry') {
      turn--
      continue
    }

    // 模型还在调用工具，说明它还没说完，继续下一轮。
    if (outcome.finishReason === 'tool-calls') {
      continuationAttempts = 0
      const toolCalls = await outcome.result.toolCalls
      await processToolCalls(toolCalls, state, options, callbacks, model)
      if (options.abortSignal?.aborted) break
      continue
    }

    // 输出被截断了，就塞一句继续生成的提示，再跑一次。
    if (outcome.finishReason === 'length') {
      if (continuationAttempts < MAX_CONTINUATIONS) {
        continuationAttempts++
        state.messages.push({
          role: 'user',
          content: 'Output token limit hit. Resume directly, no apology, no recap. Pick up exactly where you stopped.',
        })
        continue
      }

      callbacks.onError(new Error(`Response still truncated after ${MAX_CONTINUATIONS} continuation attempts.`))
      break
    }

    // 内容过滤和 stop 是两种正常结束分支。
    if (outcome.finishReason === 'content-filter') {
      callbacks.onError(new Error('Response stopped by the provider content filter.'))
    } else if (outcome.finishReason === 'stop') {
      completedNormally = true
    }
    break
  }

  // 只有真的跑到上限、并且不是自然结束，才提示 maxTurns。
  if (options.maxTurns !== undefined && turn >= options.maxTurns && !completedNormally) {
    callbacks.onError(new Error(`Reached maximum turns (${options.maxTurns}). Stopping agent loop.`))
  }

  // 收尾，避免最后一轮消息漏写。
  void flushPendingMessages(state)

  // 正常 stop 才做记忆提取，中断/报错都不跑。
  if (completedNormally && !options.abortSignal?.aborted) {
    void runMemoryExtractor({
      parentState: state,
      parentModel: model,
      abortSignal: options.abortSignal,
      onWrite: callbacks.onMemoryWrite,
    })
  }

  return { state, turnCount: turn }
}

// 退出时再补一次，保证 session 文件尽量完整。
export async function saveSession(state: LoopState, _model: LanguageModel): Promise<void> {
  await flushPendingMessages(state)
}
