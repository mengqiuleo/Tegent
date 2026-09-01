import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { Stream } from 'node:stream'

import { VERSION } from '../version.js'
import {
  type McpCallResult,
  type McpResourceEntry,
  type McpServerConfig,
  isHttpConfig,
  isStdioConfig,
} from './types.js'

/**
 * 为诊断保留的 stderr 尾部行数。
 *
 * stdio 服务器启动失败或调用中途崩溃时，`/mcp list` 中展示最后几行
 * stderr，通常比只显示 “exit code 1” 更能帮用户定位原因。
 */
const STDERR_TAIL_LINES = 20

const CLIENT_INFO = { name: 'tegent', version: VERSION }

/**
 * 首次连接默认超时，单位毫秒。
 *
 * 单个服务器可以通过配置中的 `timeout` 覆盖。30 秒偏宽松：
 * 社区 stdio 服务器通常 100-500ms 就能启动；这个预算主要留给
 * 冷缓存下较慢的 npx 安装，而不是正常运行路径。
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

/** 连接成功后暴露给 registry 的能力统计。 */
export interface ConnectInfo {
  toolCount: number
  resourceCount: number
}

export class McpClient {
  // ── 内部状态 ────────────────────────────────────────────────────────
  //
  //   registry ──► McpClient（本类）
  //                 ├── client    ：SDK Client，协议层 —— 会说 MCP
  //                 │              协议（initialize 握手、listTools、
  //                 │              callTool、readResource）
  //                 └── transport ：SDK Transport，传输层 —— 只管消息
  //                                怎么送达：stdio 型 = 子进程的
  //                                stdin/stdout 管道；HTTP 型 = 网络请求
  //
  // client / transport 为 null 就表示“当前没有活跃连接”：构造后、
  // connect() 前，以及 close() 之后都处于这个状态。

  /** SDK 协议层：所有 MCP 调用（listTools / callTool / readResource）
   *  都发给它。connect() 时创建，close() 时置回 null。 */
  private client: Client | null = null
  /** SDK 传输层：stdio 型就是被拉起的子进程（持有它的 stdin/stdout
   *  管道），HTTP 型是一条网络连接。单独存引用是为了 close() 时能
   *  彻底释放（杀掉子进程 / 断开连接）。 */
  private transport: Transport | null = null
  /** 子进程 stderr 的滚动缓冲：只保留最后 STDERR_TAIL_LINES 行，
   *  每来一行就 push，超了就丢最旧的。仅 stdio 型写入（HTTP 没有
   *  stderr）。连接失败时 enrichError 会取末尾几行拼进报错，
   *  `/mcp list` 通过 stderr() 读它来展示失败原因。 */
  private stderrTail: string[] = []
  /** connect() 时 listTools() 拉回的工具清单。之后 tools() 直接返回
   *  这份缓存、不再发请求；registry 安装工具表时也读它。 */
  private cachedTools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = []
  /** 同 cachedTools，但缓存的是 listResources() 拉回的 resource 清单，
   *  供 resources() 和 registry 使用。 */
  private cachedResources: McpResourceEntry[] = []

  constructor(
    public readonly serverName: string,
    private readonly config: McpServerConfig,
  ) {}

  /**
   * 启动或拨通服务器，并完成 MCP initialize 握手。
   *
   * 成功后会填充内部工具和 resource 缓存；失败时会关闭 transport，
   * 避免留下僵尸子进程或悬空 HTTP 连接，然后重新抛出增强后的错误。
   *
   * @returns 当前连接枚举出的工具数和 resource 数。
   * @throws {Error} 连接、握手或超时失败时抛出。
   */
  async connect(): Promise<ConnectInfo> {
    const timeout = this.config.timeout ?? DEFAULT_CONNECT_TIMEOUT_MS

    this.transport = this.buildTransport()
    this.client = new Client(CLIENT_INFO, { capabilities: {} })

    // SDK 的 connect() 会执行 initialize 往返，并在服务器确认后 resolve。
    // 这里额外与显式定时器竞争，因为卡住的 stdio 子进程
    // （例如 npx 在拉 registry 时挂住）不一定会主动报错，只会一直等待。
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      await this.client.connect(this.transport, { signal: ctrl.signal })
    } catch (err) {
      await this.safeClose()
      throw this.enrichError(err)
    } finally {
      clearTimeout(timer)
    }

