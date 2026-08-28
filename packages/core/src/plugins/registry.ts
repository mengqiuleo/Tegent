// CLI 启动时由 [[loader]].loadAllPlugins() 构建一次，然后在当前会话中作为
// 长生命周期对象使用。注册表保存所有成功加载的插件，包括已启用和已禁用的，
// 这样 `/plugin list` 才能展示完整状态；同时也保存加载错误，供
// `/plugin doctor` 展示。
//
// 热刷新模型和 SkillRegistry 一致：`/plugin refresh` 会原地替换内部状态，
// 保持 PluginRegistry 对象本身的 identity 不变，确保所有已捕获的
// `options.pluginRegistry` 引用仍然有效。刷新后 CLI 会让 `systemPromptCache`
// 失效；因为插件可能贡献 skills / agents / commands 到系统提示词里，
// CLAUDE.md 中描述的字节稳定性约束仍然适用。
import type { LoadedPlugin, PluginLoadError } from './types.js'

/**
 * 两次注册表快照之间的差异摘要。
 *
 * `/plugin refresh` 会用它渲染 added / removed / changed / unchanged 信息，
 * 展示方式和 `/mcp refresh`、`/skill refresh` 保持一致。
 */
export interface PluginReloadSummary {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: string[]
}

export class PluginRegistry {
  private byId: Map<string, LoadedPlugin>
  private errors: PluginLoadError[]

  /**
   * 创建一个插件注册表快照。
   *
   * @param plugins 成功加载的插件列表，包含 enabled 和 disabled。
   * @param errors 非致命加载错误列表，默认没有错误。
   */
  constructor(plugins: LoadedPlugin[], errors: PluginLoadError[] = []) {
    this.byId = new Map()
    for (const p of plugins) this.byId.set(p.id, p)
    this.errors = [...errors]
  }

  /**
   * 按 ID 获取已启用插件。
   *
   * 已禁用插件会被这个查询隐藏；如果调用方需要看到 disabled 状态，例如
   * `/plugin list`，请使用 {@link getEntry}。
   *
   * @param id 形如 `name@marketplace` 的插件 ID。
   * @returns 已启用插件；不存在或已禁用时返回 `undefined`。
   */
  get(id: string): LoadedPlugin | undefined {
    const p = this.byId.get(id)
    if (!p || !p.enabled) return undefined
    return p
  }

  /**
   * 按 ID 获取插件条目，包含已禁用插件。
   *
   * @param id 形如 `name@marketplace` 的插件 ID。
   * @returns 匹配插件；不存在时返回 `undefined`。
   */
  getEntry(id: string): LoadedPlugin | undefined {
    return this.byId.get(id)
  }

  /**
   * 返回所有已启用插件。
   *
   * 这是 agent loop 和下游集成层真正会看到的插件集合。
   *
   * @returns 已启用插件列表副本。
   */
  list(): LoadedPlugin[] {
    return [...this.byId.values()].filter((p) => p.enabled)
  }

  /**
   * 返回所有已加载插件，包含已禁用插件。
   *
   * @returns 注册表中所有插件列表副本。
   */
  listAll(): LoadedPlugin[] {
    return [...this.byId.values()]
  }

  /**
   * 返回所有已启用插件的 ID。
   *
   * @returns 已启用 plugin id 列表。
   */
  ids(): string[] {
    return this.list().map((p) => p.id)
  }

  /**
   * 返回加载阶段收集到的非致命错误。
   *
   * 单个插件坏掉不会阻塞启动，这些错误会留给 `/plugin doctor` 展示。
   *
   * @returns 只读的加载错误列表。
   */
  loadErrors(): readonly PluginLoadError[] {
    return this.errors
  }

  /**
   * 用新加载结果替换内存中的插件列表。
   *
   * `/plugin refresh` 会调用它。这个方法只替换内部 Map 和错误数组，不替换
   * PluginRegistry 对象本身，因此所有缓存引用都继续有效。返回的差异摘要用于
   * UI 展示 added / removed / changed / unchanged。
   *
   * @param plugins 新一轮成功加载的插件列表。
   * @param errors 新一轮加载收集到的非致命错误。
   * @returns 新旧注册表之间的差异摘要。
   */
  reload(plugins: LoadedPlugin[], errors: PluginLoadError[] = []): PluginReloadSummary {
    const previous = this.byId
    const next = new Map<string, LoadedPlugin>()
    for (const p of plugins) next.set(p.id, p)

    const summary: PluginReloadSummary = { added: [], removed: [], changed: [], unchanged: [] }
    for (const [id, plugin] of next) {
      const prev = previous.get(id)
      if (!prev) {
        summary.added.push(id)
      } else if (
        prev.manifest.version !== plugin.manifest.version ||
        prev.rootDir !== plugin.rootDir ||
        prev.enabled !== plugin.enabled ||
        prev.scope !== plugin.scope
      ) {
        summary.changed.push(id)
      } else {
        summary.unchanged.push(id)
      }
    }
    for (const id of previous.keys()) {
      if (!next.has(id)) summary.removed.push(id)
    }

    this.byId = next
    this.errors = [...errors]
    return summary
  }
}

/**
 * 创建空插件注册表。
 *
 * 当启动参数禁用插件（例如 `--no-plugins`）或没有任何插件安装时使用它。
 * 下游代码拿到空注册表即可正常调用方法，避免到处写 null 判断。
 *
 * @returns 不含插件和加载错误的注册表。
 */
export function emptyPluginRegistry(): PluginRegistry {
  return new PluginRegistry([], [])
}
