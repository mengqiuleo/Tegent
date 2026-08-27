// 本文件把 MCP SDK 的 OAuth 流程接到本地持久化和 CLI 交互上：
//
//   - tokens()                 — 从 McpTokenStorage 读取 token
//   - saveTokens()             — 写入 McpTokenStorage
//   - clientInformation()      — 从 McpTokenStorage 读取 client 信息
//   - saveClientInformation()  — 写入 McpTokenStorage（包括 RFC 7591 动态注册结果）
//   - codeVerifier() / save    — 保存在进程内存中；PKCE verifier 每次流程只用一次
//   - redirectUrl              — 指向新启动的本地 callback server URL
//   - redirectToAuthorization  — 把授权 URL 打开到用户浏览器
//
// 每个服务器一个实例，由 loader.ts 里的 factory 懒创建。
//
// 打开外部浏览器时，我们直接用 `node:child_process` 启动平台默认 opener：
// Windows 用 `rundll32`，macOS 用 `open`，Linux 用 `xdg-open` / 备选方案。
// 这样就不用再引入一个额外的 npm 依赖。
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import { spawn } from 'node:child_process'


import { type RunningCallbackServer, startCallbackServer } from './callback-server.js'
import { McpTokenStorage } from './token-storage.js'

const CLIENT_METADATA_BASE: Omit<OAuthClientMetadata, 'redirect_uris'> = {
  client_name: 'Tegent',
  client_uri: 'https://github.com/mengqiuleo/Tegent',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

export interface CreateProviderOptions {
  serverName: string
  serverUrl: string
  storage: McpTokenStorage
  /** 浏览器打开前要调用的回调，例如向 CLI UI 打印“正在打开浏览器”。 */
  onOpenBrowser?: (url: string) => void
}

/**
 * 具体 provider：连接了持久化状态和按需启动的 callback server。
 *
 * 同一个服务器在多次 connect / refresh 中会复用这个实例。
 */
export class McpOAuthProvider implements OAuthClientProvider {
  /** 当前运行中的 callback server。
   *  保留句柄是为了让第二次 redirectToAuthorization 复用同一个端口，
   *  而不是再开一个监听器。 */
  private callbackServer: RunningCallbackServer | null = null
  /** PKCE verifier，仅保存在内存里，每次新的流程都会覆盖。 */
  private memoryCodeVerifier: string | null = null
  /** 待完成的 callback promise。
   *  SDK 会在 transport 的 `finishAuth` 中消费它；`waitForAuthCode()`
   *  的调用方会拿到这个 promise。 */
  private pendingCode: Promise<{ code: string; state?: string }> | null = null
  /** `redirectToAuthorization` 是否真的要打开浏览器。
   *  默认 false：CLI 启动时如果某个 HTTP MCP 服务器没有已保存 token，
   *  绝不能悄悄弹浏览器。这个标志只会在 `connectWithOAuth`
   * （也就是 `/mcp auth <name>`）期间被打开，并在 finally 里关闭。 */
  private interactive = false

  constructor(private readonly opts: CreateProviderOptions) {}

  /** 由 client.ts 的 connectWithOAuth 在认证流程前后切换。
   *  超出这个窗口时，provider 始终保持被动。 */
  setInteractive(value: boolean): void {
    this.interactive = value
  }

  /**
   * 提前启动 callback server。
   *
   * 这样真实的 loopback 端口就能在 SDK 构造动态注册请求前，写进
   * `redirectUrl` 和 `clientMetadata.redirect_uris`。
   *
   * 为什么这一步重要：Sentry 以及其他不完全遵守 RFC 8252 §7.3
   * loopback 任意端口规则的授权服务器，会拿注册时的 redirect_uri
   * 去校验真正发起授权时的 redirect_uri。如果注册时用的是无端口占位符，
   * 后面换成具体端口就可能被拒绝。提前启动能保证注册和授权都使用同一个
   * `http://127.0.0.1:<port>/callback`。
   */
  async prepareForAuth(): Promise<void> {
    this.interactive = true
    await this.ensureCallbackServer()
  }

  // ── OAuthClientProvider 实现 ─────────────────────────────────────────

  get redirectUrl(): string {
    // SDK 会在 redirectToAuthorization 之前就读取 redirectUrl
    //（例如第一次 connect、还没有 stored token 时构造授权 URL 的阶段）。
    // 以前这里直接抛错会让 HTTP 服务器在首次启动后显示成 failed，
    // 而不是预期的 needs_auth。
    //
    // 因此这里返回和 clientMetadata.redirect_uris 一样的 loopback 占位符。
    // RFC 8252 §7.3 要求授权服务器接受注册过的 loopback redirect_uri 上任意端口，
    // 所以这个无端口占位符可以用于注册往返；真正的 redirect_uri 会在
    // redirectToAuthorization 里被改成具体端口。
    return this.callbackServer?.url ?? 'http://127.0.0.1/callback'
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      ...CLIENT_METADATA_BASE,
      // 等服务器启动后再由 redirectToAuthorization 填入真实值。
      // 在此之前 SDK 可能会在动态注册阶段读取这个对象，所以这里先放占位符；
      // 最终注册响应会覆盖它。
      redirect_uris: [this.callbackServer?.url ?? 'http://127.0.0.1/callback'],
    }
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = await this.opts.storage.get(this.opts.serverName)
    return stored?.clientInformation
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.opts.storage.setClientInformation(this.opts.serverName, this.opts.serverUrl, info)
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const stored = await this.opts.storage.get(this.opts.serverName)
    return stored?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.opts.storage.setTokens(this.opts.serverName, this.opts.serverUrl, tokens)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.memoryCodeVerifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.memoryCodeVerifier) {
      throw new Error('No PKCE verifier set — auth flow not in progress')
    }
    return this.memoryCodeVerifier
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // 被动（启动）模式：SDK 正在执行一个“懒连接”的首次尝试，但没有
    // 已保存 token。此时绝不能未经允许就打开浏览器。
    // 其他 MCP 感知 CLI（Claude Code、Gemini、OpenCode）也都是等用户明确
    // 操作后才开浏览器；CLI 启动时突然抢走用户浏览器属于很突兀的行为。
    // 这里直接返回就够了：SDK 随后会抛 UnauthorizedError，
    // registry 会把它分类成 `needs_auth`，然后 `/mcp auth <name>`
    // 再通过 `setInteractive(true)` 进入真正的交互流程。
    if (!this.interactive) {
      return
    }

    // 在把授权 URL 交给浏览器之前，临时启动 callback server。
    // 这样我们通过 `redirectUrl` 对外声明的地址，和实际监听的地址一致。
    // 接着把 auth URL 里的 redirect_uri 重写成真实端口。
    await this.ensureCallbackServer()
    authorizationUrl.searchParams.set('redirect_uri', this.callbackServer!.url)

    this.opts.onOpenBrowser?.(authorizationUrl.toString())
    await openInBrowser(authorizationUrl.toString())

    // 把 pending callback 保存起来，这样调用方就能通过
    // `waitForAuthCode()` 等待它；与此同时，transport 负责后面的
    // token exchange 步骤。
    this.pendingCode = this.callbackServer!.waitForCallback()
  }

  // ── 供 /mcp auth 处理器使用的辅助方法 ───────────────────────────────

  /**
   * 阻塞等待授权服务器回跳。
   *
   * promise resolve 后返回抓到的 code；调用方随后要在 SDK 的
   * StreamableHTTPClientTransport 上执行 `transport.finishAuth(code)`。
   *
   * 这里会关闭 callback server，因为我们已经拿到 code 了，Sentry
   * 也不会再回调第二次。但 `memoryCodeVerifier` 必须保留：
   * SDK 会在 `transport.finishAuth(code)` 里读取它，而该调用发生在
   * 本 promise resolve 之后。曾经在这里把 verifier 清空，结果就会报
   * “No PKCE verifier set — auth flow not in progress”。
   * verifier 的清理要么通过 `cancel()`，要么等下一次 `saveCodeVerifier(...)`。
   */
  async waitForAuthCode(): Promise<{ code: string; state?: string }> {
    if (!this.pendingCode) {
      throw new Error('Auth flow not started — redirectToAuthorization was never invoked')
    }
    try {
      return await this.pendingCode
    } finally {
      this.pendingCode = null
      this.callbackServer?.close()
      this.callbackServer = null
    }
  }

  /** 放弃当前进行中的流程，不保存任何状态。任何时候都可以调用。 */
  cancel(): void {
    this.callbackServer?.close()
    this.callbackServer = null
    this.pendingCode = null
    this.memoryCodeVerifier = null
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────

  private async ensureCallbackServer(): Promise<void> {
    if (this.callbackServer) return
    this.callbackServer = await startCallbackServer()
  }
}

