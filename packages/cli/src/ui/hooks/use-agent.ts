import { useCallback, useEffect, useRef, useState } from 'react'

import {
  agentLoop,
  appendCheckpoint,
  appendInterrupted,
  buildUserContent,
  capabilitiesOf,
  classifyApiError,
  compressMessages,
  flushPendingMessages,
  hydrateLoopState,
  initMemories,
  loadPersistedRules,
  markBoundaryAndReflush,
  restoreCheckpoint,
  saveSession,
} from '@tegent/core'
import { extractText } from '@tegent/core'
import type {
  AgentCallbacks,
  AgentOptions,
  CheckpointEntry,
  DisplayMessage,
  DisplayToolCall,
  LanguageModel,
  LoadedSession,
  LoopState,
  PermissionMode,
  TodoItem,
  TokenUsage,
} from '@tegent/core'

import { isCollapsibleReadOnlyTool } from '../utils.js'
import { useAgentDisplayHelpers } from './use-agent-display-helpers.js'
import { modelMessagesToDisplay, previewSubInput } from './use-agent-display.js'
import { extractLastAssistantText } from '../utils/toolkit.js'

export interface PendingPermission {
  /** core 发起的工具调用 id；用户选择授权后要用它对应回正在等待的那次调用。 */
  toolCallId: string
  /** 请求授权的工具名；内置工具是原名，MCP 工具通常是被 mangled 之后的名字。 */
  toolName: string
  /** 工具调用入参；ChatInput 会用它渲染授权弹窗里的命令、路径、参数预览。 */
  input: Record<string, unknown>
  /**
   * 当工具名能在 MCP registry 中找到时填充。
   *
   * 保存未被改名的 `<server>/<rawName>`，让弹窗显示
   * “MCP tool: filesystem/read_file”，而不是内部工具名
   * `filesystem__read_file`。这里完成查表，是为了让 MCP registry
   * 仍然只属于 CLI 启动阶段的关注点，不把它泄漏到 ChatInput。
   */
  mcp?: { serverName: string; rawName: string }
}

interface PendingQuestion {
  /** 弹窗上方展示给用户的问题文本。 */
  question: string
  /** 可选答案列表；freeform=true 的选项会切换到内联文本输入。 */
  options: { label: string; description: string; freeform?: boolean; preview?: string[] }[]
  /** 用户做出选择后要唤醒的 Promise resolver；core 或 slash command 正在等待它。 */
  resolve: (answer: string) => void
  /**
   * 用户通过 Ctrl+C / Esc 中断时传给 `resolve` 的值。
   *
   * 它的目的不是表达“真实回答”，而是保证 agent loop 能从等待状态退出：
   * plan 审批用 `'No'`，可关闭选择器用 `''`，askUser 用中断提示文本。
   */
  abortAnswer: string
  /**
   * 是否允许 Esc 仅关闭弹窗并 resolve 空字符串。
   *
   * 用户主动打开的选择器（如 `/syntax`、`/model`）会设置它，因为用户可能只是看一眼菜单。
   * 模型发起的问题（`onAskUser`、plan 审批）不设置它，避免把空答案静默喂回模型。
   */
  dismissible?: boolean
  /** 弹窗布局；紧凑横向或紧凑纵向，由 ChatInput 的选择器渲染层消费。 */
  layout?: 'compact' | 'compact-vertical'
}

/**
 * 自动追加到选项末尾的“自定义输入”入口。
 *
 * 这个选项模拟 Claude Code 的 `__other__` 行：模型会通过 askUser 工具 schema 被告知
 * 不要自己添加 “Other”，UI 在渲染时统一追加这一行，这样每个 askUser 弹窗都能切到自由文本。
 */
const OTHER_OPTION = {
  /** 选择器里显示的行标题。 */
  label: 'Other',
  /** 行描述，告诉用户这一项会打开自定义输入。 */
  description: 'Type a custom answer.',
  /** 标记该选项不是普通答案，而是进入自由文本输入状态。 */
  freeform: true as const,
}

/**
 * 当前仍在运行、需要显示在动态 UI 区域里的工具调用。
 *
 * 当模型在同一轮里并行发出多个 tool call 时，这里会同时存在多条记录。
 * `progress` 保存 `onToolProgress` 收到的最新进度文本，用它替换 `⎿` 行里的
 * “Running...” 默认文案，形成类似 Claude Code 的实时工具状态。
 */
export interface ActiveToolCall {
  /** 工具调用 id；和 core 回调中的 toolCallId 对齐。 */
  id: string
  /** 工具名，用于 UI 选择不同的预览/折叠样式。 */
  toolName: string
  /** 工具入参，用于渲染命令、文件路径、子任务摘要等。 */
  input: Record<string, unknown>
  /** 最新进度文本；没有进度时 ChatInput 使用默认运行中状态。 */
  progress?: string
  /** 子代理内部工具历史；用于 task 工具展开/摘要时展示子代理做了什么。 */
  subToolHistory?: string[]
}

export interface AgentState {
  /** 已提交到滚动区的显示消息；ChatInput 把它当作 append-only scrollback。 */
  messages: DisplayMessage[]
  /** 当前是否有一轮 agentLoop 正在执行；驱动 spinner、Esc 行为和部分 slash command 禁用。 */
  isLoading: boolean
  /** 当前正在执行的工具调用；渲染在输入框上方的动态区域。 */
  activeToolCalls: ActiveToolCall[]
  /** shell 工具实时输出缓冲；只保留当前 shell 的增量输出。 */
  shellOutput: string
  /** 等待用户处理的权限请求队列；ChatInput 一次显示队首。 */
  permissionQueue: PendingPermission[]
  /** 等待用户回答的问题或选择器；为空表示没有弹窗。 */
  pendingQuestion: PendingQuestion | null
  /** 当前会话累计 token 用量；由 core 的 onUsageUpdate 推送。 */
  usage: TokenUsage
  /** 当前错误横幅文本；为空表示没有需要展示的错误。 */
  error: string | null
  /** 实时模型 id；镜像 `modelIdRef`，让 `/model` 切换后 UI 能重新渲染。 */
  modelId: string
  /**
   * 当前会话的实时权限模式。
   *
   * 它镜像 `LoopState.permissionMode`，这样模型或用户通过 `/plan` 切换模式时，
   * 底部状态栏可以立即重绘。
   */
  permissionMode: PermissionMode
  /**
   * 模型通过 `todoWrite` 维护的实时任务清单。
   *
   * 模型尚未开始多步骤任务，或任务完成后被 core 自动清空时，这里是空数组。
   * ChatInput 用它在 spinner 上方渲染 todo 面板。
   */
  todos: TodoItem[]
  /**
   * 粘性读取状态：连续运行可折叠只读工具（Read/Glob/Grep/ListDir）时为 true。
   *
   * 它让 spinner 在多个读取工具之间 50-200ms 的短暂空档里继续显示 “Reading...”。
   * 如果没有这个标记，界面会在每个读取工具之间闪回 “Thinking...”，多秒读取时很抖。
   * 遇到非只读工具、模型开始输出文本、loop 结束或用户中断时会改回 false。
   */
  bufferingReads: boolean
  /**
   * 上下文压缩中的阶段标签。
   *
   * 非 null 时 ChatInput 用它替换普通 “Thinking...” spinner 文案，让用户知道正在压缩哪一步。
   */
  compressionLabel: string | null
}

