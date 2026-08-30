// 这个模块从 useAgent 中拆出，用一个小型子 hook 包装 `appendMessage`。
// `appendMessage` 是会触发 setState 更新的底层追加函数。
// 这里提供五种 App 的 slash command 处理器常用的消息追加形态。
// 使用子 hook 而不是普通函数，是因为每个返回函数都由 useCallback 创建，
// 下游消费者依赖这些函数稳定的 memo identity 来避免不必要的更新。
import { useCallback } from 'react' // 导入 React 的 useCallback，用来稳定回调函数引用。

import type { DisplayMessage } from '@tegent/core' // 导入 UI 展示消息类型，只在类型检查阶段使用。

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
        id: Date.now().toString(), // 使用当前时间戳生成简单消息 id。
        role, // 保留调用方传入的消息角色。
        content, // 保留调用方传入的消息正文。
        timestamp: Date.now(), // 用当前时间记录消息时间戳。
      })
    },
    [appendMessage], // 当底层追加函数变化时，重新创建包装回调。
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
        id: `cmd-${Date.now()}`, // 用命令前缀和时间戳生成命令回显 id。
        role: 'user', // 命令回显属于用户输入。
        content, // 保存原始命令文本。
        timestamp: Date.now(), // 记录回显生成时间。
        kind: 'command-echo', // 标记为命令回显，供渲染层使用紧凑样式。
      })
    },
    [appendMessage], // 依赖底层追加函数，保持闭包中的函数是最新的。
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
      const base = Date.now() // 复用同一个时间戳，让命令和结果拥有相邻且稳定的 id。
      appendMessage({
        id: `cmd-${base}`, // 生成命令回显消息 id。
        role: 'user', // 命令本身作为用户消息展示。
        content: commandText, // 保存命令文本。
        timestamp: base, // 命令消息使用共享时间戳。
        kind: 'command-echo', // 标记为命令回显样式。
      })
      appendMessage({
        id: `cmd-res-${base}`, // 生成与命令同批次的结果消息 id。
        role: 'assistant', // 命令结果作为 assistant 输出展示。
        content: resultText, // 保存结果文本。
        timestamp: base, // 结果消息使用同一个时间戳，保持排序紧邻。
        kind: 'command-result', // 标记为命令结果样式。
      })
    },
    [appendMessage], // appendMessage 变化时重新创建回调。
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
      const base = Date.now() // 用当前时间戳生成本条结果的唯一 id。
      appendMessage({
        id: `cmd-res-${base}`, // 生成命令结果消息 id。
        role: 'assistant', // 命令结果属于 assistant 输出。
        content, // 保存结果正文。
        timestamp: base, // 记录结果生成时间。
        kind: 'command-result', // 标记为命令结果样式，渲染为紧凑 `⎿` 行。
      })
    },
    [appendMessage], // 依赖底层追加函数，确保调用最新实现。
  )

  return { addInfoMessage, addUserMessage, echoCommand, addCommandMessage, addCommandResult } // 暴露所有展示辅助回调。
}
