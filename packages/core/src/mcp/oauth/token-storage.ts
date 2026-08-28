// 所有状态都写入一个文件：~/.tegent/mcp-auth.json
//
//   {
//     "sentry": {
//       "url": "https://mcp.sentry.dev",
//       "clientInformation": { client_id: "...", client_secret: "...", ... },
//       "tokens":            { access_token: "...", refresh_token: "...", expires_in: 3600, ... }
//     },
//     ...
//   }
//
// POSIX 上权限设为 0o600（只有当前用户可读写）。Windows 会忽略 mode 位，
// 但文件位于用户目录下，能访问它的仍主要是同一用户的程序。
// 写入采用临时文件 + rename 的原子方式，避免进程中途崩溃导致已知可用的
// token 文件损坏。
//
// SDK 的 `OAuthClientProvider` 接口（见 ../oauth/provider.ts）才是真正消费者；
// 本模块只负责最底层的持久化。
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import fs from 'node:fs/promises'
import path from 'node:path'

import {  userTeCodeDir } from '../../utils.js'

function authFile(): string {
  return path.join(userTeCodeDir(), 'mcp-auth.json')
}

export interface StoredServerAuth {
  /** 服务器 URL：如果用户后来把配置指向别的部署，可以据此判断旧 token 不属于它。 */
  url: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  /** 最近一次拿到 token 的 UTC ISO 时间。
   *  OAuth 的 `expires_in` 是相对发放时间的，所以要靠它本地计算绝对过期时间。 */
  tokensIssuedAt?: string
}

type FileShape = Record<string, StoredServerAuth>

export class McpTokenStorage {
  private cache: FileShape | null = null

  async get(serverName: string): Promise<StoredServerAuth | undefined> {
    await this.ensureLoaded()
    return this.cache![serverName]
  }

  async setClientInformation(serverName: string, url: string, info: OAuthClientInformationMixed): Promise<void> {
    await this.ensureLoaded()
    const entry = (this.cache![serverName] ??= { url })
    entry.url = url
    entry.clientInformation = info
    await this.flush()
  }

  async setTokens(serverName: string, url: string, tokens: OAuthTokens): Promise<void> {
    await this.ensureLoaded()
    const entry = (this.cache![serverName] ??= { url })
    entry.url = url
    entry.tokens = tokens
    entry.tokensIssuedAt = new Date().toISOString()
    await this.flush()
  }

  async clear(serverName: string): Promise<void> {
    await this.ensureLoaded()
    if (this.cache![serverName]) {
      delete this.cache![serverName]
      await this.flush()
    }
  }

  async listServers(): Promise<Array<{ name: string; url: string; hasTokens: boolean }>> {
    await this.ensureLoaded()
    return Object.entries(this.cache!).map(([name, entry]) => ({
      name,
      url: entry.url,
      hasTokens: !!entry.tokens,
    }))
  }

  // ── 辅助方法 ──────────────────────────────────────────────────────────

  /**
   * 根据 issuedAt + expires_in 计算绝对过期时间。
   *
   * 任一信息缺失时返回 undefined。某些服务器不提供过期信息，
   * 这时调用方可以先乐观使用 token，等 401 再触发刷新。
   */
  static expiresAt(stored: StoredServerAuth | undefined): number | undefined {
    const t = stored?.tokens
    if (!t) return undefined
    if (typeof t.expires_in !== 'number') return undefined
    const issued = stored.tokensIssuedAt ? Date.parse(stored.tokensIssuedAt) : NaN
    if (Number.isNaN(issued)) return undefined
    return issued + t.expires_in * 1000
  }

  /**
   * 判断存储的 token 是否“看起来还能用”。
   *
   * 只有在 token 存在且不会在接下来的 `skewMs` 窗口内过期时才返回 true。
   * 如果不知道过期时间，则返回 true，让下一次 401 再驱动刷新。
   */
  static isAccessTokenLikelyValid(stored: StoredServerAuth | undefined, skewMs = 60_000): boolean {
    if (!stored?.tokens?.access_token) return false
    const expiresAt = McpTokenStorage.expiresAt(stored)
    if (expiresAt === undefined) return true
    return Date.now() + skewMs < expiresAt
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.cache !== null) return
    this.cache = await readFile()
  }

  private async flush(): Promise<void> {
    if (!this.cache) return
    try {
      await fs.mkdir(userTeCodeDir(), { recursive: true })
      const tmp = authFile() + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      })
      await fs.rename(tmp, authFile())
    } catch (err) {

    }
  }
}

async function readFile(): Promise<FileShape> {
  try {
    const raw = await fs.readFile(authFile(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as FileShape
    }
  } catch {
    // 文件缺失或损坏时，从空状态开始。
  }
  return {}
}

/**
 * 单例实例。
 *
 * CLI 启动时构造一次，把它传给 loadMcpServers（后者会再传给每个服务器的
 * OAuth provider）以及 `/mcp auth` / `/mcp logout` 处理器。
 */
let globalInstance: McpTokenStorage | null = null
export function getTokenStorage(): McpTokenStorage {
  if (!globalInstance) globalInstance = new McpTokenStorage()
  return globalInstance
}

/**
 * 测试钩子：替换单例，避免单元测试直接碰 ~/.tegent。
 *
 * 注意：X_CODE_HOME 也会重定向文件路径，所以大多数测试只要设置这个环境变量，
 * 就不用走这个钩子了。
 */
export function setTokenStorageForTesting(s: McpTokenStorage | null): void {
  globalInstance = s
}

export type { OAuthClientInformationFull, OAuthClientInformationMixed, OAuthTokens }
