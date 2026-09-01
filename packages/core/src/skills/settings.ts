import fs from 'node:fs/promises'
import path from 'node:path'

import { USER_TEGENT_DIR, TEGENT_DIR } from '../constants.js'

/**
 * SKILL设置的作用域。
 *
 * `user` 表示用户全局配置，`project` 表示当前项目本地配置。
 */
export type SkillSettingsScope = 'user' | 'project'

/**
 * SKILL设置文件的结构。
 *
 * 目前只关心 disabledSkills；未来如果设置文件增加其他字段，读写函数会尽量保留它们。
 */
export interface SkillSettings {
  disabledSkills?: string[]
}

/**
 * 根据作用域计算SKILL设置文件路径。
 *
 * @param scope 设置作用域，用户级或项目级。
 * @returns 对应作用域的 settings 文件绝对路径。
 */
export function skillSettingsPath(scope: SkillSettingsScope): string {
  if (scope === 'user') return path.join(USER_TEGENT_DIR, 'settings.json')
  return path.join(process.cwd(), TEGENT_DIR, 'settings.local.json')
}

/**
 * 读取指定作用域的SKILL设置。
 *
 * 文件不存在、JSON 格式错误、字段结构不符合预期时都会返回空设置。这样做是为了保证
 * 一个坏配置文件不会阻止 CLI 启动；用户修复文件后重新启动即可生效。
 *
 * @param scope 要读取的设置作用域。
 * @returns 清洗后的SKILL设置对象(返回的是禁用的skills)。
 */
async function readSettings(scope: SkillSettingsScope): Promise<SkillSettings> {
  const file = skillSettingsPath(scope)
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const obj = parsed as Record<string, unknown>
    // 只保留字符串类型的SKILL名，防止脏数据进入后续 Set 合并逻辑。
    const list = Array.isArray(obj.disabledSkills)
      ? obj.disabledSkills.filter((s): s is string => typeof s === 'string')
      : []
    return { disabledSkills: list }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // JSON 格式错误或其他读取异常：忽略并返回空设置，避免坏配置阻塞启动。
    return {}
  }
}

/**
 * 写入指定作用域的SKILL设置（相当于重写 setting.json，把传入的skills 参数写进 setting.json 中）。
 *
 * 采用“读原文件 → 修改 disabledSkills → 写回”的方式，是为了保留 settings.json
 * 中未来可能出现的其他字段，避免本模块写入时把无关配置清掉。
 *
 * @param scope 要写入的设置作用域。
 * @param settings 要保存的SKILL设置。
 */
async function writeSettings(scope: SkillSettingsScope, settings: SkillSettings): Promise<void> {
  const file = skillSettingsPath(scope)
  await fs.mkdir(path.dirname(file), { recursive: true })

  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch {
    // 忽略读取失败：通常是首次写入文件，或者旧文件格式坏了但这次可以覆盖 disabledSkills。
  }

  const list = settings.disabledSkills ?? []
  if (list.length === 0) {
    // 空列表不写入字段，让 settings 文件保持简洁。
    delete existing.disabledSkills
  } else {
    existing.disabledSkills = list
  }
  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
}

/**
 * 加载所有作用域里被禁用的SKILL名集合。
 *
 * 用户级和项目级 disabledSkills 使用并集规则：只要任意作用域禁用了某个SKILL，它就会
 * 出现在返回的 Set 中。
 *
 * @returns 被禁用SKILL名的去重集合。
 */
export async function loadDisabledSkillsSet(): Promise<Set<string>> {
  const [u, p] = await Promise.all([readSettings('user'), readSettings('project')])
  const merged = new Set<string>()
  for (const name of u.disabledSkills ?? []) merged.add(name)
  for (const name of p.disabledSkills ?? []) merged.add(name)
  return merged
}

/**
 * 修改某个SKILL在指定作用域里的禁用状态。
 *
 * `disable=true` 表示把SKILL名加入 disabledSkills；`disable=false` 表示从列表中移除。
 * 函数会返回实际发生的动作，方便调用方渲染准确提示，例如“已经禁用”和“刚刚禁用”。
 *
 * @param name 要修改的SKILL名。
 * @param scope 要修改的设置作用域。
 * @param disable 是否禁用该SKILL。
 * @returns `'changed'` 表示文件内容已变化；`'noop'` 表示目标状态本来就是这样。
 */
export async function setSkillDisabled(
  name: string,
  scope: SkillSettingsScope,
  disable: boolean,
): Promise<'changed' | 'noop'> {
  const current = await readSettings(scope)
  const list = new Set(current.disabledSkills ?? [])
  const had = list.has(name)
  if (disable) {
    if (had) return 'noop'
    list.add(name)
  } else {
    if (!had) return 'noop'
    list.delete(name)
  }

  await writeSettings(scope, { disabledSkills: [...list].sort() })
  return 'changed'
}

/**
 * 读取指定作用域中被禁用的SKILL名列表。
 *
 * 这个函数只返回单个作用域的配置，不会合并用户级和项目级；需要合并结果时使用
 * loadDisabledSkillsSet。
 *
 * @param scope 要读取的设置作用域。
 * @returns 该作用域中配置的 disabledSkills 列表；没有配置时返回空数组。
 */
export async function getScopedDisabledSkills(scope: SkillSettingsScope): Promise<string[]> {
  const s = await readSettings(scope)
  return s.disabledSkills ?? []
}
