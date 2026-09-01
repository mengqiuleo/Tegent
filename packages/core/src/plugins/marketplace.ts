//   1. 读取和写入 `known_marketplaces.json`，也就是用户的订阅列表，同时保护
//      保留名称不被冒用。
//   2. 从直接指向 marketplace.json 的 HTTPS URL，或从 git URL 获取并缓存
//      marketplace 索引。git URL 会浅 clone，然后读取
//      `.claude-plugin/marketplace.json`，这是真实 Claude Code marketplace 发布时
//      使用的路径。
//   3. 把 marketplace.json 解析成类型化的 `Marketplace`，并把每个插件的 `source`
//      字段从磁盘 wire form（字符串快捷写法、`git-subdir`、`url` 等）归一化成内部
//      `PluginSource`，让 installer 只需要处理一种形状。
//   4. 根据 `name@marketplace` 插件 ID 查找安装来源。
import { execa } from 'execa'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { z } from 'zod'

import { knownMarketplacesPath, marketplaceDir, marketplaceIndexPath } from './paths.js'
import type { KnownMarketplace, KnownMarketplaces, Marketplace, MarketplaceEntry, PluginSource } from './types.js'


/**
 * 只有来源匹配规范上游时才允许注册的 marketplace 名称。
 *
 * 这可以阻止恶意发布者用自己的仓库注册 `anthropic-marketplace` 来冒充 Anthropic。
 * value 是期望的 GitHub org。
 */
export const RESERVED_MARKETPLACE_NAMES: Readonly<Record<string, string>> = {
  'anthropic-marketplace': 'anthropics',
  'claude-plugins': 'anthropics',
  'tegent-official': 'mengqiuleo',
}


/**
 * 把 marketplace `source` 字段从磁盘 wire form 转换为内部 `PluginSource`。
 *
 * | wire form                                                    | 归一化后的 PluginSource                          |
 * |--------------------------------------------------------------|--------------------------------------------------|
 * | `"./plugins/foo"` 或 `"../shared/x"`                         | `{kind:'git', url:<marketplace-clone-url>, subdir:'plugins/foo'}` |
 * | `"github:owner/repo[#ref]"`                                  | `{kind:'github', owner, repo, ref?}`             |
 * | `"https://..."` 或 `"git@..."`                               | `{kind:'git', url}`                              |
 * | `{source:'git-subdir', url, path, ref?, sha?}`               | `{kind:'git', url, ref?, subdir:path}`           |
 * | `{source:'url', url, sha?}`                                  | `{kind:'git', url}`                              |
 * | `{source:'git', url, ref?, subdir?}`                         | `{kind:'git', url, ref?, subdir?}`               |
 * | `{source:'github', owner, repo, ref?, subdir?}`              | `{kind:'github', owner, repo, ref?, subdir?}`    |
 * | `{source:'local', path}`                                     | `{kind:'local', path}`                           |
 * | `{kind:'git'\|'github'\|'local', ...}`（我们的旧形状）        | 原样透传 / 对齐到内部形状                        |
 *
 * 相对字符串形式（`./plugins/foo`）需要 marketplace 自己的 clone URL，因为我们会
 * 从该仓库中取 subdir。这个 URL 通过 `ctx.marketplaceCloneUrl` 传入；如果字符串
 * 是相对路径但没有上下文，则抛出错误。直接从 raw HTTPS 获取的 marketplace 显然
 * 没有宿主 repo，所以不能使用相对路径插件。
 *
 * `git-subdir` / `url` / `github` 中的 `sha` 字段会进入
 * `PluginSource.expectedSha`。它必须是 7-40 位 hex，并会被 installer 在 clone 后用
 * `git rev-parse HEAD` 做完整性检查，见 installer.ts 的 `fetchToTemp` sha 校验。
 * 非 hex 或形状错误的值会被静默丢弃，避免 typo 伪装成真实 mismatch。
 *
 * @param raw marketplace.json 中原始的 source 字段。
 * @param ctx 解析相对路径 source 所需的 marketplace 上下文。
 * @returns installer 可直接消费的内部插件来源。
 * @throws 当 source 形状未知或缺少必要字段时抛出 Error。
 */
