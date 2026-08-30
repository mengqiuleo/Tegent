import { Chalk } from 'chalk'

import fs from 'node:fs'
import path from 'node:path'

import {
  McpPermissionStore,
  PROVIDER_DETECTION_ORDER,  // 供应商检测顺序，用来在默认模型失效时找可用回退模型
  buildPluginIntegration,
  createCommandRegistry,
  createModelRegistry,
  createSkillRegistry,
  createSubAgentRegistry,
  ensureDefaultMarketplaces,
  getAvailableProviders,
  getEnvVarName,
  loadAllPlugins,
  loadMcpFromDisk,
  loadUserConfig,
  resolveModelId,
} from '@tegent/core'

import type { AgentOptions, HookBus, McpRegistry } from '@tegent/core'

import { getCleanupFn, startApp } from './app.js'
import { parseCliArgs } from './cli-args.js'
import { checkForUpdate, printNoApiKeyMessage, printNoWebSearchKeyHint, printResumeHint } from './startup-prints.js'

const chalk = new Chalk({ level: process.stderr.isTTY ? 3 : 0 })


// .env 文件加载依赖 Node 20.12 引入的内置 process.loadEnvFile 接口，20.19.0 以上的小版本在 ESM 模块解析等基础功能上更为稳定
const MIN_NODE_VERSION = [20, 19, 0]

function checkNodeVersion(): void {
  const [major, minor, patch] = process.versions.node.split('.').map((v) => parseInt(v, 10))
  const [reqMajor, reqMinor, reqPatch] = MIN_NODE_VERSION

  if (
    major < reqMajor ||
    (major === reqMajor && minor < reqMinor) ||
    (major === reqMajor && minor === reqMinor && patch < reqPatch)
  ) {
    console.error(
      `Error: TEGENT requires Node.js >= ${MIN_NODE_VERSION.join('.')}, but you are running ${process.versions.node}.\n` +
        'Please upgrade Node.js: https://nodejs.org/',
    )
    process.exit(1)
  }
}


let shutdownInProgress = false //  声明退出状态标记，false 表示当前还没有进入退出流程。
let mcpRegistryForShutdown: McpRegistry | null = null // 声明退出时要用的 MCP 注册表引用，初始为 null 表示还没加载。
let hookBusForShutdown: HookBus | null = null // 声明退出时要用的插件钩子总线引用，初始为 null 表示还没准备好。

//  「双保险」式的终端状态恢复。在退出前同步执行，
// 这样即使 Ink 的卸载过程部分失败（比如某个 useEffect 清理函数抛错、
// 或者长会话里 raw 模式的引用计数泄漏），终端仍能保持可用状态。
// 这个函数可以安全地多次调用——每一条转义序列都是幂等的（重复执行效果不变）。
//  定义终端恢复函数，退出前把颜色、光标、raw 模式等恢复正常。
function resetTerminal(): void {
  //  如果 stdout 不是真实终端，就不用写终端控制序列，直接返回。
  if (!process.stdout.isTTY) return
  //  开始 try 块；这里包住可能因为终端断开而失败的操作。
  try {
    //  同步写入重置样式的 ANSI 转义序列，防止 shell 提示符继承颜色或粗体。
    fs.writeSync(1, '\x1b[0m') // reset SGR (colors, bold, inverse, ...) so the shell prompt isn't styled
    // 重置 SGR（颜色、加粗、反色等），让 shell 提示符不带样式
    //  同步关闭括号粘贴模式。
    fs.writeSync(1, '\x1b[?2004l')
    // 关闭「括号粘贴模式」
    //  同步显示光标。
    fs.writeSync(1, '\x1b[?25h')
    // 显示光标
    //  同步退出备用屏幕，回到普通终端屏幕。
    fs.writeSync(1, '\x1b[?1049l')
    // 退出备用屏幕（如果曾经进入过）
    //  同步输出回车换行，让后续 shell 提示符另起一行。
    fs.writeSync(1, '\r\n')
    // 让 shell 提示符落在一个全新的行上
    //  如果 stdin 是终端，就关闭 raw 模式，让终端恢复普通输入方式。
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    // 关闭 raw 模式（raw 模式下按键不经过行缓冲、不回显，TUI 程序用它来捕获每个按键）
    //  开始 catch 块；如果恢复终端失败，就在这里吞掉异常。
  } catch {
    // 终端可能已经关闭（SIGHUP 信号、SSH 断开），忽略即可。
  }
}

