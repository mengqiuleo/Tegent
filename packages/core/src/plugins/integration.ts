// 本模块接收 [[loader]].loadAllPlugins 的输出，并把它转换为既有 skill /
// sub-agent / MCP loader 能消费的形状。因此 CLI 启动时的调用序列大致是：
//
//   const pluginLoad = await loadAllPlugins({ cwd })
//   const integration = await buildPluginIntegration(pluginLoad)
//   const skillRegistry  = await createSkillRegistry({  extraDirs: integration.skillsDirs })
//   const agentRegistry  = await createSubAgentRegistry({ extraDirs: integration.agentsDirs })
//   const mcpRegistry    = await loadMcpFromDisk({ ..., extraServers: integration.mcpServers })
//
// 这里负责三个其他模块不负责的关注点：
//
//   1. 把插件 manifest 里的 `mcpServers`（路径或内联对象）解析成类型化的
//      `Record<string, McpServerConfig>`。路径形式指向 `{ mcpServers: {...} }`
//      JSON 文件，和 ~/.tegent/config.json 一致；内联形式就是原始 record 本身。
//
//   2. 检测不同插件之间的名称冲突。当前按 server name 去重，迭代顺序中第一个插件
//      获胜，后来的同名条目会被丢弃并记录 warning。未来可以考虑用 plugin id 给
//      server name 做命名空间。
//
//   3. 记录尚未完全支持的插件贡献项诊断。当前 commands 和 hooks 都已经有下游结构，
//      但这里仍保留诊断入口，方便 `/plugin doctor` 或 debug log 追踪解析问题。
//
// 插件顺序是确定性的：它由 `loadAllPlugins` 的 `contributions` Map 迭代顺序驱动，
// 而这个顺序来自 installed_plugins.json 顺序加项目本地发现顺序。在安装集合不变时，
// 多次启动之间保持稳定。
import fs from 'node:fs/promises'

import { HookBus } from '../hooks/bus.js'
import { HookConfigParseError, parseHookConfig } from '../hooks/config-schema.js'
import { HookRegistry, buildHookRegistry } from '../hooks/registry.js'
import type { HookConfig } from '../hooks/types.js'
import { type VariableContext, buildVariableContext, expandVariables } from '../hooks/variables.js'
import { parseServersBlock } from '../mcp/config-schema.js'
import { isStdioConfig } from '../mcp/types.js'
import type { McpServerConfig } from '../mcp/types.js'
import { loadAllPlugins } from './loader.js'
import type { LoadResult, ResolvedContributions } from './loader.js'
import type { InlineMcpServers, LoadedPlugin } from './types.js'
import { getPluginUserConfigEnv } from './user-config.js'

export interface PluginIntegrationOutput {
  /**
   * skill loader 需要额外扫描的 skill 目录。
   *
   * 每个条目都会带上所属 plugin id；这里只包含已启用插件。
   */
  skillsDirs: Array<{ dir: string; pluginId: string }>
  /** sub-agent `.md` 文件目录，语义同上。 */
  agentsDirs: Array<{ dir: string; pluginId: string }>
  /**
   * slash command `*.md` 文件目录，语义同上。
   *
   * 每个条目额外携带所属插件的 rootDir，方便命令激活时替换
   * `${CLAUDE_PLUGIN_ROOT}`。
   */
  commandsDirs: Array<{ dir: string; pluginId: string; pluginRoot: string }>
  /**
   * 所有已启用插件合并后的 `mcpServers` 块。
   *
   * 名称冲突采用 first-wins 策略，失败者会记录到 `mcpCollisions`。
   */
  mcpServers: Record<string, McpServerConfig>
  /**
   * 根据所有已启用插件的 `hooks` 配置构建出的 hook registry。
   *
   * 没有插件声明 hooks 时为空 registry。交给 `new HookBus(...)` 后即可接入 agent
   * loop 的 emit 点。
   */
  hookRegistry: HookRegistry
  /**
   * 基于 `hookRegistry` 构建好的 HookBus。
   *
   * 这是给 CLI 启动接线使用的便利字段：`AgentOptions.hookBus = integration.hookBus`。
   */
  hookBus: HookBus
  /** 每个插件注册了哪些 hook 事件名，供 `/plugin doctor` 和 `/plugin info` UI 使用。 */
  pluginHooks: Array<{ pluginId: string; events: string[] }>
  /** 因与更早插件同名而被丢弃的 mcpServers 条目，形状为 `{ name, droppedFrom, keptFrom }`。 */
  mcpCollisions: Array<{ name: string; droppedFrom: string; keptFrom: string }>
  /** 按插件记录的 mcpServers 读取 / 解析错误；不阻塞启动，会在 `/plugin doctor` 展示。 */
  mcpErrors: Array<{ pluginId: string; message: string }>
  /** 按插件记录的 hooks 读取 / 解析错误。 */
  hookErrors: Array<{ pluginId: string; message: string }>
}

