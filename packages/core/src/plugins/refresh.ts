// `/plugin refresh` 会进入这个模块。它的职责是在不重启 tegent 的前提下重新扫描磁盘上
// 的已安装插件，并把新的插件状态传播给所有下游 registry。
import { reloadSubAgentRegistry } from '../agent/sub-agents/registry.js'
import type { SubAgentRegistry, SubAgentReloadSummary } from '../agent/sub-agents/registry.js'
import { reloadCommandRegistry } from '../commands/registry.js'
import type { CommandRegistry, CommandReloadSummary } from '../commands/registry.js'
import type { HookBus } from '../hooks/bus.js'
import type { HookRegistry } from '../hooks/registry.js'
import { type LoadOptions, loadMergedConfigsFromDisk } from '../mcp/loader.js'
import type { McpRegistry, RestartSummary } from '../mcp/registry.js'
import { reloadSkillRegistry } from '../skills/registry.js'
import type { SkillRegistry, SkillReloadSummary } from '../skills/registry.js'
import { buildPluginIntegration } from './integration.js'
import { loadAllPlugins } from './loader.js'
import type { PluginRegistry, PluginReloadSummary } from './registry.js'

export interface PluginRefreshSummary {
  /**
   * 插件层面的差异摘要。
   *
   * 它描述哪些插件新增、移除或变化，是 `/plugin refresh` 结果消息的主信息。
   */
  plugins: PluginReloadSummary
  /**
   * 各下游 registry 的差异摘要。
   *
   * 这些字段适合 `/plugin doctor` 一类的详细展示。它们是可选的，因为调用方
   * 未必注入了每个 registry，例如单元测试通常会跳过。
   */
  skills?: SkillReloadSummary
  subAgents?: SubAgentReloadSummary
  commands?: CommandReloadSummary
  /**
   * 刷新后注册的 hook 条目数量。
   *
   * 这个值用于给用户反馈。我们不计算按事件分组的 diff，因为 hook 没有稳定身份
   * （没有 name 字段）；总数足够确认“hooks 已重新加载”。
   */
  hookCount: number
  /**
   * MCP registry 被注入时的重启摘要。
   *
   * 调用方没有传 mcpRegistry 时为 `undefined`，例如测试或 `--no-plugins` 路径。
   */
  mcp?: RestartSummary
  /** 合并配置加载期间是否有 project MCP server 因信任门禁被跳过，供 UI 警告用户。 */
  mcpProjectSkipped?: boolean
  /**
   * 合并配置加载期间按 server 记录的 MCP 配置解析错误。
   *
   * 这些错误不会中止刷新；它们会随摘要展示，让用户知道哪些 server entry 被忽略。
   */
  mcpConfigErrors?: Array<{ name: string; message: string }>
}

export interface PluginRefreshTargets {
  pluginRegistry: PluginRegistry
  /**
   * 需要接收插件新贡献项的下游 registry。
   *
   * 调用方只传自己已经初始化并持有的 registry 即可。
   */
  skillRegistry?: SkillRegistry
  subAgentRegistry?: SubAgentRegistry
  commandRegistry?: CommandRegistry
  hookBus?: HookBus
  /**
   * 要用新合并配置重启的 MCP registry。
   *
   * 配置合并顺序包含 user + plugin + project。设置它时必须同时提供 `askUser`，
   * 供 project-trust gate 使用；不设置时 MCP 保持不变，兼容旧刷新行为。
   */
  mcpRegistry?: McpRegistry
  /** 设置 `mcpRegistry` 时必需；`loadMergedConfigsFromDisk` 会用它询问 project MCP 信任决策。 */
  askUser?: LoadOptions['askUser']
  /** 当前工作目录，默认 `process.cwd()`；测试可以覆盖它。 */
  cwd?: string
}

/**
 * 重新扫描已安装插件，并把新状态合并进所有已注入的 registry。
 *
 * 调用方负责在此之后让 systemPromptCache 失效；缓存引用位于更上层的 agent options，
 * 因此这里不直接操作它。
 *
 * @param targets 长生命周期 registry 引用，以及可选的工作目录和信任回调。
 * @returns 插件层、下游 registry 层和 MCP 重启层的刷新摘要。
 */
export async function refreshPluginContributions(targets: PluginRefreshTargets): Promise<PluginRefreshSummary> {
  const cwd = targets.cwd ?? process.cwd()

  const load = await loadAllPlugins({ cwd })

  const pluginsSummary = targets.pluginRegistry.reload(load.registry.listAll(), [...load.registry.loadErrors()])

  const integration = await buildPluginIntegration(load)

  const out: PluginRefreshSummary = { plugins: pluginsSummary, hookCount: 0 }

  if (targets.skillRegistry) {
    out.skills = await reloadSkillRegistry(targets.skillRegistry, { extraDirs: integration.skillsDirs })
  }
  if (targets.subAgentRegistry) {
    out.subAgents = await reloadSubAgentRegistry(targets.subAgentRegistry, { extraDirs: integration.agentsDirs })
  }
  if (targets.commandRegistry) {
    out.commands = await reloadCommandRegistry(targets.commandRegistry, { extraDirs: integration.commandsDirs })
  }
  if (targets.hookBus) {
    targets.hookBus.replaceRegistry(integration.hookRegistry)
    out.hookCount = countHooks(integration.hookRegistry)
  }

  if (targets.mcpRegistry && targets.askUser) {
    const merged = await loadMergedConfigsFromDisk({
      cwd,
      askUser: targets.askUser,
      extraServers: integration.mcpServers,
    })
    out.mcpProjectSkipped = merged.projectSkipped
    out.mcpConfigErrors = merged.configErrors
    out.mcp = await targets.mcpRegistry.restartAll(merged.configs)
  }

  return out
}

/**
 * 统计 HookRegistry 中当前注册的 hook 条目总数。
 *
 * HookRegistry 只暴露按事件名读取的方法，因此这里遍历一组已知事件名并累加长度。
 *
 * @param registry 要统计的 hook registry。
 * @returns 所有已知事件上的 hook 条目总数。
 */
function countHooks(registry: HookRegistry): number {
  const eventNames = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SubagentStart',
    'SubagentStop',
    'TurnComplete',
    'SessionEnd',
  ] as const
  let n = 0
  for (const e of eventNames) n += registry.get(e).length
  return n
}