//  优雅退出函数：尽可能做清理工作，然后退出进程。
// 接收一个退出码，返回值类型是 Promise<never>（表示它永远不会正常返回，一定会调用 process.exit）。
//  定义异步优雅退出函数，参数 exitCode 决定最终进程退出码。
async function gracefulShutdown(exitCode: number): Promise<never> {
  // 如果已经在退出流程中，直接返回，避免重复清理。
  //  如果退出流程已经开始，就直接返回，避免重复清理。
  if (shutdownInProgress) return undefined as never
  //  把退出状态改为 true，表示后面的清理流程已经接管。
  shutdownInProgress = true

  //  在后台尽力做清理，但不阻塞退出。
  // saveSession（保存会话）内部会调用模型生成摘要，可能要花几秒——
  // 这正是当年「按 Ctrl+C 后要等 2-5 秒」的体验问题。
  // 竞品（claude-code、gemini-cli、opencode、codex）都不让用户在退出时等任何东西，
  // 我们与它们保持一致。
  // 后果：如果进程在 saveSession 写文件之前就退出了，那次会话就不会被保存。
  // 这是可接受的折衷——用户更在意退出速度，而不是会话摘要。
  // 未来的改进方向是在会话过程中增量保存（opencode 的做法）。
  //  从 App 模块取得当前会话的清理函数；可能为空，所以后面要判断。
  const cleanup = getCleanupFn()
  //  如果清理函数存在，就异步触发它，并吞掉清理失败。
  if (cleanup) cleanup().catch(() => undefined)

  //  即发即忘地关闭 MCP。stdio 服务器在 stdin 关闭时也会自行清理，
  // 所以即使 process.exit 抢在这个 promise 之前执行，操作系统也会回收子进程——
  // 这里只是让它更明确、更快。
  //  如果已经加载过 MCP 注册表，就准备关闭所有 MCP 连接。
  if (mcpRegistryForShutdown) {
    //  触发 MCP 注册表关闭流程，并吞掉关闭失败。
    mcpRegistryForShutdown.shutdown().catch(() => undefined)
  }

  //  插件 SessionEnd（会话结束）钩子。即发即忘——不 await，
  // 因为慢的钩子会挡住用户的 shell 提示符返回；而且退出时的宽限窗口本就很小。
  // 需要保证可靠触发的钩子，应该同时订阅 TurnComplete（单轮完成）事件。
  //  如果插件钩子总线存在且有人监听 SessionEnd，就准备触发会话结束事件。
  if (hookBusForShutdown?.has('SessionEnd')) {
    //  发送 SessionEnd 事件，把当前工作目录和模型信息传给插件钩子。
    hookBusForShutdown.emit({ name: 'SessionEnd', session: { cwd: process.cwd(), modelId: '' } }).catch(() => undefined)
  }

  //  先恢复终端状态。
  //  调用终端恢复函数，确保退出后终端能正常使用。
  resetTerminal()
  //  在 resetTerminal 之后才打印，这样提示行能干净地落在 shell 提示符上方——
  // 颜色已重置、raw 模式已关闭、光标已可见。
  // 这个提示从一个同步捕获的快照里读取（由 App 通过 onSessionInfoReady 注册），
  // 所以不依赖仍在运行的异步清理。
  //  打印恢复会话提示，方便用户下次进入 TUI 后用 /resume 接着聊。
  printResumeHint()
  //  按传入的退出码真正结束 Node 进程。
  process.exit(exitCode)
}

