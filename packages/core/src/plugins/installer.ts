// 当前支持三类安装来源：
//
//   - 'local'   文件系统目录 → 递归复制到缓存
//                （跳过 .git / node_modules / OS 垃圾文件）
//   - 'git'     任意 git URL → 浅 clone（depth 1，可选 ref）
//   - 'github'  github:owner/repo → 通过 resolveCloneUrl 转换后浅 clone
//                支持 monorepo `subdir`：先浅 clone 整个 repo，再把指定 subdir
//                复制进新的临时目录，其余内容丢弃。
//
// 安装流程：
//   1. 把来源内容获取到临时目录
//   2. 发现并解析 manifest（这里会拒绝 Gemini-only 来源）
//   3. 计算最终缓存路径：cache/<marketplace>/<plugin>/<version>/
//   4. 清理该路径下已有安装（重装 / 同版本升级）
//   5. 把临时目录移动到最终目录（能 rename 就 rename，EXDEV 等情况 fallback 到 copy+rm）
//   6. 追加或更新 installed_plugins.json
//
// AbortSignal 会贯穿 git clone（通过 execa 的 `signal`）和递归复制（每个目录项之间
// 协作式检查），因此长安装过程中按 Esc 可以干净取消正在进行的工作。
//
// 缓存布局刻意按版本分目录，未来 `/plugin update` 可以并排安装新版本并原子切换；
// 当前实现只覆盖同版本安装。
import { execa } from 'execa'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { type ConsentPreview, buildConsentPreview, probePluginRoot } from './consent.js'
import { ManifestParseError, discoverManifest, parseManifest } from './manifest.js'
import { RESERVED_MARKETPLACE_NAMES, readKnownMarketplaces, resolveCloneUrl } from './marketplace.js'
import { installedPluginsPath, pluginCacheDir, pluginCacheParent } from './paths.js'
import type {
  InstalledPluginRecord,
  InstalledPlugins,
  ManifestFormat,
  PluginManifest,
  PluginScope,
  PluginSource,
} from './types.js'
import { type UserConfigValue, setPluginUserConfig } from './user-config.js'

export interface InstallRequest {
  source: PluginSource
  /**
   * 插件所属 marketplace。
   *
   * 对不属于已订阅 marketplace 的直接 git / local 安装使用 `"local"`，最终 plugin id
   * 会是 `<name>@local`。
   */
  marketplace: string
  /**
   * 安装记录所属作用域。
   *
   * 这决定哪个 settings.json 的 `enabledPlugins` map 会记录它。默认是 `'user'`。
   */
  scope?: PluginScope
  /**
   * 期望的 manifest.name。
   *
   * 设置后，如果下载到的 manifest `name` 不匹配，installer 会中止。marketplace
   * 安装路径用它防止条目冒名顶替。
   */
  expectedName?: string
  /**
   * marketplace 条目是否标记为 verified。
   *
   * 这个信息会传给 consent callback，让用户知道该条目是否得到维护者背书。它只是
   * metadata，系统不会因为该标记授予额外信任。
   */
  verified?: boolean
  /**
   * 安装授权回调。
   *
   * 它在 manifest 解析之后、临时目录移动到缓存之前被调用。返回 false 会中止安装，
   * 临时目录会被清理，缓存不受影响。未提供时安装不提示直接继续，测试和 CLI
   * `--yes` 路径会使用这种行为。
   */
  consent?: (preview: ConsentPreview) => Promise<boolean> | boolean
  /**
   * userConfig 收集回调。
   *
   * 当 manifest 声明 `userConfig` 且 consent 已通过后调用。调用方通常是 CLI / TUI
   * handler，它会逐项提示用户输入，对 `sensitive: true` 字段做掩码，然后返回
   * `{ key: value }` 映射，并由 user-config.ts 持久化。返回 `null` 会中止安装，
   * 语义等同于拒绝授权。未提供时跳过提示：非敏感字段由调用方 / 插件侧使用 manifest
   * 默认值，敏感字段保持未设置，插件 hooks / MCP 条目会看到空 env，与旧行为一致。
   */
  userConfigPrompt?: (fields: PluginManifest['userConfig']) => Promise<Record<string, UserConfigValue> | null>
  signal?: AbortSignal
}

