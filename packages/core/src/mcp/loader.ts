// 这是 CLI 入口调用的一次性编排流程：读取用户级和项目级配置，
// 对项目级内容执行信任门校验，展开环境变量，并行启动 / 连接
// 每个启用的服务器，最后构建一个 registry，供后续 `/mcp refresh`
// 继续修改。单个服务器失败不会阻止整个启动，
// `/mcp list` 会把失败原因展示给用户。
import fs from 'node:fs/promises'
import path from 'node:path'

import { getUserConfigPath } from '../config/index.js'
import { TEGENT_DIR } from '../utils.js'
import { parseServersBlock } from './config-schema.js'
import { buildCallableName as buildCallable } from './name-mangling.js'
import {
  type ConnectResult,
  McpRegistry,
  type RegisteredServer,
  connectOneServer,
  emptyRegistry,
} from './registry.js'
import { type TrustChoice, buildServerPreview, isProjectTrusted, promptForTrust, trustProject } from './trust.js'
import { type McpResourceEntry, type McpServerConfig, type McpToolEntry } from './types.js'

// 为历史调用方重新导出这些类型，避免旧 import 失效。
export type { RegisteredServer, ConnectResult }
export type { McpResourceEntry, McpToolEntry }

export interface LoadOptions {
  /** 来自 ~/.tegent/config.json 的 mcpServers，默认视为可信。 */
  userServers: Record<string, McpServerConfig> | undefined
  /** 来自 <project>/.tegent/config.json 的 mcpServers，需要用户明确同意。 */
  projectServers: Record<string, McpServerConfig> | undefined
  /** 启用插件贡献的 mcpServers，默认视为可信。
   *  用户在安装插件时已经同意过，因此没必要再对插件服务器重复弹出
   *  项目级 trust 对话框。它们与 `userServers` 处在同一优先级，
   *  但项目级同名条目仍然可以覆盖它们。 */
  extraServers?: Record<string, McpServerConfig>
  /** 项目绝对路径（CLI 启动时的 cwd），作为信任键。 */
  projectPath: string
  /** 渲染信任对话框，形状与 `AgentCallbacks.onAskUser` 相同。 */
  askUser: (question: string, options: Array<{ label: string; description: string }>) => Promise<string>
  /** loader 决定终止进程时调用；CLI 层会把它接到干净的关闭流程。
   *  默认是 no-op，具体退出责任由调用方承担。 */
  onExitRequested?: () => void
}

export interface LoadResult {
  registry: McpRegistry
  /** 在接触任何服务器之前就收集到的配置 / 解析错误。
   *  会出现在 `/mcp list` 中，方便用户同时看到配置拼写问题和连接失败。 */
  configErrors: Array<{ name: string; message: string }>
  /** 是否因为用户拒绝信任而跳过了项目级 mcpServers。
   *  CLI 会据此打印一条提醒。 */
  projectSkipped: boolean
}

/**
 * 从磁盘读取标准配置文件并调用 loader。
 *
 * 这是 CLI 入口用的便利封装，不需要上层知道具体文件路径。
 */
export async function loadMcpFromDisk(opts: {
  cwd: string
  askUser: LoadOptions['askUser']
  onExitRequested?: () => void
  /** 插件贡献的 mcpServers：已经被信任，会与用户级服务器一起并入
   *  有效配置。由 packages/core/src/plugins/integration.ts 构建。 */
  extraServers?: Record<string, McpServerConfig>
}): Promise<LoadResult> {
  const userServers = await readMcpServersFromFile(getUserConfigPath())
  const projectServers = await readMcpServersFromFile(path.join(opts.cwd, TEGENT_DIR, 'config.json'))
  return loadMcpServers({
    userServers,
    projectServers,
    extraServers: opts.extraServers,
    projectPath: opts.cwd,
    askUser: opts.askUser,
    onExitRequested: opts.onExitRequested,
  })
}

