// pushToolResult 的独立落点：把一次工具结果同时写进会话转录和 UI 回调。
// 之前它定义在 tool-execution.ts 里、plan-tools 的处理器又以参数形式引用它，
// 单独成文件后处理器可以直接把它作为参数默认值，测试无需手工注入。
import type { AgentCallbacks } from '../types/index.js'
import type { LoopState } from './loop-state.js'
import { toolResultMessage } from './messages.js'
import { clearProgressReporter } from '../tools/progress.js'

/** 把工具结果落到转录（tool-result 消息）并转发给 UI，同时清掉该调用的进度汇报。 */
export function pushToolResult(
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError = false,
): void {
  state.messages.push(toolResultMessage(toolCallId, toolName, output))
  clearProgressReporter(toolCallId)
  callbacks.onToolResult(toolCallId, output, isError)
}

export type PushToolResult = typeof pushToolResult