export function normalizeMarketplaceSource(raw: unknown, ctx: { marketplaceCloneUrl?: string } = {}): PluginSource {
  if (typeof raw === 'string') {
    if (raw.startsWith('./') || raw.startsWith('../')) {
      const cloneUrl = ctx.marketplaceCloneUrl
      if (!cloneUrl) {
        throw new Error(
          `relative source "${raw}" requires the marketplace's own clone URL, but the marketplace was fetched without one (typically because it was loaded from a raw HTTPS URL rather than a git repo)`,
        )
      }
      const subdir = raw.replace(/^\.\//, '')
      return { kind: 'git', url: cloneUrl, subdir }
    }
    if (raw.startsWith('github:')) {
      const m = raw.match(/^github:([^/]+)\/(.+?)(?:#(.+))?$/i)
      if (!m) throw new Error(`invalid github source: ${raw}`)
      return { kind: 'github', owner: m[1]!, repo: m[2]!, ref: m[3] }
    }
    if (/^https?:\/\//i.test(raw) || raw.startsWith('git@')) {
      return { kind: 'git', url: raw }
    }
    throw new Error(`unrecognised source string: ${raw}`)
  }

  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const disc = (typeof o.source === 'string' ? o.source : (o.kind as string | undefined)) as string | undefined

    // 捕获可选的 `sha` 完整性 pin。这里接受长度至少 7 的 hex 字符串，
    // 与 Git short-sha 容忍度一致；installer 会做前缀比较，所以短 sha 也可用。
    // 非 hex 形状提前丢弃，否则 typo 可能掩盖真实攻击。
    const rawSha = typeof o.sha === 'string' ? o.sha.trim().toLowerCase() : undefined
    const expectedSha = rawSha && /^[0-9a-f]{7,40}$/.test(rawSha) ? rawSha : undefined

    if (disc === 'git-subdir') {
      if (typeof o.url !== 'string' || typeof o.path !== 'string') {
        throw new Error('git-subdir source requires `url` and `path`')
      }
      return {
        kind: 'git',
        url: o.url,
        subdir: o.path,
        ref: typeof o.ref === 'string' ? o.ref : undefined,
        expectedSha,
      }
    }
    if (disc === 'url') {
      if (typeof o.url !== 'string') throw new Error('url source requires `url`')
      return { kind: 'git', url: o.url, expectedSha }
    }
    if (disc === 'git') {
      if (typeof o.url !== 'string') throw new Error('git source requires `url`')
      return {
        kind: 'git',
        url: o.url,
        ref: typeof o.ref === 'string' ? o.ref : undefined,
        subdir: typeof o.subdir === 'string' ? o.subdir : undefined,
        expectedSha,
      }
    }
    if (disc === 'github') {
      // github 来源在真实世界有两种形状：
      //   { owner, repo, ref?, subdir? } —— owner / repo 分开写
      //   { repo: "owner/repo" } —— 合并的 slash 形式，真实
      //                              claude-plugins-official 条目里出现过
      let owner = typeof o.owner === 'string' ? o.owner : undefined
      let repo = typeof o.repo === 'string' ? o.repo : undefined
      if (!owner && repo && repo.includes('/')) {
        const slash = repo.indexOf('/')
        owner = repo.slice(0, slash)
        repo = repo.slice(slash + 1)
      }
      if (!owner || !repo) {
        throw new Error('github source requires `owner` + `repo` or `repo: "owner/repo"`')
      }
      const ref = typeof o.ref === 'string' ? o.ref : typeof o.commit === 'string' ? o.commit : undefined
      return {
        kind: 'github',
        owner,
        repo,
        ref,
        subdir: typeof o.subdir === 'string' ? o.subdir : undefined,
        expectedSha,
      }
    }
    if (disc === 'local') {
      if (typeof o.path !== 'string') throw new Error('local source requires `path`')
      return { kind: 'local', path: o.path }
    }
    throw new Error(
      `unknown source discriminator: ${disc ?? '(missing)'} — accepted: git-subdir, url, git, github, local`,
    )
  }

  throw new Error('source must be a string or object')
}


// zod 层只把 `source` 校验成“字符串或对象”；真实形状检查在
// `normalizeMarketplaceSource` 中完成。这个 union 的判别形式太多：
// 有些使用 `source`，有些使用 `kind`，不适合直接用 zod discriminated union。
const wireSourceSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())])

const wireEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  verified: z.boolean().optional(),
  source: wireSourceSchema,
  version: z.string().optional(),
  homepage: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  author: z.unknown().optional(),
})