/**
 * 重新读取配置并执行信任门校验，但不启动任何服务器。
 *
 * 用于 `/mcp refresh`：调用方会把合并后的配置映射交给
 * `registry.restartAll(...)`，由 registry 原地更新，而不是创建另一套 registry。
 */
export async function loadMergedConfigsFromDisk(opts: {
  cwd: string
  askUser: LoadOptions['askUser']
  /** 插件贡献的 mcpServers（来自 `buildPluginIntegration().mcpServers`）。
   *  按照与 [[loadMcpServers]] 相同的优先级插入在用户和项目之间。
   *  在 `/mcp refresh` 和 `/plugin refresh` 时都要传入它们，
   *  以免 reload 时悄悄丢掉插件服务器。 */
  extraServers?: Record<string, McpServerConfig>
}): Promise<{
  configs: Map<string, McpServerConfig>
  configErrors: Array<{ name: string; message: string }>
  projectSkipped: boolean
}> {
  const userServers = await readMcpServersFromFile(getUserConfigPath())
  const projectServers = await readMcpServersFromFile(path.join(opts.cwd, TEGENT_DIR, 'config.json'))

  const configErrors: Array<{ name: string; message: string }> = []
  let projectSkipped = false

  const userParsed = parseServersBlock(userServers)
  configErrors.push(...userParsed.errors.map((e) => ({ name: `user:${e.name}`, message: e.message })))
  const projectParsed = parseServersBlock(projectServers)
  configErrors.push(...projectParsed.errors.map((e) => ({ name: `project:${e.name}`, message: e.message })))

  let projectServersToUse = projectParsed.servers
  if (Object.keys(projectServersToUse).length > 0) {
    const trusted = await isProjectTrusted(opts.cwd)
    if (!trusted) {
      const choice = await askForTrust(
        {
          // 为 askForTrust 拼出最小化的 LoadOptions；它只会读取
          // projectPath 和 askUser。
          userServers,
          projectServers,
          projectPath: opts.cwd,
          askUser: opts.askUser,
        },
        projectServersToUse,
      )
      if (choice === 'exit') {
        // /mcp refresh 故意忽略 'exit'：从 slash command 直接把整个 CLI 退掉
        // 太激进了，这里把它视作 'skip'，让用户在真正重启时再决定。
        projectServersToUse = {}
        projectSkipped = true
      } else if (choice === 'skip') {
        projectServersToUse = {}
        projectSkipped = true
      } else if (choice === 'trust') {
        await trustProject(opts.cwd).catch((err) => {

        })
      }
    }
  }

  // 合并顺序：用户 → 插件 → 项目，与 loadMcpServers 的初始启动优先级一致。
  // 插件条目夹在中间，这样项目级同名条目仍然可以覆盖它们。
  const merged = new Map<string, McpServerConfig>(
    Object.entries({ ...userParsed.servers, ...(opts.extraServers ?? {}), ...projectServersToUse }),
  )
  return { configs: merged, configErrors, projectSkipped }
}


