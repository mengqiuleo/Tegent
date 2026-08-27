// 本模块与 packages/core/src/permissions/index.ts 并列，后者负责
// writeFile、edit、shell 等内置工具。MCP 工具单独维护权限，原因是：
//   - 工具名称运行时才发现，无法提前写入静态规则表；
//   - 用户对某个 MCP 工具选择“以后不再询问”的决定，会按工具名持久化
//     到 ~/.tegent/mcp-permissions.json，与 Shell 前缀规则分开保存。
//
// 默认策略是：每个 MCP 工具初始都必须询问，直到用户选择“始终允许”。
// 不根据名称猜测风险，因为 `list_`、`read_`、`search_` 等命名习惯并
// 不可靠：有些 list 工具会修改数据，有些 create 工具可能只是查询。
import fs from 'node:fs/promises'
import path from 'node:path'

import { userTeCodeDir } from '../utils.js'

function permissionsFile(): string {
  return path.join(userTeCodeDir(), 'mcp-permissions.json')
}

interface StoreShape {
  alwaysAllow: string[]
}

/**
 * 持久化权限文件的内存镜像，以及“仅本次会话允许”的内存集合。
 *
 * 持久化集合在第一次检查时延迟加载；会话集合在实例创建时为空，
 * 只保留在内存中，绝不会写入磁盘。
 */
export class McpPermissionStore {
  private persisted: Set<string> | null = null
  private session = new Set<string>()

  /** 预加载持久化权限文件；不是必须的，后续检查仍会自动延迟加载。 */
  async preload(): Promise<void> {
    await this.ensurePersistedLoaded()
  }

  /**
   * 判断用户是否已经批准某个工具。
   *
   * 会话级允许和持久化的“始终允许”都算批准。
   *
   * @param callableName 模型侧工具名。
   * @returns 已批准时返回 `true`。
   */
  async isApproved(callableName: string): Promise<boolean> {
    if (this.session.has(callableName)) return true
    await this.ensurePersistedLoaded()
    return this.persisted!.has(callableName)
  }

  /** 只允许该工具在本次会话中继续使用，不写入磁盘。 */
  approveForSession(callableName: string): void {
    this.session.add(callableName)
  }

  /**
   * 永久允许该工具并写入磁盘。
   *
   * 写入失败只记录调试日志，不向调用方抛错；最坏情况是下次会话
   * 需要用户再次点击“始终允许”。内存状态仍会保留本次明确同意。
   */
  async approvePermanently(callableName: string): Promise<void> {
    await this.ensurePersistedLoaded()
    if (this.persisted!.has(callableName)) return
    this.persisted!.add(callableName)
    // 同时写入会话集合，避免紧接着发生的下一次调用与磁盘写入竞争。
    this.session.add(callableName)
    try {
      await this.writePersisted()
    } catch (err) {

    }
  }

  private async ensurePersistedLoaded(): Promise<void> {
    if (this.persisted !== null) return
    this.persisted = await readPersisted()
  }

  private async writePersisted(): Promise<void> {
    if (!this.persisted) return
    await fs.mkdir(userTeCodeDir(), { recursive: true })
    const tmp = permissionsFile() + '.tmp'
    const payload: StoreShape = { alwaysAllow: [...this.persisted].sort() }
    // 0600 表示 POSIX 下只有当前用户可读写。
    // 与 mcp-auth.json 相同，Windows 会忽略权限位，但文件位于
    // ~/.tegent，实际暴露范围仍主要限于同一用户运行的其他程序。
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(tmp, permissionsFile())
  }
}

async function readPersisted(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(permissionsFile(), 'utf-8')
    const parsed = JSON.parse(raw) as StoreShape
    if (parsed && Array.isArray(parsed.alwaysAllow)) {
      return new Set(parsed.alwaysAllow.filter((s): s is string => typeof s === 'string'))
    }
  } catch {
    // 文件缺失或格式损坏时使用空允许列表，退化为每次都询问。
  }
  return new Set<string>()
}

/**
 * 将现有 askPermission 回调返回的 `"yes"` / `"always"` / `"no"`
 * 映射成 MCP 权限模块使用的结构化决定。
 *
 * @param raw 询问回调返回的原始选择。
 * @returns MCP 内部使用的允许一次、永久允许或拒绝。
 */
export type McpPermissionDecision = 'allow-once' | 'allow-always' | 'deny'

export function classifyDecision(raw: 'yes' | 'always' | 'no'): McpPermissionDecision {
  if (raw === 'always') return 'allow-always'
  if (raw === 'yes') return 'allow-once'
  return 'deny'
}
