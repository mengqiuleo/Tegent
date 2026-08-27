/** 基于 stdio 的 MCP 服务器，即本地子进程。 */
export interface McpStdioServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** 首次连接超时时间，单位为毫秒，默认 30_000。 */
  timeout?: number
  /** 默认值为 true；设为 false 时完全跳过该服务器。 */
  enabled?: boolean
}

/** 基于可流式 HTTP 传输的 MCP 服务器，即远程服务器。 */
export interface McpHttpServerConfig {
  url: string
  /** 附加到每个请求的静态请求头，例如 `X-Custom: foo`。
   *  OAuth 的 `Authorization: Bearer ...` 会自动添加；
   *  不要把 access token 写在这里，应通过 OAuth 流程保存。 */
  headers?: Record<string, string>
  timeout?: number
  enabled?: boolean
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

/**
 * 判断配置是否为 stdio 服务器。
 *
 * @param c 待判断的 MCP 配置。
 * @returns 若存在 `command` 字段则返回 `true`。
 */
export function isStdioConfig(c: McpServerConfig): c is McpStdioServerConfig {
  return 'command' in c
}
/**
 * 判断配置是否为 HTTP 服务器。
 *
 * @param c 待判断的 MCP 配置。
 * @returns 若存在 `url` 字段则返回 `true`。
 */
export function isHttpConfig(c: McpServerConfig): c is McpHttpServerConfig {
  return 'url' in c
}

/** 每个服务器的运行时状态，UI 通过 `/mcp list` 读取。 */
export type McpServerStatus =
  | { kind: 'disabled' }
  | { kind: 'connecting' }
  | { kind: 'connected'; toolCount: number; resourceCount: number }
  | { kind: 'needs_auth'; authUrl?: string }
  | { kind: 'failed'; error: string }

/**
 * 一个完成名称转换后的 MCP 工具。
 *
 * `callableName` 是模型侧名称（`<server>__<tool>`）；
 * `rawName` 是传给 client.callTool 的原始工具名。
 * MCP 服务器不知道本项目的名称前缀规则，因此调用时必须使用 rawName。
 */
export interface McpToolEntry {
  callableName: string
  rawName: string
  serverName: string
  description: string
  /** 服务器返回的 JSON Schema，直接通过 `jsonSchema(...)` 传给 AI SDK，
   *  不经过 Zod 转换。 */
  inputSchema: Record<string, unknown>
}

/** 一个 MCP resource，即服务器允许客户端读取的数据项。 */
export interface McpResourceEntry {
  uri: string
  name: string
  description?: string
  mimeType?: string
  serverName: string
}

/**
 * 调用 MCP 工具的结果。
 *
 * MCP 原始结果由多个 content block 组成，本类型保存已经展平、可以
 * 放进 tool_result 消息的文本。当前图片和音频等原始块不会继续向模型
 * 传递，但保留这种边界，未来 UI 可以扩展为直接展示二进制内容。
 */
export interface McpCallResult {
  /** 适合放进 tool_result 的文本表示。 */
  text: string
  /** 服务器是否通过 MCP 的 `isError` 标记将本次调用判为错误。 */
  isError: boolean
}