export async function loadMcpServers(options: LoadOptions): Promise<LoadResult> {
  const configErrors: Array<{ name: string; message: string }> = []
  let projectSkipped = false

  // 先校验两个配置块。parseServersBlock 会容忍 `undefined`，
  // 并在没有 mcpServers 时返回空映射和零错误，所以空配置不会产生额外成本。
  const userParsed = parseServersBlock(options.userServers)
  configErrors.push(...userParsed.errors.map((e) => ({ name: `user:${e.name}`, message: e.message })))

  const projectParsed = parseServersBlock(options.projectServers)
  configErrors.push(...projectParsed.errors.map((e) => ({ name: `project:${e.name}`, message: e.message })))

  // 项目级信任门：如果项目里没有任何服务器，就直接跳过提示，
  // 因为没有需要用户同意的内容。
  let projectServersToUse = projectParsed.servers
  const projectServerNames = Object.keys(projectServersToUse)
  if (projectServerNames.length > 0) {
    const trusted = await isProjectTrusted(options.projectPath)
    if (!trusted) {
      const choice = await askForTrust(options, projectServersToUse)
      if (choice === 'exit') {
        options.onExitRequested?.()
        // 即使 CLI 没有真的退出，返回空 registry 也能让后续流程保持定义良好。
        return { registry: emptyRegistry(), configErrors, projectSkipped: true }
      }
      if (choice === 'skip') {
        projectServersToUse = {}
        projectSkipped = true
      }
      if (choice === 'trust') {
        await trustProject(options.projectPath).catch((err) => {

        })
      }
    }
  }

  // 合并顺序：用户 → 插件 → 项目。`extraServers` 故意放在中间：
  //   - 插件安装时已经完成过同意，因此不需要再走上面的 trust 对话；
  //   - 但如果与项目级条目重名，仍然让项目级条目优先生效，
  //     因为项目配置通常由当前运行 CLI 的同一个人维护。
  const merged: Record<string, McpServerConfig> = {
    ...userParsed.servers,
    ...(options.extraServers ?? {}),
    ...projectServersToUse,
  }

  // 任意地方都没有配置服务器时，直接走空 registry 快速路径。
  if (Object.keys(merged).length === 0) {
    return {
      registry: new McpRegistry({ servers: [], tools: [], resources: [] }),
      configErrors,
      projectSkipped,
    }
  }

  // 并行启动 / 连接。每个服务器的 promise 独立处理，避免单个超时拖垮整个启动。
  const tasks = Object.entries(merged).map(async ([name, rawConfig]) => {
    return connectOneServer(name, rawConfig)
  })
  const results = await Promise.all(tasks)

  // 组装 registry。工具名冲突按插入顺序处理（先到先得，后来的加哈希后缀），
  // 因此这里先按服务器名排序，避免结果受 connect() 完成顺序影响。
  results.sort((a, b) => a.server.name.localeCompare(b.server.name))

  const tools: McpToolEntry[] = []
  const resources: McpResourceEntry[] = []
  const taken = new Set<string>()

  for (const r of results) {
    for (const t of r.tools) {
      const callable = buildCallable(r.server.name, t.name, taken)
      taken.add(callable)
      tools.push({
        callableName: callable,
        rawName: t.name,
        serverName: r.server.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      })
    }
    for (const res of r.resources) resources.push(res)
  }

  const configs = new Map<string, McpServerConfig>(Object.entries(merged))

  const registry = new McpRegistry({
    servers: results.map((r) => r.server),
    tools,
    resources,
    configs,
  })

  return { registry, configErrors, projectSkipped }
}

/**
 * 包装 project trust 提示的调用。
 *
 * 这里会先把服务器配置整理成可展示摘要，再调用 promptForTrust。
 * 如果提示流程本身失败（比如没有 TTY），会降级为 skip。
 */
async function askForTrust(
  options: LoadOptions,
  projectServers: Record<string, McpServerConfig>,
): Promise<TrustChoice> {
  const summaries = Object.entries(projectServers).map(([name, cfg]) => ({
    name,
    preview: buildServerPreview(cfg as { command?: string; args?: string[]; url?: string }),
  }))
  try {
    return await promptForTrust(options.projectPath, summaries, options.askUser)
  } catch (err) {
    return 'skip'
  }
}

/**
 * 只读取 JSON 配置文件里的 `mcpServers` 字段。
 *
 * 文件缺失、解析失败或缺少该字段时都返回 undefined。
 * 这些情况都等价于“这里没有配置 MCP 服务器”，不需要向上抛错。
 */
async function readMcpServersFromFile(filePath: string): Promise<Record<string, McpServerConfig> | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> }
    if (parsed && typeof parsed === 'object' && parsed.mcpServers) {
      return parsed.mcpServers
    }
    return undefined
  } catch (err) {

    return undefined
  }
}