/** 不依赖模型和权限模式的初始 UI 状态；`useAgent` 创建状态时再补上两者。 */
const initialState: Omit<AgentState, 'modelId' | 'permissionMode'> = {
  /** 初始没有 scrollback 消息。 */
  messages: [],
  /** 初始没有 agentLoop 在跑。 */
  isLoading: false,
  /** 初始没有活动工具。 */
  activeToolCalls: [],
  /** 初始没有 shell 输出。 */
  shellOutput: '',
  /** 初始没有权限请求。 */
  permissionQueue: [],
  /** 初始没有问答弹窗。 */
  pendingQuestion: null,
  /** 初始 token 用量全部归零。 */
  usage: {
    /** 输入 token 累计。 */
    inputTokens: 0,
    /** 输出 token 累计。 */
    outputTokens: 0,
    /** 总 token 累计。 */
    totalTokens: 0,
    /** 命中 provider prompt cache 的 token 数。 */
    cacheReadTokens: 0,
    /** 写入 provider prompt cache 的 token 数。 */
    cacheCreationTokens: 0,
    /** 当前上下文估算 token 数。 */
    currentContextTokens: 0,
  },
  /** 初始没有错误。 */
  error: null,
  /** 初始没有 todo。 */
  todos: [],
  /** 初始不处于读取链。 */
  bufferingReads: false,
  /** 初始不处于压缩流程。 */
  compressionLabel: null,
}

/**
 * 维护 CLI 侧 agent 会话状态，并把 ChatInput/App 的用户操作桥接到 core 的 `agentLoop`。
 *
 * @param initialModel 启动时选定的模型实例，后续 `/model` 可通过 `switchModel` 替换。
 * @param options CLI 启动和 slash command 汇总出来的 agent 配置，会在每次提交时传入 core。
 * @param initialSession 通过 `--continue` 或启动恢复加载出来的历史会话；没有恢复时为空。
 * @returns 给 App/ChatInput 使用的一组状态、提交函数、授权/问答 resolver、会话管理和显示辅助方法。
 */
