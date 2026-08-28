// 这个 registry 在 CLI 启动时由 `loadMcpServers` 构建一次，平时保持稳定，
// 但不再是完全冻结的。它有两个会修改内部状态的入口：
//
//   - `restartAll(newConfigs?)`：给 `/mcp refresh` 用，断开并重连所有服务器，
//     还可以把刚从磁盘读到的新配置换进去，让新增条目无需重启 CLI 就出现。
//   - `authenticateServer(name, hooks)`：给 `/mcp auth <name>` 用，对单个 HTTP
//     服务器执行一次新的 OAuth 往返，然后重连。
//
// 这两个方法都会原地修改内部 Map，因此 `AgentOptions` 上持有的
// `options.mcpRegistry` 引用始终有效，agent loop 和 tool-execution
// 不需要重新接线。调用方在这些操作后必须清空 `state.systemPromptCache`：
// 工具面已经变化，OpenAI-compatible provider 的 prefix cache
// 也必须失效。App.tsx 里的 `/mcp` slash command 会通过
// `invalidateSystemPromptCache()` 做这件事。
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

import { McpClient } from './client.js'
import { UnsafeEnvError, assertSafeEnv } from './env-safety.js'
import { EnvExpansionError, expandEnvDeep } from './expand-env.js'
import { buildCallableName } from './name-mangling.js'
import {
  type McpCallResult,
  type McpResourceEntry,
  type McpServerConfig,
  type McpServerStatus,
  type McpToolEntry,
  isHttpConfig,
  isStdioConfig,
} from './types.js'

/**
 * 为单个 HTTP 服务器创建 OAuth provider。
 *
 * stdio 服务器会得到 `undefined`；如果 CLI 没有接好 token storage，
 * HTTP 服务器也会返回 `undefined`，表示无法驱动 OAuth。
 */
export type OAuthProviderFactory = (serverName: string, serverUrl: string) => OAuthClientProvider | undefined

export interface RegisteredServer {
  name: string
  client: McpClient
  status: McpServerStatus
  /** 当状态为 `failed` 时记录最近的 stderr 尾部（仅 stdio）。
   *  /mcp list 会用它展示失败原因。 */
  stderrTail?: string
}

/**
 * `/mcp auth` 处理器传给 registry 的钩子。
 *
 * 这样 registry 可以在不依赖 CLI 层的情况下把可见进度展示给用户。
 */
export interface AuthHooks {
  /** 浏览器即将打开前调用一次，参数是 SDK 即将重定向到的授权 URL。 */
  onBrowserOpen?: (url: string) => void
}

/** `restartAll` 实际改动的摘要，供 `/mcp refresh` 输出展示。 */
export interface RestartSummary {
  /** 重启后出现、重启前不存在的服务器名。 */
  added: string[]
  /** 被移除的服务器名（之前存在，现在不在新配置中）。 */
  removed: string[]
  /** 两边都存在、但配置内容不同的服务器名。 */
  changed: string[]
  /** 重启前后都存在且配置未变的服务器名。 */
  unchanged: string[]
}

export class McpRegistry {
  /** callableName → 工具条目。callableName 是模型侧的 `<server>__<tool>` 形式。 */
  private readonly entries = new Map<string, McpToolEntry>()
  /** uri → 资源条目。按协议 URI 应唯一；如果真的撞了，loader 会处理告警。 */
  private readonly resources = new Map<string, McpResourceEntry>()
  private readonly servers = new Map<string, RegisteredServer>()
  /** 每个服务器最近加载的配置。
   *  这是 `restartServer` 的真源，也用于 `restartAll` 做差异比较。 */
  private readonly configs = new Map<string, McpServerConfig>()
  /** 每个服务器对应的 OAuth provider 工厂。
   *  若为 undefined，需要认证的 HTTP 服务器会只显示成 `needs_auth`，
   *  `/mcp auth` 也无法驱动它们。 */
  private oauthFactory: OAuthProviderFactory | undefined

