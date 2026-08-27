import fs from 'node:fs/promises'
import path from 'node:path'

import { USER_TEGENT_DIR, TEGENT_DIR } from '../constants.js'

/**
 * 插件设置的作用域。
 *
 * `user` 表示用户全局配置（`~/.tegent/settings.json`），
 * `project` 表示当前项目本地配置（`<repo-root>/.tegent/settings.local.json`）。
 * 和 skill 设置共用同一对文件，只是字段不同。
 */
export type PluginSettingsScope = 'user' | 'project'

/**
 * 插件设置文件的结构。
 *
 * 目前只关心 `disabledPlugins`（插件 id 列表）；未来如果增加启用 marketplace、
 * 更新策略之类的字段，读写函数会尽量保留它们。
 */
export interface PluginSettings {
  disabledPlugins?: string[]
}

/**
 * 根据作用域计算插件设置文件路径。
 *
 * @param scope 设置作用域，用户级或项目级。
 * @returns 对应作用域的 settings 文件绝对路径。
 */
export function pluginSettingsPath(scope: PluginSettingsScope): string {
  if (scope === 'user') return path.join(USER_TEGENT_DIR, 'settings.json')
  return path.join(process.cwd(), TEGENT_DIR, 'settings.local.json')
}

/**
 * 读取指定作用域的插件设置。
 *
 * 文件不存在、JSON 格式错误、字段结构不符合预期时都会返回空设置。这样做是为了保证
 * 一个坏配置文件不会阻止 CLI 启动；用户修复文件后重新启动即可生效。
 *
 * @param scope 要读取的设置作用域。
 * @returns 清洗后的插件设置对象（只保留字符串类型的插件 id）。
 */
async function readSettings(scope: PluginSettingsScope): Promise<PluginSettings> {
  const file = pluginSettingsPath(scope)
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const obj = parsed as Record<string, unknown>
    // 只保留字符串类型的插件 id，防止脏数据进入后续 Set 合并逻辑。
    const list = Array.isArray(obj.disabledPlugins)
      ? obj.disabledPlugins.filter((id): id is string => typeof id === 'string')
      : []
    return { disabledPlugins: list }
  } catch {
    // ENOENT（还没写过）、JSON 语法错误或其他读取异常都按空设置处理，坏配置不阻塞启动。
    return {}
  }
}

/**
 * 写入指定作用域的插件设置。
 *
 * 采用“读原文件 → 修改 disabledPlugins → 写回”的方式，是为了保留 settings 文件
 * 里的其他字段 —— 这个文件同时存放 model、disabledSkills 等内容，本模块写入时
 * 不能把无关配置清掉。
 *
 * @param scope 要写入的设置作用域。
 * @param settings 要保存的插件设置。
 */
async function writeSettings(scope: PluginSettingsScope, settings: PluginSettings): Promise<void> {
  const file = pluginSettingsPath(scope)
  await fs.mkdir(path.dirname(file), { recursive: true })

  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch {
    // 忽略读取失败：通常是首次写入文件，或者旧文件格式坏了但这次可以覆盖 disabledPlugins。
  }

  const list = settings.disabledPlugins ?? []
  if (list.length === 0) {
    // 空列表不写入字段，让 settings 文件保持简洁。
    delete existing.disabledPlugins
  } else {
    existing.disabledPlugins = list
  }
  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
}

/**
 * 加载所有作用域里被禁用的插件 id 集合。
 *
 * 用户级和项目级 `disabledPlugins` 使用并集规则：只要任意作用域禁用了某个插件，
 * 它就会出现在返回的 Set 中。
 *
 * @returns 被禁用插件 id 的去重集合。
 */
export async function loadDisabledPluginsSet(): Promise<Set<string>> {
  const [u, p] = await Promise.all([readSettings('user'), readSettings('project')])
  const merged = new Set<string>()
  for (const id of u.disabledPlugins ?? []) merged.add(id)
  for (const id of p.disabledPlugins ?? []) merged.add(id)
  return merged
}

/**
 * 修改某个插件在指定作用域里的禁用状态。
 *
 * `disable=true` 表示把插件 id 加入 `disabledPlugins`；`disable=false` 表示从列表中
 * 移除。函数会返回实际发生的动作，方便调用方渲染准确提示，例如“已经禁用”和“刚刚禁用”。
 *
 * @param id 要修改的插件 id（`name` 或 `name@marketplace`）。
 * @param scope 要修改的设置作用域。
 * @param disable 是否禁用该插件。
 * @returns `'changed'` 表示文件内容已变化；`'noop'` 表示目标状态本来就是这样。
 */
export async function setPluginDisabled(
  id: string,
  scope: PluginSettingsScope,
  disable: boolean,
): Promise<'changed' | 'noop'> {
  const current = await readSettings(scope)
  const list = new Set(current.disabledPlugins ?? [])
  const had = list.has(id)
  if (disable) {
    if (had) return 'noop'
    list.add(id)
  } else {
    if (!had) return 'noop'
    list.delete(id)
  }
  // 排序后写入，保证文件内容稳定，减少不必要的 diff 抖动。
  await writeSettings(scope, { disabledPlugins: [...list].sort() })
  return 'changed'
}

/**
 * 读取指定作用域中被禁用的插件 id 列表。
 *
 * 这个函数只返回单个作用域的配置，不会合并用户级和项目级；需要合并结果时使用
 * `loadDisabledPluginsSet`。
 *
 * @param scope 要读取的设置作用域。
 * @returns 该作用域中配置的 disabledPlugins 列表；没有配置时返回空数组。
 */
export async function getScopedDisabledPlugins(scope: PluginSettingsScope): Promise<string[]> {
  const s = await readSettings(scope)
  return s.disabledPlugins ?? []
}