/**
 * 尽量跨平台地执行 `open <url>`。
 *
 * 子进程会 detached，避免 CLI 卡在浏览器进程上；stdio 会被丢掉，
 * 防止输出污染终端 UI。失败只记日志，不抛错，因为用户仍然可以手动复制 URL。
 */
async function openInBrowser(url: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      // 这里故意不用 `cmd /c start`。cmd.exe 会把 `&` 当成命令分隔符，
      // 所以像
      //   https://x.com/auth?response_type=code&client_id=abc&code_challenge=...
      // 这样的 OAuth URL 会被悄悄截断成
      //   https://x.com/auth?response_type=code
      // 用户浏览器最终看到的 URL 会缺少 client_id / redirect_uri / PKCE
      // challenge，Sentry 就会回 “Invalid redirect URI”。Node 的 argv quoting
      // 也不会替你把 `&` 变成 Windows 安全字符，因此即使把 URL 单独作为参数
      // 传进去也没用。
      //
      // `rundll32 url.dll,FileProtocolHandler <url>` 是 Win32 官方的默认浏览器
      // 协议处理器调用方式，它绕过 cmd，因此 `&` 会原样传递。
      spawnDetached('rundll32', ['url.dll,FileProtocolHandler', url])
      return
    }
    if (process.platform === 'darwin') {
      // macOS 的 `open` 对 URL 很稳，没有这些特殊坑。
      spawnDetached('open', [url])
      return
    }

    // Linux / *BSD 没有一个所有环境都通吃的命令。
    // xdg-open 是事实标准，但很多最小容器和服务器发行版里没有；
    // `gio open` 覆盖较新的 GNOME 栈；`wslview` 适合 WSL 调到 Windows 浏览器；
    // `kde-open` 和 `gnome-open` 则覆盖各自的传统桌面环境。
    //
    // 这里按顺序尝试，遇到 ENOENT 或非零退出就继续下一个。
    // 如果完全没有 opener，用户只能盯着终端发愣；所以我们至少写一条
    // `mcp.browser-open-no-opener` 调试日志，CLI 已经会把 URL 显示出来，用户
    // 也还能手动复制。
    const candidates: Array<[string, string[]]> = [
      ['xdg-open', [url]],
      ['gio', ['open', url]],
      ['wslview', [url]],
      ['kde-open', [url]],
      ['gnome-open', [url]],
    ]
    for (const [cmd, args] of candidates) {
      if (await trySpawnOpener(cmd, args)) return
    }

  } catch (err) {

  }
}