  constructor(input: {
    servers: RegisteredServer[]
    tools: McpToolEntry[]
    resources: McpResourceEntry[]
    /** 启动时使用的每个服务器配置。`restartServer` / `authenticateServer`
     *  需要它来知道要重建什么。 */
    configs?: Map<string, McpServerConfig>
    /** 从 CLI 传下来的 OAuth provider 工厂。 */
    oauthFactory?: OAuthProviderFactory
  }) {
    for (const s of input.servers) this.servers.set(s.name, s)
    for (const t of input.tools) this.entries.set(t.callableName, t)
    for (const r of input.resources) this.resources.set(r.uri, r)
    if (input.configs) for (const [k, v] of input.configs) this.configs.set(k, v)
    this.oauthFactory = input.oauthFactory
  }

  // ── 工具面 ────────────────────────────────────────────────────────────

  /** 所有模型侧工具名的快照，迭代顺序稳定。
   *  由 `buildTools`（agent loop）和 `buildSystemPrompt` 使用。 */
  list(): McpToolEntry[] {
    return [...this.entries.values()]
  }

  /** 通过 callableName 获取单个工具条目。找不到时返回 undefined。 */
  get(callableName: string): McpToolEntry | undefined {
    return this.entries.get(callableName)
  }

  // ── Resource 面 ───────────────────────────────────────────────────────

  /** 返回全部 resource 条目。 */
  listResources(): McpResourceEntry[] {
    return [...this.resources.values()]
  }

  /** 找到某个 URI 属于哪台服务器，以便 resource 工具转发读取。
   *  未知 URI 时返回 undefined。 */
  resourceServer(uri: string): McpClient | undefined {
    const r = this.resources.get(uri)
    if (!r) return undefined
    return this.servers.get(r.serverName)?.client
  }

  // ── 服务器状态面（供 /mcp list / status 使用） ───────────────────────

