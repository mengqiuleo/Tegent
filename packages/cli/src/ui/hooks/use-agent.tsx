// useAgent：把 core 的命令式 agentLoop 包成 React 可订阅的状态。
// 这是 UI 层和 agent 引擎之间唯一的桥——UI 组件不直接碰 LoopState。
// 权限确认、计划审批、askUser 都以「挂起问题 + Promise」的形式对接真实 UI。
import { useCallback, useRef, useState } from 'react'

import { agentLoop, saveSession } from '@tegent/core'
import type { AgentOptions, LanguageModel, LoopState, PermissionMode, TodoItem } from '@tegent/core'

/** UI 直接渲染的消息形状：user 输入、assistant 输出、tool 事件行、system 命令输出。 */
export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
}

/**
 * 挂起中的交互问题：权限确认 / 计划审批 / askUser。
 * core 的 processToolCalls 是串行 for 循环，同一时间最多挂起一个问题。
 */
export type PendingQuestion =
  | { id: string; kind: 'permission'; toolName: string; input: Record<string, unknown> }
  | { id: string; kind: 'plan'; planText: string }
  | { id: string; kind: 'askUser'; question: string; options?: { label: string; description: string }[] }

export interface AgentUiState {
  messages: DisplayMessage[]
  isLoading: boolean
  error: string | null
}

// 展示消息的自增 id；进程内唯一即可。
let nextId = 0

