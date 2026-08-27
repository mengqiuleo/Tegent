// 本文件会在 127.0.0.1:<随机端口>/callback 上启动一个临时 HTTP 服务器，
// 等待授权服务器把用户浏览器重定向回来，然后返回捕获到的 `code`
// 和 `state`（或错误）。收到第一次有效请求或超时后会自动关闭。
//
// 为什么使用临时随机端口：
//   - 固定端口在同时运行两个 CLI 时容易冲突；
//   - 随机端口只有在监听器启动后才能知道，所以 `start()` 必须先返回
//     实际 URL，OAuth provider 再把这个 URL 告诉授权服务器。
//
// 安全边界：
//   - 只绑定 127.0.0.1，绝不绑定 0.0.0.0，避免局域网其他机器访问；
//   - 只接受第一次匹配请求，后续请求只会看到“授权已完成”的友好页面；
//   - 这里不校验 `state`，那是 SDK 的职责；本层只原样转发授权服务器返回值。
import http from 'node:http'
import { AddressInfo } from 'node:net'


export interface CallbackResult {
  code: string
  state?: string
}

export interface RunningCallbackServer {
  /** 要注册 / 传给授权服务器的完整 redirect URL。 */
  url: string
  /** 首次有效 callback 到达时 resolve code/state；
   *  超时或授权服务器返回 OAuth error 时 reject。 */
  waitForCallback: () => Promise<CallbackResult>
  /** 停止接受新连接并释放端口。幂等。 */
  close: () => void
}

export interface StartOptions {
  /** 最大等待时间，单位毫秒；默认 5 分钟。 */
  timeoutMs?: number
  /** 授权服务器应回跳到的路径，默认 `/callback`。 */
  path?: string
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_PATH = '/callback'

/**
 * 启动本地监听器，并把实际 URL 返回给调用方。
 *
 * 调用方拿到 URL 后会把它交给 OAuth provider；真正等待授权回调的动作，
 * 通过返回对象上的 `waitForCallback()` promise 完成。
 *
 * @param options 回调路径和超时时间。
 * @returns 正在运行的回调服务器句柄。
 */
export async function startCallbackServer(options: StartOptions = {}): Promise<RunningCallbackServer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const expectedPath = options.path ?? DEFAULT_PATH

  let resolveOnce: ((r: CallbackResult) => void) | null = null
  let rejectOnce: ((e: Error) => void) | null = null

  const waiter = new Promise<CallbackResult>((res, rej) => {
    resolveOnce = res
    rejectOnce = rej
  })

  const server = http.createServer((req, response) => {
    if (!req.url) {
      response.writeHead(400).end('missing URL')
      return
    }
    // req.url 只有路径和查询串，所以用假的 base 来解析；
    // 本逻辑只关心 pathname 和 searchParams。
    const u = new URL(req.url, 'http://localhost')
    if (u.pathname !== expectedPath) {
      response.writeHead(404).end('not found')
      return
    }

    const err = u.searchParams.get('error')
    if (err) {
      const desc = u.searchParams.get('error_description') ?? ''
      response
        .writeHead(400, { 'Content-Type': 'text/html' })
        .end(`<html><body><h1>Authorization failed</h1><p>${escapeHtml(err)}: ${escapeHtml(desc)}</p></body></html>`)
      rejectOnce?.(new Error(`OAuth callback error: ${err} ${desc}`.trim()))
      resolveOnce = null
      rejectOnce = null
      return
    }

    const code = u.searchParams.get('code')
    if (!code) {
      response.writeHead(400).end('missing code')
      rejectOnce?.(new Error('OAuth callback missing `code` parameter'))
      resolveOnce = null
      rejectOnce = null
      return
    }

    const state = u.searchParams.get('state') ?? undefined
    response
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        `<html><body style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto;">` +
          `<h1>Authorization complete</h1>` +
          `<p>You can close this tab and return to the Tegent.</p>` +
          `</body></html>`,
      )
    resolveOnce?.({ code, state })
    resolveOnce = null
    rejectOnce = null
  })

  // 监听 socket 错误，避免连接重置直接打崩 CLI。
  // Windows 上 ECONNRESET 更常见，所以这里尤其重要。
  server.on('error', (err) => {
    rejectOnce?.(err)
    resolveOnce = null
    rejectOnce = null
  })

  // 绑定临时端口。listen(0, '127.0.0.1') 表示向操作系统申请任意空闲端口；
  // 真正的端口号需要从 address() 里取。
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const addr = server.address() as AddressInfo
  const url = `http://127.0.0.1:${addr.port}${expectedPath}`

  const timeoutHandle = setTimeout(() => {
    rejectOnce?.(new Error(`OAuth callback timed out after ${timeoutMs}ms`))
    resolveOnce = null
    rejectOnce = null
  }, timeoutMs)
  // 不管 promise 成功还是失败，都清理超时定时器。
  void waiter.finally(() => clearTimeout(timeoutHandle))

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    server.close()
  }
  // 单次 callback 处理完成后自动关闭服务器。
  void waiter.finally(close)

  return { url, waitForCallback: () => waiter, close }
}

/**
 * 对嵌入 HTML 页面里的文本做最小转义。
 *
 * @param s 未信任的字符串。
 * @returns 安全放进 HTML 文本位置的字符串。
 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}