//  主函数：CLI 的核心启动流程。
// 整个启动顺序很重要——插件必须在 skill/子 agent/MCP 注册表之前加载，
// 这样插件的贡献才能被合并进各个注册表。
//  定义主启动函数；CLI 的启动流程从这里串起来。
async function main() {
  // 1. 检查 Node 版本
  //  先执行 Node 版本检查，不满足要求就会提前退出。
  checkNodeVersion()
  // 2. 加载 .env 环境变量文件（从当前目录往上找，和 dotenv 的约定一致）
  //  加载 .env 文件，把里面的环境变量放进 process.env。
  loadEnvFile()

  //  即发即忘的更新检查——查询 npm 仓库（带 24 小时磁盘缓存），
  // 如果存在新版本就打印一行提示。绝不阻塞启动，也绝不抛错。
  // 在非 TTY 环境下不执行（checkForUpdate 内部会检查 stderr.isTTY）。
  //  后台启动版本更新检查；void 表示故意不等待这个 Promise。
  void checkForUpdate().catch(() => undefined)

  // 解析命令行参数（yargs）。CLI 没有配置类 flag，这里只为处理
  // --version / --help；多余的位置参数会被忽略。
  // await parseCliArgs()

  //  获取当前配置了 API Key 的所有模型供应商列表
  //  检测当前环境变量里哪些模型供应商已经可用。
  const availableProviders = getAvailableProviders()

  //  如果没有任何供应商配置了 key，显示友好提示并退出。
  //  如果一个可用供应商都没有，就进入缺 API key 的提示分支。
  if (availableProviders.length === 0) {
    //  打印没有配置 API key 时的帮助信息。
    printNoApiKeyMessage()
    //  退出码用 0：这只是一个用户配置提示，不是崩溃。
    // 如果用非 0，会让 `pnpm dev` 堆出 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL / ELIFECYCLE 噪音。
    //  用退出码 0 结束进程，表示正常退出或只是给用户提示。
    process.exit(0)  
  }

  //  解析模型 id（格式是 `provider:model`，比如 `anthropic:claude-...`）
  //  从用户配置（~/.tegent/config.json）或环境变量检测解析默认模型 id。
  let modelId = resolveModelId() // 解析模型 id：取用户配置的默认模型，没有就按供应商检测顺序找第一个有 key 的。
  //  如果没能解析出模型，说明没有任何供应商配置 key。
  if (!modelId) {
    //  打印没有配置 API key 时的帮助信息。
    printNoApiKeyMessage()
    //  用退出码 0 结束进程，表示正常退出或只是给用户提示。
    process.exit(0)
  }

  //  防范「过期模型 id」——即当前启动没有注册该供应商的情况。
  // “过期模型 id”可以理解成：保存的默认模型还在，但它依赖的 provider key 当前没了，导致这个模型在本次运行不可用。
  // 常见场景：用户删掉了某个环境变量 key，但 config.json 还指向它；
  // 或者某个供应商被整个移除出构建（比如 kimicode 在某次功能回滚后）。
  // 否则注册表会在 languageModel() 处抛出 NoSuchProviderError，
  // 在 UI 还没挂载前就致命退出。
  // 对于持久化/智能默认的 id，我们回退到第一个可用的供应商，保证 CLI 仍可用。
  //  从已解析的模型 id 中取出供应商名，用来确认它当前真的可用。
  const requestedProvider = modelId.split(':')[0]
  //  如果解析出的供应商不在可用列表里，就处理过期模型配置。
  if (!availableProviders.includes(requestedProvider)) {
    //  查这个 provider 应该使用哪个 API key 环境变量；查不到就拼一个默认名字。
    const envVar = getEnvVarName(requestedProvider) ?? `${requestedProvider.toUpperCase()}_API_KEY`
    //  按预设顺序找第一个环境变量存在的供应商作为回退。
    const fallback = PROVIDER_DETECTION_ORDER.find(({ envKey }) => process.env[envKey])
    //  如果理论上找不到回退供应商，就走防御性提示并退出。
    if (!fallback) {
      //  防御性处理：上面 availableProviders 非空，所以是某个已配置项把我们带到这里——
      // 显示提示并干净退出。
      //  打印没有配置 API key 时的帮助信息。
      printNoApiKeyMessage()
      //  用退出码 0 结束进程，表示正常退出或只是给用户提示。
      process.exit(0)
    }
    //  开始向 stderr 打印错误或提示信息。
    console.error(
      //  把后面的提示染成黄色，表示这不是致命错误但需要用户注意。
      chalk.yellow(
        //  执行这一行 TypeScript 代码，继续完成当前启动或清理流程。
        `Note: saved model '${modelId}' needs ${envVar}, which is not set. ` +
          //  执行这一行 TypeScript 代码，继续完成当前启动或清理流程。
          `Falling back to '${fallback.defaultModel}'. Use /model to pick a different default.`,
        //  结束当前多行函数调用。
      ),
      //  结束当前多行函数调用。
    )
    //  把当前模型 id 改成回退供应商的默认模型。
    modelId = fallback.defaultModel
  }

  //  创建各注册表，并从模型注册表拿到具体的模型实例。
  // providerRegistry 是「模型供应商注册表」，languageModel() 根据 `provider:model` id 返回模型对象。
  //  创建模型供应商注册表。
  const providerRegistry = createModelRegistry()
  //  根据模型 id 从注册表中取得真正会调用的语言模型对象。
  const model = providerRegistry.languageModel(modelId as `${string}:${string}`)


  //  首次运行的种子数据：如果还没有订阅文件，就把默认的
  // `anthropic-marketplace` 订阅写入 known_marketplaces.json。
  // 这是幂等操作——明确删除过该订阅的用户不会被重新加回来。
  // 要在 loadAllPlugins 之前做，这样首次运行就能看到一个已填充的市场列表。
  //  确保默认插件市场订阅存在；失败不中断启动。
  await ensureDefaultMarketplaces().catch((err) => {})

  //  插件必须在 skill / 子 agent / MCP 注册表之前加载，
  // 这样插件的贡献才能被合并进各个注册表。
  // 非致命的加载错误会以和下面 `[mcp] config error in ...` 相同的样式输出到 stderr——
  // 一个坏插件绝不会阻塞其他插件。
  const pluginLoad = await loadAllPlugins({ cwd: process.cwd() })
  //  遍历插件加载错误，把每个错误展示给用户。
  for (const e of pluginLoad.registry.loadErrors()) {
    //  向标准错误输出打印信息。
    console.error(chalk.yellow(`[plugin] ${e.id ?? e.path}: ${e.message}`)) 
  }
  //  把插件加载结果整合成后续注册表可消费的结构。
  const pluginIntegration = await buildPluginIntegration(pluginLoad)

  //  如果插件贡献的 MCP 配置有错误，就准备逐条打印。
  if (pluginIntegration.mcpErrors.length > 0) {
    //  遍历插件 MCP 错误。
    for (const e of pluginIntegration.mcpErrors) {
      //  向标准错误输出打印信息。
      console.error(chalk.yellow(`[plugin] ${e.pluginId}: ${e.message}`))
    }
  }

  //  创建三个注册表，都把插件提供的额外目录（extraDirs）合并进来：
  // - subAgentRegistry：子 agent 注册表（explore、general-purpose 等专用子 agent）
  // - skillRegistry：技能（skill）注册表
  // - commandRegistry：斜杠命令（/xxx）注册表
  //  创建子 agent 注册表，并加入插件提供的 agent 目录。
  const subAgentRegistry = await createSubAgentRegistry({ extraDirs: pluginIntegration.agentsDirs })
  //  创建技能注册表，并加入插件提供的 skill 目录。
  const skillRegistry = await createSkillRegistry({ extraDirs: pluginIntegration.skillsDirs })
  //  创建斜杠命令注册表，并加入插件提供的 command 目录。
  const commandRegistry = await createCommandRegistry({ extraDirs: pluginIntegration.commandsDirs })

  //  MCP（Model Context Protocol，模型上下文协议）部分：
  // 加载服务器，如果项目级配置是「不熟悉」的，就运行信任对话框。
  // 这要在 Ink 挂载之前做，这样基于 readline 的信任提示能有一个干净的终端。
  // MCP 机制是「可选」的：配置里没有 mcpServers 的用户只会付出一次 fs.stat 的代价
  // （用户配置一次、项目配置一次），仅此而已。
  //  创建 MCP 权限存储实例。
  const mcpPermissionStore = new McpPermissionStore()
  //  从磁盘加载 MCP 配置、启动服务器，并得到加载结果。
  const mcpLoadResult = await loadMcpFromDisk({
    //  把当前工作目录传入加载器，让它按当前项目读取配置。
    cwd: process.cwd(),
    //  把插件贡献的 MCP 服务器配置也交给 MCP 加载器。
    extraServers: pluginIntegration.mcpServers,
    //  把启动阶段的终端提问函数交给 MCP 加载器使用。
    askUser: (question, opts) => askInTerminal(question, opts),
    //  把 MCP 加载器请求退出时的处理方式设为正常退出进程。
    onExitRequested: () => process.exit(0),
  })
  //  保存 MCP 注册表，用于退出时关闭。
  //  把 MCP 注册表保存到模块级变量，供退出清理时使用。
  mcpRegistryForShutdown = mcpLoadResult.registry
  //  保存插件钩子总线，退出时触发 SessionEnd 钩子。
  hookBusForShutdown = pluginIntegration.hookBus

  //  如果 MCP 配置加载时出现错误，就准备输出这些错误。
  if (mcpLoadResult.configErrors.length > 0) {
    //  遍历每一条 MCP 配置错误。
    for (const e of mcpLoadResult.configErrors) {
      //  向标准错误输出打印信息。
      console.error(chalk.yellow(`[mcp] config error in ${e.name}: ${e.message}`))
    }
  }
  //  如果项目级 MCP 因未信任而被跳过，就提示用户。
  if (mcpLoadResult.projectSkipped) {
    //  向标准错误输出打印信息。
    console.error(chalk.yellow(`[mcp] Project-level MCP servers skipped (not trusted).`))
  }
  //  预加载「始终允许」列表，这样第一次工具调用就不用承担读文件的延迟。
  //  预加载 MCP 权限数据，减少第一次工具调用时的等待。
  await mcpPermissionStore.preload()

  //  组装传给 agent 引擎的所有选项（AgentOptions）。
  // 这些选项决定了模型、权限模式、插件、MCP、命令、钩子等核心行为。
  //  开始组装传给 agent 引擎的配置对象。
  const options: AgentOptions = {
    //  把最终模型 id 放入 agent 选项。
    modelId,
    //  信任模式默认关闭；写操作在会话里逐次向用户确认。
    trustMode: false,
    //  从磁盘读取持久化的 /thinking 开关。默认 false，这样在无配置的机器上启动
    // 与该功能引入前的行为一致（供应商默认的 thinking 行为，没有意外的延迟/成本跳变）。
    // App.tsx 里的 /thinking 命令可以通过 useAgent 的 setThinking 热替换这个标志，无需重启。
    //  把 /thinking 开关放入 agent 选项；配置缺失时默认 false。
    thinking: loadUserConfig().thinking ?? false,
    //  计划模式（plan mode）是「会话级」作用域（与 Claude Code 一致）——
    // 会话中用 /plan 切换不会持久化，所以每次新启动都从 'default'
    // （默认模式）开始，进入会话后可用 /plan 开启。
    //  每次启动都从默认权限模式开始。
    permissionMode: 'default',
    //  把模型注册表交给 agent 引擎。
    modelRegistry: providerRegistry,
    //  把子 agent 注册表交给 agent 引擎。
    subAgentRegistry,
    //  把技能注册表交给 agent 引擎。
    skillRegistry,
    //  把 MCP 注册表交给 agent 引擎。
    mcpRegistry: mcpLoadResult.registry,
    //  导入 MCP 权限存储类，用来记住 MCP 工具的允许策略。
    mcpPermissionStore,
    //  把插件注册表交给 agent 引擎。
    pluginRegistry: pluginLoad.registry,
    //  把斜杠命令注册表交给 agent 引擎。
    commandRegistry,
    //  把插件钩子总线交给 agent 引擎。
    hookBus: pluginIntegration.hookBus,
  }

  //  插件 SessionStart（会话开始）钩子。在 CLI 启动时触发，
  // 让钩子能在用户开始交互之前做准备工作（环境校验、上下文预热等）。
  // 之前它放在 agentLoop 的「首次调用分支」里，这意味着一个没发任何用户消息就结束的会话
  // （比如用户只跑了几个斜杠命令就退出）永远不会触发 SessionStart；
  // 而触发了的会话又看到它滞后于第一条提示。这里与 gracefulShutdown 里的 SessionEnd 对称。
  // 即发即忘——慢钩子绝不能阻塞启动。
  //  如果有插件监听 SessionStart，就触发会话开始钩子。
  if (options.hookBus?.has('SessionStart')) {
    //  从 options 里取出 hookBus，下一行会继续链式调用。
    options.hookBus
      //  向插件钩子总线发送事件。
      .emit({ name: 'SessionStart', session: { cwd: process.cwd(), modelId } })
      //  如果前面的异步链失败，就在这里处理错误。
      .catch((err) => {})
  }

  //  会话恢复不通过命令行参数入口——要继续历史会话，
  // 进入交互模式后用 /resume 斜杠命令打开选择器。

  //  提醒：WebSearch（联网搜索）需要 API key。
  // 在 Ink 接管之前打印一次，让提示落在 TUI 上方的滚动历史里。
  // 这不是致命错误——WebFetch（抓取网页）无需 key 也能工作，
  // 而且工具本身在没有配置 key 被调用时会返回详细错误。
  //  如果两个 WebSearch key 都没有配置，就打印联网搜索不可用提示。
  if (!process.env.TAVILY_API_KEY && !process.env.BRAVE_API_KEY) {
    //  打印 WebSearch 缺少 key 的非致命提示。
    printNoWebSearchKeyHint()
  }

  //  启动主应用（挂载 Ink TUI）。waitUntilExit 在 Ink 卸载时 resolve（包括 Ctrl+C 触发的卸载）。
  // 要恢复历史会话，进入 TUI 后用 /resume 选择。
  //  启动 Ink TUI，并拿到一个会在应用退出时完成的 Promise。
  const waitUntilExit = startApp(model, options)
  //  等待 TUI 卸载；用户退出或 Ctrl+C 都会走到这里。
  await waitUntilExit()

  //  正常退出路径（包括 Ctrl+C，它会先卸载 Ink）。
  //  TUI 正常结束后，用退出码 0 走统一清理流程。
  await gracefulShutdown(0)
}

