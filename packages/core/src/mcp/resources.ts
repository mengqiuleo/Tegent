// MCP resource 是服务器提供、模型可以按需读取的数据，例如文件系统
// 服务器暴露的文件、日志条目或数据库行。这里不把所有资源自动注入
// 对话（这样消耗 token，且大多数资源与当前任务无关），而是提供两个工具：
//
//   - listMcpResources({ server? }) — 枚举模型可以读取的 URI；
//   - readMcpResource({ uri }) — 按 URI 读取一个资源。
//
// 两个工具都不定义 `execute`，由 agent loop 的 processToolCalls
// 统一分发；具体见 tool-execution.ts 中的
// BYPASS_LOOP_GUARD_HANDLERS。只有存在 MCP registry 时，
// buildTools 才会把它们加入系统提示词。
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
