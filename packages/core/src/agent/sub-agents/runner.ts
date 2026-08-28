// 子代理通过嵌套 agentLoop 执行，并拥有隔离上下文。
// 父 agent 只接收最终文本结果；子代理中间的消息和工具调用都留在子循环里，
// 不会直接混入父 LoopState。这能让子代理处理大文件/探索任务时不污染父上下文。
import type { LanguageModel } from 'ai'

import { resolveModelId } from '../../config/index.js'
import type { HookBus } from '../../hooks/bus.js'
import type { HookEvent } from '../../hooks/types.js'
import type { AgentCallbacks, AgentOptions, TokenUsage } from '../../types/index.js'

import { createLoopState } from '../loop-state.js'
import type { LoopState } from '../loop-state.js'
import { agentLoop } from '../loop.js'
import { buildSubAgentSystemPrompt } from '../system-prompt.js'
import type { SubAgentRegistry } from './registry.js'
import type { SubAgentDefinition } from './types.js'

/** 触发 SubagentStart / SubagentStop hook。
 *
 * best-effort：父 agent 一旦决定委派，子代理调用就是主流程的一部分；
 * hook 失败或 abort 不能向外冒泡，避免插件问题阻断实际任务。 */
function emitSubAgentHook(
  bus: HookBus | undefined,
  event: HookEvent & { name: 'SubagentStart' | 'SubagentStop' },
  signal: AbortSignal | undefined,
): void {
  if (!bus?.has(event.name)) return
  void bus.emit(event, { signal }).catch((err) => {})
}

export interface RunSubAgentArgs {
  // 父 LoopState。子代理不会直接写它，只有最终 token usage 会累计回去。
  parentState: LoopState
  // 父 agent 选项。子代理会继承大部分配置，再覆盖模型、turn 上限、工具过滤等字段。
  parentOptions: AgentOptions
  // 父 UI 回调。子代理事件会折叠后转发到这里。
  callbacks: AgentCallbacks
  // 父 task 工具调用 id，用来把子代理事件归到同一个 UI task 区块下。
  toolCallId: string
  // 要运行的子代理名称。
  agentName: string
  // 父模型给 task 工具的任务短描述。
  description: string
  // 子代理真正收到的任务 prompt。
  prompt: string
  // 父 agent 已经构建好的知识上下文，避免子代理重复扫描。
  knowledgeContext: string
  // 当前 cwd 是否是 git repo，用于构建子代理系统提示词。
  isGitRepo: boolean
}

export interface RunSubAgentResult {
  // 返回给父模型看的文本结果。
  resultText: string
  // 子代理本次消耗的 token。
  tokenUsage: TokenUsage
  // 子代理实际跑了多少 agentic turn。
  turnCount: number
  // 子代理内部工具调用次数。
  toolCallCount: number
  // 子代理总耗时，毫秒。
  durationMs: number
  // 是否被用户中断。
  aborted: boolean
}

/** 从消息数组里提取最后一条 assistant 文本，跳过 tool-call part。
 *
 * 子代理最后可能以 content part 数组形式返回，所以这里同时支持 string content 和 text part。 */
function extractFinalText(messages: LoopState['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant') continue
    const content = msg.content
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      const textParts = (content as Array<{ type?: string; text?: string }>)
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
      const joined = textParts.join('').trim()
      if (joined) return joined
    }
  }
  return ''
}

function resolveSubModel(
  agentDef: SubAgentDefinition,
  parentOptions: AgentOptions,
  parentModel: LanguageModel,
): LanguageModel {
  // 子代理没有指定 model 时，直接继承父模型。
  if (!agentDef.model) return parentModel
  // CLI 未注入 modelRegistry 时，也只能继承父模型。
  if (!parentOptions.modelRegistry) return parentModel

  const resolvedId = resolveModelId(agentDef.model)
  if (!resolvedId) return parentModel

  try {
    return parentOptions.modelRegistry.languageModel(resolvedId as `${string}:${string}`)
  } catch {
    // 模型覆盖解析失败时不要让 task 失败，
    
    return parentModel
  }
}

function buildToolFilter(agentDef: SubAgentDefinition, parentPermissionMode: string) {
  // 子代理永远禁止 task，防止递归委派导致树无限展开。
  const deny = [...(agentDef.disallowedTools ?? []), 'task']

  // 父会话处于 plan mode 时，general-purpose 子代理也不能写文件。
  // 这样不会绕过父层“计划阶段只读”的用户预期。
  if (parentPermissionMode === 'plan' && agentDef.name === 'general-purpose') {
    deny.push('writeFile', 'edit')
  }

  // `'*'` 是通配符，表示“所有工具”，对齐 Claude Code 的 `tools: ['*']` 语义。
  // 这里传 undefined，让 buildTools 跳过 allowlist，只应用显式 deny list。
  // 否则 `['*']` 会被当成字面工具名，导致所有真实工具都被过滤掉。
  const allow = agentDef.tools?.includes('*') ? undefined : agentDef.tools

  return {
    allow,
    deny,
  }
}