//  从当前工作目录加载 .env 文件（逐层往上目录找，和 dotenv 的约定一致）。
// 找到第一个 .env 就用 process.loadEnvFile 加载它，然后停止。
//  定义 .env 加载函数，从当前目录一路向父目录查找。
function loadEnvFile(): void {
  //  把搜索起点设为当前工作目录。
  let dir = process.cwd()
  //  开始无限循环，直到找到 .env 或到达磁盘根目录才跳出。
  while (true) {
    //  拼出当前目录下 .env 文件的完整路径。
    const envPath = path.join(dir, '.env')
    //  如果这个目录里存在 .env，就尝试加载它。
    if (fs.existsSync(envPath)) {
      //  开始 try 块；这里包住可能因为终端断开而失败的操作。
      try {
        //  调用 Node 的 .env 加载能力，把文件内容注入 process.env。
        process.loadEnvFile(envPath)
        //  开始 catch 块；如果恢复终端失败，就在这里吞掉异常。
      } catch {
        //  解析出错就忽略（比如 .env 文件格式不对）
      }
      //  从当前函数返回，结束后续执行。
      return
    }
    //  取得当前目录的父目录，下一轮循环会继续往上找。
    const parent = path.dirname(dir)
    //  如果父目录等于自己，说明已经到根目录，跳出循环。
    if (parent === dir) break
    //  已经到根目录了，停止
    //  把搜索目录移动到父目录。
    dir = parent
  }
}