  serverStatus(): Array<{ name: string; status: McpServerStatus; stderrTail?: string }> {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      status: s.status,
      stderrTail: s.stderrTail,
    }))
  }

  /** 按服务器名查找对应的 RegisteredServer。 */
  getServer(serverName: string): RegisteredServer | undefined {
    return this.servers.get(serverName)
  }

  /** 读取某个服务器最近保存的配置。 */
  getConfig(serverName: string): McpServerConfig | undefined {
    return this.configs.get(serverName)
  }

  // ── 分发 ─────────────────────────────────────────────────────────────

  /** 按模型侧 callableName 调用一个 MCP 工具。
   *
   * 先查工具条目，再找到所属服务器，最后转发给 SDK client。
   */
  async callTool(callableName: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const entry = this.entries.get(callableName)
    if (!entry) throw new Error(`MCP tool not found: ${callableName}`)
    const server = this.servers.get(entry.serverName)
    if (!server) throw new Error(`MCP server gone: ${entry.serverName}`)
    return server.client.callTool(entry.rawName, args, signal)
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────

  /**
   * 干净断开所有服务器。
   *
   * 这里是 best-effort：某个服务器关闭失败不会妨碍其他服务器退出。
   * 由 CLI 退出钩子调用，也会在 `restartAll` 重建前内部调用。
   */
  async shutdown(): Promise<void> {
    const tasks: Promise<void>[] = []
    for (const s of this.servers.values()) {
      tasks.push(
        s.client.close().catch(() => {
          // 这里已经在 client.safeClose 里记过日志了，再处理也没有额外价值。
        }),
      )
    }
    await Promise.allSettled(tasks)
  }

  // ── 重启 / 刷新 ───────────────────────────────────────────────────────

  /**
   * 用当前配置就地重连一个服务器。
   *
   * 供 `authenticateServer` 在新 token 保存后调用，也可以给只想重载单个
   * 服务器的调用方使用。旧连接中的工具和 resource 会被丢弃，
   * 由新连接重新枚举出来的内容替换；如果服务器的 `tools/list`
   * 结果变化，工具名也可能随之变化。
   *
   * 调用结束后，调用方必须失效 agent 的 systemPromptCache。
   */
  async restartServer(name: string, opts: { driveOAuth?: AuthHooks } = {}): Promise<RegisteredServer> {
    const config = this.configs.get(name)
    if (!config) {
      throw new Error(`No MCP server registered as "${name}"`)
    }
    // 先关闭旧 client（如果存在）再创建新实例。
    // 对 stdio 来说这会顺手杀掉旧子进程，避免留下僵尸。
    // 关闭失败不是致命错误：坏掉的连接仍然应该被替换。
    const existing = this.servers.get(name)
    if (existing) {
      try {
        await existing.client.close()
      } catch (err) {

      }
    }

    // 在新的 connect 之前先删除旧的工具 / resource。
    // 这样如果重连中途失败，状态会停留在“一条都没有”，
    // 而不是“旧的和空的混在一起”。
    this.removeServerEntries(name)

    const result = await connectOneServer(name, config, this.oauthFactory, opts.driveOAuth)
    this.installServer(result)
    return result.server
  }

  /**
   * 断开全部服务器，并根据 `newConfigs`（或现有配置）重新构建。
   *
   * 返回一个差异摘要，方便 UI 告诉用户到底改了什么。
   * 供 `/mcp refresh` 使用：先重新读取用户 / 项目配置文件，把合并后的
   * 映射交给这里，再由 registry 负责增删改。即使配置字节没变，
   * 服务器也会重新连接，这比逐层比较嵌套字段更简单，也更直观。
   */
  async restartAll(newConfigs?: Map<string, McpServerConfig>): Promise<RestartSummary> {
    const oldNames = new Set(this.configs.keys())
    const newNames = new Set((newConfigs ?? this.configs).keys())

    const summary: RestartSummary = {
      added: [...newNames].filter((n) => !oldNames.has(n)),
      removed: [...oldNames].filter((n) => !newNames.has(n)),
      changed: [],
      unchanged: [],
    }

    if (newConfigs) {
      for (const name of newNames) {
        if (!oldNames.has(name)) continue
        const before = JSON.stringify(this.configs.get(name))
        const after = JSON.stringify(newConfigs.get(name))
        if (before !== after) summary.changed.push(name)
        else summary.unchanged.push(name)
      }
    } else {
      summary.unchanged = [...newNames]
    }

    // 先把所有服务器都拆掉。采用先 close-all 再 connect-all 的方式，
    // 比逐台 close+connect 更可预测：不会出现同一服务器同时活着两个 client，
    // stdio 子进程也会先退出，再启动替代进程。
    await this.shutdown()

    // 重置内部状态。OAuth factory 保留，因为它来自 CLI 进程本身，
    // 不绑定到某一份配置。
    this.servers.clear()
    this.entries.clear()
    this.resources.clear()
    this.configs.clear()
    const effective = newConfigs ?? new Map<string, McpServerConfig>()
    for (const [k, v] of effective) this.configs.set(k, v)

    // 并行重连，和初始启动一样。单个失败只会记录为 `status: failed`，
    // 不会中断整个重启。
    const tasks = [...effective.entries()].map(async ([name, config]) => {
      try {
        return await connectOneServer(name, config, this.oauthFactory)
      } catch (err) {

        return null
      }
    })
    const results = await Promise.all(tasks)

    // 按名称排序，让工具插入顺序保持稳定（与 loader.ts 的初始启动一致）。
    const installable = results
      .filter((r): r is ConnectResult => r !== null)
      .sort((a, b) => a.server.name.localeCompare(b.server.name))
    for (const r of installable) this.installServer(r)

    return summary
  }

  /**
   * 为单个 HTTP 服务器驱动一次新的 OAuth 往返，然后重连。
   *
   * 用于 `/mcp auth <name>`。前置条件是调用方刚刚通过 token storage 的
   * `clear()` 清掉旧 token，否则“存在但过期”的 token 可能让重新认证
   * 走回头路，继续复用坏状态。
   *
   * @returns 认证后的服务器状态。
   * @throws {Error} 服务器是 stdio、没有配置 OAuth 工厂，或用户关闭浏览器
   *   / callback 超时等情况时抛出。
   */
  async authenticateServer(name: string, hooks: AuthHooks = {}): Promise<RegisteredServer> {
    const config = this.configs.get(name)
    if (!config) throw new Error(`No MCP server registered as "${name}"`)
    if (!isHttpConfig(config)) {
      throw new Error(`MCP server "${name}" is stdio — OAuth applies to HTTP servers only`)
    }
    if (!this.oauthFactory) {
      throw new Error(`OAuth not configured — set a token storage in the loader to use /mcp auth`)
    }

    return this.restartServer(name, { driveOAuth: hooks })
  }

  /**
   * 整体替换 OAuth factory。
   *
   * 用于 CLI 在 registry 构建后，才懒加载 token storage / onBrowserOpen
   * 接线的场景。虽然少见，但测试环境需要这个能力来切换实现。
   */
  /** 替换 registry 当前使用的 OAuth provider 工厂。 */
  setOAuthFactory(factory: OAuthProviderFactory | undefined): void {
    this.oauthFactory = factory
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────

  /** 删除某个服务器拥有的所有工具和 resource。幂等。 */
  private removeServerEntries(name: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.serverName === name) this.entries.delete(key)
    }
    for (const [key, res] of this.resources) {
      if (res.serverName === name) this.resources.delete(key)
    }
  }

  /**
   * 把新的 ConnectResult 安装进各个 Map。
   *
   * 调用方必须先删掉同一服务器的旧条目。
   */
  private installServer(r: ConnectResult): void {
    this.servers.set(r.server.name, r.server)
    const taken = new Set(this.entries.keys())
    for (const t of r.tools) {
      const callable = buildCallableName(r.server.name, t.name, taken)
      taken.add(callable)
      this.entries.set(callable, {
        callableName: callable,
        rawName: t.name,
        serverName: r.server.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      })
    }
    for (const res of r.resources) this.resources.set(res.uri, res)
  }
}