    // 枚举服务器能力。tool 和 resource 彼此独立，服务器可以只提供其中一种。
    // 某些服务器在没有 resource 时会直接拒绝 listResources，因此任一枚举失败
    // 都只记录日志并降级为空列表，不影响连接本身。
    try {
      const tools = await this.client.listTools()
      this.cachedTools = (tools.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
      }))
    } catch (err) {

      this.cachedTools = []
    }

    try {
      const resources = await this.client.listResources()
      this.cachedResources = (resources.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name ?? r.uri,
        description: r.description,
        mimeType: r.mimeType,
        serverName: this.serverName,
      }))
    } catch (err) {

      this.cachedResources = []
    }

    return {
      toolCount: this.cachedTools.length,
      resourceCount: this.cachedResources.length,
    }
  }

  /**
   * 返回连接时发现的工具列表。
   *
   * 该列表在当前连接生命周期内保持稳定；如果需要刷新工具面，
   * 应创建新的 McpClient 并重新调用 connect。
   */
  tools(): ReadonlyArray<{ name: string; description?: string; inputSchema: Record<string, unknown> }> {
    return this.cachedTools
  }

  /**
   * 返回连接时发现的 resource 列表。
   *
   * @returns 当前连接缓存的 resource 条目。
   */
  resources(): ReadonlyArray<McpResourceEntry> {
    return this.cachedResources
  }

  /**
   * 调用远端 MCP 工具。
   *
   * @param name MCP 服务器认识的原始工具名，不是模型侧 callableName。
   * @param args 模型传入并已解析的工具参数。
   * @param signal 可选的取消信号，用户中断工具调用时会传入。
   * @returns 已展平为文本的工具结果。
   */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    if (!this.client) throw new Error(`MCP server "${this.serverName}" is not connected`)
    const result = await this.client.callTool(
      { name, arguments: args as Record<string, unknown> | undefined },
      undefined,
      { signal },
    )
    return flattenCallResult(result)
  }

  /**
   * 按 URI 读取 MCP resource。
   *
   * @param uri MCP resource URI。
   * @param signal 可选的取消信号。
   * @returns 文本内容和首个 content block 的 mimeType。
   */
  async readResource(uri: string, signal?: AbortSignal): Promise<{ text: string; mimeType?: string }> {
    if (!this.client) throw new Error(`MCP server "${this.serverName}" is not connected`)
    const result = await this.client.readResource({ uri }, { signal })
    // resource 返回 content block 数组；这里拼接所有文本块，
    // 同时保留第一个 mimeType，供调用方展示或判断类型。
    const parts: string[] = []
    let mimeType: string | undefined
    for (const c of result.contents ?? []) {
      mimeType ??= (c as { mimeType?: string }).mimeType
      const text = (c as { text?: string }).text
      if (typeof text === 'string') parts.push(text)
      else if ((c as { blob?: string }).blob !== undefined) {
        parts.push(`[binary content omitted, mimeType=${mimeType ?? 'unknown'}]`)
      }
    }
    return { text: parts.join('\n'), mimeType }
  }

  /** 返回最近 N 行 stderr 快照；HTTP 服务器没有 stderr，因此通常为空。 */
  stderr(): string {
    return this.stderrTail.join('\n')
  }

  /** 关闭当前 client 和 transport，忽略关闭过程中的非致命错误。 */
  async close(): Promise<void> {
    await this.safeClose()
  }


  /**
   * 根据服务器配置创建对应的 SDK transport。
   *
   * stdio 配置会启动本地子进程；HTTP 配置会创建 StreamableHTTP transport。
   * 该函数只负责构建 transport，不执行 initialize 握手。
   *
   * @returns 新建的 SDK transport。
   */
  private buildTransport(): Transport {
    if (isStdioConfig(this.config)) {
      const t = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: this.config.env,
        cwd: this.config.cwd,
        // 将 stderr 设为 pipe，方便捕获诊断信息。
        // 默认 inherit 会把子进程输出直接写进父 CLI 终端，
        // 干扰 ChatInput 的 cell-buffer UI。
        stderr: 'pipe',
      })
      const stderr: Stream | null = t.stderr
      if (stderr) {
        stderr.on('data', (chunk: Buffer | string) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          for (const line of text.split(/\r?\n/)) {
            if (!line) continue
            this.stderrTail.push(line)
            if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
          }
        })
      }
      return t
    }

    if (isHttpConfig(this.config)) {
      return new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
      })
    }

    // 上游 schema 校验应阻止这种情况；这里保留防御式分支。
    throw new Error(`mcp server "${this.serverName}": unrecognised config shape`)
  }

  /**
   * 安全关闭 SDK client 或 transport。
   *
   * 优先关闭 client，因为 Client.close() 会发送规范的 shutdown 通知，
   * 且会顺带关闭 transport。若 client 尚未创建，则直接关闭 transport。
   * 关闭失败只写调试日志，最终都会清空本类持有的句柄。
   */
  private async safeClose(): Promise<void> {
    try {
      if (this.client) {
        await this.client.close()
      } else if (this.transport) {
        await this.transport.close()
      }
    } catch (err) {

    } finally {
      this.client = null
      this.transport = null
    }
  }

  /**
   * 将 stderr 尾部附加到连接错误上。
   *
   * 这样 `/mcp list` 能展示比 “Connection closed” 更有用的诊断信息。
   *
   * @param err 原始错误。
   * @returns 原错误或附带 stderr 摘要的新错误。
   */
  private enrichError(err: unknown): Error {
    const base = err instanceof Error ? err : new Error(String(err))
    if (this.stderrTail.length === 0) return base
    const tail = this.stderrTail.slice(-5).join(' | ')
    const enriched = new Error(`${base.message} — stderr: ${tail}`)
    enriched.stack = base.stack
    return enriched
  }
}