//  启动阶段（Ink 挂载之前）用的「朴素终端」提问函数。
// 目前唯一的调用方是 MCP 项目级信任对话框——
// loader.ts 把它的 `askUser` 回调传入一个任意选项列表，并期望拿回某个选项的 label。
// 当 stdin 不是 TTY（管道输入、CI 环境）时优雅回退：
// 如果有 label 像 "skip" 的选项就返回它，否则返回第二个选项
// （loader 的约定是 index 1 == 安全默认值）。这保证我们绝不会为了永远不会到来的输入而阻塞。
//  定义启动阶段的终端问答函数，返回用户选择的选项 label。
async function askInTerminal(
  //  声明第一个参数 question：要展示给用户的问题文本。
  question: string,
  //  声明第二个参数 options：可供用户选择的选项数组。
  options: Array<{ label: string; description: string }>,
  //  结束函数参数列表，并声明这个异步函数最终会得到一个字符串。
): Promise<string> {
  //  挑一个安全默认值：优先 label 含 "skip" 的，否则第二个，否则第一个
  //  计算安全默认选项：优先含 skip 的 label，其次第二项，再其次第一项。
  const safeDefault = options.find((o) => /skip/i.test(o.label))?.label ?? options[1]?.label ?? options[0]?.label ?? ''

  //  不是 TTY 就直接返回安全默认值（管道/CI 环境）
  //  如果输入或输出不是终端，就不能交互提问，直接使用默认选项。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    //  返回前面算出的安全默认选项。
    return safeDefault
  }

  //  动态导入 readline/promises，用它向用户提问并等待输入。
  const readline = await import('node:readline/promises')

  //  渲染到 stderr，这样提问内容和其它 CLI 状态消息落在同一个流；
  // 如果有人在捕获 stdout（交互启动时少见，但宁可保险），stdout 仍是干净的。
  //  向标准错误输出写入文本。
  process.stderr.write('\n' + chalk.yellow(question) + '\n')
  //  按序遍历所有可选项，准备把它们打印出来。
  for (let i = 0; i < options.length; i++) {
    //  取出当前序号对应的选项对象。
    const o = options[i]
    //  向标准错误输出写入文本。
    process.stderr.write(`  ${chalk.bold(`${i + 1}.`)} ${o.label} — ${chalk.gray(o.description)}\n`)
  }

  //  用 readline 创建一个交互式问答，等用户输入编号
  //  创建 readline 接口，把输入接 stdin、输出接 stderr。
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  //  开始 try 块；这里包住可能因为终端断开而失败的操作。
  try {
    //  向用户询问编号，并等待用户输入一行文本。
    const answer = await rl.question(`\nChoose [1-${options.length}]: `)
    //  把用户输入转成数组下标；用户看到的是从 1 开始，所以这里减 1。
    const idx = parseInt(answer.trim(), 10) - 1
    //  确认输入是有效数字，并且落在选项数组范围内。
    if (Number.isFinite(idx) && idx >= 0 && idx < options.length) {
      //  返回用户选择的选项 label。
      return options[idx].label
    }
    //  输入不合法就用安全默认值
    //  返回前面算出的安全默认选项。
    return safeDefault
    //  无论前面成功还是出错，都会进入 finally 做资源清理。
  } finally {
    //  关闭 readline 接口，释放 stdin/stderr 相关资源。
    rl.close()
  }
}