export interface BuildPluginIntegrationOptions {
  /**
   * 变量展开使用的会话工作目录，影响 `${cwd}`。
   *
   * 默认 `process.cwd()`。CLI 侧通常不传；测试希望 `${cwd}` 指向临时目录时使用。
   */
  cwd?: string
}

/**
 * 构建 plugin 所有的 skill， sub-agent，slash command，MCP server 和 hook 贡献的集成结果，路径均改为绝对路径。
 * plugin 包括 user 和 project
 * 
 * 函数只处理已启用插件：目录贡献会整理成 extraDirs，MCP server 会合并去重，
 * hooks 会构建成 HookRegistry 和 HookBus。非致命错误收集在输出对象里。
 *
 * @param load `loadAllPlugins` 的输出。
 * @param opts 集成选项，目前只有变量展开使用的 `cwd`。
 * @returns 可直接传给 skill / agent / command / MCP / hook 子系统的集成结果。
 */
export async function buildPluginIntegration(
  load: LoadResult,
  opts: BuildPluginIntegrationOptions = {},
): Promise<PluginIntegrationOutput> {
  // Hook registry 最后构建，因为遍历插件时要先收集每个插件自己的 hook config。
  // 所有 rootDir 都来自 LoadedPlugin，只有遍历时才完整可得。
  const hookInputs: Array<{ pluginId: string; pluginDir: string; config: HookConfig }> = []

  const out: PluginIntegrationOutput = {
    skillsDirs: [],
    agentsDirs: [],
    commandsDirs: [],
    mcpServers: {},
    hookRegistry: new HookRegistry(),
    hookBus: new HookBus(new HookRegistry()),
    pluginHooks: [],
    mcpCollisions: [],
    mcpErrors: [],
    hookErrors: [],
  }
  const mcpOwners = new Map<string, string>()

  for (const plugin of load.registry.list()) {
    const contrib = load.contributions.get(plugin.id)
    if (!contrib) continue

    if (contrib.skillsDir) out.skillsDirs.push({ dir: contrib.skillsDir, pluginId: plugin.id })
    if (contrib.agentsDir) out.agentsDirs.push({ dir: contrib.agentsDir, pluginId: plugin.id })
    if (contrib.commandsDir) {
      out.commandsDirs.push({ dir: contrib.commandsDir, pluginId: plugin.id, pluginRoot: plugin.rootDir })
    }

    if (contrib.hooks) {
      const config = await resolvePluginHooks(plugin, contrib.hooks, out)
      if (config) {
        hookInputs.push({ pluginId: plugin.id, pluginDir: plugin.rootDir, config })
        out.pluginHooks.push({ pluginId: plugin.id, events: Object.keys(config) })
      }
    }

    if (contrib.mcpServers) {
      const servers = await resolvePluginMcpServers(plugin, contrib.mcpServers, out, opts.cwd)
      for (const [name, cfg] of Object.entries(servers)) {
        const prevOwner = mcpOwners.get(name)
        if (prevOwner !== undefined) {
          out.mcpCollisions.push({ name, droppedFrom: plugin.id, keptFrom: prevOwner })
          continue
        }
        out.mcpServers[name] = cfg
        mcpOwners.set(name, plugin.id)
      }
    }
    // out.mcpServers 最后拿到的东西，其实就是 mcp.json 中的东西，并且是变量替换成绝对路径后的
  }

  out.hookRegistry = buildHookRegistry(hookInputs)
  out.hookBus = new HookBus(out.hookRegistry)
  return out
}