/**
 * 将 MCP 调用结果中的 content block 展平成单个字符串。
 *
 * MCP 响应通常是 `{ type: "text" | "image" | ... }` 数组。
 * 当前 tool_result 只向模型回传文本；图片 / 音频会被替换成占位说明，
 * 因为 agent loop 目前只从用户输入读取图片，不从工具结果 ingest 图片。
 *
 * @param result MCP SDK 返回的原始调用结果。
 * @returns 展平后的文本结果和错误标记。
 */
function flattenCallResult(result: unknown): McpCallResult {
  const r = result as { content?: Array<unknown>; isError?: boolean }
  const blocks = Array.isArray(r.content) ? r.content : []
  const parts: string[] = []
  for (const b of blocks) {
    const block = b as { type?: string; text?: string; data?: unknown; mimeType?: string }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'image') {
      parts.push(`[image content omitted, mimeType=${block.mimeType ?? 'unknown'}]`)
    } else if (block.type === 'resource') {
      // 嵌入式 resource：优先展示嵌套文本，否则展示 resource URI 标记。
      const nested = (block as { resource?: { text?: string; uri?: string } }).resource
      if (nested?.text) parts.push(nested.text)
      else if (nested?.uri) parts.push(`[resource: ${nested.uri}]`)
    } else if (block.type) {
      parts.push(`[${block.type} content]`)
    }
  }
  return {
    text: parts.join('\n').trim() || '(empty response)',
    isError: r.isError === true,
  }
}