// 拒绝（rejection）安全网。
//  Node 15+ 默认会在出现「未处理的 Promise 拒绝」时终止进程。
// AI SDK 会创建好几个 promise（response、usage、finishReason、toolCalls、流内部的 flush），
// 当请求失败时它们可能各自独立地 reject（拒绝）——我们在 loop.ts 里尽量排干它们，
// 但时序竞争或新的 SDK 路径仍可能漏掉一个。如果没有这个处理器，
// 供应商侧的错误（余额不足、max_tokens 不合法、上游 5xx）会在会话中途杀死 REPL。
// 我们吞掉这个拒绝，让 loop 的 onError 路径去渲染一个友好的错误提示。
//  监听未处理的 Promise 拒绝，防止供应商错误直接杀掉进程。
process.on('unhandledRejection', (reason) => {
  //  只有开启 DEBUG_STDOUT 时才把异常细节打印出来。
  if (process.env.DEBUG_STDOUT) {
    //  打印未处理 Promise 拒绝的调试信息。
    console.error('[unhandledRejection]', reason)
  }
  //  结束当前函数调用或回调表达式。
})
//  未捕获异常：同理吞掉，只在 DEBUG_STDOUT 时打印，避免进程崩溃。
//  监听未捕获异常，采用和未处理拒绝相同的兜底策略。
process.on('uncaughtException', (err) => {
  //  只有开启 DEBUG_STDOUT 时才把异常细节打印出来。
  if (process.env.DEBUG_STDOUT) {
    //  打印未捕获异常的调试信息。
    console.error('[uncaughtException]', err)
  }
  //  结束当前函数调用或回调表达式。
})