/**
 * 启动子进程、detach，然后离开。
 *
 * 适用于 Windows/macOS 这种 opener 已知靠谱的场景；失败只记调试日志。
 */
function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
  child.unref()
  child.on('error', (err) => {})
}

/**
 * 尝试一个 Linux URL opener 候选命令。
 *
 * 如果二进制存在，并且要么干净退出，要么在短暂宽限期后仍然存活，
 * 就返回 true。大多数 opener 会直接 exec 到浏览器然后几乎立刻退出，
 * 但少数（例如冷启动的 wslview）会 fork 并短暂保持运行。
 * 遇到 ENOENT 或非零退出时返回 false，让调用方尝试下一个候选。
 */
function trySpawnOpener(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    } catch {
      settle(false)
      return
    }
    child.on('error', () => settle(false))
    child.on('exit', (code) => {
      if (code === 0) {
        child.unref()
        settle(true)
      } else {
        settle(false)
      }
    })
    // 给 fork-and-stay-alive 的 opener 留一点宽限。500ms 远低于用户能感知的
    // 卡顿，但足够覆盖较慢的启动路径；到这时还活着的进程，基本就是真正
    // 负责拉起浏览器的那个。
    setTimeout(() => {
      if (!settled) {
        child.unref()
        settle(true)
      }
    }, 500)
  })
}

/**
 * loader.ts 使用的 factory。
 *
 * stdio 服务器不需要 OAuth，所以由 loader 跳过；这里返回的是 HTTP
 * 服务器专用的 provider 构造器。
 */
export function createOAuthProviderFactory(
  storage: McpTokenStorage,
  onOpenBrowser?: (serverName: string, url: string) => void,
) {
  return (serverName: string, serverUrl: string): McpOAuthProvider => {
    return new McpOAuthProvider({
      serverName,
      serverUrl,
      storage,
      onOpenBrowser: onOpenBrowser ? (url) => onOpenBrowser(serverName, url) : undefined,
    })
  }
}
