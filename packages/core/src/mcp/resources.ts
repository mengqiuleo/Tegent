// MCP 服务器除了提供可调用的"工具"（tool），还可以提供"资源"（resource）：
// 一批用 URI 标识、模型可以按需读取的数据，例如服务器暴露的文件内容、
// 日志条目、数据库的若干行。
//
// 本文件为资源声明两个内建工具，让模型按需"拉取"，而不是把资源全量注入
// 对话（资源可能又多又大，且大多数与当前任务无关，全量注入纯属浪费 token）：
//
//   - listMcpResources({ server? }) — 列出可读的资源及其 URI，可按服务器过滤；
//   - readMcpResource({ uri }) — 用 list 得到的 URI 读取一个资源的内容。
//
// 这两个工具只有"声明"（名字 + 参数 schema + 给模型看的 description），
// 没有 execute。没有 execute 的工具 AI SDK 不会在本地执行，模型的调用请求
// 会被留在 result.toolCalls 里，交给 agent loop 的 processToolCalls 统一分发，
// 落到 tool-execution.ts 里的真正实现 handleListMcpResources /
// handleReadMcpResource（登记在 BYPASS_LOOP_GUARD_HANDLERS 中：列资源只读
// 本地 registry 缓存、读资源没有本地副作用，所以允许它们跳过针对
// writeFile/edit/shell 的 loop guard 和权限流水线）。
//
// 注册时机见 loop.ts：只有配置了 MCP registry 时才会把这两个工具加入
// 工具列表——一个 MCP 服务器都没有时，模型无从列举资源，注册了也没意义。
// 执行工具：handleListMcpResources，handleReadMcpResource
import { tool } from 'ai'

import { z } from 'zod'

export const listMcpResources = tool({
  description: `List resources exposed by connected MCP servers.

Output one resource per line: "<uri>\t[<server>] <name> (<mimeType>)" with a description on the next indented line when present.

Use this BEFORE readMcpResource so you have a URI to read. If the model already knows the URI (e.g. from a previous list call), readMcpResource directly is fine.`,
  inputSchema: z.object({
    server: z
      .string()
      .optional()
      .describe('Optional server name to filter by. Omit to list resources from all servers.'),
  }),
})

export const readMcpResource = tool({
  description: `Read the contents of an MCP resource by its URI.

URIs come from listMcpResources. Text resources return their text directly; binary resources surface a one-line marker noting the omitted content.`,
  inputSchema: z.object({
    uri: z.string().describe('The resource URI to read, as returned by listMcpResources.'),
  }),
})