/** 运行一个子代理，并返回父模型可读的 task result。
 *
 * parentModel 是父 agent 当前实际使用的 LanguageModel 实例。
 * 子代理如果没有 model override，就复用它；如果有 override，则通过 modelRegistry 解析。 */
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
    return {
      resultText: '[Sub-agent system not initialized]',
      tokenUsage: zeroUsage(),
      turnCount: 0,
      toolCallCount: 0,
      durationMs: 0,
      aborted: false,
    }
  }

  const agentDef = registry.get(agentName)
  if (!agentDef) {
    const available = registry.names().join(', ')
    return {
      resultText: `[Sub-agent '${agentName}' not found. Available: ${available}]`,
      tokenUsage: zeroUsage(),
      turnCount: 0,
      toolCallCount: 0,
      durationMs: 0,
      aborted: false,
    }
  }

  // 通知 UI：子代理开始运行。UI 会用这些事件构造 task 折叠块。
  callbacks.onSubAgentEvent?.({
    kind: 'start',
    toolCallId,
    agentName,
    description,
    prompt,
  })

  // 插件 hook：SubagentStart。
  // 在 agent 定义解析完成后、嵌套 agentLoop 运行前触发。best-effort。
  emitSubAgentHook(
    parentOptions.hookBus,
    {
      name: 'SubagentStart',
      session: { cwd: process.cwd(), modelId: parentOptions.modelId },
      agent: { name: agentName, description, prompt },
    },
    parentOptions.abortSignal,
  )

  const subModel = resolveSubModel(agentDef, parentOptions, parentModel)
  const subModelId = agentDef.model ? (resolveModelId(agentDef.model) ?? parentOptions.modelId) : parentOptions.modelId

  const subSystemPrompt = buildSubAgentSystemPrompt({
    agentPrompt: agentDef.prompt,
    knowledgeContext,
    isGitRepo,
  })

  // 子代理使用全新的 LoopState，避免内部 messages/todos/recentToolCalls 污染父会话。
  // systemPromptCache 直接设置为专用子代理 prompt，保证子循环使用隔离身份。
  const subState = createLoopState('default')
  subState.systemPromptCache = subSystemPrompt

  const toolFilter = buildToolFilter(agentDef, parentState.permissionMode)

  const subOptions: AgentOptions = {
    ...parentOptions,
    modelId: subModelId,
    maxTurns: agentDef.maxTurns,
    toolFilter,
    abortSignal: parentOptions.abortSignal,
    permissionMode: 'default',
    // 子代理不再拿 subAgentRegistry：明确禁止递归调用 task。
    subAgentRegistry: undefined,
  }

  // 构造子代理 callbacks：
  // 子循环事件会折叠后转发给父 UI，但不会直接把子状态混进父状态。
  const subCallbacks: AgentCallbacks = {
    onTextDelta: (delta) => {
      callbacks.onSubAgentEvent?.({ kind: 'text-delta', toolCallId, delta })
    },
    onToolCall: (_subToolCallId, subToolName, subInput) => {
      callbacks.onSubAgentEvent?.({
        kind: 'tool-call',
        toolCallId,
        subToolName,
        subInput,
      })
      // 同时转发到父级 onToolProgress，让底部 live indicator 能显示子代理正在做什么。
      callbacks.onToolProgress(toolCallId, `${subToolName}: ${previewInput(subInput)}`)
    },
    onToolProgress: (_subToolCallId, message) => {
      callbacks.onToolProgress(toolCallId, message)
    },
    onToolResult: (subToolCallId, result, isError) => {
      const preview = result.length > 200 ? result.slice(0, 197) + '...' : result
      callbacks.onSubAgentEvent?.({
        kind: 'tool-result',
        toolCallId,
        subToolName: subToolCallId,
        resultPreview: preview,
        durationMs: 0,
        isError: isError ?? false,
      })
    },
    onFileEdit: callbacks.onFileEdit,
    onAskPermission: callbacks.onAskPermission,
    onAskUser: callbacks.onAskUser,
    onPlanApprovalRequest: callbacks.onPlanApprovalRequest,
    onPlanModeChange: () => {},
    onTodosUpdate: () => {},
    onShellOutput: callbacks.onShellOutput,
    onUsageUpdate: () => {},
    onContextCompressed: () => {},
    onError: (error) => {
      
    },
  }

  try {
    const { state: finalSubState, turnCount } = await agentLoop(prompt, subModel, subOptions, subCallbacks, subState)

    const finalText = extractFinalText(finalSubState.messages)
    const toolUseCount = countToolCalls(finalSubState.messages)

    // 把子代理 token 用量累计回父状态。
    // 不混入子代理 messages，只累计 usage，让 /usage 能反映真实花费。
    parentState.tokenUsage.inputTokens += finalSubState.tokenUsage.inputTokens
    parentState.tokenUsage.outputTokens += finalSubState.tokenUsage.outputTokens
    parentState.tokenUsage.totalTokens = parentState.tokenUsage.inputTokens + parentState.tokenUsage.outputTokens
    parentState.tokenUsage.cacheReadTokens += finalSubState.tokenUsage.cacheReadTokens
    parentState.tokenUsage.cacheCreationTokens += finalSubState.tokenUsage.cacheCreationTokens
    callbacks.onUsageUpdate(parentState.tokenUsage)

    const durationMs = Date.now() - startTime
    const resultText = finalText || '[Sub-agent completed without producing a final response]'

    callbacks.onSubAgentEvent?.({
      kind: 'end',
      toolCallId,
      finalText: resultText,
      tokenUsage: finalSubState.tokenUsage,
      turnCount,
      durationMs,
      aborted: false,
    })

    emitSubAgentHook(
      parentOptions.hookBus,
      {
        name: 'SubagentStop',
        session: { cwd: process.cwd(), modelId: parentOptions.modelId },
        agent: { name: agentName, description },
        durationMs,
        outcome: 'completed',
        tokenUsage: {
          inputTokens: finalSubState.tokenUsage.inputTokens,
          outputTokens: finalSubState.tokenUsage.outputTokens,
          totalTokens: finalSubState.tokenUsage.totalTokens,
        },
      },
      parentOptions.abortSignal,
    )

    if (turnCount >= agentDef.maxTurns && !finalText) {
      // 只有 finalText 为空且达到 maxTurns 时才走这里。
      // 自 agentLoop 返回后 messages 没再被改过，所以 partial output 只能诚实报告 none。
      return {
        resultText: `[Sub-agent reached max turns (${agentDef.maxTurns}) without finishing. Partial output: none]`,
        tokenUsage: finalSubState.tokenUsage,
        turnCount,
        toolCallCount: toolUseCount,
        durationMs,
        aborted: false,
      }
    }

    return {
      resultText: `<task_result>\n${resultText}\n</task_result>`,
      tokenUsage: finalSubState.tokenUsage,
      turnCount,
      toolCallCount: toolUseCount,
      durationMs,
      aborted: false,
    }
  } catch (err) {
    const durationMs = Date.now() - startTime

    // agentLoop 通常会在内部捕获 abort/error，并带 outcome marker 正常返回。
    // 能逃到这里的多半是 setup 阶段错误，例如知识加载、slug 生成等。
    // 这时子代理实际上还没执行 turn，所以报告 0 是诚实的。
    const fallbackTurnCount = 0

    if (isAbortError(err, parentOptions.abortSignal)) {
      const partial = extractFinalText(subState.messages)
      const text = partial
        ? `[Sub-agent interrupted by user]\n\nPartial output:\n${partial}`
        : '[Sub-agent interrupted by user]'
      const toolUseCount = countToolCalls(subState.messages)

      callbacks.onSubAgentEvent?.({
        kind: 'end',
        toolCallId,
        finalText: text,
        tokenUsage: subState.tokenUsage,
        turnCount: fallbackTurnCount,
        durationMs,
        aborted: true,
      })

      emitSubAgentHook(
        parentOptions.hookBus,
        {
          name: 'SubagentStop',
          session: { cwd: process.cwd(), modelId: parentOptions.modelId },
          agent: { name: agentName, description },
          durationMs,
          outcome: 'aborted',
        },
        parentOptions.abortSignal,
      )

      return {
        resultText: text,
        tokenUsage: subState.tokenUsage,
        turnCount: fallbackTurnCount,
        toolCallCount: toolUseCount,
        durationMs,
        aborted: true,
      }
    }

    const message = err instanceof Error ? err.message : String(err)
  
    const toolUseCount = countToolCalls(subState.messages)

    callbacks.onSubAgentEvent?.({
      kind: 'end',
      toolCallId,
      finalText: `[Sub-agent failed: ${message}]`,
      tokenUsage: subState.tokenUsage,
      turnCount: fallbackTurnCount,
      durationMs,
      aborted: false,
    })

    emitSubAgentHook(
      parentOptions.hookBus,
      {
        name: 'SubagentStop',
        session: { cwd: process.cwd(), modelId: parentOptions.modelId },
        agent: { name: agentName, description },
        durationMs,
        outcome: 'failed',
      },
      parentOptions.abortSignal,
    )

    return {
      resultText: `[Sub-agent failed: ${message}]`,
      tokenUsage: subState.tokenUsage,
      turnCount: fallbackTurnCount,
      toolCallCount: toolUseCount,
      durationMs,
      aborted: false,
    }
  }
}

function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
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
      if (part?.type === 'tool-call') count++
    }
  }
  return count
}

function previewInput(input: Record<string, unknown>): string {
  // 选一个最能代表工具调用的字段显示在父级 live indicator 里。
  // 不同工具的输入 schema 不同，所以按常见字段依次兜底。
  const val =
    (input.filePath as string) ??
    (input.command as string) ??
    (input.pattern as string) ??
    (input.query as string) ??
    (input.dirPath as string) ??
    ''
  return val.length > 80 ? val.slice(0, 77) + '...' : val
}
