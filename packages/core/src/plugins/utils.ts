import path from 'node:path'

import { TEGENT_DIR, USER_TEGENT_DIR } from '../constants.js'

/**
 * 插件清单目录名。
 *
 * 每个插件根目录下用这个固定目录存放元信息，对齐 Claude Code 的
 * `.claude-plugin/` 约定。
 */
export const PLUGIN_MANIFEST_DIR = '.tegent-plugin'

/**
 * 插件清单文件名，完整路径是 `<plugin-root>/.tegent-plugin/plugin.json`。
 */
export const PLUGIN_MANIFEST_FILENAME = 'plugin.json'

/**
 * 用户级插件缓存目录：`~/.tegent/plugins/cache`。
 *
 * marketplace 安装的插件落在 `cache/<name>/` 下；loader 默认从这里扫描。
 */
export function pluginCacheDir(): string {
  return path.join(USER_TEGENT_DIR, 'plugins', 'cache')
}

/**
 * 项目级插件目录：`<repo-root>/.tegent/plugins`。
 *
 * 项目自带的插件直接放在 `plugins/<name>/` 下（没有 cache 这一层），
 * 同名时项目级覆盖用户级缓存里的版本。
 */
export function projectPluginsDir(): string {
  return path.join(process.cwd(), TEGENT_DIR, 'plugins')
}

/**
 * 计算插件清单文件的绝对路径。
 *
 * @param pluginDir - 插件根目录。
 * @returns 该插件清单文件的路径，不保证文件存在。
 */
export function pluginManifestPath(pluginDir: string): string {
  return path.join(pluginDir, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILENAME)
}

/**
 * 拼出插件唯一 id。
 *
 * @param name - 插件名称，来自清单 `name` 字段。
 * @param marketplace - marketplace 名称；本地直装插件省略。
 * @returns 有 marketplace 时是 `name@marketplace`，否则就是 `name` 本身。
 *
 * 这个字符串是注册表的主键，也会写进 skill 的 `pluginId` 和设置文件的
 * `disabledPlugins`，全局保持同一种格式。
 */
export function formatPluginId(name: string, marketplace?: string): string {
  return marketplace ? `${name}@${marketplace}` : name
}

/**
 * 拆开插件 id。
 *
 * @param id - 插件 id（`name` 或 `name@marketplace`）。
 * @returns 名称和可选的 marketplace；id 里有多余 `@` 时只按最后一个切分，
 *   因为插件名本身不允许出现 `@`（见 `isValidPluginName`），多余的 `@`
 *   只可能来自 marketplace 侧。
 */
export function parsePluginId(id: string): { name: string; marketplace?: string } {
  const at = id.lastIndexOf('@')
  if (at <= 0) return { name: id } // 没有 @，或 @ 在首位（不是合法 id，按原样返回让调用方处理）。
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) }
}

/**
 * 插件名的最大长度，和 npm 包名上限保持一致。
 */
const MAX_PLUGIN_NAME_LENGTH = 214

/**
 * 判断是否是合法插件名。
 *
 * 规则对齐 npm 包名的常用子集：小写字母开头，只含小写字母、数字、`.`、`_`、`-`。
 * 收窄到小写是为了让插件 id 在不同操作系统的大小写不敏感文件系统上行为一致 ——
 * 插件目录名来自插件名，`Foo` 和 `foo` 在 Windows/macOS 上会碰撞。
 *
 * @param name - 待校验的插件名。
 * @returns 合法返回 `true`。
 */
export function isValidPluginName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_PLUGIN_NAME_LENGTH &&
    /^[a-z0-9][a-z0-9._-]*$/.test(name)
  )
}
