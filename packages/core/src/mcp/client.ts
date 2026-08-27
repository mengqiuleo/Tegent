// 一个 McpClient 实例代表一条服务器连接。MCP SDK 原本需要同时管理
// `new Client(...)`、`new XxxTransport(...)` 和
// `client.connect(transport)` 这几个对象 / 步骤；本类把这些细节收进
// 一个 `connect()` 方法里，并由 `close()` 负责关闭传输层。
// registry 只需要使用 listTools、callTool、listResources、readResource
// 和 close 这几个窄接口。
//
// AbortSignal 透传也集中在这里：每个发往服务器的 RPC 方法都接受可选
// AbortSignal，并通过 `RequestOptions.signal` 传给 SDK。用户在工具调用
// 期间按 Esc 时，agent loop 的 signal 会取消当前 SDK 请求，关闭这次
// JSON-RPC future，但不会杀掉底层连接；下一次调用仍可复用同一 transport。
import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { Stream } from 'node:stream'

import { VERSION } from '../version.js'
import { McpOAuthProvider } from './oauth/provider.js'
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

const CLIENT_INFO = { name: 'tegent-cli', version: VERSION }

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
  /** SDK Client 实例；只有成功进入连接流程后才存在。 */
  private client: Client | null = null
  /** SDK transport；由本类持有，以便 `close()` 时能干净释放。 */
  private transport: Transport | null = null
  /** stderr 的滚动尾部缓存，仅 stdio 服务器会写入。 */
  private stderrTail: string[] = []
  /** 最近一次连接枚举出的工具缓存，供 registry 安装工具表。 */
  private cachedTools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = []
  /** 最近一次连接枚举出的 resource 缓存，供 registry 安装 resource 表。 */
  private cachedResources: McpResourceEntry[] = []

  constructor(
    public readonly serverName: string,
    private readonly config: McpServerConfig,
    /** HTTP 服务器可选的 OAuth provider；stdio 服务器会忽略。 */
    private readonly authProvider?: OAuthClientProvider,
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
      // OAuth 流程中抛 UnauthorizedError 是预期行为：
      // SDK 已经调用 redirectToAuthorization，现在需要调用方在同一个
      // transport 上执行 finishAuth(code)。如果这里关闭连接，
      // runOAuthDance 会丢失 transport 句柄，无法完成 token 交换。
      // 所以 UnauthorizedError 时暂时保留 client + transport，
      // 由 runOAuthDance 或后续 finally 路径清理；其他错误仍然 safeClose，
      // 避免泄漏子进程或 HTTP 连接。
      if (!isUnauthorizedError(err)) {
        await this.safeClose()
      }
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
   * 执行一次完整的交互式 OAuth 连接流程。
   *
   * MCP SDK 的 StreamableHTTP transport 采用懒认证：没有已保存 token 时，
   * 首次 connect 会调用 `authProvider.redirectToAuthorization`，随后抛出
   * `UnauthorizedError`，因为 token 交换必须等用户在浏览器中授权并跳回。
   * 调用方需要等待本地回调拿到授权码，把 code 交给
   * `transport.finishAuth(code)`，再重试 connect；第二次连接时 token
   * 已保存，握手即可成功。
   *
   * 本方法把这整套流程封装起来，让 `/mcp auth` 只需选择“驱动 OAuth
   * 到完成”，不必理解 finishAuth 细节。默认 `connect()` 会让 OAuth
   * provider 处于被动模式：只有这里调用 `setInteractive(true)` 后，
   * `redirectToAuthorization` 才会真正打开浏览器，从而避免 CLI 启动时
   * 对 `needs_auth` 服务器突然弹出浏览器窗口。
   *
   * @param hooks 可选的 UI 回调，用于在浏览器打开前向用户展示授权 URL。
   * @returns OAuth 完成后的连接能力统计。
   */
  async connectWithOAuth(hooks: { onBrowserOpen?: (url: string) => void } = {}): Promise<ConnectInfo> {
    if (!this.authProvider) {
      throw new Error(`MCP server "${this.serverName}" has no OAuth provider configured`)
    }
    if (!(this.authProvider instanceof McpOAuthProvider)) {
      // 允许第三方 provider 自己处理 OAuth；此时无法使用本类的
      // waitForAuthCode 钩子，直接走普通 connect。
      return this.connect()
    }

    const provider = this.authProvider

    // 提前启动本地回调服务器，让真实 loopback 端口在 SDK 构造动态注册请求前
    // 就写入 `clientMetadata.redirect_uris` 和 `redirectUrl`。
    // 否则我们会用不带端口的占位 redirect_uri 注册；Sentry 等不完全接受
    // RFC 8252 §7.3 “loopback 任意端口”规则的认证服务器，会拒绝授权 URL
    // 中带真实端口的 redirect_uri。
    await provider.prepareForAuth()

    // 将浏览器打开通知同时转发给调用方 hook，这样 /mcp auth 处理器可以把
    // “正在打开浏览器”的提示写入 CLI scrollback。
    // provider 没有事件 API，所以这里临时 monkey-patch 当前实例的方法；
    // patch 只存在于本次调用的 try/finally 生命周期内，边界足够明确。
    const originalRedirect = provider.redirectToAuthorization.bind(provider)
    if (hooks.onBrowserOpen) {
      provider.redirectToAuthorization = async (url: URL) => {
        try {
          hooks.onBrowserOpen?.(url.toString())
        } catch {
          // UI hook 失败不能中断 OAuth 主流程。
        }
        return originalRedirect(url)
      }
    }
    try {
      return await this.runOAuthDance()
    } finally {
      provider.setInteractive(false)
      if (hooks.onBrowserOpen) {
        provider.redirectToAuthorization = originalRedirect
      }
    }
  }

  /**
   * 实际执行 OAuth 的两阶段连接。
   *
   * 第一阶段触发浏览器跳转并等待 UnauthorizedError；随后等待用户授权回调，
   * 调用 finishAuth 完成 token 交换；第二阶段重新连接并得到真正会话。
   * 两次尝试共用同一组工具 / resource 缓存字段，最终由成功的第二次连接填充。
   *
   * @returns 授权完成后的连接能力统计。
   */
  private async runOAuthDance(): Promise<ConnectInfo> {
    const provider = this.authProvider as McpOAuthProvider

    // 第一次尝试通常会在打开浏览器后抛 UnauthorizedError。
    // 如果磁盘上恰好已有有效 token，则 connect 会直接成功并提前返回。
    try {
      return await this.connect()
    } catch (err) {
      // 不是“需要等待用户授权”的错误都继续向外抛出。
      if (!isUnauthorizedError(err)) {
        provider.cancel()
        throw err
      }
    }

    // provider 已经被 SDK 调用过 redirectToAuthorization。
    // 现在等待用户从浏览器跳回本地 callback server，再完成 token 交换。
    const { code } = await provider.waitForAuthCode()
    const transport = this.transport
    if (!(transport instanceof StreamableHTTPClientTransport)) {
      throw new Error(`Internal error: OAuth flow expected an HTTP transport for "${this.serverName}"`)
    }
    await transport.finishAuth(code)

    // token 已保存。第一次 connect 在握手中途抛错，client + transport
    // 处于半开状态；为了避免“已经连接”或状态泄漏，先关闭再重建 transport，
    // 让第二次 initialize 往返发生在干净连接上。
    await this.safeClose()
    return this.connect()
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

  // ── 内部实现 ──────────────────────────────────────────────────────────

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
        authProvider: this.authProvider,
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
 * 判断错误是否代表 SDK 的 UnauthorizedError。
 *
 * 这里不只依赖 instanceof，因为打包或依赖重复安装时，
 * 同名类可能来自不同 esm/cjs 根路径，instanceof 会失效。
 * 因此同时检查 SDK 导出的类、错误名称和常见 401 文案。
 *
 * @param err 任意错误值。
 * @returns 认为是未授权错误时返回 `true`。
 */
function isUnauthorizedError(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true
  if (err instanceof Error) {
    if (err.name === 'UnauthorizedError') return true
    if (/unauthorized|401/i.test(err.message)) return true
  }
  return false
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