/**
 * 解析单个插件的 hooks 贡献项。
 *
 * 内联贡献直接使用对象；路径贡献需要读取并 JSON.parse。解析或读取失败不会抛出，
 * 而是写入 `out.hookErrors`，让启动流程继续。
 *
 * @param plugin hooks 所属插件。
 * @param contrib loader 解析出的 hooks 贡献描述。
 * @param out 当前集成输出，用于记录错误。
 * @returns 解析成功的 HookConfig；失败时返回 null。
 */
async function resolvePluginHooks(
  plugin: LoadedPlugin,
  contrib: NonNullable<ResolvedContributions['hooks']>,
  out: PluginIntegrationOutput,
): Promise<HookConfig | null> {
  let raw: unknown
  if (contrib.kind === 'inline') {
    raw = contrib.data
  } else {
    try {
      const text = await fs.readFile(contrib.path, 'utf-8')
      raw = JSON.parse(text) // 解析出来的是 `<cwd>/.tegent/plugins/<name>/hooks/hooks.json` 或 `~/.tegent/plugins/<name>/hooks/hooks.json` 的内容
    } catch (err) {
      out.hookErrors.push({
        pluginId: plugin.id,
        message: `failed to read hooks file ${contrib.path}: ${err instanceof Error ? err.message : String(err)}`,
      })
      return null
    }
  }
  try {
    return parseHookConfig(raw, plugin.id)
  } catch (err) {
    out.hookErrors.push({
      pluginId: plugin.id,
      message: err instanceof HookConfigParseError ? err.message : String(err),
    })
    return null
  }
}

/**
 * 对插件贡献的 stdio MCP server 配置执行变量展开。
 *
 * 支持的变量与 hooks executor 一致（`${pluginDir}`、`${pluginDataDir}`、
 * `${cwd}`、`${homedir}`、`${sep}`、`${env:NAME}`，见 hooks/variables.ts）；
 * 此外把 `${CLAUDE_PLUGIN_ROOT}` 当作 `${pluginDir}` 的别名处理——真实
 * Claude Code 插件的 `.mcp.json` 普遍用它引用随包脚本，不展开就无法在
 * tegent 里运行，这是两条插件生态保持兼容的必要一环。
 *
 * 只展开 stdio 配置的 `command` / `args` / `cwd` / `env` 值；HTTP 配置的
 * `url` / `headers` 原样保留。远端端点不引用插件本地路径，而 header 里的
 * 凭据语义上应走 OAuth 流程而不是文本替换。未知变量同样保留原样，
 * 让 spawn 的报错能暴露真正的拼写问题（与 hooks 的策略一致）。
 *
 * @param servers schema 校验通过后的 server 映射。
 * @param vars 变量上下文，通常由 `buildVariableContext` 构造。
 * @returns 展开后的新映射；入参对象不会被修改。
 */
export function expandMcpServerVariables(
  servers: Record<string, McpServerConfig>,
  vars: VariableContext,
): Record<string, McpServerConfig> {
  const expand = (s: string) => expandVariables(s.replaceAll('${CLAUDE_PLUGIN_ROOT}', '${pluginDir}'), vars)

  const out: Record<string, McpServerConfig> = {}
  for (const [name, cfg] of Object.entries(servers)) {
    if (!isStdioConfig(cfg)) {
      out[name] = cfg
      continue
    }
    out[name] = {
      ...cfg,
      command: expand(cfg.command),
      ...(cfg.args ? { args: cfg.args.map(expand) } : {}),
      ...(cfg.cwd ? { cwd: expand(cfg.cwd) } : {}),
      ...(cfg.env
        ? { env: Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, expand(v)] as const)) }
        : {}),
    }
  }
  return out
}

/**
 * 从 `.mcp.json` 文件内容中提取 `name → cfg` server 块。
 *
 * 接受两种形状：
 *
 * - Wrapped：`{ "mcpServers": { "name": cfg, ... } }`
 * - Flat：`{ "name": cfg, ... }`，没有 wrapper key
 *
 * Claude Code 官方插件，例如 linear@anthropic-marketplace，使用 flat 形式；
 * wrapped 形式则匹配我们自己的 config.json 布局。检测规则是：只要解析对象包含
 * `mcpServers` key，就按 wrapped 处理，并把 value 原样交给 schema parser，
 * 让它在形状错误时给出干净错误；否则把整个对象当作 flat block。
 *
 * @param parsed 已 JSON.parse 的 `.mcp.json` 内容。
 * @returns 可交给 MCP schema parser 的 server block。
 */