export interface InstallResult {
  pluginId: string
  rootDir: string
  manifest: PluginManifest
  manifestFormat: ManifestFormat
  record: InstalledPluginRecord
}

/**
 * 安装失败时抛出的领域错误。
 *
 * 调用方可以用它和底层 I/O、JSON、git 错误区分开，展示更友好的插件安装消息。
 */
export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

/**
 * 安装一个插件。
 *
 * 函数会执行来源获取、manifest 发现和解析、策略检查、授权预览、userConfig 收集、
 * 缓存提交以及 installed_plugins.json 账本更新。中途失败时会尽力清理临时目录。
 *
 * @param req 安装请求，包含来源、marketplace、作用域、可选授权回调和取消信号。
 * @returns 安装完成后的 plugin id、根目录、manifest、manifest 格式和账本记录。
 * @throws InstallError 安装策略、来源获取、manifest、授权或缓存提交失败时抛出。
 */
export async function installPlugin(req: InstallRequest): Promise<InstallResult> {
  // ── 安装前策略检查（便宜，尽早失败） ──
  // `strictKnownMarketplaces` 和 `blockedPlugins` 来自
  // ~/.tegent/plugins/known_marketplaces.json。管理员（通常是企业场景）开启严格模式后，
  // 所有安装都必须来自已订阅 marketplace；直接 git / github / local 安装会被拒绝。
  // `blockedPlugins` 要等 manifest 解析后检查，因为需要规范 plugin id。
  const km = await readKnownMarketplaces()
  if (km.strictKnownMarketplaces) {
    const subscribed = km.marketplaces.some((m) => m.name === req.marketplace)
    if (!subscribed) {
      throw new InstallError(
        `strict marketplace mode is enabled (known_marketplaces.json:strictKnownMarketplaces=true) — ` +
          `plugins can only be installed from a subscribed marketplace, but "${req.marketplace}" is not one. ` +
          `Either subscribe it first (\`xc plugin marketplace add\`) or turn strict mode off.`,
      )
    }
  }

  const tempDir = await fetchToTemp(req.source, req.signal)

  try {
    const discovery = await discoverManifest(tempDir)
    if (!discovery) {
      throw new InstallError(
        'no plugin manifest found in source (looked for .tegent-plugin/plugin.json, .claude-plugin/plugin.json, plugin.json)',
      )
    }
    if (discovery.format === 'gemini') {
      throw new InstallError(
        'this is a Gemini extension (gemini-extension.json) — tegent-cli does not support Gemini extensions; see docs/plugins.md',
      )
    }

    let manifest: PluginManifest
    try {
      manifest = await parseManifest(discovery.manifestPath)
    } catch (err) {
      if (err instanceof ManifestParseError) throw new InstallError(err.message)
      throw err
    }

    if (req.expectedName && manifest.name !== req.expectedName) {
      throw new InstallError(`manifest name "${manifest.name}" does not match expected "${req.expectedName}"`)
    }

    // 此时已经知道规范 plugin id，可以执行第二个策略检查：
    // known_marketplaces.json 中的 blockedPlugins。这是偏管理员的强制禁用列表；
    // 命中的插件无论 marketplace 或 consent 如何，安装都会被拒绝。
    // 支持两种匹配形式：
    //   - 完整 id `name@marketplace`：精确阻止某个 marketplace 版本，不影响 fork
    //   - 裸 name `name`：广泛阻止所有 marketplace 中的同名插件，符合一些管理员对
    //     npm `--ignore` 风格的预期
    const earlyId = `${manifest.name}@${req.marketplace}`
    const blocked = km.blockedPlugins?.find((b) => b === earlyId || b === manifest.name)
    if (blocked) {
      throw new InstallError(
        `plugin "${earlyId}" is on the blockedPlugins list in known_marketplaces.json ` +
          `(matched entry: "${blocked}") — remove it from that list (or use a different plugin) to install.`,
      )
    }

    // ── 授权门禁 ──
    // 授权预览基于已解析 manifest 构建，调用方可以展示插件将贡献的内容
    // （hooks、mcp、作用域等），并显式询问用户。callback 缺失时跳过提示是有意为之：
    // 非交互路径和 CLI `--yes` 都通过不传 `consent` 实现。
    if (req.consent) {
      const rootProbe = await probePluginRoot(tempDir)
      const preview = buildConsentPreview({
        pluginId: `${manifest.name}@${req.marketplace}`,
        manifest,
        source: req.source,
        marketplace: req.marketplace,
        verified: req.verified,
        fromReservedMarketplace: req.marketplace in RESERVED_MARKETPLACE_NAMES,
        rootProbe,
      })
      const accepted = await req.consent(preview)
      if (!accepted) {
        throw new InstallError('install cancelled by user (consent declined)')
      }
    }

    // ── userConfig 提示（授权之后，提交缓存之前） ──
    // 只有 manifest 声明 userConfig 字段且调用方传入 prompt callback 时才触发。
    // 非交互路径（--yes、CI）会跳过提示，字段保持未设置；插件在 hook / mcp 启动时
    // 会看到空 env，和引入该功能前的行为一致。
    // prompt 返回 null 会中止安装，按拒绝授权处理；非 null 对象会通过
    // setPluginUserConfig 持久化。
    if (manifest.userConfig && manifest.userConfig.length > 0 && req.userConfigPrompt) {
      const collected = await req.userConfigPrompt(manifest.userConfig)
      if (collected === null) {
        throw new InstallError('install cancelled by user (userConfig prompt aborted)')
      }
      // 在临时目录移动到缓存前持久化配置。这样如果两个阶段之间崩溃，
      // 用户不会得到半坏插件，也不会产生无法关联的孤立 secret。
      // 配置文件以 plugin id 为 key，重装时可以干净覆盖。
      const pluginIdForConfig = `${manifest.name}@${req.marketplace}`
      await setPluginUserConfig(pluginIdForConfig, collected)
    }

    const finalDir = pluginCacheDir(req.marketplace, manifest.name, manifest.version)

    // 同版本重装：先删除已有安装。否则如果新包移除了旧包里的某个文件，
    // 旧文件会残留并和新文件混在一起。
    await fs.rm(finalDir, { recursive: true, force: true })
    await fs.mkdir(path.dirname(finalDir), { recursive: true })
    await moveOrCopy(tempDir, finalDir, req.signal)

    const pluginId = `${manifest.name}@${req.marketplace}`
    const record: InstalledPluginRecord = {
      id: pluginId,
      name: manifest.name,
      marketplace: req.marketplace,
      version: manifest.version,
      source: req.source,
      installedAt: new Date().toISOString(),
      installScope: req.scope ?? 'user',
    }
    await recordInstallation(record)

    return { pluginId, rootDir: finalDir, manifest, manifestFormat: discovery.format, record }
  } catch (err) {
    // 安装中途失败时尽力清理临时目录。moveOrCopy 成功路径会把 temp rename 走，
    // 所以这里主要处理移动前发生错误的情况。
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
      /* 清理失败时没有更有用的恢复动作，保留原始安装错误即可。 */
    })
    if (err instanceof InstallError || err instanceof ManifestParseError) throw err
    throw new InstallError(err instanceof Error ? err.message : String(err))
  }
}