const wireMarketplaceSchema = z.object({
  schemaVersion: z.string().optional(),
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  owner: z
    .object({
      name: z.string().optional(),
      url: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
  plugins: z.array(wireEntrySchema),
})

export class MarketplaceParseError extends Error {
  constructor(
    message: string,
    public readonly sourceLabel: string,
  ) {
    super(message)
    this.name = 'MarketplaceParseError'
  }
}

export interface ParseMarketplaceContext {
  /**
   * marketplace 自身仓库的 git clone URL。
   *
   * 它用于解析 `"./plugins/foo"` 这类相对字符串 source。从 raw HTTPS URL 获取
   * marketplace 时没有这个值，因为那种来源没有可引用的宿主 repo。
   */
  marketplaceCloneUrl?: string
}

/**
 * 解析并校验 marketplace.json 字符串。
 *
 * 函数会把每个插件条目的 `source` 归一化成内部 `PluginSource`。`sourceLabel`
 * 会出现在错误信息中，让用户知道具体哪个 marketplace 出了问题。
 *
 * @param raw marketplace.json 原始文本。
 * @param sourceLabel 用户订阅该 marketplace 时使用的别名。
 * @param ctx source 归一化所需的上下文。
 * @returns 类型化并归一化后的 marketplace。
 * @throws MarketplaceParseError JSON 或 schema 整体不合法时抛出。
 */
export function parseMarketplace(raw: string, sourceLabel: string, ctx: ParseMarketplaceContext = {}): Marketplace {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new MarketplaceParseError(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`, sourceLabel)
  }
  const result = wireMarketplaceSchema.safeParse(json)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new MarketplaceParseError(`invalid marketplace.json — ${issues}`, sourceLabel)
  }

  const normalised: MarketplaceEntry[] = []
  const sourceErrors: string[] = []
  for (let i = 0; i < result.data.plugins.length; i++) {
    const entry = result.data.plugins[i]!
    try {
      const source = normalizeMarketplaceSource(entry.source, ctx)
      normalised.push({
        name: entry.name,
        description: entry.description,
        category: entry.category,
        verified: entry.verified,
        version: entry.version,
        homepage: entry.homepage,
        keywords: entry.keywords,
        source,
      })
    } catch (err) {
      sourceErrors.push(`plugins.${i} (${entry.name}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (normalised.length === 0 && sourceErrors.length > 0) {
    throw new MarketplaceParseError(`no plugin entries parsed — ${sourceErrors.join('; ')}`, sourceLabel)
  }
  if (sourceErrors.length > 0) {
    
  }

  // `name` 使用调用方传入的订阅别名 sourceLabel，而不是上游 marketplace.json
  // 自声明的 `name` 字段。存储路径、安装 id 和 lookup 都以订阅别名为 key。
  // 如果 parseMarketplace 在这里泄漏上游 name，会导致
  // `plugin marketplace info <alias>` 失败，也会让 `plugin search` 标错
  // marketplace。上游自声明名称保存在 `upstreamName`，供 info 展示差异。
  return {
    schemaVersion: result.data.schemaVersion ?? '1',
    name: sourceLabel,
    upstreamName: result.data.name !== sourceLabel ? result.data.name : undefined,
    displayName: result.data.displayName,
    description: result.data.description,
    owner: result.data.owner ? { name: result.data.owner.name, url: result.data.owner.url } : undefined,
    plugins: normalised,
  }
}


/**
 * 创建一个全新的空订阅状态。
 *
 * 这里使用函数而不是共享 const，是为了让每次调用都返回新的 `marketplaces: []`。
 * 如果使用共享常量，一个调用方的 mutation 可能泄漏到下一个调用方的“空结果”里。
 *
 * @returns 空 KnownMarketplaces 对象。
 */
function freshKnown(): KnownMarketplaces {
  return { marketplaces: [] }
}

/**
 * 读取用户已订阅 marketplace 列表。
 *
 * 文件不存在、JSON 损坏或结构不符合预期时会降级为空状态, 不会阻塞 cli 启动
 *
 * @returns 当前 known_marketplaces.json 解析结果。
 */
export async function readKnownMarketplaces(): Promise<KnownMarketplaces> {
  const file = knownMarketplacesPath()
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return freshKnown()
    const obj = parsed as Record<string, unknown>
    const list = Array.isArray(obj.marketplaces) ? (obj.marketplaces as KnownMarketplace[]) : []
    return {
      marketplaces: list.filter((m) => m && typeof m.name === 'string' && typeof m.source === 'string'),
      strictKnownMarketplaces:
        typeof obj.strictKnownMarketplaces === 'boolean' ? obj.strictKnownMarketplaces : undefined,
      blockedPlugins: Array.isArray(obj.blockedPlugins)
        ? (obj.blockedPlugins as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return freshKnown()
    return freshKnown()
  }
}

/**
 * 写入用户已订阅 marketplace 列表。
 *
 * 使用 read-modify-write，避免未来新增的无关字段被当前版本覆盖掉。
 *
 * @param km 要写入的 marketplace 订阅状态。
 */
async function writeKnownMarketplaces(km: KnownMarketplaces): Promise<void> {
  const file = knownMarketplacesPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch {

  }
  existing.marketplaces = km.marketplaces
  if (km.strictKnownMarketplaces !== undefined) existing.strictKnownMarketplaces = km.strictKnownMarketplaces
  if (km.blockedPlugins !== undefined) existing.blockedPlugins = km.blockedPlugins
  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
}

/**
 * 确保默认 marketplace 订阅存在。
 *
 * CLI 启动时会调用它，让全新安装的用户默认订阅 Anthropic 官方 marketplace，
 * 因而 `/plugin search` 不需要用户手动添加订阅就能返回结果。函数是幂等的：
 * 它不会覆盖已有条目，因此用户如果主动移除了默认订阅，也不会被这里重新加回。
 *
 * 默认目标是 `anthropics/claude-plugins-official`，而不是
 * `anthropics/claude-code` 里更小的内置 marketplace；专用仓库才是规范发现面。
 */
export async function ensureDefaultMarketplaces(): Promise<void> {
  const km = await readKnownMarketplaces()
  const haveAnthropic = km.marketplaces.some((m) => m.name === 'anthropic-marketplace')
  if (haveAnthropic) return

  try {
    await addKnownMarketplace({
      name: 'anthropic-marketplace',
      source: 'github:anthropics/claude-plugins-official',
    })
  } catch (err) {
  }
}

/**
 * 注册一个新的 marketplace 订阅。
 *
 * 如果名称是保留名称，但 source 不匹配规范上游，则拒绝注册；规则见
 * RESERVED_MARKETPLACE_NAMES。函数是幂等的：重复添加同名订阅会更新 source。
 * 增加或移除订阅，是将原文件中的内容读取出来，修改后再写回
 * @param entry 要注册或更新的 marketplace 订阅条目。
 * @throws 当保留名称指向非规范来源时抛出 Error。
 */
export async function addKnownMarketplace(entry: KnownMarketplace): Promise<void> {
  const reservedOrg = RESERVED_MARKETPLACE_NAMES[entry.name]
  if (reservedOrg !== undefined) {
    if (!sourceMatchesOrg(entry.source, reservedOrg)) {
      throw new Error(
        `Marketplace name "${entry.name}" is reserved; only sources under github:${reservedOrg}/* may use it. ` +
          `Got: ${entry.source}`,
      )
    }
    entry.reservedName = true
    entry.officialSource = reservedOrg
  }

  const km = await readKnownMarketplaces()
  const idx = km.marketplaces.findIndex((m) => m.name === entry.name)
  if (idx >= 0) {
    km.marketplaces[idx] = entry
  } else {
    km.marketplaces.push(entry)
  }
  await writeKnownMarketplaces(km)
}

/**
 * 移除一个 marketplace 订阅。
 *
 * @param name marketplace 订阅别名。
 * @returns `'removed'` 表示已移除，`'noop'` 表示原本不存在。
 */
export async function removeKnownMarketplace(name: string): Promise<'removed' | 'noop'> {
  const km = await readKnownMarketplaces()
  const before = km.marketplaces.length
  km.marketplaces = km.marketplaces.filter((m) => m.name !== name)
  if (km.marketplaces.length === before) return 'noop'
  await writeKnownMarketplaces(km)
  return 'removed'
}

/**
 * 判断 source 字符串是否指向期望的 GitHub org。
 *
 * @param source 用户提供的 marketplace source。
 * @param expectedOrg 保留名称允许的 GitHub org。
 * @returns source 是 `github:org/repo` 或 `https://github.com/org/repo` 且 org 匹配时为 true。
 */
function sourceMatchesOrg(source: string, expectedOrg: string): boolean {
  // 接受 `github:org/repo[...]` 和 `https://github.com/org/repo[...]` 两种写法。
  const ghShort = source.match(/^github:([^/]+)\//i)
  if (ghShort) return ghShort[1]!.toLowerCase() === expectedOrg.toLowerCase()
  const ghHttps = source.match(/^https?:\/\/github\.com\/([^/]+)\//i)
  if (ghHttps) return ghHttps[1]!.toLowerCase() === expectedOrg.toLowerCase()
  return false
}


export interface FetchOptions {
  signal?: AbortSignal
  /** 如果缓存索引存在且比这个阈值更新，则跳过网络请求。 */
  maxAgeMs?: number
}

/**
 * 拉取 marketplace.json，写入本地缓存，并解析为 Marketplace。
 *
 * 支持两种 source 形状：
 *
 * - `https://...` 或 `http://...`：直接指向 marketplace.json 的 URL。
 * - 其他来源（`github:owner/repo`、普通 git URL）：浅 clone 仓库，然后读取
 *   `.claude-plugin/marketplace.json`。这是 Claude Code 的规范路径，可参考
 *   `anthropics/claude-code` 和 `anthropics/claude-plugins-official` 的布局。
 *
 * 返回前会把原始 JSON 写入
 * `~/.tegent/plugins/marketplaces/<name>/marketplace.json`。
 *
 * @param entry 已订阅 marketplace 条目。
 * @param opts 获取选项，包括 AbortSignal 和缓存新鲜度阈值。
 * @returns 解析后的 marketplace。
 */
export async function fetchMarketplace(entry: KnownMarketplace, opts: FetchOptions = {}): Promise<Marketplace> {
 // 比如 entry.name = 'anthropic-marketplace'，那就是： ~/.tegent/plugins/marketplaces/anthropic-marketplace/marketplace.json
  const cachedPath = marketplaceIndexPath(entry.name)

  // 如果传了 maxAgeMs，并且本地缓存还够新，就直接读本地文件，不重新下载：
  if (opts.maxAgeMs !== undefined) {
    const fresh = await isFreshEnough(cachedPath, opts.maxAgeMs)
    if (fresh) {
      const raw = await fs.readFile(cachedPath, 'utf-8')
      return parseMarketplace(raw, entry.name, contextForKnownEntry(entry))
    }
  }

  // 判断 marketplace 来源是“直接 URL JSON”还是“git 仓库”：
  const isHttp = /^https?:\/\//i.test(entry.source) && /\.json($|\?)/i.test(entry.source)
  const rawJson = isHttp
    ? await fetchHttpJson(entry.source, opts.signal) // eg: https://example.com/marketplace.json
    : await fetchViaShallowClone(entry.source, opts.signal) // eg: github:anthropics/claude-plugins-official

// 它不是下载完就直接覆盖本地索引，而是先 parse 成功后再写文件。如果远端 marketplace.json 坏了，本地缓存不会被坏内容覆盖。
  const marketplace = parseMarketplace(rawJson, entry.name, contextForKnownEntry(entry))

  await fs.mkdir(marketplaceDir(entry.name), { recursive: true })
  await fs.writeFile(cachedPath, rawJson, 'utf-8')

  return marketplace
}

/**
 * 根据订阅条目构建 `ParseMarketplaceContext`。
 *
 * 对 git-cloned marketplace，它提供 clone URL，让 `"./plugins/foo"` 这类相对
 * source 能解析到 marketplace 自身仓库的 subdir。对 raw HTTPS marketplace，
 * 没有 clone URL；其中的相对 source 会归一化失败，这是正确行为，因为没有 repo
 * 可供引用。
 *
 * @param entry 已订阅 marketplace 条目。
 * @returns source 归一化上下文。
 */
function contextForKnownEntry(entry: KnownMarketplace): ParseMarketplaceContext {
  const isRawHttps = /^https?:\/\//i.test(entry.source) && /\.json($|\?)/i.test(entry.source)
  if (isRawHttps) return {}
  return { marketplaceCloneUrl: resolveCloneUrl(entry.source) }
}

/**
 * 判断缓存文件是否足够新。
 *
 * @param filePath 缓存文件路径。
 * @param maxAgeMs 允许的最大缓存年龄。
 * @returns 文件存在且 mtime 距当前时间不超过 maxAgeMs 时为 true。
 */
async function isFreshEnough(filePath: string, maxAgeMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return Date.now() - stat.mtimeMs <= maxAgeMs
  } catch {
    return false
  }
}

/**
 * 从 HTTP(S) URL 获取 marketplace JSON 文本。
 *
 * @param url 指向 marketplace.json 的 URL。
 * @param signal 可选取消信号。
 * @returns 响应文本。
 * @throws 当 HTTP 状态不是 2xx 时抛出 Error。
 */
async function fetchHttpJson(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`)
  }
  return res.text()
}

/**
 * 浅 clone 指定 marketplace 仓库，并返回其中 marketplace 索引内容。
 *
 * 函数会先探测规范路径 `.claude-plugin/marketplace.json`，再回退到根目录
 * `marketplace.json` 以兼容非标准布局。无论成功与否，临时 clone 目录都会在返回前
 * 清理。
 *
 * @param source marketplace source 字符串。
 * @param signal 可选取消信号。
 * @returns marketplace.json 的原始文本。
 */
async function fetchViaShallowClone(source: string, signal?: AbortSignal): Promise<string> {
  const cloneUrl = resolveCloneUrl(source)
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tegent-marketplace-'))
  try {
    await execa('git', ['clone', '--depth', '1', cloneUrl, tempDir], { signal, stdio: 'pipe' })
    const candidates = [
      path.join(tempDir, '.claude-plugin', 'marketplace.json'),
      path.join(tempDir, 'marketplace.json'),
    ]
    for (const candidate of candidates) {
      try {
        return await fs.readFile(candidate, 'utf-8')
      } catch {

      }
    }
    throw new Error(
      `marketplace repo ${cloneUrl} has no .claude-plugin/marketplace.json (also tried root marketplace.json)`,
    )
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {

    })
  }
}

/**
 * 把 source 字符串转换成 `git clone` 可理解的 URL。
 *
 * `github:owner/repo` 会转换成 `https://github.com/owner/repo.git`；其他形式，
 * 例如真实 git URL、ssh URL 等，原样返回。
 *
 * @param source marketplace 或插件来源字符串。
 * @returns 可传给 `git clone` 的 URL。
 */
export function resolveCloneUrl(source: string): string {
  const m = source.match(/^github:([^/]+)\/(.+?)(?:\.git)?$/i)
  if (m) {
    return `https://github.com/${m[1]}/${m[2]}.git`
  }
  return source
}


/**
 * 读取所有已缓存的 marketplace 索引。
 *
 * `/plugin search` 和 `/plugin install <name@marketplace>` 查询会使用它。
 * 缓存损坏的 marketplace 会被跳过并写 debug log；单个坏缓存不影响其他
 * marketplace。
 *
 * @returns 成功解析的 marketplace 列表。
 */
export async function readAllCachedMarketplaces(): Promise<Marketplace[]> {
  const km = await readKnownMarketplaces()
  const out: Marketplace[] = []
  for (const entry of km.marketplaces) {
    try {
      const raw = await fs.readFile(marketplaceIndexPath(entry.name), 'utf-8')
      out.push(parseMarketplace(raw, entry.name, contextForKnownEntry(entry)))
    } catch (err) {
    }
  }
  return out
}

/**
 * 通过 `name@marketplace` ID 查找单个插件条目。
 *
 * 如果 marketplace 未订阅、缓存不可读，或插件不在索引中，则返回 `undefined`。
 *
 * @param pluginId 形如 `name@marketplace` 的插件 ID。
 * @returns 匹配的 marketplace 和 entry；找不到时为 `undefined`。
 */
export async function lookupPlugin(
  pluginId: string,
): Promise<{ marketplace: Marketplace; entry: MarketplaceEntry } | undefined> {
  const at = pluginId.lastIndexOf('@')
  if (at <= 0) return undefined
  const pluginName = pluginId.slice(0, at)
  const marketplaceName = pluginId.slice(at + 1)

  const km = await readKnownMarketplaces()
  const known = km.marketplaces.find((m) => m.name === marketplaceName)

  try {
    const raw = await fs.readFile(marketplaceIndexPath(marketplaceName), 'utf-8')
    const m = parseMarketplace(raw, marketplaceName, known ? contextForKnownEntry(known) : {})
    const entry = m.plugins.find((p) => p.name === pluginName)
    if (!entry) return undefined
    return { marketplace: m, entry }
  } catch {
    return undefined
  }
}
