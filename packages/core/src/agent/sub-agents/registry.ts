// CLI 启动时构建一次；/plugin refresh 时可以通过 reloadSubAgentRegistry 热重载。
// 内置 agents 同步加载，磁盘上的自定义 agents 异步扫描。
// 同名自定义 agent 会覆盖内置 agent，优先级是 project > user > built-in。
import { builtInAgents } from './built-in.js'
import { type LoadCustomAgentsOptions, loadCustomAgents } from './loader.js'
import type { SubAgentDefinition } from './types.js'

/** reload 返回的差异摘要。
 *
 * /plugin refresh 会用它生成用户可见的刷新结果提示。 */
export interface SubAgentReloadSummary {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: string[]
}

export class SubAgentRegistry {
  private agents: Map<string, SubAgentDefinition>

  constructor(agents: SubAgentDefinition[]) {
    this.agents = new Map()
    for (const a of agents) {
      this.agents.set(a.name, a)
    }
  }

  get(name: string): SubAgentDefinition | undefined {
    return this.agents.get(name)
  }

  list(): SubAgentDefinition[] {
    return [...this.agents.values()]
  }

  names(): string[] {
    return [...this.agents.keys()]
  }

  /** 用新加载的 agent 列表替换内存注册表。
   *
   * /plugin refresh 使用它。注意这里保持 SubAgentRegistry 对象身份不变，
   * 这样已经捕获 `options.subAgentRegistry` 引用的地方仍然有效。 */
  reload(agents: SubAgentDefinition[]): SubAgentReloadSummary {
    const previous = this.agents
    const next = new Map<string, SubAgentDefinition>()
    for (const a of agents) next.set(a.name, a)
    const summary: SubAgentReloadSummary = { added: [], removed: [], changed: [], unchanged: [] }
    for (const [name, agent] of next) {
      const prev = previous.get(name)
      if (!prev) summary.added.push(name)
      else if (prev.prompt !== agent.prompt || prev.source !== agent.source || prev.pluginId !== agent.pluginId)
        summary.changed.push(name)
      else summary.unchanged.push(name)
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) summary.removed.push(name)
    }
    this.agents = next
    return summary
  }
}

/** 构建完整注册表：先内置，再自定义；后面的同名条目会覆盖前面的。 */
export async function createSubAgentRegistry(opts: LoadCustomAgentsOptions = {}): Promise<SubAgentRegistry> {
  const custom = await loadCustomAgents(opts)
  // 加载顺序：built-in -> custom。Map.set 覆盖同名项，所以 custom 胜出。
  return new SubAgentRegistry([...builtInAgents, ...custom])
}

/** 重新扫描磁盘并原地重建内存 agent 列表。
 *
 * 扫描逻辑与启动时相同；opts 会由调用方传入，尤其是插件贡献的 extraDirs。
 * 返回差异摘要，供 /plugin refresh 展示。 */
export async function reloadSubAgentRegistry(
  registry: SubAgentRegistry,
  opts: LoadCustomAgentsOptions = {},
): Promise<SubAgentReloadSummary> {
  const custom = await loadCustomAgents(opts)
  return registry.reload([...builtInAgents, ...custom])
}

/** 只包含内置 agents 的同步注册表。
 *
 * 用于测试，或明确需要跳过磁盘扫描的场景。 */
export function createBuiltInRegistry(): SubAgentRegistry {
  return new SubAgentRegistry(builtInAgents)
}