// ── 来源 → 临时目录 ───────────────────────────────────────────────────

/**
 * 把插件来源获取到一个新的临时目录。
 *
 * local 来源会递归复制目录；git / github 来源会浅 clone，必要时再抽取 subdir。
 * 调用方拿到的目录就是后续 manifest discovery 的根目录。
 *
 * @param source 插件来源。
 * @param signal 可选取消信号，会传给 git clone 和递归复制。
 * @returns 包含插件内容的临时目录路径。
 * @throws InstallError 来源不可用、clone 失败、subdir 缺失或 sha 校验失败时抛出。
 */
async function fetchToTemp(source: PluginSource, signal?: AbortSignal): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-install-'))

  if (source.kind === 'local') {
    const resolved = path.resolve(source.path)
    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat || !stat.isDirectory()) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      // 错误中展示 cwd：相对路径会基于 process.cwd() 解析；当 xc 通过 `pnpm dev`
      // 启动时 cwd 可能是 `packages/cli/` 而不是仓库根目录。用户在 slash command
      // 中输入 `./foo` 时容易被这个差异困住，同时展示解析后的绝对路径和 cwd
      // 能让原因更明显。
      const isRelative = !path.isAbsolute(source.path)
      const cwdHint = isRelative ? ` (resolved relative to cwd: ${process.cwd()})` : ''
      throw new InstallError(`local source is not a directory: ${resolved}${cwdHint}`)
    }
    await copyDirFiltered(resolved, tempDir, signal)
    return tempDir
  }

  if (source.kind === 'git' || source.kind === 'github') {
    const cloneUrl = source.kind === 'git' ? source.url : resolveCloneUrl(`github:${source.owner}/${source.repo}`)
    const args = ['clone', '--depth', '1']
    if (source.ref) args.push('--branch', source.ref)
    // subdir 安装仍然先浅 clone 整个 repo。真正的 sparse-checkout 在巨大 monorepo
    // 上会更快，但 `--depth 1 --filter=blob:none --sparse` 组合在不同 git 版本中
    // 比较脆弱；即使是大型 monorepo，depth-1 clone 通常也小于 100 MB。
    // 如果未来成为痛点再重新评估。
    args.push(cloneUrl, tempDir)

    try {
      await execa('git', args, { signal, stdio: 'pipe' })
    } catch (err) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw new InstallError(`git clone failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // 完整性检查：当 marketplace.json pin 了 `sha` 时，确认实际 clone 到的 commit
    // 与之匹配。这可以防止 marketplace 审核后、终端用户安装前，上游 ref 被
    // force-push 或仓库被入侵。必须在删除 `.git` 前执行，因为 rev-parse 需要 repo
    // metadata。
    //
    // 前缀匹配语义：声明的 sha 可以是短 sha（至少 7 位 hex），并和完整 40 位 HEAD
    // 做前缀校验。这与 `git checkout <short-sha>` 的容忍度一致，也符合真实
    // marketplace 的产出方式（anthropics/claude-plugins-official 有时发布 7 位 sha）。
    //
    // 为什么硬失败而不是警告：sha mismatch 按定义要么是 marketplace.json 配错
    // （作者 bug），要么是真实供应链异常。无论哪种情况，用户都不应该把未经审核的
    // 代码落到磁盘上。大声报错并指向 marketplace 作者，胜过静默安装当前 HEAD。
    if (source.expectedSha) {
      try {
        const result = await execa('git', ['rev-parse', 'HEAD'], { cwd: tempDir, stdio: 'pipe', signal })
        const actualSha = result.stdout.trim().toLowerCase()
        const expected = source.expectedSha.toLowerCase()
        if (!actualSha.startsWith(expected)) {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
          throw new InstallError(
            `sha integrity check failed for ${cloneUrl}${source.ref ? `@${source.ref}` : ''}: ` +
              `marketplace.json declared sha=${expected}, actual HEAD=${actualSha}. ` +
              `The upstream ref may have been force-pushed or the repo compromised. ` +
              `Contact the marketplace author or pin to a different version.`,
          )
        }
      } catch (err) {
        if (err instanceof InstallError) throw err
        // rev-parse 失败在新 clone 中理论上不该发生；这里按完整性失败处理，
        // 避免静默安装未经检查的代码。
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(
          `failed to verify sha for ${cloneUrl}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // 删除 .git 目录；安装后不再需要它，而且大型历史仓库会显著撑大缓存。
    await fs.rm(path.join(tempDir, '.git'), { recursive: true, force: true }).catch(() => {})

    // subdir 处理：插件实际位于 <tempDir>/<subdir>。
    // 这里重新 staging，让后续安装流程（manifest discovery + moveOrCopy 到缓存）
    // 只面对该 subdir。最简单的做法是把 subdir 复制到新的临时目录，然后丢弃原 clone。
    const subdir = source.subdir
    if (subdir) {
      const subdirPath = path.join(tempDir, subdir)
      const stat = await fs.stat(subdirPath).catch(() => null)
      if (!stat || !stat.isDirectory()) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(`subdir "${subdir}" not found in cloned repo ${cloneUrl}`)
      }
      const subdirTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-subdir-'))
      try {
        await copyDirFiltered(subdirPath, subdirTemp, signal)
      } catch (err) {
        await fs.rm(subdirTemp, { recursive: true, force: true }).catch(() => {})
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(`failed to extract subdir: ${err instanceof Error ? err.message : String(err)}`)
      }
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      return subdirTemp
    }
    return tempDir
  }

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  throw new InstallError(`unknown source kind: ${(source as PluginSource).kind}`)
}

