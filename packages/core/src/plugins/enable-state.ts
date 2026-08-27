// 本模块从不同作用域的 settings.json 文件中读取 `enabledPlugins` 映射，
// 并为每个 plugin id 解析出最终生效的启用状态。
//
// 当前是两级作用域模型，和 MCP、skill 子系统保持一致：
//
//   user     ~/.tegent/settings.json
//   project  <cwd>/.tegent/settings.local.json   （被 git 忽略）
//
// 这里的 `'project'` 读取 `.local.json`，命名上有一点历史包袱：它继承自
// skills 的语义，表示“当前仓库下的个人覆盖”，不是团队共享文件。未来如果要加
// 一个会提交到仓库里的 team scope，可以在现有两级之外继续叠加。
//
// 映射形状是 `{ "name@marketplace": true | false }`：
// true 表示显式启用，false 表示显式禁用，缺失表示使用项目级默认值。
// 当前默认值是 `true`，也就是安装后的插件默认可用。
//
// 优先级：project > user。高优先级作用域只要出现显式值就直接胜出；
// 如果没有记录，则继续向低优先级作用域回退。
import fs from 'node:fs/promises'
import path from 'node:path'

import { TEGENT_DIR, userTeCodeDir } from '../utils.js'
import type { PluginScope } from './types.js'

/** 按最高优先级在前排序；第一个含有显式记录的作用域决定最终状态。 */
const SCOPE_PRECEDENCE: ReadonlyArray<PluginScope> = ['project', 'user']

/**
 * 没有任何作用域提到某个插件时使用的默认启用状态。
 *
 * 默认启用可以让新安装的插件开箱即用；如果用户希望某个插件走显式 opt-in，
 * 可以把对应 plugin id 写成 `false`。
 */
const DEFAULT_ENABLED = true

interface PluginSettingsFile {
  enabledPlugins?: Record<string, boolean>
}

/**
 * 返回指定作用域对应的 settings 文件路径。
 *
 * @param scope 要读取或写入的插件配置作用域。
 * @param cwd 项目作用域使用的工作目录，默认是当前进程工作目录。
 * @returns 用户级或项目级 settings 文件的绝对路径。
 */
export function settingsPathForScope(scope: PluginScope, cwd: string = process.cwd()): string {
  if (scope === 'user') return path.join(userTeCodeDir(), 'settings.json')
  return path.join(cwd, TEGENT_DIR, 'settings.local.json')
}

/**
 * 尝试读取某个作用域的插件设置。
 *
 * 读取失败、文件不存在、JSON 损坏或字段形状不符合预期时，都返回空对象。
 * 这样一个手动编辑坏掉的 settings 文件不会阻塞 CLI 启动。
 *
 * @param scope 设置文件所在作用域。
 * @param cwd 项目作用域使用的工作目录。
 * @returns 只包含合法 `enabledPlugins` 布尔值的设置快照。
 */
async function readSettings(scope: PluginScope, cwd: string): Promise<PluginSettingsFile> {
  const file = settingsPathForScope(scope, cwd)
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const obj = parsed as Record<string, unknown>
    if (obj.enabledPlugins && typeof obj.enabledPlugins === 'object' && !Array.isArray(obj.enabledPlugins)) {
      // 防御式地只接收 boolean 值；settings.json 可能被手动编辑过，
      // 单个错误类型不应该让 loader 崩掉。
      const out: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(obj.enabledPlugins)) {
        if (typeof v === 'boolean') out[k] = v
      }
      return { enabledPlugins: out }
    }
    return {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // JSON 损坏时忽略并返回空设置，避免坏配置阻塞启动；
    // 用户修好文件后重启即可重新读取。
    return {}
  }
}

/**
 * 单个插件解析后的启用状态。
 *
 * `decidedBy` 用于 `/plugin doctor` 展示“是谁决定了这个状态”。当它是
 * `undefined` 时，说明没有任何作用域写过该 plugin id，最终使用默认值。
 */
export interface ResolvedEnableState {
  enabled: boolean
  decidedBy: PluginScope | undefined
}

export class EnableState {
  private constructor(private readonly perScope: Map<PluginScope, Record<string, boolean>>) {}

  /**
   * 读取所有作用域的 settings 文件并构建一个状态快照。
   *
   * 这个快照创建后不会原地追踪磁盘变化；调用方在写入 settings.json 后，
   * 需要再次调用 `EnableState.load()` 得到新快照。`cwd` 控制 `project`
   *  作用域从哪个仓库目录读取。
   *
   * @param cwd 项目作用域使用的工作目录。
   * @returns 当前磁盘配置对应的启用状态快照。
   */
  static async load(cwd: string = process.cwd()): Promise<EnableState> {
    const map = new Map<PluginScope, Record<string, boolean>>()
    for (const scope of SCOPE_PRECEDENCE) {
      const s = await readSettings(scope, cwd)
      map.set(scope, s.enabledPlugins ?? {})
    }
    return new EnableState(map)
  }