export function extractMcpServersBlock(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const obj = parsed as Record<string, unknown>
  if ('mcpServers' in obj) return obj.mcpServers
  return obj
}

/**
 * 解析单个插件的 mcpServers 贡献项。
 *
 * 函数会读取路径或内联对象，调用 MCP schema parser 校验，对 stdio 配置执行
 * 变量展开，再把插件 userConfig 合并到 stdio server 的 env 中。读取、解析和
 * env 合并错误都会记录到 `out`，不会中断整个插件集成过程。
 *
 * @param plugin mcpServers 所属插件。
 * @param contrib loader 解析出的 mcpServers 贡献描述。
 * @param out 当前集成输出，用于记录错误。
 * @param cwd 变量展开使用的会话工作目录；缺省时取 `process.cwd()`。
 * @returns 解析成功的 MCP server 映射；失败时返回空对象。
 */
async function resolvePluginMcpServers(
  plugin: LoadedPlugin,
  contrib: NonNullable<ResolvedContributions['mcpServers']>,
  out: PluginIntegrationOutput,
  cwd: string = process.cwd(),
): Promise<Record<string, McpServerConfig>> {
  let rawBlock: unknown
  if (contrib.kind === 'inline') {
    rawBlock = contrib.data as InlineMcpServers
  } else {
    try {
      const raw = await fs.readFile(contrib.path, 'utf-8')
      const parsed = JSON.parse(raw)
      rawBlock = extractMcpServersBlock(parsed)
    } catch (err) {
      out.mcpErrors.push({
        pluginId: plugin.id,
        message: `failed to read mcpServers file ${contrib.path}: ${err instanceof Error ? err.message : String(err)}`,
      })
      return {}
    }
  }

  const { servers, errors } = parseServersBlock(rawBlock)
  for (const e of errors) {
    out.mcpErrors.push({ pluginId: plugin.id, message: `mcpServers.${e.name}: ${e.message}` })
  }

  // stdio 命令里的插件变量在这里展开；schema 校验先于展开，保证结构错误
  // 仍然由 MCP config-schema 报告，而不是变成展开后的奇怪字符串。
  const vars = buildVariableContext({ pluginDir: plugin.rootDir, cwd, pluginId: plugin.id })
  const expanded = expandMcpServerVariables(servers, vars)

  // 把所属插件的 userConfig 值合并进每个 server 的 env token。
  try {
    const pluginEnv = await getPluginUserConfigEnv(plugin.id)
    if (Object.keys(pluginEnv).length > 0) {
      for (const name of Object.keys(expanded)) {
        const cfg = expanded[name]!
        // 只有 stdio server 会启动子进程并接收 env；HTTP server 是远端端点，
        // 合并环境变量没有意义。
        if (isStdioConfig(cfg)) {
          expanded[name] = { ...cfg, env: { ...pluginEnv, ...(cfg.env ?? {}) } }
        }
      }
    }
  } catch (err) {
    out.mcpErrors.push({ pluginId: plugin.id, message: `userConfig env merge: ${String(err)}` })
  }

  return expanded
}

/**
 * 从磁盘重新扫描插件，并只返回插件贡献的合并 mcpServers 块。
 *
 * `/mcp refresh` 会用它把插件 server 也纳入合并配置，避免单独刷新 MCP 时静默丢掉
 * 插件贡献的 server；`/plugin refresh` 则通过 buildPluginIntegration 间接使用同样
 * 逻辑。失败时降级为 `{}` 并写 debug log，因为 MCP-only refresh 不应该因为插件
 * 系统的一次小故障失败。
 *
 * @param cwd 当前工作目录，用于扫描项目本地插件。
 * @returns 插件贡献的 MCP server 映射；失败时返回空对象而不是 undefined。
 */
export async function getPluginMcpServersFromDisk(cwd: string): Promise<Record<string, McpServerConfig>> {
  try {
    const load = await loadAllPlugins({ cwd })
    const integration = await buildPluginIntegration(load)
    return integration.mcpServers
  } catch (err) {
    return {}
  }
}

// 重新导出常用类型和函数，让典型 CLI 启动接线只需要从这个模块 import。
export type { LoadResult, ResolvedContributions } from './loader.js'
export { loadAllPlugins }