/**
 * 复制插件目录时永远跳过的文件 / 目录名。
 *
 * `node_modules` 被排除，是因为带依赖的插件应该在用户机器上重新安装依赖；如果未来
 * 有插件真的必须携带 node_modules，再重新讨论。
 */
const COPY_SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])

/**
 * 递归复制目录，同时过滤不应进入插件缓存的条目。
 *
 * 函数会保留目录结构和普通文件，并对 symlink 做逃逸检查，避免插件缓存中出现指向
 * 源目录外部的链接。`root` 只在递归内部传递，用来始终以最初源目录作为安全边界。
 *
 * @param src 源目录。
 * @param dst 目标目录。
 * @param signal 可选取消信号，每处理一个目录项前检查一次。
 * @param root 初始源目录，递归调用内部使用。
 */
async function copyDirFiltered(src: string, dst: string, signal?: AbortSignal, root?: string): Promise<void> {
  // `root` 在第一次非递归调用时捕获。下面的 symlink 逃逸检查必须基于原始插件源目录，
  // 而不是当前递归层的 `src`，因为 `src` 会随着进入子目录不断变化。
  const rootDir = root ?? src
  await fs.mkdir(dst, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (COPY_SKIP.has(entry.name)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyDirFiltered(s, d, signal, rootDir)
    } else if (entry.isFile()) {
      await fs.copyFile(s, d)
    } else if (entry.isSymbolicLink()) {
      // symlink 目标相对其所在目录解析。如果解析后的目标逃出插件源根目录，
      // 就丢弃该 symlink 而不是保留它：在 POSIX 上，插件树里的
      // `evil -> /etc/passwd` 会把主机文件指针放进缓存，loader / hooks 运行时可能
      // 解引用它；在 Windows 上，下面的 fallback 甚至可能把 `/etc/passwd` 等价文件
      // 直接复制进缓存。这里不跟随 symlink 校验目标是否存在，因为“损坏但仍在边界内”
      // 的 symlink 依然可以安全保留。
      const target = await fs.readlink(s)
      const resolved = path.resolve(path.dirname(s), target)
      const rel = path.relative(rootDir, resolved)
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        continue
      }
      try {
        await fs.symlink(target, d)
      } catch {
        // Windows 没有 symlink 权限时，fallback 为复制解析后的文件。
        // 这是 best-effort；损坏 symlink 会被直接丢弃。
        await fs.copyFile(s, d).catch(() => {})
      }
    }
  }
}

