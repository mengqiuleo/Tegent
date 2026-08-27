// 这是包在 [[HookRegistry]] 之上的轻量调度层。agent loop、工具执行、
// 上下文压缩和子代理运行器会在十个生命周期节点调用 `bus.emit(event)`。
// 总线负责按 matcher 过滤 hook（只有 PreToolUse / PostToolUse 会使用
// matcher），执行匹配到的 hook，并把每个 hook 的决策结果交还给调用方聚合。
//
// 串行与并行策略：
//
//   决策型事件（UserPromptSubmit / PreToolUse / PostToolUse）串行执行。
//   只要某个 hook 返回 `deny`，后续 hook 就不再执行；agent 会停在第一处
//   明确阻止的位置。执行顺序等同于注册顺序，因此插件作者可以获得稳定、
//   可预测的行为。
//
//   通知型事件（SessionStart / PreCompact / PostCompact / SubagentStart /
//   SubagentStop / TurnComplete / SessionEnd）并行执行。它们不参与决策，
//   也没有顺序依赖，主要用于日志、通知、持久化等副作用。
//
// 总线会捕获单个 hook 的异常并降级为 `allow`，避免某个损坏的 hook 卡死
// 主循环。非零退出码和超时的降级逻辑已经在 executor 层处理；这里额外兜住
// matcher 正则构造失败和并发执行中的异常。

import { type ExecuteHookOptions, executeHook } from './executor.js'
import { type HookRegistry, emptyHookRegistry } from './registry.js'
import type { HookDecision, HookEvent, RegisteredHook } from './types.js'

export interface EmitOptions extends ExecuteHookOptions {
  /**
   * 强制使用并行执行。
   *
   * 默认情况下，决策型事件会串行执行，通知型事件会并行执行。调用方通常不需要覆盖
   * 这个策略，只有在测试或明确知道 hook 之间没有顺序关系时才会传入。
   */
  parallel?: boolean
}

export class HookBus {
  // 保持 registry 可替换，是为了让 /plugin refresh 能在不要求调用方重新持有
  // bus 引用的情况下切换到新的 hook 集合。新的事件会看到新的 registry；已经
  // 进入 executeHook 的调用仍然使用旧 registry 完成执行。这是刻意选择的行为：
  // 让已启动的 hook 自然结束，比协调中途停止更简单也更便宜。
  constructor(private registry: HookRegistry) {}

  /**
   * 判断某个事件名下是否存在已注册的 hook。
   *
   * 该方法主要用于热路径上的提前跳过：如果没有监听者，调用方就不必构造完整的
   * 事件 payload。
   *
   * @param event 要检查的 hook 事件名。
   * @returns 存在至少一个监听该事件的 hook 时返回 true。
   */
  has(event: HookEvent['name']): boolean {
    return this.registry.has(event)
  }

  /**
   * 替换当前总线内部持有的 registry。
   *
   * `/plugin refresh` 在重新扫描插件后调用它，以便纳入新增 hook 或移除已经卸载的
   * hook。该操作只影响之后进入总线的事件，不会打断已经在执行中的 hook。
   *
   * @param registry 重新构建后的 hook 注册表。
   */
  replaceRegistry(registry: HookRegistry): void {
    this.registry = registry
  }

  /**
   * 发射一个 hook 事件并返回每个匹配 hook 的决策。
   *
   * 返回数组会保留实际运行顺序；没有注册 hook 或没有 hook 通过 matcher 时返回空数组。
   * 通常只有三个决策型事件会读取返回值，通知型事件的调用方只是等待副作用完成。
   *
   * @param event 要发射的生命周期事件。
   * @param opts 执行选项，包括 abort 信号、默认超时和是否强制并行。
   * @returns 按执行顺序排列的 hook 决策列表。
   */
  async emit(event: HookEvent, opts: EmitOptions = {}): Promise<HookDecision[]> {
    const hooks = this.registry.get(event.name)
    if (hooks.length === 0) return []

    const applicable = hooks.filter((h) => matches(h, event))
    if (applicable.length === 0) return []

    // 决策型事件（UserPromptSubmit / PreToolUse / PostToolUse）串行执行
    const isDecisionEvent =
      event.name === 'UserPromptSubmit' || event.name === 'PreToolUse' || event.name === 'PostToolUse'
    const parallel = opts.parallel ?? !isDecisionEvent // 传参要求是否强制并行，不是决策性事件，则走并行执行策略

    // 并行执行
    if (parallel) {
      // 通知型事件虽然不影响 agent 决策，但仍然要 await 所有 hook，保证调用方
      // 的“等待副作用完成”语义成立。这里仅取消串行约束；单个 hook 失败不会让
      // 整批失败，executor 会把失败转换为 `allow`。
      const settled = await Promise.allSettled(applicable.map((h) => executeHook(h, event, opts)))
      const out: HookDecision[] = []
      for (const r of settled) {
        if (r.status === 'fulfilled') out.push(r.value)
        else {
          if (opts.signal?.aborted) throw r.reason
          out.push({ decision: 'allow' }) // 总线会捕获单个 hook 的异常并降级为 `allow`，避免某个损坏的 hook 卡死主循环
        }
      }
      return out
    }

    // 串行路径：第一个 `deny` 会停止后续 hook。`modify` 如何叠加到下一次
    // 输入由调用方负责；总线只收集每个 hook 的原始决策。
    const decisions: HookDecision[] = []
    for (const h of applicable) {
      try {
        const d = await executeHook(h, event, opts)
        decisions.push(d)
        if (d.decision === 'deny') break
      } catch (err) {
        if (opts.signal?.aborted) throw err
        decisions.push({ decision: 'allow' })
      }
    }
    return decisions
  }
}

