// `/plugin refresh` 会进入这个模块。它的职责是在不重启 xc 的前提下重新扫描磁盘上
// 的已安装插件，并把新的插件状态传播给所有下游 registry。
//
// 为什么它是独立模块，而不是 PluginRegistry 的一个方法：
// 重新加载插件注册表本身只是一行，真正的工作是把新的贡献项折叠进 agent loop
// 启动时已经捕获的五个下游注册表：skill / sub-agent / command / hook / mcp。
// 这些引用都必须保持稳定，所以每个 registry 都暴露“原地 reload”的方法，而不是
// 返回新实例。
//
// 当调用方同时传入 mcpRegistry 和 askUser callback 时，这里也会重启 MCP servers；
// askUser 是项目信任门禁检查所必需的。插件贡献的 MCP servers 会和 user / project
// servers 合并，然后整体走 `McpRegistry.restartAll(...)`，也就是 `/mcp refresh`
// 使用的同一路径。没有传 mcpRegistry 的调用方则保持旧行为，只刷新
// skill/agent/command/hook。
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

  // 1. 从磁盘重新扫描插件。loadAllPlugins 会构建自己的临时 registry；
  //    我们取出其中的插件列表和加载错误，再通过 reload() 填回调用方持有的
  //    长生命周期 registry。
  const load = await loadAllPlugins({ cwd })

  // 2. 替换调用方插件 registry 的内部状态，并拿到用于 UI 展示的主 diff。
  const pluginsSummary = targets.pluginRegistry.reload(load.registry.listAll(), [...load.registry.loadErrors()])

  // 3. 基于新的插件集合重新计算下游集成信息：
  //    skills dirs、agents dirs、commands dirs、mcp servers 和 hook registry。
  const integration = await buildPluginIntegration(load)

  // 4. 把新的贡献项合并进调用方实际传入的每个子 registry。
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
    // 通过累加新 registry 各事件下的 hook 条目数得到总数。
    // 这个值只用于用户消息，精确 diff 不值得引入额外复杂度。
    out.hookCount = countHooks(integration.hookRegistry)
  }

  // 5. MCP 重启：只有同时传入 mcpRegistry 和 askUser 时执行。
  //    这里会重新从磁盘读取 user + project 配置，并合并最新插件贡献的
  //    extraServers，然后断开并重连整个 MCP 集合。它和 /mcp refresh 走同一路径。
  //    因此安装带 MCP server 的插件后，只需要 /plugin refresh 一次即可生效。
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
  // HookRegistry 暴露的是 get(eventName) → array；这里遍历已知事件名。
  // 事件名和 types.ts 有重复，但从那里导入会造成循环依赖，所以在此硬编码小列表。
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
