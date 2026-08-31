// 这里提供五种 App 的 slash command 处理器常用的消息追加形态。
// 使用子 hook 而不是普通函数，是因为每个返回函数都由 useCallback 创建，
// 下游消费者依赖这些函数稳定的 memo identity 来避免不必要的更新。
import { useCallback } from 'react' 

import type { DisplayMessage } from '@tegent/core'

/**
 * 创建一组向 UI 回滚区追加消息的辅助函数。
 *
 * @param appendMessage - 底层消息追加函数，会把 `DisplayMessage` 写入展示状态。
 * @returns 用于追加普通消息、命令回显和命令结果的稳定回调集合。
 */
export function useAgentDisplayHelpers(appendMessage: (msg: DisplayMessage) => void) {
  const addMessage = useCallback(
    (role: 'user' | 'assistant', content: string) => {
      appendMessage({
        id: Date.now().toString(),
        role,
        content,
        timestamp: Date.now(),
      })
    },
    [appendMessage],
  )

  /**
   * 追加一条系统或信息类消息。
   *
   * @param content - 要展示的消息正文。
   * @returns 无返回值。
   *
   * slash command 的说明性输出复用 assistant 角色展示。
   */
  const addInfoMessage = useCallback((content: string) => addMessage('assistant', content), [addMessage])

  /**
   * 向历史记录追加一条用户消息。
   *
   * @param content - 要展示的用户消息正文。
   * @returns 无返回值。
   *
   * 主要用于回显 slash command，保持用户输入在回滚区可见。
   */
  const addUserMessage = useCallback((content: string) => addMessage('user', content), [addMessage])

  /**
   * 以紧凑的 `❯ /cmd` 行回显一条 slash command。
   *
   * @param content - 要回显的命令文本。
   * @returns 无返回值。
   *
   * 这个形态不会产生尾随空行。
   * 后续可搭配 `addCommandResult` 追加紧凑的 `⎿  result` 结果行。
   */
  const echoCommand = useCallback(
    (content: string) => {
      appendMessage({
        id: `cmd-${Date.now()}`,
        role: 'user', 
        content, 
        timestamp: Date.now(),
        kind: 'command-echo',
      })
    },
    [appendMessage],
  )

  /**
   * 渲染一条 slash command 及其短结果。
   *
   * @param commandText - 要回显的命令文本。
   * @param resultText - 命令对应的单行或短结果文本。
   * @returns 无返回值。
   *
   * 输出会形成类似 Claude 风格的两行块：
   *
   * ```text
   * > /cmd
   *   ⎿  result
   * ```
   *
   * 适合单行命令响应。
   * 对 `/help`、`/usage`、`/init` 这类较长多行输出，应直接使用 `addUserMessage` 和 `addInfoMessage`。
   */
  const addCommandMessage = useCallback(
    (commandText: string, resultText: string) => {
      const base = Date.now() 
      appendMessage({
        id: `cmd-${base}`, 
        role: 'user', 
        content: commandText, 
        timestamp: base, 
        kind: 'command-echo',
      })
      appendMessage({
        id: `cmd-res-${base}`, 
        role: 'assistant',
        content: resultText,
        timestamp: base, 
        kind: 'command-result', 
      })
    },
    [appendMessage],
  )

  /**
   * 在最近一次命令回显下方追加额外的 `⎿  result` 结果行。
   *
   * @param content - 要追加的结果文本。
   * @returns 无返回值。
   *
   * 这个函数不会再次回显命令。
   * 它适合 `/mcp refresh` 这类多步骤 slash command：
   * 一次用户输入会产生一个随着异步流程逐步补全的紧凑结果块。
   *
   * ```text
   * > /mcp refresh
   *   ⎿  Re-reading MCP config and reconnecting servers...   (addCommandMessage)
   *   ⎿  Reloaded MCP — added: github; reconnected: weather. (addCommandResult)
   * ```
   *
   * 如果后续结果使用 `addInfoMessage`，每段都会被渲染成独立 assistant 块，
   * 块前后会带空行，导致下一个提示符前额外塞入三行以上空白。
   */
  const addCommandResult = useCallback(
    (content: string) => {
      const base = Date.now() 
      appendMessage({
        id: `cmd-res-${base}`,
        role: 'assistant',
        content, 
        timestamp: base,
        kind: 'command-result', // 标记为命令结果样式，渲染为紧凑 `⎿` 行。
      })
    },
    [appendMessage],
  )

  return { addInfoMessage, addUserMessage, echoCommand, addCommandMessage, addCommandResult }
}