/**
 * 创建一个不包含任何注册 hook 的空总线。
 *
 * CLI 在禁用插件（`--no-plugins`）时传入它，这样 agent loop 的各个 emit 调用点
 * 不需要到处做 null 检查。
 *
 * @returns 使用空 registry 构造的 HookBus。
 */
export function emptyHookBus(): HookBus {
  return new HookBus(emptyHookRegistry())
}

/**
 * 判断某个注册 hook 是否适用于当前事件。
 *
 * 只有工具前后事件支持 matcher；其他生命周期事件只要注册在对应事件名下就会执行。
 * matcher 构造失败时会降级为匹配所有工具，并写入调试日志，避免错误正则让 hook
 * 静默失效。
 *
 * @param hook 待检查的注册 hook。
 * @param event 当前发射的事件。
 * @returns hook 应执行时返回 true。
 */
function matches(hook: RegisteredHook, event: HookEvent): boolean {
  if (event.name !== 'PreToolUse' && event.name !== 'PostToolUse') return true
  if (!hook.entry.matcher) return true
  try {
    return new RegExp(hook.entry.matcher).test(event.tool.name)
  } catch (err) {
    return true
  }
}

// -- agent loop 各个 emit 调用点使用的决策聚合辅助函数 --

/**
 * 将一组 PreToolUse 决策折叠为一个最终生效结果。
 *
 * 顺序很重要：`emit` 已经在遇到 `deny` 时短路，所以这里一旦看到 `deny`，它就是
 * 最终结论。多个 `modify` 可以叠加，最后一个携带 `args` 的修改会胜出，这让后注册
 * 的插件可以继续细化前面插件给出的参数。
 */
export interface PreToolEffect {
  decision: 'allow' | 'deny'
  reason?: string
  /** 修改后的工具参数；为 undefined 时沿用原始参数。 */
  args?: unknown
  /** 需要注入的额外上下文；PreToolUse 很少使用，但为了协议对称保留。 */
  context?: string
}

/**
 * 聚合 PreToolUse hook 返回的决策。
 *
 * @param decisions HookBus.emit 返回的原始决策列表。
 * @returns agent loop 可直接消费的工具前置效果。
 */
export function aggregatePreToolUse(decisions: ReadonlyArray<HookDecision>): PreToolEffect {
  let args: unknown
  let context: string | undefined
  for (const d of decisions) {
    if (d.decision === 'deny') return { decision: 'deny', reason: d.reason }
    if (d.decision === 'modify') {
      if (d.args !== undefined) args = d.args
      if (d.context) context = d.context
    } else if (d.decision === 'allow' && d.context) {
      context = d.context
    }
  }
  return { decision: 'allow', args, context }
}

export interface PostToolEffect {
  /** 替换后的工具输出；为 undefined 时保留原始输出。 */
  output?: string
  context?: string
}

/**
 * 聚合 PostToolUse hook 返回的决策。
 *
 * `modify.output` 会替换工具输出，后出现的替换结果会覆盖前一个；`context` 会记录
 * 最后一个非空上下文，供 agent loop 追加到后续模型输入中。
 *
 * @param decisions HookBus.emit 返回的原始决策列表。
 * @returns agent loop 可直接消费的工具后置效果。
 */
export function aggregatePostToolUse(decisions: ReadonlyArray<HookDecision>): PostToolEffect {
  let output: string | undefined
  let context: string | undefined
  for (const d of decisions) {
    if (d.decision === 'modify') {
      if (typeof d.output === 'string') output = d.output
      if (d.context) context = d.context
    } else if (d.decision === 'allow' && d.context) {
      context = d.context
    }
  }
  return { output, context }
}

export interface UserPromptEffect {
  decision: 'allow' | 'deny'
  reason?: string
  /** 所有 hook 注入上下文拼接后的字符串，可直接前置到用户消息；没有注入时为空字符串。 */
  context: string
}

/**
 * 聚合 UserPromptSubmit hook 返回的决策。
 *
 * 任意 `deny` 都会阻止本轮用户输入继续进入 agent loop；所有允许或修改分支上的
 * `context` 会按 hook 顺序用空行拼接，保持插件注入内容的相对顺序。
 *
 * @param decisions HookBus.emit 返回的原始决策列表。
 * @returns 用户输入提交阶段的最终效果。
 */
export function aggregateUserPromptSubmit(decisions: ReadonlyArray<HookDecision>): UserPromptEffect {
  const contexts: string[] = []
  for (const d of decisions) {
    // allow 可附加上下文，deny 可附加拒绝原因，modify 可修改工具参数、工具输出或注入上下文。
    if (d.decision === 'deny') return { decision: 'deny', reason: d.reason, context: '' }
    // `context` 同时可能出现在 allow 和 modify 分支；上面的 deny 分支已经返回，
    // 因此这里按两个可注入上下文的分支分别处理即可。
    if (d.decision === 'allow' && d.context) contexts.push(d.context)
    else if (d.decision === 'modify' && d.context) contexts.push(d.context)
  }
  return { decision: 'allow', context: contexts.join('\n\n') }
}