/**
 * 把临时目录提交到最终缓存目录。
 *
 * 当 src 和 dst 位于同一文件系统时，rename 既原子又便宜；跨文件系统移动时
 * （Windows 上常见 EXDEV），会回退为 copy + rm。
 *
 * @param src 临时目录。
 * @param dst 最终缓存目录。
 * @param signal 可选取消信号，传给复制 fallback。
 */
async function moveOrCopy(src: string, dst: string, signal?: AbortSignal): Promise<void> {
  try {
    await fs.rename(src, dst)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTEMPTY') {
    }
  }
  await copyDirFiltered(src, dst, signal)
  await fs.rm(src, { recursive: true, force: true }).catch(() => {})
}

// ── installed_plugins.json 账本维护 ───────────────────────────────────

/**
 * 读取已安装插件账本。
 *
 * 文件不存在、JSON 损坏或结构不符合预期时返回空账本，避免坏账本阻塞启动或安装。
 *
 * @returns 已安装插件账本快照。
 */
async function readInstalledPlugins(): Promise<InstalledPlugins> {
  const file = installedPluginsPath()
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as InstalledPlugins
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.plugins)) {
      return { schemaVersion: '1', plugins: [] }
    }
    return { schemaVersion: parsed.schemaVersion ?? '1', plugins: parsed.plugins }
  } catch {
    return { schemaVersion: '1', plugins: [] }
  }
}

