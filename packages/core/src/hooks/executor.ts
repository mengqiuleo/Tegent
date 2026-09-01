// 该模块负责启动 hook 声明的 shell 命令，把事件 JSON 写入 stdin，再从 stdout
// 读取 hook 返回的决策 JSON。整个协议按“单次事件输入、单次决策输出”设计：
// stdin 是一个 JSON 对象，stdout 可以是一个 JSON 对象，也可以为空；空 stdout 表示
// 默认 allow。非 JSON stdout 会被忽略，这样 hook 可以把普通日志写到 stdout/stderr
// 而不影响 agent 行为。
//
// 失败处理有意保持宽松（默认 `failurePolicy: 'allow'`）：损坏的 hook 不应该卡死
// agent loop。非零退出码、超时或崩溃都会降级为 `allow` 并写入调试线索。`block`
// 策略需要插件作者显式声明，适合那些明确承担“闸门”职责的 hook。
//
// AbortSignal 会透传给 execa 的 `cancelSignal`，因此用户在 hook 执行期间按 Esc 时，
// 子进程会被及时杀掉。这和 shell tool 使用的是同一套取消机制。
import { execa } from 'execa'

import { getPluginUserConfigEnv } from '../plugins/user-config.js'
import type { HookConfigEntry, HookDecision, HookEvent, RegisteredHook } from './types.js'
import { buildVariableContext, expandVariables } from './variables.js'

/**
 * 根据当前操作系统选择要执行的 hook 命令。
 *
 * 插件作者会把 `command` 作为跨平台默认值，也可以额外提供 `commandWindows`、
 * `commandDarwin`、`commandLinux` 来处理 shebang、可执行文件名或 shell 引号等
 * 平台差异。未知平台（如 freebsd、sunos、aix）统一回退到基础命令。
 *
 * @param entry hooks.json 中的一条 hook 配置。
 * @returns 当前平台应该执行的 shell 命令。
 */
function pickPlatformCommand(entry: HookConfigEntry): string {
  switch (process.platform) {
    case 'win32':
      return entry.commandWindows ?? entry.command
    case 'darwin':
      return entry.commandDarwin ?? entry.command
    case 'linux':
      return entry.commandLinux ?? entry.command
    default:
      return entry.command
  }
}

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30_000

export interface ExecuteHookOptions {
  /**
   * 取消 hook 子进程的信号。
   *
   * agent loop 的 abort 信号会沿着这里传进执行器，因此慢 hook 执行期间按 Esc 可以
   * 及时停止子进程。
   */
  signal?: AbortSignal
  /**
   * 覆盖默认的 5 秒超时时间。
   *
   * 当 hook 自己配置了 `entry.timeout` 时，以 hook 配置为准；无论来自哪里，最终超时
   * 都会被限制在 30 秒以内。
   */
  defaultTimeoutMs?: number
}

/**
 * 针对一个事件执行一个 hook。
 *
 * 成功时返回解析后的 hook 决策；遇到非预期输出、非零退出码、超时或崩溃时，默认按
 * failurePolicy 转换为 allow/deny。除非调用方的 AbortSignal 已触发，否则该函数不会
 * 向外抛出异常；取消信号值得继续冒泡，因为此时上层 loop 已经在收尾。
 *
 * @param hook 已注册且携带插件身份信息的 hook。
 * @param event 当前要发送给 hook 的生命周期事件。
 * @param opts 执行选项，包括取消信号和默认超时。
 * @returns hook 对当前事件的决策。
 */