export function useAgent(initialModel: LanguageModel, options: AgentOptions, initialSession?: LoadedSession | null) {
  // 如果启动时已经加载了会话（例如 --continue），先把 UI 状态填上历史消息和 token 用量。
  // 这样用户还没输入新消息时，scrollback 和 /usage 就已经是恢复后的视图。
  // loopStateRef 会在下面配套的 useEffect 中 hydrate，因为 ref 不能在 useState 初始化器之前设置。
  const [state, setState] = useState<AgentState>({
    /** 先展开通用初始值，下面再覆盖需要从 options/session 派生的字段。 */
    ...initialState,
    /** 当前 UI 显示的模型 id 来自启动配置。 */
    modelId: options.modelId,
    /** 权限模式默认是 default，也可能由 --plan 等启动参数指定。 */
    permissionMode: options.permissionMode ?? 'default',
    /** 有历史会话时把 core 消息转换成 UI 消息；否则从空消息开始。 */
    messages: initialSession ? modelMessagesToDisplay(initialSession.messages) : initialState.messages,
    /** 有历史会话时恢复 token 用量；否则使用归零值。 */
    usage: initialSession ? { ...initialSession.tokenUsage } : initialState.usage,
  })

  /** 当前模型实例的 ref；避免每次切模型都重建大量回调，下一轮 submit 会读取最新值。 */
  const modelRef = useRef<LanguageModel>(initialModel)
  /** 当前模型 id 的 ref；和 state.modelId 分工：ref 给逻辑读，state 给 UI 重绘。 */
  const modelIdRef = useRef<string>(options.modelId)
  /**
   * 镜像 `state.permissionMode`，供每次 `submit` 组装 agentLoop options 时读取。
   *
   * agentLoop 在创建 LoopState 时读取 options.permissionMode；进入 loop 后，
   * 工具分发会直接修改 LoopState，再通过 `onPlanModeChange` 回调同步回这里。
   */
  const permissionModeRef = useRef<PermissionMode>(options.permissionMode ?? 'default')
  /**
   * 镜像 `state.activeToolCalls.length`，给 `abort()` 同步判断当前是否处在工具执行中。
   *
   * 如果 `abort()` 直接依赖 React state，每次工具数量变化都会重建回调，
   * ChatInput 也会反复重新绑定按键处理器。
   */
  const activeToolCallsLenRef = useRef(0)
  // 镜像 /thinking 开关，让 agentLoop 在下一轮读取到会话中途切换后的最新值。
  // 初始值来自 CLI options；options 在启动时会读取 ~/.tegent/config.json。
  const thinkingRef = useRef<boolean>(options.thinking ?? false)
  /** 长生命周期的 core LoopState；它保存模型消息、会话 id、checkpoint、权限模式等核心会话状态。 */
  const loopStateRef = useRef<LoopState | null>(null)
  /** 当前轮的 AbortController；Esc/Ctrl+C 通过它把取消信号传给 core、SDK 和工具执行。 */
  const abortControllerRef = useRef<AbortController | null>(null)
  /** initialize 是否已经执行过；initMemories/loadPersistedRules 每个 CLI 会话只跑一次。 */
  const initializedRef = useRef(false)
  /**
   * 按 toolCallId 记录尚未收到结果的工具调用。
   *
   * 不能用单个变量存，因为模型可能一轮发多个并行工具调用：SDK 会先发 tool-call A、
   * tool-call B，再回 tool-result A、tool-result B。单槽位会被覆盖，结果回填时就会变成 unknown。
   */
  const pendingToolsRef = useRef<Map<string, { toolName: string; input: Record<string, unknown>; startedAt: number }>>(
    new Map(),
  )
  /**
   * 按 toolCallId 暂存编辑工具产生的结构化 diff。
   *
   * `onFileEdit` 会在工具执行完成、`onToolResult` 之前触发；随后 `onToolResult`
   * 取走它并挂到新的 DisplayToolCall 上。单独建 map 是因为不是每个工具都有 diff，
   * 也不希望 pendingToolsRef 的普通记录被空 diff 字段撑大。
   */
  const pendingEditDiffsRef = useRef<Map<string, import('@tegent/core').EditDiffPayload>>(new Map())
  /**
   * 与 `permissionQueue` 平行保存的授权 Promise resolver。
   *
   * 放在 ref 里，是为了 `abort()` 能在 `controller.abort()` 前同步拒绝所有等待中的权限门。
   * 否则 core loop 可能卡在第一个 shell 授权上，而 UI 还显示已经过期的 Yes/No。
   */
  const permissionResolversRef = useRef<Array<(decision: 'yes' | 'always' | 'no') => void>>([])

  /**
   * 向 UI scrollback 追加一条显示消息。
   *
   * @param msg 已转换成 CLI 显示模型的消息。
   */
  const appendMessage = useCallback((msg: DisplayMessage) => {
    setState((prev) => ({ ...prev, messages: [...prev.messages, msg] }))
  }, [])

  // /** 流式文本缓冲器：把高频 delta 合并后再追加到 messages，减少 ChatInput 重绘次数。 */
  // const { appendTextDelta, flushBuffer, resetBuffer } = useStreamBuffer(appendMessage)

  /**
   * 第一版的直通流式文本追加逻辑。
   *
   * 这里刻意绕过 `useStreamBuffer` 的安全边界、批处理和终端重绘优化。
   * 模型每吐出一个 delta，就直接合并到当前 assistant 流式消息里。
   * 如果上一条消息不是 assistant 流式消息，就创建一条新的 assistant 消息。
   *
   * @param delta 模型刚产生的文本增量。
   */
  const appendTextDelta = useCallback((delta: string) => {
    if (!delta) return
    setState((prev) => {
      const last = prev.messages[prev.messages.length - 1]
      if (last?.role === 'assistant' && last.streamingChunk && !last.toolCalls && !last.kind) {
        const next = prev.messages.slice()
        next[next.length - 1] = {
          ...last,
          content: last.content + delta,
          timestamp: Date.now(),
        }
        return { ...prev, messages: next }
      }
      const msg: DisplayMessage = {
        id: `stream-direct-${Date.now()}`,
        role: 'assistant',
        content: delta,
        streamingChunk: true,
        timestamp: Date.now(),
      }
      return { ...prev, messages: [...prev.messages, msg] }
    })
  }, [])

  /**
   * 直通模式没有额外文本缓冲，因此 flush 是 no-op。
   */
  const flushBuffer = useCallback(() => {}, [])

  /**
   * 直通模式没有额外文本缓冲，因此 reset 是 no-op。
   */
  const resetBuffer = useCallback(() => {}, [])

  // 保持 activeToolCallsLenRef 与 React state 同步。
  // abort() 用这个 ref 区分普通中断和工具执行中断，同时避免把 state 放进 abort 的依赖数组。
  useEffect(() => {
    activeToolCallsLenRef.current = state.activeToolCalls.length
  }, [state.activeToolCalls.length])

  // 首次渲染后，把预加载会话 hydrate 成 core 的 LoopState。
  // 这个 effect 会早于 App 里提交 initialPrompt 的 effect 执行，因此恢复会话后的第一条新消息
  // 会带着 existingState 进入 agentLoop，继续写同一个会话，而不是新开一段。
  useEffect(() => {
    if (initialSession && !loopStateRef.current) {
      loopStateRef.current = hydrateLoopState(initialSession, options.permissionMode ?? 'default')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 初始化记忆和持久化权限规则；每个 CLI 会话只执行一次。
   *
   * 项目上下文来自从 cwd 向上查找的 AGENTS.md 链，而不是语言 manifest 扫描；
   * 这样不会把工具偏向 Node/TypeScript 项目。
   *
   * @returns 初始化完成后 resolve；重复调用会立即返回。
   */
  const initialize = useCallback(async () => {
    if (initializedRef.current) return
    initializedRef.current = true
    await initMemories()
    loadPersistedRules(process.cwd())
  }, [])

  /**
   * 提交一条用户消息给 core 的 agentLoop，并把流式文本、工具调用、授权请求等回调同步成 CLI 状态。
   *
   * `silent: true` 表示不要把这段文本追加到 UI scrollback，但仍然喂给模型。
   * 这用于 `/init` 这类注入长提示词的 slash command：用户已经看到命令回显，
   * 如果再把完整提示词刷进 scrollback 会很吵。spinner、中断信号和会话保存仍照常工作。
   *
   * @param text 用户输入或 slash command 注入给模型的文本。
   * @param submitOptions 提交选项；`silent` 为 true 时只发送给模型、不显示为用户消息。
   * @returns 当前 agentLoop 完成、失败或被中断后 resolve。
   */
  const submit = useCallback(
    async (text: string, submitOptions?: { silent?: boolean }) => {
      // 确保记忆和权限规则已经加载；重复调用会被 initialize 内部短路。
      await initialize()

      // 进入 loading：清掉上一轮的 shell 输出和错误，并按 silent 规则决定是否回显用户文本。
      setState((prev) => ({
        ...prev,
        isLoading: true,
        shellOutput: '',
        error: null,
        messages: submitOptions?.silent
          ? prev.messages
          : [...prev.messages, { id: Date.now().toString(), role: 'user', content: text, timestamp: Date.now() }],
      }))

      // 每次 submit 都创建新的 AbortController；这一轮所有 core/工具/SDK 异步流程共享这根信号线。
      const controller = new AbortController()
      abortControllerRef.current = controller

      // 记录本轮是否收到过文本 delta；后面的兜底提取会用它避免重复显示已 flush 的文本。
      let sawTextDelta = false

      // 这组 callbacks 是 CLI 和 core 的主要通信协议：core 不直接碰 UI，只通过这些回调报告事件。
      const callbacks: AgentCallbacks = {
        /** 模型流式吐出文本时，直通追加到当前 assistant 流式消息。 */
        onTextDelta: (delta) => {
          if (delta) {
            sawTextDelta = true
            // 文本输出会打断“连续读取工具”状态：模型正在写回复时，spinner 应回到 Thinking。
            // 这里用新旧状态判断，确保读取链后的第一个 delta 才 setState，避免每个 token 都重绘。
            setState((prev) => (prev.bufferingReads ? { ...prev, bufferingReads: false } : prev))
          }
          appendTextDelta(delta)
        },
        /** core 开始执行工具时，把工具登记为 active；直通模式下 flushBuffer 是 no-op。 */
        onToolCall: (toolCallId, toolName, input) => {
          // 同一同步 tick 内完成“刷文本缓冲”和“登记 live 工具行”，让 React 18 自动批处理成一次渲染。
          // 以前用 4ms setTimeout 跳过超快工具的 Running 帧，但慢工具会产生文本提交帧和工具行帧两次写 stdout，
          // 文本到工具的过渡会明显闪烁。现在超快工具会短暂闪一下 Running，但慢工具体验更稳定。
          flushBuffer()
          // 保存工具名、入参和开始时间；工具结果回来时要用它组装 DisplayToolCall 和耗时。
          pendingToolsRef.current.set(toolCallId, { toolName, input, startedAt: Date.now() })
          // 同步更新粘性读取链：可折叠只读工具延续 Reading，Edit/Write/Shell/Task 等会打断它。
          const isReadOnly = isCollapsibleReadOnlyTool(toolName)
          setState((prev) => ({
            ...prev,
            activeToolCalls: [...prev.activeToolCalls, { id: toolCallId, toolName, input }],
            bufferingReads: isReadOnly ? true : false,
          }))
        },
        /** 工具执行中上报进度时，只更新对应 active tool 的 progress 字段。 */
        onToolProgress: (toolCallId, message) => {
          setState((prev) => {
            // 找不到说明工具已经完成、被取消，或 UI 状态已被清理；直接忽略迟到进度。
            const idx = prev.activeToolCalls.findIndex((t) => t.id === toolCallId)
            if (idx < 0) return prev
            // 浅拷贝数组和目标项，保持 React state 不可变更新。
            const next = prev.activeToolCalls.slice()
            next[idx] = { ...next[idx], progress: message }
            return { ...prev, activeToolCalls: next }
          })
        },
        /** 文件编辑工具生成 diff 时先暂存，等工具结果消息出现时再附到 DisplayToolCall。 */
        onFileEdit: (toolCallId, payload) => {
          // 结构化 patch 会在 onToolResult 被取走并删除，避免同 id 的失败重试继承旧 diff。
          pendingEditDiffsRef.current.set(toolCallId, payload)
        },
        /** 工具执行结束时，把 live 工具行移除，并把结果固化为一条 scrollback 消息。 */
        onToolResult: (toolCallId, result, isError) => {
          // 取出并清理 pending 记录；后续即使有迟到回调，也不会重复显示。
          const pending = pendingToolsRef.current.get(toolCallId)
          pendingToolsRef.current.delete(toolCallId)
          // 取出并清理对应 diff；只有编辑类工具会存在 editPayload。
          const editPayload = pendingEditDiffsRef.current.get(toolCallId)
          pendingEditDiffsRef.current.delete(toolCallId)
          // 根据开始时间计算展示用耗时；没有 pending 时用 0 作为兜底。
          const durationMs = pending ? Date.now() - pending.startedAt : 0
          setState((prev) => {
            // DisplayToolCall 是 UI 层模型，和 core/SDK 的 tool result 格式解耦。
            const tc: DisplayToolCall = {
              id: `tc-${Date.now()}`,
              toolName: pending?.toolName ?? 'unknown',
              input: pending?.input ?? {},
              output: result,
              status: isError ? 'error' : 'completed',
              durationMs,
              ...(editPayload ? { editPayload } : {}),
            }
            return {
              ...prev,
              // 从动态区域移除这个工具。
              activeToolCalls: prev.activeToolCalls.filter((t) => t.id !== toolCallId),
              // 工具结束后清空 shellOutput，避免下一条 shell 继承旧输出。
              shellOutput: '',
              // 把工具结果作为 assistant 消息追加到 scrollback；ChatInput 会渲染成工具块。
              messages: [
                ...prev.messages,
                {
                  id: `tool-${Date.now()}`,
                  role: 'assistant',
                  content: '',
                  toolCalls: [tc],
                  timestamp: Date.now(),
                },
              ],
            }
          })
        },
        /** core 需要用户授权工具时，把请求排进 UI 队列，并返回一个等待用户选择的 Promise。 */
        onAskPermission: (toolCall) => {
          return new Promise<'yes' | 'always' | 'no'>((resolve) => {
            // resolver 与 permissionQueue 平行入队；用户点 Yes/No 时 resolvePermission 会取队首。
            permissionResolversRef.current.push(resolve)
            // MCP 查表：registry 里有未 mangled 的 server + raw tool name，可用于弹窗标题和 always-allow 标签。
            // 内置工具查不到 registry，mcp 保持 undefined，ChatInput 会走原来的内置工具展示逻辑。
            const mcpEntry = options.mcpRegistry?.get(toolCall.toolName)
            const entry: PendingPermission = {
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              input: toolCall.input,
              mcp: mcpEntry ? { serverName: mcpEntry.serverName, rawName: mcpEntry.rawName } : undefined,
            }
            setState((prev) => ({ ...prev, permissionQueue: [...prev.permissionQueue, entry] }))
          })
        },
        /** 模型通过 askUser 向用户提问时，转成 CLI 选择器并把答案 Promise 交回 core。 */
        onAskUser: (question, opts) => {
          return new Promise<string>((resolve) => {
            // plan 模式下追加两个 UI 侧 meta 选项；它们不在模型原始 tool input 里。
            // 系统提示的 plan overlay 会教模型识别这些字面 label，因此答案回去后模型知道如何处理。
            // OTHER_OPTION 永远最后追加，保证任何 plan footer 存在时它仍在末尾。
            const planMeta =
              permissionModeRef.current === 'plan'
                ? [
                    {
                      label: 'Chat about this',
                      description: 'Reply in conversation without picking an option above.',
                    },
                    {
                      label: 'Skip interview and plan immediately',
                      description: 'Stop the questions — produce the final plan now with everything gathered so far.',
                    },
                  ]
                : []
            const augmented = [...opts, ...planMeta, OTHER_OPTION]
            setState((prev) => ({
              ...prev,
              // pendingQuestion 驱动 ChatInput 打开选择器；用户选择后 resolveQuestion 会唤醒这个 Promise。
              pendingQuestion: {
                question,
                options: augmented,
                resolve,
                abortAnswer: '[Request interrupted by user]',
                layout: 'compact-vertical',
              },
            }))
          })
        },
        /** core 生成 plan 后请求用户审批：先把 plan 渲染到 scrollback，再弹 Yes/No。 */
        onPlanApprovalRequest: (planText) => {
          // 两步 UX：先把 plan 正文作为普通 assistant 消息提交到 scrollback，享受完整 markdown 渲染；
          // 再弹一个紧凑 Yes/No 对话框。如果把几十行 plan 塞进 SelectOptions 的 question，
          // 会挤掉 Yes/No 并显示一墙带 ? 前缀的原始 markdown。磁盘上的 plan 文件仍是权威副本。
          appendMessage({
            id: `plan-approval-${Date.now()}`,
            role: 'assistant',
            content: planText,
            timestamp: Date.now(),
          })
          return new Promise<boolean>((resolve) => {
            // 延后一 tick 再打开弹窗，让 plan 文本先完成绘制，避免提交消息和弹窗增高同时发生扰乱几何计算。
            setTimeout(() => {
              setState((prev) => ({
                ...prev,
                pendingQuestion: {
                  question: 'Approve the plan above?',
                  options: [
                    { label: 'Yes', description: 'Exit plan mode and start implementing (writes auto-approved).' },
                    { label: 'No', description: 'Stay in plan mode and let the model revise.' },
                  ],
                  resolve: (answer) => resolve(answer === 'Yes'),
                  abortAnswer: 'No',
                },
              }))
            }, 0)
          })
        },
        /** core 内部改变权限模式时，同步 ref 和 UI state。 */
        onPlanModeChange: (mode) => {
          permissionModeRef.current = mode
          setState((prev) => ({ ...prev, permissionMode: mode }))
          // 模式只作用于当前会话；不写入用户配置。新会话默认 default，除非启动时传了 --plan。
        },
        /** core 更新 todo 列表时，CLI 只做镜像存储，验证和自动清空语义都在 core 内完成。 */
        onTodosUpdate: (todos) => {
          setState((prev) => ({ ...prev, todos }))
        },
        /** 子代理事件：把 task 内部的工具调用摘要映射成父工具行的进度文本。 */
        onSubAgentEvent: (event) => {
          if (event.kind === 'tool-call') {
            setState((prev) => {
              // 子代理事件属于父 task toolCallId；找不到父工具行就忽略。
              const idx = prev.activeToolCalls.findIndex((t) => t.id === event.toolCallId)
              if (idx < 0) return prev
              const tc = prev.activeToolCalls[idx]!
              // 构造一条简短历史：“工具名: 入参预览”。
              const label = `${event.subToolName}: ${previewSubInput((event.subInput as Record<string, unknown>) ?? {})}`
              const history = [...(tc.subToolHistory ?? []), label]
              const next = prev.activeToolCalls.slice()
              next[idx] = { ...tc, progress: label, subToolHistory: history }
              return { ...prev, activeToolCalls: next }
            })
          }
          if (event.kind === 'end') {
            // 子代理结束时把轮数、token 和耗时压缩成一条 Done 状态。
            const turnInfo = `${event.turnCount}t`
            const tokInfo =
              event.tokenUsage.totalTokens > 1000
                ? `${(event.tokenUsage.totalTokens / 1000).toFixed(1)}k tok`
                : `${event.tokenUsage.totalTokens} tok`
            const durInfo =
              event.durationMs > 1000 ? `${(event.durationMs / 1000).toFixed(1)}s` : `${event.durationMs}ms`
            callbacks.onToolProgress(event.toolCallId, `Done (${turnInfo}, ${tokInfo}, ${durInfo})`)
          }
        },
        /** shell 工具实时输出；ChatInput 会把 shellOutput 渲染成当前工具的流式输出区域。 */
        onShellOutput: (chunk) => {
          setState((prev) => ({ ...prev, shellOutput: prev.shellOutput + chunk }))
        },
        /** token 用量更新；直接镜像到 UI state。 */
        onUsageUpdate: (usage) => {
          setState((prev) => ({ ...prev, usage }))
        },
        /** 自动上下文压缩进度；用来替换 spinner 文案。 */
        onCompressionProgress: (description) => {
          setState((prev) => ({ ...prev, compressionLabel: description }))
        },
        /** 自动上下文压缩完成；清掉进度标签并把摘要作为命令结果展示。 */
        onContextCompressed: (summary) => {
          setState((prev) => ({ ...prev, compressionLabel: null }))
          appendMessage({
            id: `compress-${Date.now()}`,
            role: 'assistant',
            content: summary,
            timestamp: Date.now(),
            kind: 'command-result',
          })
        },
        /** core 报错时把错误文本挂到 UI state；submit 的 catch 也会做最终兜底分类。 */
        onError: (error) => {
          setState((prev) => ({ ...prev, error: error.message }))
        },
        /** 记忆抽取器写入事实后，追加一条轻量提示到 scrollback。 */
        onMemoryWrite: ({ scope, category, key, fact }) => {
          // 记忆抽取是 fire-and-forget，可能在 submit resolved 后甚至下一轮才回来。
          // 直接追加到 scrollback，cell-buffer renderer 会像普通 assistant 消息一样插入，
          // 不会破坏用户此刻正在输入的内容。
          appendMessage({
            id: `mem-${Date.now()}-${key}`,
            role: 'assistant',
            content: `Remembered (${scope} · ${category}) \`${key}\`: ${fact}`,
            timestamp: Date.now(),
            kind: 'command-result',
          })
        },
      }

      try {
        // 把输入里的 @path / 裸路径解析成模型可消费的 content parts。
        // 多模态模型拿到图片 part；PDF/Office/非视觉模型拿到抽取文本；没有可附加内容时走纯字符串快路径。
        // onNotice 用于显示摄取阶段事件，例如非视觉模型把图片交给视觉子代理生成 caption。
        const content = await buildUserContent(text, capabilitiesOf(modelIdRef.current), (notice) => {
          appendMessage({
            id: `ingest-notice-${Date.now()}`,
            role: 'assistant',
            content: notice,
            timestamp: Date.now(),
            kind: 'command-result',
          })
        })

        // 调用 core 的 agentLoop：CLI 提供 content、模型、options、callbacks 和旧 LoopState。
        // agentLoop 返回 { state, turnCount }；交互式主循环只保存长生命周期 state，turnCount 留给子代理场景。
        const agentResult = await agentLoop(
          content,
          modelRef.current,
          {
            ...options,
            modelId: modelIdRef.current,
            thinking: thinkingRef.current,
            // permissionMode 只有首次 submit 创建 LoopState 时真正生效。
            // 后续 submit 会沿用 existingState.permissionMode，这里只是保持 options 形状完整。
            permissionMode: permissionModeRef.current,
            abortSignal: controller.signal,
          },
          callbacks,
          loopStateRef.current ?? undefined,
        )
        // 保存 core 返回的最新 LoopState；下一次用户输入会继续这段会话。
        loopStateRef.current = agentResult.state

        // 收尾：直通模式下没有额外流式缓冲；保留 flushBuffer 调用是为了以后恢复优化时不改调用点。
        // 如果 provider 没有发文本 delta（例如只流 reasoning，最终文本在 response.messages），
        // 就从 LoopState 中提取最后一条 assistant 文本，保证用户能看到回复。
        flushBuffer()
        if (!sawTextDelta && loopStateRef.current) {
          const fallback = extractLastAssistantText(loopStateRef.current.messages)
          if (fallback) {
            appendMessage({
              id: `text-${Date.now()}`,
              role: 'assistant',
              content: fallback,
              timestamp: Date.now(),
            })
          }
        }
        // 正常结束后清掉所有 pending 工具；迟到结果不应再影响 UI。
        pendingToolsRef.current.clear()
        setState((prev) => ({
          ...prev,
          isLoading: false,
          activeToolCalls: [],
          bufferingReads: false,
          compressionLabel: null,
        }))
      } catch (err) {
        // 异常结束也要清掉 pending 工具，避免下一轮出现旧工具残影。
        pendingToolsRef.current.clear()
        // 用户取消路径：agentLoop 通常会把 AbortError 吞成干净的 aborted outcome 并正常返回。
        // 如果某个还没接入 abort 的 helper 在 controller 已取消时抛错，就压掉错误横幅；
        // abort() 已经写入 `[Request interrupted by user]`，那才是用户应该看到的信号。
        const wasAborted = controller.signal.aborted
        setState((prev) => ({
          ...prev,
          isLoading: false,
          activeToolCalls: [],
          bufferingReads: false,
          compressionLabel: null,
          error: wasAborted ? null : classifyApiError(err).message,
        }))
      }
    },
    [options, initialize, appendTextDelta, flushBuffer, appendMessage],
  )

  /**
   * 解析队首权限请求，并把对应弹窗从队列中移除。
   *
   * @param decision 用户对当前权限请求的选择：本次允许、永久允许或拒绝。
   */
  const resolvePermission = useCallback((decision: 'yes' | 'always' | 'no') => {
    setState((prev) => {
      // UI 只处理队首权限请求，tail 会成为下一次渲染时显示的新队首。
      const [head, ...tail] = prev.permissionQueue
      if (head) {
        // resolver 队列和 permissionQueue 平行；取队首 resolver 对应队首 UI 项。
        const r = permissionResolversRef.current[0]
        queueMicrotask(() => {
          // 微任务中再次确认队首没变，避免同步 setState 期间重复 resolve 或错位 resolve。
          if (r !== undefined && permissionResolversRef.current[0] === r) {
            permissionResolversRef.current.shift()
            r(decision)
          }
        })
      }
      return { ...prev, permissionQueue: tail }
    })
  }, [])

  /**
   * 解析当前 pendingQuestion，并关闭选择器。
   *
   * @param answer 用户选择的 label 或自由输入文本。
   */
  const resolveQuestion = useCallback((answer: string) => {
    setState((prev) => {
      if (prev.pendingQuestion) {
        // 用微任务唤醒等待者，避免在 React state updater 里同步触发外部流程。
        queueMicrotask(() => prev.pendingQuestion!.resolve(answer))
      }
      return { ...prev, pendingQuestion: null }
    })
  }, [])

  /**
   * 给 slash command 弹出一个多选问题。
   *
   * 它复用 `askUser` 的 SelectOptions 弹窗，供 `/model`、`/syntax` 等命令使用。
   * Promise 会 resolve 为用户选择的 label，或 “Other” 自由输入的文本。
   *
   * @param question 选择器标题。
   * @param options 选项列表。
   * @param opts 布局和是否禁用 Other 的 UI 选项。
   * @returns 用户选择或输入的答案。
   */
  const askQuestion = useCallback(
    (
      question: string,
      options: { label: string; description: string; preview?: string[] }[],
      opts?: { layout?: 'compact' | 'compact-vertical'; noOther?: boolean },
    ) => {
      return new Promise<string>((resolve) => {
        // slash picker 默认也带 Other；显式 noOther 时只展示调用方给出的选项。
        const augmented = opts?.noOther ? options : [...options, OTHER_OPTION]
        setState((prev) => ({
          ...prev,
          pendingQuestion: {
            question,
            options: augmented,
            resolve,
            abortAnswer: '',
            dismissible: true,
            layout: opts?.layout,
          },
        }))
      })
    },
    [],
  )

  /**
   * 中断当前正在执行的一轮 agent。
   *
   * 处理顺序刻意保持稳定：
   * 1. 先调用 flushBuffer；直通模式下它是 no-op，恢复缓冲优化后仍能保证已有文本先显示。
   * 2. 追加 `[Request interrupted by user]` 或工具中断提示，并同步写入 LoopState。
   * 3. 同步 resolve 掉授权弹窗、askUser、plan 审批和 slash picker，避免 core 还在 await。
   * 4. 最后触发 AbortController，让 streamText、shell、工具执行沿 abortSignal 退出。
   *
   * 没有正在执行的 controller，或 controller 已经 aborted 时，这是 no-op。
   * `isLoading=false`、`activeToolCalls=[]` 等 UI 清理由 submit 的收尾路径统一完成。
   */
  const abort = useCallback(() => {
    // 没有当前轮，或当前轮已经被取消过，就不重复写中断消息。
    const controller = abortControllerRef.current
    if (!controller || controller.signal.aborted) return

    // 先刷文本缓冲，保证部分 assistant 回复排在中断提示之前。
    flushBuffer()

    // 工具执行中断要给模型更具体的上下文，下一轮它就知道上次停在工具使用阶段。
    const forToolUse = activeToolCallsLenRef.current > 0
    const noticeText = forToolUse ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]'

    appendMessage({
      id: `interrupt-${Date.now()}`,
      role: 'assistant',
      content: noticeText,
      timestamp: Date.now(),
      kind: 'command-result',
    })

    // 把中断提示也写入 core 消息历史；下一轮 API 请求才能明确看到上一轮被用户打断。
    // 如果只显示在 UI，模型可能只看到半截 assistant 消息，然后尝试悄悄续写。
    if (loopStateRef.current) {
      loopStateRef.current.messages.push({ role: 'user', content: noticeText })
      // 持久化中断：追加 interrupted meta 行，并 flush 未保存尾部（包括刚才 push 的 notice）。
      // 这是 fire-and-forget，避免因为 FS 错误阻塞用户的取消动作。
      void appendInterrupted(loopStateRef.current)
      void flushPendingMessages(loopStateRef.current)
    }

    // 解除 core 中所有 `await onAskPermission`。
    // 并行工具会排多个 UI 行，但执行通常按权限门顺序等待；取消时必须把这些门全部拒绝。
    const permResolvers = permissionResolversRef.current
    permissionResolversRef.current = []
    for (const r of permResolvers) r('no')

    // 解除 askUser、plan 审批或 slash picker 对 pendingQuestion 的等待。
    const pendingAbortRef: {
      current: { resolve: (answer: string) => void; abortAnswer: string } | null
    } = { current: null }
    setState((prev) => {
      // React updater 内只提取 resolver 信息，不直接调用外部函数。
      const pq = prev.pendingQuestion
      pendingAbortRef.current = pq ? { resolve: pq.resolve, abortAnswer: pq.abortAnswer } : null
      return { ...prev, permissionQueue: [], pendingQuestion: null, bufferingReads: false }
    })
    // updater 结束后再真正 resolve，保持 React 更新纯净。
    const pa = pendingAbortRef.current
    if (pa) pa.resolve(pa.abortAnswer)

    // 最后广播 abort 信号，让底层异步任务开始退出。
    controller.abort()
  }, [flushBuffer, appendMessage])

  /**
   * 保存当前会话并执行退出清理。
   *
   * @returns 会话保存完成后 resolve；没有 LoopState 时直接返回。
   */
  const cleanup = useCallback(async () => {
    if (loopStateRef.current) {
      await saveSession(loopStateRef.current, modelRef.current)
    }
  }, [])

  /**
   * 同步读取当前会话摘要，供 `index.ts` 在退出后打印 resume 提示。
   *
   * 用户启动后从未提交消息时没有 LoopState，返回 null，让 index.ts 跳过空会话提示。
   *
   * @returns 会话 id、slug、消息数量和首条用户提示预览；无会话时为 null。
   */
  const getSessionInfo = useCallback(() => {
    // LoopState 是 core 侧权威会话对象；没有它就没有可恢复内容。
    const ls = loopStateRef.current
    if (!ls || ls.messages.length === 0) return null
    // 用第一条 user 消息生成退出提示里的任务预览。
    const firstUserMsg = ls.messages.find((m) => m.role === 'user')
    const firstPrompt = firstUserMsg ? extractText(firstUserMsg.content).slice(0, 80) : ''
    return { sessionId: ls.sessionId, taskSlug: ls.taskSlug, messageCount: ls.messages.length, firstPrompt }
  }, [])

  /**
   * 清空当前对话，但保留当前模型和权限模式。
   */
  const clear = useCallback(() => {
    // 清掉 core 会话；下一次 submit 会创建新的 LoopState。
    loopStateRef.current = null
    // 清掉所有未完成工具和权限 resolver，避免旧会话的异步回调影响新会话。
    pendingToolsRef.current.clear()
    permissionResolversRef.current = []
    // 清掉流式文本缓冲，避免旧文本被下一轮 flush。
    resetBuffer()
    // /clear 只清对话，不清会话级设置；用户刚选的模型和 plan/default 模式应保留。
    setState((prev) => ({ ...initialState, modelId: prev.modelId, permissionMode: prev.permissionMode }))
  }, [resetBuffer])

  /**
   * 在当前 CLI 会话中热切换到一个已保存的历史会话。
   *
   * 它会从 jsonl hydrate 出新的 LoopState，因此下一次 agent submit 会继续写同一个文件。
   * 当前实时模型和权限模式继续沿用；被恢复会话里保存的 `modelId` 只作为历史信息展示。
   *
   * UI 侧选择“追加 converted history”而不是替换 messages：ChatInput 的 scrollback diff
   * 把 messages 当作 append-only，只有长度小于 writtenMessageCountRef 才触发清屏重绘。
   * 如果把 1 条消息直接替换成 6 条，diff 会指向错误 slice，用户可能看不到恢复内容。
   *
   * @param loaded 已从磁盘解析出的历史会话。
   */
  const resume = useCallback(
    (loaded: LoadedSession) => {
      // 旧会话的 pending 工具和流式缓冲不能带进恢复后的会话。
      pendingToolsRef.current.clear()
      resetBuffer()
      // hydrate 后的 LoopState 保留 sessionId/taskSlug，从而继续写同一个 jsonl。
      loopStateRef.current = hydrateLoopState(loaded, permissionModeRef.current)
      // core 消息模型转换为 CLI 展示模型。
      const converted = modelMessagesToDisplay(loaded.messages)
      setState((prev) => ({
        ...prev,
        // 清理旧会话的瞬态 UI 状态。
        activeToolCalls: [],
        shellOutput: '',
        error: null,
        todos: [],
        // 追加历史，而不是替换 scrollback。
        messages: [...prev.messages, ...converted],
        // /usage 展示恢复会话的累计用量。
        usage: { ...loaded.tokenUsage },
      }))
    },
    [resetBuffer],
  )

  /**
   * 读取当前会话可用于 `/rewind` 的 checkpoint 列表。
   *
   * 没有会话或尚无 checkpoint 时返回空数组。返回的是浅拷贝，
   * 调用方可以安全地构造 picker choices，不会别名到内存里的真实数组。
   *
   * @returns 当前 LoopState 中 checkpoint 的浅拷贝。
   */
  const getCheckpoints = useCallback((): CheckpointEntry[] => {
    return loopStateRef.current?.checkpoints.slice() ?? []
  }, [])

  /**
   * 回滚到某个 checkpoint：恢复工作区，并截断该点之后的消息历史。
   *
   * 调用方（App.tsx）负责从 `getCheckpoints()` 中选择 ckptId，并把结果提示显示出来。
   * 预条件失败时返回 ok=false 和可读 reason，调用方应通过 addInfoMessage 展示，而不是让 UI 抛错。
   *
   * 成功副作用：
   * - 工作区按 checkpoint manifest 回滚。
   * - `state.messages` 截断到 `messageCount - 1`，丢掉触发快照的用户消息及之后所有内容。
   * - 会话 jsonl 写入 compact-boundary 并重新 flush，让 `/resume` 看到同样的截断历史。
   * - display messages 数组变短，ChatInput 的 shrink detection 会清屏并重绘截断后的视图。
   *
   * @param ckptId 目标 checkpoint id。
   * @returns 成功时返回 checkpoint 预览和截断后消息数量；失败时返回原因。
   */
  const rewind = useCallback(
    async (
      ckptId: string,
    ): Promise<{ ok: true; preview: string; messageCount: number } | { ok: false; reason: string }> => {
      // 必须有当前 LoopState 才能知道 checkpoints 和会话历史。
      const ls = loopStateRef.current
      if (!ls) return { ok: false, reason: 'No active session to rewind.' }
      // 拒绝在一轮执行中回滚：写工具可能正在并发修改磁盘，强行回滚容易得到半恢复状态。
      if (state.isLoading) {
        return { ok: false, reason: 'A turn is in progress. Press Esc to cancel it, then run /rewind.' }
      }
      // 找到目标 checkpoint；找不到就返回可显示错误。
      const target = ls.checkpoints.find((c) => c.ckptId === ckptId)
      if (!target) return { ok: false, reason: `Checkpoint not found: ${ckptId}` }

      // 恢复工作区，并把 checkpoint 列表原地修剪到目标前缀。
      // restoreCheckpoint 失败时直接返回错误，不掩盖潜在的部分恢复问题。
      const ok = await restoreCheckpoint(ls, ckptId)
      if (!ok) {
        return { ok: false, reason: 'Failed to read checkpoint manifest — backups may have been cleaned up.' }
      }

      // 丢掉触发该快照的用户消息，以及之后模型产生的 assistant/tool 条目。
      const newLen = Math.max(0, target.messageCount - 1)
      ls.messages = ls.messages.slice(0, newLen)
      ls.persistedMessageCount = ls.messages.length

      // markBoundaryAndReflush 会写 compact-boundary 并重刷截断后的消息。
      // 它也会按压缩语义清空 checkpoints，所以先保存 surviving prefix，重刷后再逐条写回。
      const survivingCheckpoints = ls.checkpoints.slice()
      await markBoundaryAndReflush(ls)
      ls.checkpoints = survivingCheckpoints
      for (const c of survivingCheckpoints) {
        await appendCheckpoint(ls, c)
      }

      // 用截断后的会话重建 UI messages。长度变短会触发 ChatInput 清屏重绘，视觉语义类似 /clear。
      pendingToolsRef.current.clear()
      resetBuffer()
      const converted = modelMessagesToDisplay(ls.messages)
      setState((prev) => ({
        ...prev,
        activeToolCalls: [],
        shellOutput: '',
        error: null,
        todos: [],
        messages: converted,
      }))

      return { ok: true, preview: target.userPrompt, messageCount: newLen }
    },
    [resetBuffer, state.isLoading],
  )

  /**
   * 手动压缩当前上下文。
   *
   * @param onProgress 可选进度回调，供 slash command 在 UI 里显示当前阶段。
   * @returns 压缩前后 token 数；无会话或消息过少时返回 null。
   */
  const compact = useCallback(async (onProgress?: (description: string) => void) => {
    // 没有会话就没有可压缩的消息。
    if (!loopStateRef.current) return null
    // 动态 import 避免把估算工具提前拉进 CLI 初始路径。
    const { estimateTokenCount, KEEP_RECENT } = await import('@tegent/core')
    // 消息数量不超过保留窗口时无需压缩。
    if (loopStateRef.current.messages.length <= KEEP_RECENT) return null
    // 估算压缩前 token，方便用户看到压缩效果。
    const before = estimateTokenCount(loopStateRef.current.messages)
    onProgress?.('Summarizing conversation...')
    // core 负责真正摘要；这里直接替换 LoopState.messages。
    loopStateRef.current.messages = await compressMessages(loopStateRef.current.messages, modelRef.current)
    // 估算压缩后 token，并返回前后对比。
    const after = estimateTokenCount(loopStateRef.current.messages)
    return { beforeTokens: before, afterTokens: after }
  }, [])

  /**
   * 在运行中切换模型。
   *
   * @param newModelId 新模型 id，用于 options 和 UI 展示。
   * @param newModel 新模型实例，用于下一轮 agentLoop 调用。
   */
  const switchModel = useCallback((newModelId: string, newModel: LanguageModel) => {
    // ref 给业务逻辑读；state.modelId 给 UI 重绘。
    modelRef.current = newModel
    modelIdRef.current = newModelId
    setState((prev) => ({ ...prev, modelId: newModelId }))
  }, [])

  /**
   * 在运行中切换 extended-thinking。
   *
   * 下一轮 agent turn 会通过 `thinkingRef.current` 读取最新值。
   * 持久化由 App.tsx 的 slash command handler 负责，这个 hook 不做磁盘副作用。
   *
   * @param enabled 是否开启 thinking。
   */
  const setThinking = useCallback((enabled: boolean) => {
    thinkingRef.current = enabled
  }, [])

  /**
   * 读取当前 `/thinking` 开关。
   *
   * @returns 当前 thinking 是否开启。
   */
  const getThinking = useCallback(() => thinkingRef.current, [])

  /**
   * 丢弃缓存的 system prompt，让下一轮 agent turn 重新构建工具面和 plan overlay。
   *
   * systemPromptCache 是 agentLoop 在会话开始时构建的“工具列表 + plan overlay”快照，
   * 跨轮复用是为了保住 OpenAI-compatible providers 的稳定前缀缓存。
   * `/mcp refresh`、`/mcp auth <name>` 等会改变可见工具面的命令必须调用它。
   */
  const invalidateSystemPromptCache = useCallback(() => {
    if (loopStateRef.current) {
      loopStateRef.current.systemPromptCache = null
    }
  }, [])

  /**
   * 直接设置权限模式。
   *
   * 用于 `/plan` 这类用户明确指定目标模式的命令。它会同步更新 LoopState，
   * 让下一轮 agent turn 拿到新模式；同时清掉 systemPromptCache，
   * 让下一轮 prompt 使用正确的工具面和 plan overlay。
   *
   * @param next 目标权限模式。
   */
  const setPermissionMode = useCallback((next: PermissionMode) => {
    // 目标模式没变时不用触发任何 state 更新。
    if (permissionModeRef.current === next) return
    permissionModeRef.current = next
    if (loopStateRef.current) {
      loopStateRef.current.permissionMode = next
      loopStateRef.current.systemPromptCache = null
      // 离开 plan 模式时清掉当前 plan 文件路径。
      // 以后重新进入 plan 时，agentLoop/enterPlanMode 会基于新的用户消息懒生成 fresh slug。
      if (next !== 'plan') loopStateRef.current.currentPlanPath = null
    }
    // 镜像到 React state，让底部权限模式指示器立即重绘。
    setState((prev) => ({ ...prev, permissionMode: next }))
  }, [])

  /** 显示辅助函数：把 App/slash command 的提示、命令回显和结果统一追加成 DisplayMessage。 */
  const { addInfoMessage, addUserMessage, echoCommand, addCommandMessage, addCommandResult } =
    useAgentDisplayHelpers(appendMessage)

  // 对外暴露给 App.tsx/ChatInput.tsx 的完整控制面：state 用于渲染，函数用于驱动 core 或解析 UI 事件。
  return {
    state,
    submit,
    resolvePermission, // 解析队首权限请求
    resolveQuestion, // 解析当前 pendingQuestion
    abort,
    cleanup, // 保存会话并退出
    clear,
    compact, // 手动压缩上下文
    resume,
    rewind,
    getCheckpoints,
    getSessionInfo,
    switchModel,
    setThinking,
    getThinking,
    invalidateSystemPromptCache, // 清掉 system prompt cache
    setPermissionMode, // 直接设置权限模式
    addInfoMessage,
    addUserMessage,
    echoCommand, // 追加命令回显
    addCommandMessage, // 追加命令消息
    addCommandResult, // 追加命令结果
    askQuestion, // 弹出选择器问题
  }
}
