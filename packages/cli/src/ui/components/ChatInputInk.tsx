// 最小版 ChatInput：只做「消息区 + 输入框」两件事。
// 键盘只处理最基础的输入、退格、左右移动、Enter 提交、Esc 中断、Ctrl+C。
// 输入历史、补全、权限弹窗等交互后续在这里扩展。
import { useState } from 'react'

import { Box, Text, useInput, useStdin } from 'ink'

import type { DisplayMessage } from '../hooks/use-agent.js'

/** 最多直接渲染的历史消息数量，避免长会话把输入框挤出屏幕。 */
const MAX_VISIBLE_MESSAGES = 30

interface ChatInputProps {
  /** 滚动区消息。 */
  messages: readonly DisplayMessage[]
  /** 提交入口；App 在这里调用 useAgent.submit。 */
  onSubmit: (text: string) => void
  /** Ctrl+C 入口；App 负责双击退出判定。 */
  onInterrupt: () => void
  /** loading 时 Esc 的取消入口。 */
  onEscapeCancel?: () => void
  /** 当前是否有 agent turn 在执行。 */
  isLoading?: boolean
  /** 输入框下方的短提示。 */
  notice?: string | null
  /** 错误提示。 */
  errorMessage?: string | null
}

/** 根据消息角色生成左侧短标签。 */
function renderLabel(msg: DisplayMessage): string {
  if (msg.role === 'user') return 'you'
  if (msg.role === 'tool') return 'tool'
  return 'assistant'
}

/** 渲染一条消息：标签一行 + 正文逐行。 */
function MessageBlock({ msg }: { msg: DisplayMessage }) {
  const label = renderLabel(msg)
  const labelColor = msg.role === 'user' ? 'cyan' : msg.role === 'tool' ? 'gray' : undefined
  const lines = msg.content.length > 0 ? msg.content.trimEnd().split('\n') : []

  if (lines.length === 0) return null

  return (
    <Box flexDirection="column" marginBottom={1}>
      {labelColor ? (
        <Text color={labelColor}>{label}</Text>
      ) : (
        <Text>{label}</Text>
      )}
      {lines.map((line, idx) => (
        <Text key={`${msg.id}-line-${idx}`}>{line}</Text>
      ))}
    </Box>
  )
}

export function ChatInput({
  messages,
  onSubmit,
  onInterrupt,
  onEscapeCancel,
  isLoading = false,
  notice,
  errorMessage,
}: ChatInputProps) {
  // 单行输入：文本 + 光标位置，光标渲染为反色字符。
  const [text, setText] = useState('')
  const [cursor, setCursor] = useState(0)
  // 非 TTY（管道/重定向）下 stdin 不支持 raw mode，useInput 必须停用，
  // 否则 Ink 会直接抛错；此时输入框只读，仍能渲染消息流。
  const { isRawModeSupported } = useStdin()

  useInput((input, key) => {
    // Ctrl+C：App 负责第一次取消、第二次退出。
    if ((key.ctrl && input.toLowerCase() === 'c') || input === '\x03') {
      onInterrupt()
      return
    }

    if (key.return) {
      const trimmed = text.trim()
      if (trimmed && !isLoading) {
        onSubmit(trimmed)
        setText('')
        setCursor(0)
      }
      return
    }

    if (key.escape) {
      if (isLoading && onEscapeCancel) onEscapeCancel()
      return
    }

    if (key.backspace || key.delete) {
      setText((t) => t.slice(0, Math.max(0, cursor - 1)) + t.slice(cursor))
      setCursor((c) => Math.max(0, c - 1))
      return
    }

    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1))
      return
    }

    if (key.rightArrow) {
      setCursor((c) => Math.min(text.length, c + 1))
      return
    }

    // 普通文本插入光标处；过滤掉控制字符。
    if (input && !key.ctrl && !key.meta && !key.escape && !key.tab && !key.return) {
      setText((t) => t.slice(0, cursor) + input + t.slice(cursor))
      setCursor((c) => c + input.length)
    }
  // 注意：非 TTY 下 stdin.isTTY 是 undefined 而不是 false，
  // 而 Ink 内部用 `isActive === false` 严格判断，undefined 会穿透并触发 setRawMode 崩溃，
  // 所以这里必须归一成真正的布尔值。
  }, { isActive: isRawModeSupported === true })

  return (
    <Box flexDirection="column">
      {/* 消息区：只渲染尾部一段，避免巨量消息撑爆动态区域。 */}
      <Box flexDirection="column">
        {messages.slice(-MAX_VISIBLE_MESSAGES).map((msg) => (
          <MessageBlock key={msg.id} msg={msg} />
        ))}
      </Box>

      {/* 错误提示。 */}
      {errorMessage ? <Text color="red">Error: {errorMessage}</Text> : null}

      {/* agent 执行中显示 spinner 提示。 */}
      {isLoading ? <Text color="gray">Thinking...</Text> : null}

      {/* 主输入框：光标前文本、反色光标字符、光标后文本分三段渲染。 */}
      <Box borderStyle="single" borderColor={isLoading ? 'gray' : 'cyan'} paddingX={1}>
        <Text color="cyan">› </Text>
        <Text>{text.slice(0, cursor)}</Text>
        <Text inverse>{text[cursor] ?? ' '}</Text>
        <Text>{text.slice(cursor + 1)}</Text>
      </Box>

      {/* 底部短提示，目前只用于 “Press Ctrl+C again to exit”。 */}
      {notice ? <Text color="yellow">{notice}</Text> : null}
    </Box>
  )
}
