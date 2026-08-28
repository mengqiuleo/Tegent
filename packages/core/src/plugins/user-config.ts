// 文件布局：
//
//   ~/.tegent/plugins/user-config.json    →  {
//                                              [pluginId]: { [key]: <value> }
//                                            }
//
// 存储格式是普通 JSON map；文件创建时使用 0600 权限（仅所有者可读写），
// 尽量避免其他用户会话中的进程读取敏感值。这不是系统级密钥链的替代品
// （macOS Keychain / Windows Credential Manager / Linux libsecret），只是一个
// 避免引入原生构建复杂度的 v1 方案。`sensitive: true` 仍然会在输入阶段驱动
// 掩码显示，只是静态存储目前仍放在同一个文件里。
//
// 未来可以把 `sensitive` 条目迁移到真正的密钥链。读取层届时可以合并 JSON
// 文件和 keychain 两个来源，所以这个增强可以做到向后兼容。
//
// 为什么不把 sensitive 和 non-sensitive 拆成两个文件：它只会增加文件 IO，
// 并不会提升安全边界，因为两个文件仍位于同一目录并使用同样权限。真正的保护
// 需要系统密钥链；在那之前，一个文件更诚实也更简单。
import fs from 'node:fs/promises'
import path from 'node:path'

import { pluginsRoot } from './paths.js'

/**
 * 单个 userConfig 字段允许保存的值类型。
 *
 * manifest 中的 `type`（string / number / boolean）会在提示用户输入时校验；
 * 落盘经过 JSON 往返时也只需要支持这三类基础值。
 */
export type UserConfigValue = string | number | boolean

/** 单个插件的 userConfig 映射，key 来自 manifest 中每个字段的 `key`。 */
export type PluginUserConfig = Record<string, UserConfigValue>

/** 整个 user-config.json 的形状：`{ [pluginId]: PluginUserConfig }`。 */
type UserConfigFile = Record<string, PluginUserConfig>

/**
 * 返回 user-config.json 文件路径。
 *
 * @returns 插件 userConfig 持久化文件的绝对路径。
 */
function userConfigPath(): string {
  return path.join(pluginsRoot(), 'user-config.json')
}

/**
 * 读取完整 userConfig 文件。
 *
 * 文件不存在、JSON 损坏或顶层不是对象时都返回空对象；损坏场景会写入 debug log，
 * 但不阻塞插件加载。
 *
 * @returns 所有插件的 userConfig 映射。
 */
async function readFile(): Promise<UserConfigFile> {
  try {
    const raw = await fs.readFile(userConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as UserConfigFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}

    return {}
  }
}

/**
 * 写入完整 userConfig 文件。
 *
 * 写入前会确保父目录存在，并尽量用 0600 权限创建文件，降低敏感值被其他用户
 * 读取的风险。
 *
 * @param data 要写入的完整 userConfig 映射。
 */
async function writeFile(data: UserConfigFile): Promise<void> {
  const p = userConfigPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  // 0600 让文件仅对当前用户可读写。Windows 上这基本是 no-op，
  // 因为 fs.chmod 不能等价映射到 ACL；除非调用 icacls，否则这里没有
  // 更可靠的纯 Node 做法。后续 keychain 方案会更完整地解决 Windows。
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

/**
 * 读取单个插件已保存的 userConfig。
 *
 * 插件尚未保存配置时返回空对象，调用方可以继续从 manifest 的 default 字段
 * 推导默认值。
 *
 * @param pluginId 形如 `name@marketplace` 的插件 ID。
 * @returns 该插件保存过的配置映射。
 */
export async function getPluginUserConfig(pluginId: string): Promise<PluginUserConfig> {
  const all = await readFile()
  return all[pluginId] ?? {}
}

/**
 * 写入单个插件的 userConfig。
 *
 * 新值会和已有字段合并，而不是整体替换；这样交互式提示可以每收集一个字段
 * 就调用一次，不会把前面输入的字段清掉。
 *
 * @param pluginId 形如 `name@marketplace` 的插件 ID。
 * @param values 要合并保存的字段值。
 */
export async function setPluginUserConfig(pluginId: string, values: PluginUserConfig): Promise<void> {
  const all = await readFile()
  all[pluginId] = { ...(all[pluginId] ?? {}), ...values }
  await writeFile(all)
}

/**
 * 删除单个插件的所有 userConfig。
 *
 * 通常由卸载流程调用；如果插件没有保存过配置，则直接返回。
 *
 * @param pluginId 形如 `name@marketplace` 的插件 ID。
 */
export async function clearPluginUserConfig(pluginId: string): Promise<void> {
  const all = await readFile()
  if (!(pluginId in all)) return
  delete all[pluginId]
  await writeFile(all)
}

/**
 * 把单个插件的 userConfig 映射转换成可合并到子进程环境变量里的字符串记录。
 *
 * 每个 manifest key 会直接成为环境变量名；number 和 boolean 会转换为字符串。
 * 未设置的字段不会出现在返回对象中，因此调用方合并 env 时会保持原环境不变。
 *
 * @param pluginId 形如 `name@marketplace` 的插件 ID。
 * @returns 可传给子进程 env 的字符串映射。
 */
export async function getPluginUserConfigEnv(pluginId: string): Promise<Record<string, string>> {
  const cfg = await getPluginUserConfig(pluginId)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(cfg)) {
    env[k] = String(v)
  }
  return env
}
