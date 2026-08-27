// 插件贡献内容与既有注册表之间的桥接层。
//
// skills/loader.ts 的 LoadSkillsOptions.extraDirs 就是为这一步预留的入口：
// 插件物理上位于 ~/.tegent/plugins/cache/<name>/，但它的 skills/ 子目录要能
// 并入同一个 skill 注册表，且保留 pluginId 来源信息。这里只做纯函数换算，
// 不做任何 I/O —— 是否真的有 skills/ 子目录由 loadSkillsFromDir 的 fail-soft
// readdir 决定（目录不存在按空处理），因此无需预先探测磁盘。
import path from 'node:path'

import type { LoadSkillsOptions } from '../skills/loader.js'
import type { PluginDefinition } from './types.js'

/**
 * 插件贡献 skills 的固定子目录名，与 Claude Code 插件布局对齐。
 */
export const PLUGIN_SKILLS_DIRNAME = 'skills'

/**
 * 把已启用插件列表换算成 skill 加载器的 extraDirs 参数。
 *
 * @param plugins - 已启用的插件定义列表（调用方应传 `registry.list()` 的结果，
 *   禁用插件的贡献内容不进入 agent 视野）。
 * @returns 形如 `[{ dir: '<plugin-root>/skills', pluginId: '<id>' }]` 的列表，
 *   可直接作为 `loadSkills({ extraDirs })` / `createSkillRegistry({ extraDirs })` 的参数。
 *
 * 合并后的优先级由 loadSkills 的扫描顺序决定：用户级 → 插件级 → 项目级，
 * 即项目作者可以用项目级同名 skill 覆盖插件提供的版本（后扫描者覆盖）。
 */
export function pluginSkillDirs(
  plugins: readonly PluginDefinition[],
): NonNullable<LoadSkillsOptions['extraDirs']> {
  return plugins.map((plugin) => ({
    dir: path.join(plugin.dir, PLUGIN_SKILLS_DIRNAME),
    pluginId: plugin.id, // SkillDefinition.pluginId 由此而来，UI 显示 “(from plugin: …)”。
  }))
}
