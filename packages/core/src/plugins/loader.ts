// 扫描 ~/.tegent/plugins/cache/<name>/.tegent-plugin/plugin.json 和
// <repo-root>/.tegent/plugins/<name>/.tegent-plugin/plugin.json，把每个带合法清单的
// 目录加载成一个 PluginDefinition。目录布局对齐 Claude Code 插件：
//
//   <plugins-root>/<name>/
//     .tegent-plugin/plugin.json   ← 清单，必须有
//     skills/<skill-name>/SKILL.md ← 可选：贡献给 skill 注册表
//     agents/<agent>.md            ← 可选：贡献给子代理注册表（暂未接入）
//
// 优先级：同 id 插件里，项目级会覆盖用户级（注册表后写覆盖）。
// 约束：坏清单只打印警告并跳过，单个损坏的 plugin.json 不能导致 CLI 崩溃。
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { formatPluginId, isValidPluginName, pluginCacheDir, pluginManifestPath, projectPluginsDir } from './utils.js'
import type { PluginDefinition, PluginSource } from './types.js'

const manifestSchema = z.object({
  name: z.string().min(1).refine(isValidPluginName, 'plugin name must be a valid npm-style name'),
  version: z.string().min(1),
  description: z.string().optional(),
  author: z.string().optional(),
  marketplace: z.string().optional(),
})

export interface LoadPluginsOptions {
  /**
   * 覆盖用户级插件缓存目录。
   *
   * 默认是 `~/.tegent/plugins/cache`。测试通过这里把扫描指到临时目录，
   * 避免读到开发机上真实安装的插件。
   */
  userDir?: string

  /**
   * 覆盖项目级插件目录。
   *
   * 默认是 `<repo-root>/.tegent/plugins`。测试同样通过这里注入临时目录。
   */
  projectDir?: string
}

/**
 * 解析单个清单 JSON 文本。
 *
 * @param raw - plugin.json 的原始文本。
 * @returns 解析成功时返回清洗后的清单对象；JSON 语法错误或结构不符时返回 `null`。
 */
async function parseManifestFile(raw: string): Promise<z.infer<typeof manifestSchema> | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const result = manifestSchema.safeParse(parsed)
  return result.success ? result.data : null
}

/**
 * 从指定插件根目录加载单个插件。
 *
 * @param pluginDir - 插件根目录（形如 `<root>/<name>`）。
 * @param source - 插件来源，用于 UI 展示和优先级判断。
 * @returns 加载成功返回插件定义；目录里没有清单或清单坏了返回 `undefined`。
 */
async function loadPlugin(
  pluginDir: string,
  source: PluginSource,
): Promise<PluginDefinition | undefined> {
  const manifestPath = pluginManifestPath(pluginDir)

  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf-8')
  } catch {
    // 没有 plugin.json 就不是插件：缓存目录里允许有临时目录、checkouts 等杂物，静默跳过。
    return undefined
  }

  const manifest = await parseManifestFile(raw)
  if (!manifest) {
    console.error(`[plugins] Skipping ${manifestPath}: invalid or corrupted plugin.json`)
    return undefined
  }

  return {
    id: formatPluginId(manifest.name, manifest.marketplace),
    name: manifest.name,
    version: manifest.version,
    source,
    dir: pluginDir,
    manifestPath,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.author ? { author: manifest.author } : {}),
    ...(manifest.marketplace ? { marketplace: manifest.marketplace } : {}),
  }
}

/**
 * 从指定根目录加载全部插件。
 *
 * 只把“子目录里有合法清单”的条目当作插件；普通文件、无清单目录直接跳过。
 * 单个插件解析失败时只跳过该插件，不会中断其他插件加载，这样一个坏清单不会拖垮整个 CLI。
 *
 * @param dir - 要扫描的插件根目录（用户缓存目录或项目插件目录）。
 * @param source - 插件来源，用于 UI 展示和优先级判断。
 * @returns 从该目录成功加载出来的插件定义列表。
 */
async function loadPluginsFromDir(dir: string, source: PluginSource): Promise<PluginDefinition[]> {
  const plugins: PluginDefinition[] = []

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return plugins // 目录不存在（最常见）或不可读：按“没有插件”处理。
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue // 根目录下的普通文件不是插件。
    const plugin = await loadPlugin(path.join(dir, entry.name), source)
    if (plugin) plugins.push(plugin)
  }

  return plugins
}

/**
 * 加载当前会话可用的全部插件。
 *
 * 按“用户级缓存 → 项目级”顺序加载，注册表里同 id 插件由后者覆盖，
 * 因此项目自带插件可以覆盖 marketplace 安装的同名版本。
 *
 * @param opts 加载选项，主要用于测试注入临时目录。
 * @returns 加载成功的插件定义列表。
 */
export async function loadPlugins(opts: LoadPluginsOptions = {}): Promise<PluginDefinition[]> {
  const userPlugins = await loadPluginsFromDir(opts.userDir ?? pluginCacheDir(), 'user')
  const projectPlugins = await loadPluginsFromDir(opts.projectDir ?? projectPluginsDir(), 'project')

  // 合并顺序：注册表采用“后者覆盖前者”，所以项目级排在用户缓存之后。
  return [...userPlugins, ...projectPlugins]
}
