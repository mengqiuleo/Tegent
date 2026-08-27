// CLI 入口会调用这个一次性编排。加载分两轮：
//
//   第 1 轮 —— 从 installed_plugins.json 读取 user-scope 安装记录。每条记录都指向
//              一个带版本号的缓存目录；记录写的是哪个版本，我们就加载哪个版本。
//              如果账本记录存在但缓存目录缺失，会收集为 PluginLoadError。
//
//   第 2 轮 —— 扫描 <cwd>/.tegent/plugins/<name>/ 下的项目本地插件。
//              它们不记录在 installed_plugins.json 中，因为它们作为仓库内插件被提交。
//              这类插件的 marketplace 名统一是 "local"。
//
// `installed_plugins.json` 是 user-scope 安装的事实来源。孤立缓存目录（有目录但无
// 账本记录）会被静默忽略，等用户下次运行 `/plugin uninstall` 时再清理。
//
// 单个坏插件（JSON 错误、缺少 manifest、schema 不合法）绝不能中止启动；
// 错误会进入 `PluginLoadError[]`，后续由 `/plugin doctor` 展示。
//
// 返回的 `PluginRegistry` 设计上会在会话内冻结使用，和 MCP / skills 一样遵守
// CLAUDE.md 中的字节稳定性约束。CLI 启动时调用一次 `loadAllPlugins()`，并把结果
// 放入 `AgentOptions`。`/plugin refresh` 会通过 `registry.reload(...)` 原地替换
// 内存状态，并让 `systemPromptCache` 失效。
import fs from 'node:fs/promises'
import path from 'node:path'

import { EnableState } from './enable-state.js'
import { listInstalledPlugins } from './installer.js'
import { ManifestParseError, discoverManifest, parseManifest } from './manifest.js'
import { pluginCacheDir, projectPluginsDir } from './paths.js'
import { PluginRegistry } from './registry.js'
import type {
  InlineHookConfig,
  InlineMcpServers,
  LoadedPlugin,
  PluginLoadError,
  PluginManifest,
  PluginScope,
  PluginSource,
} from './types.js'

export interface LoadOptions {
  /** 当前工作目录，用于寻找项目本地插件。 */
  cwd: string
  /**
   * 是否完全跳过插件加载。
   *
   * 由启动参数 `--no-plugins` 驱动；为 true 时返回空 registry 和空贡献映射。
   */
  disabled?: boolean
}

export interface LoadResult {
  registry: PluginRegistry
  /**
   * 每个插件解析后的贡献项路径 / 内联对象。
   *
   * skill / agent / mcp 等下游 loader 集成会读取这里，把插件贡献的内容合并进去。
   * Map 以 plugin id 为 key。
   */
  contributions: Map<string, ResolvedContributions>
}

/**
 * 单个插件 manifest 贡献项解析后的形状。
 *
 * 相对路径会基于 `rootDir` 解析成绝对路径。`mcpServers` 和 `hooks` 的 `path` /
 * `inline` 判别字段对应 manifest 中的联合类型：插件作者既可以指向文件，也可以
 * 直接内联配置对象。
 */
export interface ResolvedContributions {
  /**
   * 插件 skills 目录的绝对路径。
   *
   * 目录下每个子目录都应遵循现有 `<name>/SKILL.md` 布局，这样 skill loader
   * 无需特殊逻辑即可扫描。
   */
  skillsDir?: string
  /** 插件 sub-agent `.md` 文件目录的绝对路径。 */
  agentsDir?: string
  /** 插件 slash-command `.md` 文件目录的绝对路径。 */
  commandsDir?: string
  /**
   * mcpServers 贡献项。
   *
   * 可以是指向 `{ mcpServers: { ... } }` JSON 文件的路径，也可以是和
   * ~/.tegent/config.json `mcpServers` 形状一致的内联记录。
   */
  mcpServers?: { kind: 'path'; path: string } | { kind: 'inline'; data: InlineMcpServers }
  /**
   * hooks 贡献项。
   *
   * 可以是 hooks.json 路径，也可以是内联对象；schema 校验位于
   * packages/core/src/hooks。
   */
  hooks?: { kind: 'path'; path: string } | { kind: 'inline'; data: InlineHookConfig }
}