export async function executeHook(
  hook: RegisteredHook,
  event: HookEvent,
  opts: ExecuteHookOptions = {},
): Promise<HookDecision> {
  const timeoutMs = Math.min(hook.entry.timeout ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

  const vars = buildVariableContext({
    pluginDir: hook.pluginDir,
    cwd: event.session.cwd,
    pluginId: hook.pluginId,
  })
  const expandedCommand = expandVariables(pickPlatformCommand(hook.entry), vars)
  const stdinPayload = JSON.stringify(buildStdinPayload(hook, event))

  // 把所属插件的 userConfig 合并进 hook 环境变量。需要 manifest 中声明的 API key 时，
  // hook 脚本可以直接通过 `process.env[KEY]` 读取，不需要额外胶水代码；命令字符串中的
  // `${env:KEY}` 替换也会基于这个合并后的环境。读取失败时静默降级为空对象，因为常见
  // 情况只是用户尚未配置 userConfig。
  let pluginEnv: Record<string, string> = {}
  try {
    pluginEnv = await getPluginUserConfigEnv(hook.pluginId)
  } catch (err) {

  }

  try {
    const result = await execa(expandedCommand, [], {
      shell: true,
      input: stdinPayload,
      timeout: timeoutMs,
      cancelSignal: opts.signal,
      stdio: 'pipe',
      reject: false, // 非零退出码在下面显式处理，不交给 execa 作为异常抛出。
      cwd: event.session.cwd,
      env: { ...process.env, ...pluginEnv },
    })

    if (opts.signal?.aborted) {
      throw new Error('aborted')
    }

    if (result.timedOut) {

      return failurePolicyDecision(hook, `hook timed out after ${timeoutMs}ms`)
    }
    if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
      const stderrTail = (result.stderr ?? '').toString().slice(0, 200)

      return failurePolicyDecision(hook, `hook exited ${result.exitCode}`)
    }

    const decision = parseDecision(result.stdout ?? '', hook, event)
    // 记录成功执行的 hook，方便插件作者确认 hook 确实被触发，而不必在脚本里额外写日志。
    // 由于 stdio 使用 `pipe`（stdout 要拿来读 JSON 决策），hook 自己写入 stderr 的内容

    return decision
  } catch (err) {
    if (opts.signal?.aborted) throw err

    return failurePolicyDecision(hook, `hook crashed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 按 hook 的失败策略把执行失败转换成 agent 决策。
 *
 * @param hook 当前失败的 hook。
 * @param reason 写给用户或调试日志的失败原因。
 * @returns `block` 策略返回 deny，其余情况返回 allow。
 */
function failurePolicyDecision(hook: RegisteredHook, reason: string): HookDecision {
  if (hook.entry.failurePolicy === 'block') return { decision: 'deny', reason }
  return { decision: 'allow' }
}

/**
 * 构造通过 stdin 发送给 hook 的 JSON 对象。
 *
 * 事件特有字段会平铺到顶层，保持与 Claude Code hook 协议相近的形状，降低插件作者
 * 在不同工具之间迁移脚本时的心智成本。
 *
 * @param hook 当前要执行的 hook。
 * @param event 当前生命周期事件。
 * @returns 可 JSON.stringify 后写入 stdin 的事件 payload。
 */
function buildStdinPayload(hook: RegisteredHook, event: HookEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    event: event.name,
    session: event.session,
    plugin: { id: hook.pluginId, dir: hook.pluginDir },
  }
  switch (event.name) {
    case 'UserPromptSubmit':
      base.prompt = event.prompt
      break
    case 'PreToolUse':
      base.tool = event.tool
      break
    case 'PostToolUse':
      base.tool = event.tool
      break
    case 'PreCompact':
      base.trigger = event.trigger
      base.messageCount = event.messageCount
      base.tokenEstimate = event.tokenEstimate
      break
    case 'PostCompact':
      base.trigger = event.trigger
      base.messageCount = event.messageCount
      base.summary = event.summary
      break
    case 'SubagentStart':
      base.agent = event.agent
      break
    case 'SubagentStop':
      base.agent = event.agent
      base.durationMs = event.durationMs
      base.outcome = event.outcome
      if (event.tokenUsage) base.tokenUsage = event.tokenUsage
      break
    case 'TurnComplete':
      base.turn = event.turn
      if (event.tokenUsage) base.tokenUsage = event.tokenUsage
      break
    // SessionStart / SessionEnd 除 session/plugin 之外没有额外字段。
  }
  return base
}

/**
 * 解析 hook stdout 中的决策 JSON。
 *
 * 空输出会被视为默认 allow；非 JSON 或结构不符合 HookDecision 的输出也会降级为 allow，
 * 并在必要时写入调试日志，帮助用户发现“脚本以为自己影响了 agent，但其实没有”的情况。
 *
 * @param stdout hook 子进程的标准输出。
 * @param hook 当前执行的 hook，用于记录调试信息。
 * @param event 当前事件，用于记录调试信息。
 * @returns 解析得到的 HookDecision，或默认 allow。
 */
function parseDecision(stdout: string, hook: RegisteredHook, event: HookEvent): HookDecision {
  const trimmed = (stdout ?? '').toString().trim()
  if (!trimmed) return { decision: 'allow' }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const d = obj.decision
      if (d === 'allow' || d === 'deny' || d === 'modify') {
        return obj as HookDecision
      }
    }
  } catch {

  }
  return { decision: 'allow' }
}
