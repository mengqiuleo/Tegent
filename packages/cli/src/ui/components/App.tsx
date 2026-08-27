// 交互式 TUI 的根组件：只负责「提交分发（斜杠命令 vs agentLoop）+ Ctrl+C/Esc 处理 + 渲染 ChatInput」。
// 权限弹窗、模型切换等交互后续在这里扩展。
import { useCallback, useEffect, useRef, useState } from 'react'

import { useApp } from 'ink'

import type { AgentOptions, LanguageModel } from '@tegent/core'

import { useAgent } from '../hooks/use-agent.js'
import { handleSlashCommand } from '../slash-commands.js'
import type { CliSession } from '../slash-commands.js'
import { ChatInput } from './ChatInputInk.js'

interface AppProps {
  model: LanguageModel
  options: AgentOptions
  /** 会话注册表容器（skill / plugin / MCP），斜杠命令在这里原地更新。 */
  session: CliSession
  initialPrompt?: string | undefined
  /** 注册退出清理函数（保存会话），供 Ink 卸载后的收尾路径调用。 */
  onCleanupReady?: (fn: () => Promise<void>) => void
}

export function App({ model, options, session, initialPrompt, onCleanupReady }: AppProps) {
  const { exit } = useApp()
  const { state, question, submit, abort, cleanup, pushSystemMessage, answerQuestion } =
    useAgent(model, options)

  // 输入框下方的临时提示；目前只用于 “Press Ctrl+C again to exit” 双击退出提醒。
  const [notice, setNotice] = useState<string | null>(null)
  // 最近一次 Ctrl+C 的时间戳：2 秒窗口内第二次按下才真正退出。
  const ctrlCArmedAtRef = useRef(0)
  const ctrlCArmWindowMs = 2000
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // arm window 过期后自动清除 notice。
  useEffect(() => {
    if (!notice) return
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), ctrlCArmWindowMs)
    return () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = null
      }
    }
  }, [notice])

  // 注册清理函数，供外层收尾调用。
  useEffect(() => {
    onCleanupReady?.(cleanup)
  }, [cleanup, onCleanupReady])

  // 挂载时自动提交初始提示词（`tegent 做点什么` 的入口路径）。
  useEffect(() => {
    if (initialPrompt) {
      void submit(initialPrompt)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 处理 Ctrl+C：空闲时单击提示、双击退出；加载中时单击中断当前 turn。
   */
  const handleCtrlC = useCallback(() => {
    const now = Date.now()
    const armed = now - ctrlCArmedAtRef.current < ctrlCArmWindowMs
    if (armed) {
      // 窗口期内第二次按下，确认退出；exit 触发 Ink 卸载，收尾交给 index.ts。
      exit()
      return
    }
    ctrlCArmedAtRef.current = now
    if (state.isLoading) {
      abort()
    }
    setNotice('Press Ctrl+C again to exit')
  }, [exit, abort, state.isLoading])

  /** 提交用户输入：以 / 开头走斜杠命令层，其余直接进 agentLoop。 */
  const handleSubmit = useCallback(
    (text: string) => {
      if (text.startsWith('/')) {
        void handleSlashCommand(text, {
          session,
          print: pushSystemMessage,
          submitToAgent: (content) => {
            void submit(content, { echo: false })
          },
        })
        return
      }
      void submit(text)
    },
    [session, pushSystemMessage, submit],
  )

  return (
    <ChatInput
      messages={state.messages}
      onSubmit={handleSubmit}
      onInterrupt={handleCtrlC}
      onEscapeCancel={abort}
      isLoading={state.isLoading}
      notice={notice}
      errorMessage={state.error}
      question={question}
      onAnswer={answerQuestion}
    />
  )
}