/**
 * 加载当前环境中的全部插件。
 *
 * 函数先加载已安装插件账本，再扫描项目本地插件；所有成功加载的插件进入 registry，
 * 每个插件解析后的贡献项进入 contributions。坏插件只记录错误，不阻塞其他插件。
 *
 * @param opts 加载选项，包含工作目录和是否禁用插件。
 * @returns 插件注册表以及按 plugin id 索引的贡献项映射。
 */
export async function loadAllPlugins(opts: LoadOptions): Promise<LoadResult> {
  if (opts.disabled) {
    return { registry: new PluginRegistry([], []), contributions: new Map() }
  }

  const enableState = await EnableState.load(opts.cwd)
  const plugins: LoadedPlugin[] = []
  const errors: PluginLoadError[] = []
  const contributions = new Map<string, ResolvedContributions>()

  // ── 第 1 轮：user-scope 已安装插件 ───────────────────────────────────
  const installed = await listInstalledPlugins()
  for (const record of installed) {
    const rootDir = pluginCacheDir(record.marketplace, record.name, record.version)
    await loadOnePlugin({
      rootDir,
      fallbackId: record.id,
      marketplace: record.marketplace,
      scope: record.installScope,
      source: record.source,
      enableState,
      plugins,
      errors,
      contributions,
    })
  }

  // ── 第 2 轮：项目本地插件 ───────────────────────────────────────────
  const projectRoot = projectPluginsDir(opts.cwd)
  let projectEntries: import('node:fs').Dirent[] = []
  try {
    projectEntries = await fs.readdir(projectRoot, { withFileTypes: true })
  } catch {
    /* 没有项目插件目录是最常见路径，直接跳过。 */
  }
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue
    const pluginRoot = path.join(projectRoot, entry.name)
    await loadOnePlugin({
      rootDir: pluginRoot,
      // 先用目录名构造临时 id；manifest 解析成功后会由 manifest.name 覆盖。
      fallbackId: `${entry.name}@local`,
      marketplace: 'local',
      scope: 'project',
      source: undefined,
      enableState,
      plugins,
      errors,
      contributions,
    })
  }

  return { registry: new PluginRegistry(plugins, errors), contributions }
}

interface LoadOneArgs {
  rootDir: string
  fallbackId: string
  marketplace: string
  scope: PluginScope
  source: PluginSource | undefined
  enableState: EnableState
  plugins: LoadedPlugin[]
  errors: PluginLoadError[]
  contributions: Map<string, ResolvedContributions>
}

/**
 * 尝试加载单个插件目录。
 *
 * 函数负责 manifest 发现、manifest 解析、启用状态解析、LoadedPlugin 构造以及
 * 贡献项解析。任何异常都会转换为 `PluginLoadError` 并写入 args.errors。
 *
 * @param args 单插件加载所需的上下文和可变输出数组 / Map。
 */
