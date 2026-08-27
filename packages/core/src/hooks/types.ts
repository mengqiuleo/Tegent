// hook 是插件注册到 agent 生命周期事件上的 shell 命令。CLI 会把事件 payload 作为
// 一段 JSON 写入 hook 的 stdin；hook 可以在 stdout 返回一个 JSON 形式的
// `HookDecision`，从而影响 agent 后续行为，例如允许、拒绝、修改工具参数或注入上下文。
//
// 使用 shell 命令而不是程序化 SDK，是为了降低插件作者的接入门槛，复用用户在
// Claude Code 中已经见过的协议形状，并把宿主进程的暴露面保持得足够小：插件代码不会
// 直接跑在我们的进程里。完整设计理由见 [[plugin-marketplace-design]] 第 8 节。
//
// 目前保留十个事件，是为了覆盖高价值生命周期集成点：上下文注入、工具闸门、
// 子代理审计、压缩观测和完成通知等，同时避免把未来可能重构的内部细节全部暴露出去。
// 将来新增事件成本较低；移除事件则会构成破坏性变更。PreCompact / PostCompact 与
// SubagentStart / SubagentStop 是第二轮补充的事件，用来贴近 Claude/Codex 的协议形状，
// 也给需要记录每次子代理调用、或在压缩前持久化状态的插件提供挂载点。

export type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreCompact'
  | 'PostCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TurnComplete'
  | 'SessionEnd'

/**
 * 会产生 agent 可执行决策的事件子集。
 *
 * 其他事件属于通知型事件：hook 可以执行日志、通知等副作用，但 agent 会忽略它们的
 * stdout 决策内容。
 */
export type DecisionEvent = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse'

/** hooks.json 中的一条 hook 配置项。 */
export interface HookConfigEntry {
  /**
   * 用于匹配工具名的可选正则。
   *
   * 只有 PreToolUse / PostToolUse 会读取该字段，其他事件会忽略它。未设置 matcher
   * 表示匹配所有工具。
   */
  matcher?: string
  /**
   * 当前平台没有专用覆盖项时要执行的 shell 命令。
   *
   * 支持 `${pluginDir}`、`${pluginDataDir}`、`${cwd}`、`${homedir}`、
   * `${env:NAME}`、`${sep}` 变量展开，详见 [[variables]]。
   *
   * 即使配置了平台专用命令，该字段仍然必填。这样可以避免插件作者无意间发布一个
   * 只能在单一系统上运行的插件；基础命令是作者没有显式考虑到的平台的兜底方案。
   */
  command: string
  /**
   * 平台专用命令覆盖项。
   *
   * 设置后，当前 OS 对应字段会替代 `command`。字段语义与 `process.platform` 对齐；
   * 未知平台（freebsd / sunos / aix）会回退到基础 `command`。
   */
  commandWindows?: string
  commandDarwin?: string
  commandLinux?: string
  /** 单个 hook 的超时时间，单位毫秒；默认 5000，上限 30000。 */
  timeout?: number
  description?: string
  /**
   * hook 非零退出、超时或崩溃时的处理策略。
   *
   *    'allow'  默认值，记录警告，并按 hook 返回 allow 处理
   *    'block'  按 deny 处理（只对 DecisionEvents 真正有意义）
   *
   * 默认策略刻意保持宽松：损坏的 hook 不应该让 agent loop 长时间卡住。
   */
  failurePolicy?: 'allow' | 'block'
}

/**
 * 完整 hooks.json 的类型。
 *
 * 每个事件名映射到一组有序配置项；越早出现的配置越先执行。对决策型事件而言，
 * 前面的 hook 返回 deny 会短路后续 hook。
 */
export type HookConfig = Partial<Record<HookEventName, HookConfigEntry[]>>

/** 附加到每个事件 payload 上的会话级上下文。 */
export interface SessionContext {
  cwd: string
  modelId: string
  /** 可选的会话 id；CLI 分配后会透传给 hook，方便插件关联同一会话内的事件。 */
  sessionId?: string
}

/**
 * 所有 hook 事件 payload 的可辨识联合类型。
 *
 * `name` 字段同时承担判别标签的角色。CLI 构造这些事件并传给 [[HookBus.emit]]；
 * executor 会把事件序列化成 JSON 后写入 hook 的 stdin。
 */
export type HookEvent =
  | { name: 'SessionStart'; session: SessionContext }
  | { name: 'UserPromptSubmit'; session: SessionContext; prompt: string }
  | {
      name: 'PreToolUse'
      session: SessionContext
      tool: { name: string; args: unknown; callId: string }
    }
  | {
      name: 'PostToolUse'
      session: SessionContext
      tool: { name: string; args: unknown; callId: string; output: string; isError: boolean }
    }
  | {
      name: 'PreCompact'
      session: SessionContext
      /**
       * 触发压缩的原因。
       *
       * hook 可以根据该字段决定是否需要 checkpoint 状态，或跳过某些昂贵操作。
       */
      trigger: 'proactive' | 'reactive'
      /** 压缩前的近似消息数量。 */
      messageCount: number
      /** 压缩前的近似 token 数量。 */
      tokenEstimate: number
    }
  | {
      name: 'PostCompact'
      session: SessionContext
      trigger: 'proactive' | 'reactive'
      /** 压缩后的消息数量；与 PreCompact 的 messageCount 相减可估算回收幅度。 */
      messageCount: number
      /** 压缩摘要；轻量压缩路径没有生成 LLM 摘要时为空字符串。 */
      summary: string
    }
  | {
      name: 'SubagentStart'
      session: SessionContext
      agent: {
        /** 子代理的注册名，例如 `code-reviewer`。 */
        name: string
        /** 父 agent 传给子代理的一行任务描述。 */
        description: string
        /** 父 agent 发送给子代理的完整 prompt。 */
        prompt: string
      }
    }
  | {
      name: 'SubagentStop'
      session: SessionContext
      agent: {
        name: string
        description: string
      }
      /** 子代理运行的墙钟耗时，单位毫秒。 */
      durationMs: number
      /**
       * 子代理的结束方式。
       *
       * `aborted` 包含用户按 Esc 取消，以及达到单个子代理 maxTurns 上限但未正常收尾的情况。
       */
      outcome: 'completed' | 'aborted' | 'failed'
      tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number }
    }
  | {
      name: 'TurnComplete'
      session: SessionContext
      turn: number
      tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number }
    }
  | { name: 'SessionEnd'; session: SessionContext }

/**
 * hook 可以通过 stdout JSON 请求 agent 执行的动作。
 *
 * allow 可附加上下文，deny 可附加拒绝原因，modify 可修改工具参数、工具输出或注入上下文。
 */
export type HookDecision =
  | { decision: 'allow'; context?: string }
  | { decision: 'deny'; reason?: string }
  | { decision: 'modify'; args?: unknown; output?: string; context?: string }

/**
 * 已准备好执行的 hook。
 *
 * 它会携带所属插件的身份和根目录，供变量展开解析 `${pluginDir}`。该对象在启动时由
 * [[buildHookRegistry]] 构建，并在整个会话中保持不可变。
 */
export interface RegisteredHook {
  pluginId: string
  /** 插件根目录的绝对路径，会通过 `${pluginDir}` 替换进 hook 命令。 */
  pluginDir: string
  event: HookEventName
  entry: HookConfigEntry
}