/**
 * 写入已安装插件账本。
 *
 * @param data 要写入的完整账本数据。
 */
async function writeInstalledPlugins(data: InstalledPlugins): Promise<void> {
  const file = installedPluginsPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/**
 * 记录一次插件安装。
 *
 * 如果 plugin id 已存在，则用新记录覆盖旧记录；否则追加到列表末尾。
 *
 * @param record 要写入的安装记录。
 */
async function recordInstallation(record: InstalledPluginRecord): Promise<void> {
  const data = await readInstalledPlugins()
  const idx = data.plugins.findIndex((p) => p.id === record.id)
  if (idx >= 0) data.plugins[idx] = record
  else data.plugins.push(record)
  await writeInstalledPlugins(data)
}

/**
 * 列出所有已安装插件记录。
 *
 * @returns installed_plugins.json 中的插件记录数组。
 */
export async function listInstalledPlugins(): Promise<InstalledPluginRecord[]> {
  const data = await readInstalledPlugins()
  return data.plugins
}

/**
 * 根据 plugin id 查找已安装插件记录。
 *
 * @param id 形如 `name@marketplace` 的插件 ID。
 * @returns 匹配记录；不存在时返回 `undefined`。
 */
export async function findInstalledPlugin(id: string): Promise<InstalledPluginRecord | undefined> {
  const data = await readInstalledPlugins()
  return data.plugins.find((p) => p.id === id)
}

// ── 卸载 ───────────────────────────────────────────────────────────────

export interface UninstallResult {
  /** 从缓存中删除的版本列表；插件没有缓存时为空数组。 */
  removedVersions: string[]
  /** installed_plugins.json 中的记录是否被删除。 */
  removedRecord: boolean
}

/**
 * 卸载一个插件。
 *
 * 函数会删除该插件的所有缓存版本，并移除 installed_plugins.json 中的账本记录。
 * 它不会删除数据目录（`~/.tegent/plugins/data/<id>/`），这样用户后续重装时不会
 * 丢失插件状态。
 *
 * @param id 形如 `name@marketplace` 的插件 ID。
 * @returns 删除的缓存版本和账本删除状态。
 */
export async function uninstallPlugin(id: string): Promise<UninstallResult> {
  const record = await findInstalledPlugin(id)
  const result: UninstallResult = { removedVersions: [], removedRecord: false }

  if (record) {
    const parent = pluginCacheParent(record.marketplace, record.name)
    try {
      const versions = await fs.readdir(parent)
      result.removedVersions = versions
      await fs.rm(parent, { recursive: true, force: true })
    } catch {
      // 没有缓存条目时，账本记录可能已经过期；下面仍会尝试移除账本记录。
    }
  }

  const data = await readInstalledPlugins()
  const before = data.plugins.length
  data.plugins = data.plugins.filter((p) => p.id !== id)
  if (data.plugins.length !== before) {
    await writeInstalledPlugins(data)
    result.removedRecord = true
  }

  return result
}