/**
 * 空 registry。
 *
 * 用于 MCP 完全不可用的情况：配置里没有 mcpServers，或者信任对话被拒绝。
 * 这比在下游到处 null-check registry 更省心。
 */
export function emptyRegistry(): McpRegistry {
  return new McpRegistry({ servers: [], tools: [], resources: [] })
}

// ── 连接辅助（与 loader.ts 在初始启动时共享） ─────────────────────────

/**
 * 单台服务器“连接 + 枚举”的输出。
 *
 * 在初始启动（`loadMcpServers`）和 registry 的重启路径之间共享，
 * 这样连接结果的形状保持一致。
 */
export interface ConnectResult {
  server: RegisteredServer
  tools: ReadonlyArray<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
  resources: ReadonlyArray<McpResourceEntry>
}

/**
 * 为单个服务器构建 client，执行连接握手，并报告枚举出的能力。
 *
 * `driveOAuth` 设定时，会在 UnauthorizedError 上主动进入完整的浏览器
 * OAuth 流程；不设定时，UnauthorizedError 会被折叠成 `status: needs_auth`，
 * 由用户手动执行 `/mcp auth`。
 */
export async function connectOneServer(
  name: string,
  rawConfig: McpServerConfig,
  oauthFactory: OAuthProviderFactory | undefined,
  driveOAuth?: AuthHooks,
): Promise<ConnectResult> {
  // 尊重 `enabled: false`：保留注册信息，但跳过连接。
  if (rawConfig.enabled === false) {
    const client = new McpClient(name, rawConfig)
    return {
      server: { name, client, status: { kind: 'disabled' } },
      tools: [],
      resources: [],
    }
  }

  // 在构建 client 之前先展开 `${VAR}` 引用。
  // 然后对 stdio 配置执行环境安全检查：所有环境变量来源
  // （CLI flag、mcp.json、插件 manifest）都会流经这里，
  // 所以在此拒绝危险键，就能一次性覆盖所有入口。威胁模型见 env-safety.ts。
  let expanded: McpServerConfig
  try {
    expanded = expandEnvDeep(rawConfig)
    if (isStdioConfig(expanded)) assertSafeEnv(expanded.env)
  } catch (err) {
    const msg =
      err instanceof EnvExpansionError || err instanceof UnsafeEnvError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err)
    const client = new McpClient(name, rawConfig)
    return {
      server: { name, client, status: { kind: 'failed', error: msg } },
      tools: [],
      resources: [],
    }
  }

  const authProvider = oauthFactory && isHttpConfig(expanded) ? oauthFactory(name, expanded.url) : undefined
  const client = new McpClient(name, expanded, authProvider)

  try {
    const info = driveOAuth ? await client.connectWithOAuth(driveOAuth) : await client.connect()
    return {
      server: {
        name,
        client,
        status: { kind: 'connected', toolCount: info.toolCount, resourceCount: info.resourceCount },
      },
      tools: client.tools(),
      resources: client.resources(),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const needsAuth = /unauth|401|UnauthorizedError/i.test(msg) && isHttpConfig(expanded)
    const status: RegisteredServer['status'] = needsAuth ? { kind: 'needs_auth' } : { kind: 'failed', error: msg }
    return {
      server: { name, client, status, stderrTail: client.stderr() || undefined },
      tools: [],
      resources: [],
    }
  }
}
