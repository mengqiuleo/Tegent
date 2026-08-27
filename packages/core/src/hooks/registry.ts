// 注册表是一个内存映射：事件名 -> 按注册顺序排列的 `RegisteredHook` 列表。
// CLI 启动时由 [[buildHookRegistry]] 构建一次，然后交给 HookBus 在整个会话中持有。
// 它遵循和插件管线其他部分相同的字节稳定性约束：hook 列表不应在两轮对话之间悄悄改变。
// 如果 hook 列表变化，应通过 `/plugin refresh` 重新扫描并让 systemPromptCache 失效。
// 即使 hook 本身不会出现在 prompt 里，保持统一规则也能避免引入特殊分支。
import type { HookConfig, HookEventName, RegisteredHook } from './types.js'

export class HookRegistry {
  private byEvent: Map<HookEventName, RegisteredHook[]>

  /**
   * 根据 hook 列表构造事件到 hook 列表的索引。
   *
   * 输入顺序会被原样保留到每个事件的数组中，因此调用方必须在传入前保证插件顺序稳定。
   *
   * @param hooks 已发现并展开好的 hook 列表。
   */
  constructor(hooks: ReadonlyArray<RegisteredHook> = []) {
    this.byEvent = new Map()
    for (const h of hooks) {
      const list = this.byEvent.get(h.event) ?? []
      list.push(h)
      this.byEvent.set(h.event, list)
    }
  }

  /**
   * 读取绑定到指定事件的 hook。
   *
   * @param event 要查询的事件名。
   * @returns 按注册顺序排列的 hook 列表；没有匹配项时返回空数组。
   */
  get(event: HookEventName): readonly RegisteredHook[] {
    return this.byEvent.get(event) ?? []
  }

  /**
   * 快速判断某个事件是否有监听 hook。
   *
   * 总线会用它在热路径上跳过事件 payload 构造；各个 emit 调用点都可能频繁触发，
   * 因此这个廉价检查可以避免不必要的对象创建。
   *
   * @param event 要检查的事件名。
   * @returns 至少有一个 hook 监听该事件时返回 true。
   */
  has(event: HookEventName): boolean {
    return (this.byEvent.get(event)?.length ?? 0) > 0
  }

  /**
   * 列出所有已注册 hook。
   *
   * `/plugin doctor` 使用该方法展示当前生效的 hook，以及它们分别来自哪个插件。
   *
   * @returns 展平后的全部 RegisteredHook 列表。
   */
  list(): readonly RegisteredHook[] {
    const all: RegisteredHook[] = []
    for (const arr of this.byEvent.values()) all.push(...arr)
    return all
  }
}

/**
 * 从每个插件的 hook 配置构建 HookRegistry。
 *
 * 输入数组的迭代顺序会决定最终 emit 顺序；调用方（integration.ts）负责按稳定顺序
 * 传入插件，以保证同一套插件每次启动时执行顺序一致。
 *
 * @param pluginHooks 已加载的插件 hook 配置集合。
 * @returns 可供 HookBus 使用的注册表。
 */
export function buildHookRegistry(
  pluginHooks: ReadonlyArray<{ pluginId: string; pluginDir: string; config: HookConfig }>,
): HookRegistry {
  const all: RegisteredHook[] = []
  for (const { pluginId, pluginDir, config } of pluginHooks) {
    for (const eventName of Object.keys(config) as HookEventName[]) {
      const entries = config[eventName]
      if (!entries) continue
      for (const entry of entries) {
        all.push({ pluginId, pluginDir, event: eventName, entry })
      }
    }
  }
  return new HookRegistry(all)
// registry 的数据结构可以理解成：
// PreToolUse -> [pluginA 的 hook, pluginB 的 hook]
// PostToolUse -> [pluginC 的 hook]
// SessionStart -> [pluginD 的 hook]
}

/**
 * 创建一个空的 HookRegistry。
 *
 * @returns 不包含任何 hook 的注册表实例。
 */
export function emptyHookRegistry(): HookRegistry {
  return new HookRegistry([])
}
