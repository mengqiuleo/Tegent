// 本文件为 `/mcp add` 和 `/mcp remove` 提供配置读写能力。
// 看起来只是读改写 JSON，但必须同时满足以下约束：
//   - 保留 model、thinking 等无关的顶层字段；
//   - 添加或删除一个 mcpServer 时保留其他 `mcpServers` 条目；
//   - 通过临时文件加重命名实现原子写入，避免 Ctrl-C 留下半个 JSON；
//   - 写入前重新读取文件，尽量避免覆盖其他进程刚刚做出的修改。

import fs from 'node:fs/promises'
import path from 'node:path'

import { getUserConfigPath } from '../config/index.js'
import { TEGENT_DIR } from '../utils.js'
import { parseServerConfig } from './config-schema.js'
import { type McpServerConfig } from './types.js'

export type ConfigScope = 'user' | 'project'

/**
 * 返回指定作用域的 config.json 路径。
 *
 * @param scope 配置作用域：用户级或当前项目级。
 * @param cwd 当前项目的绝对路径。
 * @returns 对应作用域的配置文件路径 `~/.tegent/config.json` 或者 `.tegent/config.json`。
 */
export function getConfigPath(scope: ConfigScope, cwd: string): string {
  if (scope === 'user') return getUserConfigPath()
  return path.join(cwd, TEGENT_DIR, 'config.json')
}

/**
 * 读取指定作用域的 JSON 配置对象。
 *
 * 文件不存在时返回空对象。文件存在但 JSON 损坏时会抛错，而不是返回
 * 空对象，因为返回空对象会掩盖配置损坏，并可能在后续写入时覆盖原文件。
 *
 * @param scope 要读取的配置作用域。
 * @param cwd 当前项目路径。
 * @returns 已解析的顶层对象；不存在时返回空对象。
 * @throws {Error} 文件存在但不是合法 JSON 时抛出。
 */
async function readConfigObject(scope: ConfigScope, cwd: string): Promise<Record<string, unknown>> {
  const file = getConfigPath(scope, cwd)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    throw new Error(`Config file at ${file} is not valid JSON. Fix it manually before running /mcp add or /mcp remove.`)
  }
  return {}
}

/**
 * 原子写入 JSON 配置。
 *
 * 先写入同目录临时文件，再调用 rename 替换目标文件。这样即使进程在
 * 写入期间被终止，目标文件仍然保持上一次完整内容。
 *
 * @param scope 要写入的配置作用域。
 * @param cwd 当前项目路径。
 * @param obj 要序列化的顶层配置对象。
 */
async function writeConfigObject(scope: ConfigScope, cwd: string, obj: Record<string, unknown>): Promise<void> {
  const file = getConfigPath(scope, cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, file)
}

/**
 * 描述一个 mcpServer 名称当前存在于哪些配置作用域。
 *
 * `/mcp remove` 可以据此自动选择作用域；如果用户级和项目级同时存在
 * 同名 mcpServer ，则返回 `both`，要求调用方显式指定 `--scope`。
 */
export type DetectScopeResult = { kind: 'not-found' } | { kind: 'user' } | { kind: 'project' } | { kind: 'both' }

/**
 * 检查 mcpServer 名称是否存在于指定作用域的配置中。
 *
 * @param name 要查找的 mcpServer 名称。
 * @param scope 要检查的配置作用域。
 * @param cwd 当前项目路径。
 * @returns 找到同名条目时返回 `true`，否则返回 `false`。
 */
export async function detectScope(name: string, cwd: string): Promise<DetectScopeResult> {
  const [user, project] = await Promise.all([serverExists(name, 'user', cwd), serverExists(name, 'project', cwd)])
  if (user && project) return { kind: 'both' }
  if (user) return { kind: 'user' }
  if (project) return { kind: 'project' }
  return { kind: 'not-found' }
}

/**
 * 检查指定作用域的 `mcpServers` 是否包含 mcpServer 名称。
 *
 * @param name 要查找的 mcpServer 名称。
 * @param scope 要检查的配置作用域。
 * @param cwd 当前项目路径。
 * @returns 条目存在时返回 `true`。
 */
export async function serverExists(name: string, scope: ConfigScope, cwd: string): Promise<boolean> {
  const obj = await readConfigObject(scope, cwd)
  const servers = obj.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false
  return Object.prototype.hasOwnProperty.call(servers, name)
}

/**
 * 将一个 mcpServer 配置写入指定作用域。
 *
 * 函数会先用统一 schema 校验配置，再读取最新文件内容并只替换目标
 * 条目。它本身不负责判断重复名称，调用方应先用 `serverExists` 检查，
 * 并向用户展示更友好的“已存在”提示。
 *
 * @param name 要写入的 mcpServer 名称。
 * @param config 要写入的 MCP 配置。
 * @param scope 目标配置作用域。
 * @param cwd 当前项目路径。
 * @returns 实际写入的配置文件路径。
 * @throws {Error} 配置不符合 schema，或文件读写失败时抛出。
 */
export async function writeServerToConfig(
  name: string,
  config: McpServerConfig,
  scope: ConfigScope,
  cwd: string,
): Promise<{ path: string }> {
  // 先校验再写入，避免错误配置被持久化后在下一次启动时才暴露。
  const validated = parseServerConfig(name, config)

  const obj = await readConfigObject(scope, cwd)
  const existing = obj.mcpServers
  const servers =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  servers[name] = validated
  obj.mcpServers = servers
  await writeConfigObject(scope, cwd, obj)
  return { path: getConfigPath(scope, cwd) }
}

/**
 * 从指定作用域删除一个 mcpServer 配置。
 *
 * 该操作是幂等的： mcpServer 不存在或文件不存在时返回 `removed: false`。
 * 删除最后一个 mcpServer 后仍保留 `mcpServers: {}`，方便以后继续添加，
 * 也避免用户查看 Git diff 时看到不必要的字段删除和重建。
 *
 * @param name 要删除的 mcpServer 名称。
 * @param scope 要修改的配置作用域。
 * @param cwd 当前项目路径。
 * @returns 配置文件路径，以及本次是否真的删除了条目。
 */
export async function removeServerFromConfig(
  name: string,
  scope: ConfigScope,
  cwd: string,
): Promise<{ path: string; removed: boolean }> {
  const file = getConfigPath(scope, cwd)
  const obj = await readConfigObject(scope, cwd)
  const existing = obj.mcpServers
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return { path: file, removed: false }
  }
  const servers = existing as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(servers, name)) {
    return { path: file, removed: false }
  }
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(servers)) {
    if (k !== name) next[k] = v
  }
  obj.mcpServers = next
  await writeConfigObject(scope, cwd, obj)
  return { path: file, removed: true }
}

/**
 * 读取指定作用域中某个 mcpServer 的原始配置。
 *
 * 主要用于 `/mcp add` 发现重复名称时展示当前配置。找不到条目时返回
 * `null`；读取或解析失败时也返回 `null`，因为重复检查不应让命令崩溃。
 *
 * @param name 要读取的 mcpServer 名称。
 * @param scope 要读取的配置作用域。
 * @param cwd 当前项目路径。
 * @returns 原始配置对象，找不到或读取失败时返回 `null`。
 */
export async function readServerConfig(name: string, scope: ConfigScope, cwd: string): Promise<unknown | null> {
  try {
    const obj = await readConfigObject(scope, cwd)
    const servers = obj.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null
    const value = (servers as Record<string, unknown>)[name]
    return value ?? null
  } catch {
    return null
  }
}
