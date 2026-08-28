import type { TokenUsage } from '../../types/index.js'

/** 一个可注册的子代理定义。
 *
 * 子代理定义来自三类来源：内置、用户目录、项目目录。
 * 插件贡献的 agent 会在 loader 阶段折叠成同样结构，只是额外带 pluginId。 */
export interface SubAgentDefinition {
  // 子代理名称，也是 task 工具里的 subagent_type。
  name: string
  // 给父模型看的短描述，用于帮助它选择哪个子代理。
  description: string
  /** Markdown 正文，也就是该子代理的系统提示词主体。 */
  prompt: string
  /** 允许调用的工具列表。省略时使用默认只读工具集合。`'*'` 表示允许所有工具。 */
  tools?: string[]
  /** 显式禁止的工具列表，会在 tools 允许列表之后再应用。 */
  disallowedTools?: string[]
  /** 模型覆盖，例如 "anthropic:claude-sonnet-4-6"。省略时继承父代理模型。 */
  model?: string
  /** 子代理最多 agentic turn 数，超过后强制停止。 */
  maxTurns: number
  /** 禁止的 shell 命令关键字。只有 shell 在 tools 中可用时才有意义。 */
  shellRestrictions?: string[]
  /** 定义来源：内置、用户级或项目级。 */
  source: 'built-in' | 'user' | 'project'
  /** 当子代理来自插件贡献时，记录所属插件 id，格式通常是 `name@marketplace`。 */
  pluginId?: string
}

/** 子代理执行轨迹的简化结构。
 *
 * 主要用于调试、展示和未来审计；父 agent 只拿最终结果，不直接混入子代理内部消息。 */
export interface SubAgentTrace {
  toolCalls: Array<{
    toolName: string
    input: unknown
    result: string
    durationMs: number
    isError: boolean
  }>
  finalText: string
  tokenUsage: TokenUsage
  turnCount: number
}

/** 子代理运行过程中向父 UI 冒泡的事件。
 *
 * 这些事件只用于展示折叠/展开的 task 区块，不会把子代理消息直接写进父 LoopState。 */
export type SubAgentEvent =
  | { kind: 'start'; toolCallId: string; agentName: string; description: string; prompt: string }
  | { kind: 'tool-call'; toolCallId: string; subToolName: string; subInput: unknown }
  | {
      kind: 'tool-result'
      toolCallId: string
      subToolName: string
      resultPreview: string
      durationMs: number
      isError: boolean
    }
  | { kind: 'text-delta'; toolCallId: string; delta: string }
  | {
      kind: 'end'
      toolCallId: string
      finalText: string
      tokenUsage: TokenUsage
      turnCount: number
      durationMs: number
      aborted: boolean
    }
