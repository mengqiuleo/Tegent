// useAgent：把 core 的命令式 agentLoop 包成 React 可订阅的状态。
// 这是 UI 层和 agent 引擎之间唯一的桥——UI 组件不直接碰 LoopState。
// 权限问答、工具调用展示等交互只留了最小占位，后续在这里扩展。
import { useCallback, useRef, useState } from 'react'

import { agentLoop, saveSession } from '@tegent/core'
import type { AgentOptions, LanguageModel, LoopState, PermissionMode, TodoItem } from '@tegent/core'

/** UI 直接渲染的消息形状：user 输入、assistant 输出、tool 事件行。 */
export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
}

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

    // 权限问答占位：trust 模式直接放行，否则直接拒绝。
    // TODO: 换成真正的权限确认 UI 时，在这里弹窗并等待用户选择。
    onAskPermission: async () => (options.trustMode ? 'yes' : 'no'),

    // askUser 占位：还没有交互式选择 UI，回显问题让模型至少拿到确定回复。
    // TODO: 接入输入组件后，把 options 渲染成候选列表并等待用户选择。
    onAskUser: async (question: string) => `(no interactive input yet) ${question}`,

    // 计划审批占位：先直接批准，让 exitPlanMode 流程能走通。
    // TODO: 接入计划展示 UI 后，展示 planText 并等待用户批准或驳回。
    onPlanApprovalRequest: async (_planText: string) => true,

    onPlanModeChange: (_mode: PermissionMode) => {},

    onTodosUpdate: (_todos: TodoItem[]) => {},
  }

  /**
   * 提交一次用户输入，跑一轮 agentLoop。
   */
  const submit = useCallback(
    async (text: string) => {
      if (!text.trim()) return
      // 新一轮从一条全新的 assistant 消息开始积累。
      assistantIdRef.current = null
      setState((s) => ({ ...s, error: null }))

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

  /** 中断当前 turn（Esc）。 */
  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  /** 退出前保存会话（core 的 session store 目前是空实现，保留调用对接将来持久化）。 */
  const cleanup = useCallback(async () => {
    if (loopStateRef.current) await saveSession(loopStateRef.current, modelRef.current)
  }, [])

  return { state, submit, abort, cleanup }
}