export function useAgent(model: LanguageModel, options: AgentOptions) {
  const [state, setState] = useState<AgentUiState>({
    messages: [],
    isLoading: false,
    error: null,
  })

  // 会话状态在多次提交之间复用，对应 agentLoop 的 existingState 参数。
  const loopStateRef = useRef<LoopState | null>(null)
  // 模型可能被热替换，用 ref 保证进行中的循环读到最新值。
  const modelRef = useRef(model)
  // 每次提交一个 AbortController，Esc 中断时触发。
  const abortRef = useRef<AbortController | null>(null)
  // 当前正在积累的 assistant 消息 id：text delta 都追加到它上面。
  const assistantIdRef = useRef<string | null>(null)

  // 挂起中的交互问题及其 resolver。串行工具保证最多一个，单个 ref 就够。
  const [question, setQuestion] = useState<PendingQuestion | null>(null)
  const questionResolverRef = useRef<((answer: string) => void) | null>(null)

  /** 挂起一个问题并等待 UI 回答；答案统一用字符串编码（'yes'/'approve'/自由文本…）。 */
  const waitForAnswer = (q: PendingQuestion) =>
    new Promise<string>((resolve) => {
      questionResolverRef.current = resolve
      setQuestion(q)
    })

  /** UI 的回答入口：先摘掉 resolver 再放行 Promise，重复回答天然变 no-op。 */
  const answerQuestion = useCallback((value: string) => {
    const resolve = questionResolverRef.current
    questionResolverRef.current = null
    setQuestion(null)
    resolve?.(value)
  }, [])

  /** 追加一条消息；id 在 updater 外生成，保持 updater 纯净。 */
  const pushMessage = useCallback((role: DisplayMessage['role'], content: string) => {
    nextId += 1
    const id = `${role}-${nextId}`
    setState((s) => ({ ...s, messages: [...s.messages, { id, role, content }] }))
    return id
  }, [])

  /** 追加一个 tool 事件行。 */
  const pushToolLine = useCallback(
    (line: string) => {
      pushMessage('tool', line)
    },
    [pushMessage],
  )

  /** 斜杠命令输出通道：往消息区追加一条 system 行。 */
  const pushSystemMessage = useCallback(
    (content: string) => {
      pushMessage('system', content)
    },
    [pushMessage],
  )

  // agentLoop 的回调只依赖 setState / ref，天然稳定。
  const callbacks = {
    onTextDelta: (text: string) => {
      const id = assistantIdRef.current ?? pushMessage('assistant', '')
      assistantIdRef.current = id
      setState((s) => ({
        ...s,
        messages: s.messages.map((m) => (m.id === id ? { ...m, content: m.content + text } : m)),
      }))
    },

    onToolCall: (_id: string, name: string, input: Record<string, unknown>) => {
      pushToolLine(`[tool-call] ${name} ${JSON.stringify(input)}`)
    },

    onToolResult: (_id: string, result: string, isError?: boolean) => {
      pushToolLine(`[tool-result${isError ? ' ERROR' : ''}] ${result.slice(0, 300)}`)
    },

    // 下面的回调目前没有对应 UI，先留空占位。
    onToolProgress: () => {},
    onShellOutput: () => {},
    onUsageUpdate: () => {},

    onContextCompressed: (summary: string) => {
      pushToolLine(`[compressed] ${summary.slice(0, 120)}`)
    },

    onError: (error: Error) => {
      setState((s) => ({ ...s, error: error.message }))
    },

    onMemoryWrite: (notice: string) => {
      pushToolLine(`[memory] ${notice}`)
    },

    // 权限确认：trust 模式直接放行；否则挂起问题等用户在弹层里选择。
    // 'always' 的会话规则持久化由 core 的 checkPermission 内部处理，这里只回传选择。
    onAskPermission: async (
      toolCall: { toolCallId: string; toolName: string; input: Record<string, unknown> },
    ): Promise<'yes' | 'always' | 'no'> => {
      if (options.trustMode) return 'yes'
      nextId += 1
      const answer = await waitForAnswer({
        id: `question-${nextId}`,
        kind: 'permission',
        toolName: toolCall.toolName,
        input: toolCall.input,
      })
      // 未知答案（包括 abort 注入的）一律按拒绝处理。
      const normalized: 'yes' | 'always' | 'no' = answer === 'yes' || answer === 'always' ? answer : 'no'
      pushToolLine(`[permission] ${toolCall.toolName} → ${normalized}`)
      return normalized
    },

    // askUser：有候选走选择列表，没有候选复用输入框自由输入。
    onAskUser: async (question: string, choices?: { label: string; description: string }[]) => {
      nextId += 1
      return waitForAnswer({
        id: `question-${nextId}`,
        kind: 'askUser',
        question,
        // exactOptionalPropertyTypes：候选存在才带 options 字段。
        ...(choices && choices.length > 0 ? { options: choices } : {}),
      })
    },

    // 计划审批：挂起计划正文等用户批准或驳回；'approve' 之外的一律视为驳回。
    onPlanApprovalRequest: async (planText: string) => {
      nextId += 1
      const answer = await waitForAnswer({ id: `question-${nextId}`, kind: 'plan', planText })
      const approved = answer === 'approve'
      pushToolLine(`[plan] ${approved ? 'approved' : 'rejected'}`)
      return approved
    },

    onPlanModeChange: (mode: PermissionMode) => {
      pushToolLine(`[plan-mode] ${mode}`)
    },

    onTodosUpdate: (_todos: TodoItem[]) => {},
  }

  /**
   * 提交一次用户输入，跑一轮 agentLoop。
   * echo: false 供 /<skillname> 激活路径使用——注入的 skill 正文直接进模型上下文，
   * 不在消息区回显（激活提示由斜杠命令层自己 print）。
   */
  const submit = useCallback(
    async (text: string, opts?: { echo?: boolean }) => {
      if (!text.trim()) return
      // 新一轮从一条全新的 assistant 消息开始积累。
      assistantIdRef.current = null
      setState((s) => ({ ...s, error: null }))
      if (opts?.echo !== false) pushMessage('user', text)

      const controller = new AbortController()
      abortRef.current = controller
      setState((s) => ({ ...s, isLoading: true }))
      try {
        const { state: loop } = await agentLoop(
          text,
          modelRef.current,
          { ...options, abortSignal: controller.signal },
          callbacks,
          loopStateRef.current ?? undefined,
        )
        loopStateRef.current = loop
      } finally {
        setState((s) => ({ ...s, isLoading: false }))
      }
    },
    // callbacks 每次渲染都是新对象字面量，但它只闭包稳定的 setState/ref，行为等价。
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )

  /** 中断当前 turn（Esc/Ctrl+C）：先把挂起的问题按保守答案放行——
   *  否则 agentLoop 在 onAskPermission 上的 await 会永远悬空——再触发 abort。
   *  core 在权限问答返回后会自查 abortSignal，补上 interrupted 结果。 */
  const abort = useCallback(() => {
    answerQuestion('no')
    abortRef.current?.abort()
  }, [answerQuestion])

  /** 退出前保存会话（core 的 session store 目前是空实现，保留调用对接将来持久化）。 */
  const cleanup = useCallback(async () => {
    if (loopStateRef.current) await saveSession(loopStateRef.current, modelRef.current)
  }, [])

  return { state, question, submit, abort, cleanup, pushSystemMessage, answerQuestion }
}