// SIGINT（Ctrl+C）信号处理器。
//  只是一个安全网：把 exitCode 设成 0，
// 这样即使进程在 gracefulShutdown() 运行前就退出了，退出码仍然是 0。
// 双击 Ctrl+C 时，立即强制退出。
//  声明 Ctrl+C 计数器，用来区分第一次和第二次 Ctrl+C。
let sigintCount = 0
//  注册 SIGINT 信号处理器，也就是处理 Ctrl+C。
process.on('SIGINT', () => {
  //  每收到一次 Ctrl+C，就把计数器加一。
  sigintCount++
  //  预先把退出码设为 0，避免中途退出时被当成错误。
  process.exitCode = 0
  //  如果用户连续按了两次 Ctrl+C，就立即走强制退出路径。
  if (sigintCount >= 2) {
    //  双击 Ctrl+C → 用户想立刻退出。跳过异步清理
    // （gracefulShutdown 已经在第一次按下时开始跑了），但「一定」要恢复终端，
    // 让 shell 提示符可用。如果不重置，raw 模式 / 隐藏的光标 / 括号粘贴模式
    // 可能泄漏到 shell 里。
    //  调用终端恢复函数，确保退出后终端能正常使用。
    resetTerminal()
    //  打印恢复会话提示，方便用户下次进入 TUI 后用 /resume 接着聊。
    printResumeHint()
    //  用退出码 0 结束进程，表示正常退出或只是给用户提示。
    process.exit(0)
  }
  //  结束当前函数调用或回调表达式。
})

//  调用 main() 启动整个 CLI。如果它抛错：
// - 如果正在关闭（Ctrl+C 卸载了 Ink，waitUntilExit reject 了），不算致命错误，由 gracefulShutdown 处理。
// - 否则打印致命错误并以退出码 1 退出。
//  调用主函数启动 CLI，并捕获启动或运行中冒出的顶层错误。
main().catch((err) => {
  //  如果正在关闭中（Ctrl+C 卸载了 Ink，waitUntilExit reject 了），
  // 不当致命错误处理——由 gracefulShutdown 处理。
  //  如果错误发生在退出过程中，就忽略它，避免把正常退出报成崩溃。
  if (sigintCount > 0 || shutdownInProgress) {
    //  从当前函数返回，结束后续执行。
    return
  }
  //  打印真正的致命错误，方便用户或开发者定位问题。
  console.error('Fatal error:', err)
  //  用退出码 1 结束进程，表示发生了错误。
  process.exit(1)
})
