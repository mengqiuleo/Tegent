//   1. 将每个 McpToolEntry 转换成 AI SDK 的 `tool({...})` 定义，
//      让 streamText() 可以和内置工具一起把它们提供给模型；
//   2. 截断服务器提供的过长描述，避免系统提示词和工具列表膨胀。
//
// 这些工具故意不定义 `execute`。AI SDK 会把模型发出的 tool_call
// 放入 result.toolCalls，再由 processToolCalls 手动分发。
// 这样每个 MCP 调用都能经过统一的权限检查和循环保护逻辑，
// 与 shell、writeFile、edit 的处理路径一致。
import { jsonSchema, tool } from 'ai'

import type { McpToolEntry } from './types.js'

/**
 * 单个工具在模型侧允许使用的描述最大字符数。
 *
 * 200 个字符足够说明工具用途；部分 MCP 服务器会把多段文档直接塞进
 * description，若不限制会扩大系统提示词并消耗提示词缓存窗口。
 * 截断后追加省略号，让模型知道描述不完整，也方便服务器作者在
 * `/mcp tools` 中发现自己的描述过长。
 */
const DESCRIPTION_MAX_CHARS = 200

export function truncateDescription(input: string): string {
  if (input.length <= DESCRIPTION_MAX_CHARS) return input
  // 预留一个字符给省略号，确保返回值仍不超过上限。
  return input.slice(0, DESCRIPTION_MAX_CHARS - 1) + '…'
}

/**
 * 把一个 MCP 工具适配成 AI SDK Tool。
 *
 * 不提供 execute，由 tool-execution 负责人工分发和权限控制。
 * 输入 schema 直接作为 JSON Schema 传入；AI SDK 已经通过
 * `jsonSchema(...)` 原生支持这种格式，不需要先转换成 Zod。
 *
 * @param entry 已完成名称转换的 MCP 工具条目。
 * @returns 可传给 AI SDK 的工具定义。
 */
export function bridgeMcpTool(entry: McpToolEntry) {
  return tool({
    description: truncateDescription(entry.description || `MCP tool from ${entry.serverName}`),
    // jsonSchema() 将 MCP 返回的 JSON Schema 包装成 tool() 所需的
    // Schema 实例。MCP 协议要求服务器返回合法 JSON Schema，因此这里
    // 不再做额外预处理。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: jsonSchema(entry.inputSchema as any),
    // 不设置 execute；调用由 tool-execution.ts 手动分发，
    // 以便经过权限和循环保护。
  })
}

/**
 * 构造适合放入系统提示词的 MCP 工具视图。
 *
 * 只保留模型侧名称、所属服务器和截断后的短描述，
 * 由 system-prompt.ts 渲染成 `## MCP Tools` 部分。
 *
 * @param entries MCP 工具条目列表。
 * @returns 用于系统提示词渲染的轻量对象列表。
 */
export function toSystemPromptEntries(entries: readonly McpToolEntry[]) {
  return entries.map((e) => ({
    callableName: e.callableName,
    serverName: e.serverName,
    description: truncateDescription(e.description),
  }))
}