  /**
   * 解析一个 plugin id 的最终启用状态。
   *
   * 函数会按 `SCOPE_PRECEDENCE` 从高到低查找显式记录；找到后立即返回。
   * 如果所有作用域都缺失，则返回默认启用状态。
   *
   * @param pluginId 形如 `name@marketplace` 的插件 ID。
   * @returns 启用状态，以及决定该状态的作用域。
   */
  resolve(pluginId: string): ResolvedEnableState {
    for (const scope of SCOPE_PRECEDENCE) {
      const table = this.perScope.get(scope) ?? {}
      if (pluginId in table) {
        return { enabled: table[pluginId]!, decidedBy: scope }
      }
    }
    return { enabled: DEFAULT_ENABLED, decidedBy: undefined }
  }

  /**
   * 返回某个作用域的原始 enabledPlugins 映射副本。
   *
   * `/plugin list` 会用它把每个作用域的显式标记和最终生效状态一起展示。
   * 返回副本可以避免调用方意外修改内部快照。
   *
   * @param scope 要查看的作用域。
   * @returns 该作用域下的 plugin id 到启用布尔值映射。
   */
  scopeEntries(scope: PluginScope): Record<string, boolean> {
    return { ...(this.perScope.get(scope) ?? {}) }
  }
}

// ── 会修改 settings 文件的写操作（供 /plugin enable|disable|install 使用） ──

/**
 * 在指定作用域写入单个插件的启用标记。
 *
 * 这里使用 read-modify-write，而不是重写整个文件，避免覆盖 settings.json
 *  中其他子系统的字段，例如 skill 子系统的 `disabledSkills`。返回值会告诉
 *  调用方文件是否真的变化，从而让 UI 能准确显示“已经启用”或“已启用”。
 *
 * @param pluginId 形如 `name@marketplace` 的插件 ID。
 * @param scope 写入的作用域。
 * @param enabled 要写入的启用状态。
 * @param cwd 项目作用域使用的工作目录。
 * @returns `'changed'` 表示文件被修改，`'noop'` 表示原本就是该状态。
 */
export async function setPluginEnabled(
  pluginId: string,
  scope: PluginScope,
  enabled: boolean,
  cwd: string = process.cwd(),
): Promise<'changed' | 'noop'> {
  const file = settingsPathForScope(scope, cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })

  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch {
    // 第一次写入时文件可能还不存在；这不是错误，后面会创建新结构。
  }

  const currentMap =
    existing.enabledPlugins && typeof existing.enabledPlugins === 'object' && !Array.isArray(existing.enabledPlugins)
      ? { ...(existing.enabledPlugins as Record<string, boolean>) }
      : {}

  if (currentMap[pluginId] === enabled) return 'noop'
  currentMap[pluginId] = enabled
  existing.enabledPlugins = currentMap

  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
  return 'changed'
}

/**
 * 从某个作用域的 `enabledPlugins` 中移除单个插件记录。
 *
 * `/plugin uninstall` 会调用它清理 settings.json，避免卸载后留下无效配置。
 * 如果文件不存在、结构不含 enabledPlugins，或目标 plugin id 原本就不存在，
 * 函数都会返回 `'noop'`。
 *
 * @param pluginId 形如 `name@marketplace` 的插件 ID。
 * @param scope 要清理的作用域。
 * @param cwd 项目作用域使用的工作目录。
 * @returns `'changed'` 表示文件被修改，`'noop'` 表示无需修改。
 */
export async function clearPluginEntry(
  pluginId: string,
  scope: PluginScope,
  cwd: string = process.cwd(),
): Promise<'changed' | 'noop'> {
  const file = settingsPathForScope(scope, cwd)
  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch {
    return 'noop'
  }

  if (
    !existing.enabledPlugins ||
    typeof existing.enabledPlugins !== 'object' ||
    Array.isArray(existing.enabledPlugins)
  ) {
    return 'noop'
  }

  const map = { ...(existing.enabledPlugins as Record<string, boolean>) }
  if (!(pluginId in map)) return 'noop'
  delete map[pluginId]

  if (Object.keys(map).length === 0) {
    delete existing.enabledPlugins
  } else {
    existing.enabledPlugins = map
  }

  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
  return 'changed'
}
