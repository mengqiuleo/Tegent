import type { PluginDefinition, PluginEntry, PluginReloadSummary } from './types.js'

/**
 * 会话级插件注册表。
 *
 * 它用插件 id 建立索引，并负责按 `disabledPlugins` 设置过滤 agent 可见的插件。
 * 结构刻意和 `SkillRegistry` 保持同构：构造器接收 loader 扫描出的定义列表，
 * `reload()` 原地替换内容并返回 diff 摘要，方便未来 `/plugin refresh` 复用
 * `/skill refresh` 的渲染逻辑。
 *
 * 和 `SkillRegistry` 的差别是多了 `register()` / `unregister()` 两个命令式入口：
 * 插件除了从磁盘扫描，也可能由宿主代码编程式注册（例如内置插件、测试夹具）。
 */
export class PluginRegistry {
  private byId: Map<string, PluginEntry> // 以插件 id 为 key 的注册表内部索引。

  private disabledIds: ReadonlySet<string> // 当前被禁用的插件 id 集合，register() 时也要参考它。

  /**
   * 创建一个插件注册表。
   *
   * @param plugins - 已加载的插件定义列表。
   * @param disabled - 当前被禁用的插件 id 集合（来自 settings 的 `disabledPlugins`）。
   */
  constructor(plugins: PluginDefinition[], disabled: ReadonlySet<string> = new Set()) {
    this.byId = new Map() // 初始化内部 map。
    this.disabledIds = disabled // 记录禁用集合，供后续 register() 计算 disabled 状态。
    // 同 id 插件采用后写覆盖前写。
    // `loadPlugins()` 会先返回用户级插件，再返回项目级插件，
    // 因此项目级同名插件会覆盖用户级缓存里的版本。
    for (const plugin of plugins) {
      this.register(plugin)
    }
  }

  /**
   * 注册（或覆盖）一个插件。
   *
   * @param plugin - 插件定义。
   *
   * 已存在同 id 条目时直接覆盖 —— 这与构造器里“后写覆盖前写”的语义一致，
   * 也让 `/plugin refresh` 之外的程序化更新（例如热替换）成为可能。
   */
  register(plugin: PluginDefinition): void {
    this.byId.set(plugin.id, { ...plugin, disabled: this.disabledIds.has(plugin.id) }) // 写入条目并计算禁用状态。
  }

  /**
   * 按 id 移除一个插件。
   *
   * @param id - 插件 id。
   * @returns 移除成功返回 `true`；id 不存在返回 `false`。
   */
  unregister(id: string): boolean {
    return this.byId.delete(id)
  }

  /**
   * 用新加载的插件列表替换内存中的注册表内容。
   *
   * @param plugins - 新加载的插件定义列表。
   * @param disabled - 新读取的禁用插件 id 集合。
   * @returns 和旧状态对比后的逐 id 变更摘要。
   *
   * 方法会保持 `PluginRegistry` 对象身份不变，只替换内部 map，
   * 这样已缓存注册表引用的调用方不需要重新取引用。
   */
  reload(plugins: PluginDefinition[], disabled: ReadonlySet<string>): PluginReloadSummary {
    const previous = this.byId // 保存旧 map，用于稍后计算 diff。
    const next = new Map<string, PluginEntry>() // 创建新的 map，承载刷新后的条目。
    for (const plugin of plugins) {
      next.set(plugin.id, { ...plugin, disabled: disabled.has(plugin.id) }) // 写入新条目并重新计算禁用状态。
    }

    const summary: PluginReloadSummary = { added: [], removed: [], changed: [], unchanged: [] } // 初始化刷新摘要。
    for (const [id, entry] of next) {
      const prev = previous.get(id) // 查找同 id 旧条目。
      if (!prev) {
        summary.added.push(id) // 旧 map 中不存在，说明这是新增插件。
      } else if (
        prev.version !== entry.version ||
        prev.description !== entry.description ||
        prev.dir !== entry.dir ||
        prev.source !== entry.source ||
        prev.disabled !== entry.disabled
      ) {
        summary.changed.push(id) // 关键字段或禁用状态不同，说明这个插件已变化。
      } else {
        summary.unchanged.push(id) // 新旧字段一致，说明这个插件未变化。
      }
    }
    for (const id of previous.keys()) {
      if (!next.has(id)) summary.removed.push(id) // 旧 map 有而新 map 没有，说明这个插件已移除。
    }

    this.byId = next // 用刷新后的 map 替换内部索引。
    this.disabledIds = disabled // 同步更新禁用集合，保证后续 register() 的判断基于最新设置。
    return summary // 返回调用方可展示的刷新摘要。
  }

  /**
   * 按 id 获取已启用的插件。
   *
   * @param id - 插件 id（`name` 或 `name@marketplace`）。
   * @returns 找到且未禁用时返回插件定义，否则返回 `undefined`。
   *
   * 禁用插件对调用方（贡献目录计算、`/plugin list` 等）表现为不存在。
   * 如果调用方需要查看禁用标记，应使用 `getEntry()`。
   */
  get(id: string): PluginDefinition | undefined {
    const entry = this.byId.get(id) // 从内部索引中读取条目。
    if (!entry || entry.disabled) return undefined // 不存在或已禁用时，对外表现为不可用。
    return entry // 返回可用插件定义。
  }

  /**
   * 按 id 获取原始插件条目。
   *
   * @param id - 插件 id。
   * @returns 找到时返回条目，包括 disabled 标记；否则返回 `undefined`。
   *
   * enable/disable、uninstall 这类 handler 需要看见并操作已禁用插件，走这个入口。
   */
  getEntry(id: string): PluginEntry | undefined {
    return this.byId.get(id) // 不过滤 disabled，直接返回内部条目。
  }

  /**
   * 列出所有已启用的插件。
   *
   * @returns 已启用插件定义列表。
   */
  list(): PluginDefinition[] {
    return [...this.byId.values()].filter((p) => !p.disabled) // 展开内部条目并过滤掉禁用项。
  }

  /**
   * 列出所有已启用插件的 id。
   *
   * @returns 已启用插件 id 列表。
   */
  names(): string[] {
    return [...this.byId.values()].filter((p) => !p.disabled).map((p) => p.id) // 过滤禁用项后提取 id。
  }

  /**
   * 列出所有已加载插件，包括禁用项。
   *
   * @returns 带 `disabled` 标记的完整插件条目列表。
   *
   * `/plugin list` 会使用它，因为列表命令也需要展示已禁用插件。
   */
  listAll(): PluginEntry[] {
    return [...this.byId.values()] // 直接返回内部条目的数组副本。
  }
}