async function loadOnePlugin(args: LoadOneArgs): Promise<void> {
  try {
    const discovery = await discoverManifest(args.rootDir)
    if (!discovery) {
      args.errors.push({
        id: args.fallbackId,
        path: args.rootDir,
        message:
          'no plugin manifest found (looked for .tegent-plugin/plugin.json, .claude-plugin/plugin.json, plugin.json)',
      })
      return
    }
    if (discovery.format === 'gemini') {
      args.errors.push({
        id: args.fallbackId,
        path: args.rootDir,
        message: 'Gemini extensions are not supported (gemini-extension.json detected); see docs/plugins.md',
      })
      return
    }

    let manifest: PluginManifest
    try {
      manifest = await parseManifest(discovery.manifestPath)
    } catch (err) {
      args.errors.push({
        id: args.fallbackId,
        path: args.rootDir,
        message: err instanceof ManifestParseError ? err.message : String(err),
      })
      return
    }

    // 规范 id 永远来自 manifest，而不是缓存目录名。
    // 对已安装插件来说它通常和账本 id 一致；对项目本地插件来说，它可能和目录名不同，
    // 此时 manifest.name 拥有最高优先级。
    const id = `${manifest.name}@${args.marketplace}`
    const enableResolution = args.enableState.resolve(id)

    const plugin: LoadedPlugin = {
      id,
      manifest,
      rootDir: args.rootDir,
      manifestPath: discovery.manifestPath,
      manifestFormat: discovery.format,
      source: args.source,
      marketplace: args.marketplace,
      scope: args.scope,
      enabled: enableResolution.enabled,
    }
    args.plugins.push(plugin)
    args.contributions.set(id, await resolveContributions(plugin))
  } catch (err) {
    args.errors.push({
      id: args.fallbackId,
      path: args.rootDir,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * 把插件 manifest 中的贡献字段解析为绝对路径或内联对象。
 *
 *  它被导出是因为少数调用方偶尔需要针对单个插件重新计算贡献项，例如
 *  `/plugin info`。
 *
 *  每类贡献项都有两轮发现：
 *
 *  1. manifest 显式声明：如果 manifest 写了路径，例如 `"skills": "./my-skills"`，
 *     就直接使用该路径。
 *  2. 约定式回退：如果没有声明，则探测约定目录（`skills/`、`agents/`、
 *     `commands/`）和约定文件（`hooks/hooks.json`、`.mcp.json`、`mcp.json`）。
 *     真实 Claude Code 插件常这么做：manifest 只写 name / version / description，
 *     贡献项则放在旁边的约定位置。
 *
 *  这个函数是 async，因为约定式探测需要 stat 文件和目录。
 *
 * @param plugin 已加载插件对象。
 * @returns 解析后的贡献项集合。
 */
export async function resolveContributions(plugin: LoadedPlugin): Promise<ResolvedContributions> {
  const m = plugin.manifest
  const root = plugin.rootDir
  const result: ResolvedContributions = {}

  // skills / agents / commands 都是目录类贡献项。
  if (m.skills) {
    result.skillsDir = path.resolve(root, m.skills)
  } else if (await isDir(path.join(root, 'skills'))) {
    result.skillsDir = path.join(root, 'skills')
  }
  if (m.agents) {
    result.agentsDir = path.resolve(root, m.agents)
  } else if (await isDir(path.join(root, 'agents'))) {
    result.agentsDir = path.join(root, 'agents')
  }
  if (m.commands) {
    result.commandsDir = path.resolve(root, m.commands)
  } else if (await isDir(path.join(root, 'commands'))) {
    result.commandsDir = path.join(root, 'commands')
  }

  // mcpServers 可以来自 manifest 显式声明（path / inline），也可以来自约定文件。
  if (m.mcpServers !== undefined) {
    if (typeof m.mcpServers === 'string') {
      result.mcpServers = { kind: 'path', path: path.resolve(root, m.mcpServers) }
    } else {
      result.mcpServers = { kind: 'inline', data: m.mcpServers }
    }
  } else {
    // Claude Code 约定是在插件根目录放 `.mcp.json`。
    // 我们也接受无点号的 `mcp.json`，作为务实 fallback；有些作者更喜欢可见文件名。
    for (const conv of ['.mcp.json', 'mcp.json']) {
      const p = path.join(root, conv)
      if (await isFile(p)) {
        result.mcpServers = { kind: 'path', path: p }
        break
      }
    }
  }

  // hooks 使用同样模式，约定文件是 `hooks/hooks.json`。
  if (m.hooks !== undefined) {
    if (typeof m.hooks === 'string') {
      result.hooks = { kind: 'path', path: path.resolve(root, m.hooks) }
    } else {
      result.hooks = { kind: 'inline', data: m.hooks }
    }
  } else {
    const conv = path.join(root, 'hooks', 'hooks.json')
    if (await isFile(conv)) {
      result.hooks = { kind: 'path', path: conv }
    }
  }

  return result
}

/**
 * 判断路径是否是目录。
 *
 * @param p 待检查路径。
 * @returns 存在且是目录时为 true，否则为 false。
 */
async function isDir(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

/**
 * 判断路径是否是普通文件。
 *
 * @param p 待检查路径。
 * @returns 存在且是文件时为 true，否则为 false。
 */
async function isFile(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isFile()
  } catch {
    return false
  }
}
