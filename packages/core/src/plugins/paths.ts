// 默认布局（位于 ~/.tegent/plugins/ 下）：
//
//   known_marketplaces.json          —— 用户已订阅 marketplace 的注册表
//   marketplaces/<name>/marketplace.json
//                                    —— 缓存下来的 marketplace 索引
//   cache/<marketplace>/<plugin>/<version>/
//                                    —— 实际安装后的插件内容
//   data/<plugin-id>/                —— 插件的持久化数据目录
//                                      （升级后仍保留；plugin-id 是
//                                      "name@marketplace"，路径分隔符会被清洗）
//   installed_plugins.json           —— 已安装插件的账本文件
import path from 'node:path'

import { TEGENT_DIR, userTeCodeDir } from '../utils.js'

const PLUGINS_DIR_NAME = 'plugins'

/**
 * 返回插件子系统的根目录。
 *
 * @returns 插件根目录的绝对路径或用户提供的覆盖路径。 `~/.tegent/plugins/` 
 */
export function pluginsRoot(): string {
  return path.join(userTeCodeDir(), PLUGINS_DIR_NAME)
}

/**
 * 返回已订阅 marketplace 注册表文件的路径。
 *
 * @returns `~/.tegent/plugins/known_marketplaces.json`。
 */
export function knownMarketplacesPath(): string {
  return path.join(pluginsRoot(), 'known_marketplaces.json')
}

/**
 * 返回某个 marketplace 的缓存目录。
 *
 * @param name marketplace 的订阅别名。
 * @returns `~/.tegent/plugins/marketplaces/<name>/`。
 */
export function marketplaceDir(name: string): string {
  return path.join(pluginsRoot(), 'marketplaces', name)
}

/**
 * 返回某个 marketplace 缓存索引文件的路径。
 *
 * @param name marketplace 的订阅别名。
 * @returns `~/.tegent/plugins/marketplaces/<name>/marketplace.json`。
 */
export function marketplaceIndexPath(name: string): string {
  return path.join(marketplaceDir(name), 'marketplace.json')
}

/**
 * 返回某个插件所有版本共同的缓存父目录。
 *
 * 所有版本都放在这个目录下；当前启用哪个版本由
 * `installed_plugins.json` 里最近记录的版本决定。
 *
 * @param marketplace 插件所属 marketplace 的别名。
 * @param plugin 插件名。
 * @returns `~/.tegent/plugins/cache/<marketplace>/<plugin>/`。
 */
export function pluginCacheParent(marketplace: string, plugin: string): string {
  return path.join(pluginsRoot(), 'cache', marketplace, plugin) // 因为 cache/<marketplace>/<plugin>/<version>/
}

/**
 * 返回某个插件某个版本的实际缓存目录。
 *
 * @param marketplace 插件所属 marketplace 的别名。
 * @param plugin 插件名。
 * @param version manifest 中解析出的版本号。
 * @returns `~/.tegent/plugins/cache/<marketplace>/<plugin>/<version>/`。
 */
export function pluginCacheDir(marketplace: string, plugin: string, version: string): string {
  return path.join(pluginCacheParent(marketplace, plugin), version)
}

/**
 * 返回插件持久化数据目录。
 *
 * 这个目录和版本缓存分离，因此插件升级或重装后仍然保留。插件 ID
 * 通常是 `name@marketplace`；这里会把路径分隔符等危险字符替换成 `_`，
 * 避免 Windows 或 POSIX 路径解析被意外打断。
 *
 * @param pluginId 形如 `name@marketplace` 的插件 ID。
 * @returns `~/.tegent/plugins/data/<sanitised-plugin-id>/`。
 */
export function pluginDataDir(pluginId: string): string {
  const safe = pluginId.replace(/[/\\:]/g, '_')
  return path.join(pluginsRoot(), 'data', safe)
}

/**
 * 返回已安装插件账本文件的路径。
 *
 * @returns `~/.tegent/plugins/installed_plugins.json`。
 */
export function installedPluginsPath(): string {
  return path.join(pluginsRoot(), 'installed_plugins.json')
}

/**
 * 返回项目内置插件目录。
 *
 * 这个路径比较少见，适用于仓库自己提交插件源码的场景，而不是从
 * marketplace 安装到用户缓存。loader 会在用户级缓存之外额外扫描这里。
 *
 * @param cwd 当前项目工作目录。
 * @returns `<cwd>/.tegent/plugins/`。
 */
export function projectPluginsDir(cwd: string): string {
  return path.join(cwd, TEGENT_DIR, 'plugins')
}


/**
 * loader 会按优先级探测这些相对 manifest 路径，第一个命中的路径生效。
 *
 * 这里故意接受 Claude Code 的 `.claude-plugin/plugin.json`，让为 Claude Code 编写的插件无需修改就能安装到 tegent
 */
export const MANIFEST_CANDIDATES: ReadonlyArray<{ format: 'native' | 'claude' | 'bare'; rel: string }> = [
  { format: 'native', rel: '.tegent-plugin/plugin.json' },
  { format: 'claude', rel: '.claude-plugin/plugin.json' },
  { format: 'bare', rel: 'plugin.json' },
]

/**
 * Gemini 扩展使用的 manifest 文件名。
 *
 * 我们只探测它来给用户更明确的错误信息：当用户尝试安装 Gemini-only
 * 扩展时，installer 会拒绝并指向设计文档，而不是笼统地说“找不到 manifest”。
 */
export const GEMINI_MANIFEST_REL = 'gemini-extension.json'
