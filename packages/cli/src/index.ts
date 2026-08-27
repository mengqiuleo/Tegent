// 这是 CLI（命令行界面）的入口文件。
// 当用户在终端敲下 `xc` 命令时，程序就从这里的 main() 函数开始执行。
// 这个文件负责：启动前的所有准备工作（检查环境、解析参数、加载插件/MCP、
// 恢复会话等），然后挂载 Ink（TUI 框架）启动主界面，最后处理退出流程。
//  从 chalk 引入 Chalk，用来创建一个按终端能力上色的输出工具。
import { Chalk } from 'chalk'
//  从 yargs/helpers 引入 hideBin，用来去掉 node 和脚本路径，只保留用户传给 CLI 的参数。
import { hideBin } from 'yargs/helpers'

//  引入 Node 内置 fs 模块，用来同步写终端转义序列、检查 .env 等文件。
import fs from 'node:fs'
//  引入 Node 内置 path 模块，用来拼接和向上查找目录路径。
import path from 'node:path'

//  开始从 core 包导入一组运行 CLI 需要的核心能力。
import {
  //  导入 MCP 权限存储类，用来记住 MCP 工具的允许策略。
  McpPermissionStore,
  //  导入供应商检测顺序，用来在默认模型失效时找可用回退模型。
  PROVIDER_DETECTION_ORDER,
  //  导入插件整合函数，把插件贡献的技能、命令、MCP 等内容整理成统一结构。
  buildPluginIntegration,
  //  导入斜杠命令注册表创建函数。
  createCommandRegistry,
  //  导入模型注册表创建函数，用它把模型 id 解析成真实模型对象。
  createModelRegistry,
  //  导入 MCP OAuth 供应商工厂，用来处理 MCP 授权流程。
  createOAuthProviderFactory,
  //  导入技能注册表创建函数。
  createSkillRegistry,
  //  导入子 agent 注册表创建函数。
  createSubAgentRegistry,
  //  导入空钩子总线，用于 --no-hooks 时让生命周期事件变成空操作。
  emptyHookBus,
  //  导入默认插件市场初始化函数，用于首次运行时补默认市场订阅。
  ensureDefaultMarketplaces,
  //  导入可用供应商检测函数，用来判断哪些 API key 已配置。
  getAvailableProviders,
  //  导入供应商到环境变量名的映射函数，用来给用户打印缺 key 的提示。
  getEnvVarName,
  //  导入令牌存储获取函数，MCP OAuth 会把授权令牌放在这里。
  getTokenStorage,
  //  导入会话列表读取函数，用于 --resume 查找历史会话。
  listSessions,
  //  导入插件加载函数，用来扫描并加载所有可用插件。
  loadAllPlugins,
  //  导入 MCP 配置加载函数，用来从磁盘读取并启动 MCP 服务器。
  loadMcpFromDisk,
  //  导入单个会话加载函数，用于恢复历史对话。
  loadSession,
  //  导入用户配置读取函数，用来取主题、thinking 开关等持久化配置。
  loadUserConfig,
  //  导入最近会话选择函数，用于 --continue 快速继续。
  pickLatestSession,
  //  导入模型 id 解析函数，用默认配置或参数得到最终模型。
  resolveModelId,
} from '@tegent/core'
//  只导入 TypeScript 类型，编译成 JavaScript 时不会产生运行时代码。
import type { AgentOptions, HookBus, LoadedSession, McpRegistry } from '@tegent/core'

//  从本地 app 模块导入清理函数获取器和启动 TUI 的函数。
import { getCleanupFn, startApp } from './app.js'
//  导入命令行参数解析函数。
import { parseCliArgs } from './cli-args.js'
//  导入插件子命令入口，用于 xc plugin ... 这种非交互命令。
import { runPluginCli } from './plugin-cli.js'
//  导入启动时需要打印的提示和更新检查函数。
import { checkForUpdate, printNoApiKeyMessage, printNoWebSearchKeyHint, printResumeHint } from './startup-prints.js'
//  导入语法高亮主题设置函数。
import { setSyntaxTheme } from './ui/syntax-highlight.js'
//  导入主题解析、应用和取配色的函数。
import { getThemeColors, parseThemeName, setTheme } from './ui/theme.js'

;(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS = (options: {
  //  声明回调参数里的 warnings 字段：这里是一组未知结构的警告对象。
  warnings: unknown[]
  //  声明可选的 provider 字段：表示警告来自哪个模型供应商。
  provider?: string
  //  声明可选的 model 字段：表示警告来自哪个具体模型。
  model?: string
  //  结束参数类型声明，并开始这个警告处理回调的函数体。
}) => {
  //  逐个遍历 AI SDK 传来的每一条警告。
  for (const warning of options.warnings) {

  
  }
  //  结束当前代码块。
}

//  chalk 是一个给终端文字上色的库。
// 这里根据 stderr 是否是真正的终端（TTY）决定颜色等级：
// 是终端就用 24 位真彩色（level 3），否则不上色（level 0，比如输出被重定向到文件时）。
//  创建 chalk 实例；stderr 是终端就启用真彩色，不是终端就关闭颜色。
const chalk = new Chalk({ level: process.stderr.isTTY ? 3 : 0 })

//  最低要求的 Node.js 版本：20.19.0
//  保存项目要求的最低 Node.js 版本号，数组三项依次是主版本、次版本、补丁版本。
const MIN_NODE_VERSION = [20, 19, 0]

//  检查当前 Node.js 版本是否满足最低要求，不满足就报错退出。
//  定义 Node 版本检查函数；返回 void 表示它没有正常返回值。
function checkNodeVersion(): void {
  //  把当前 Node 版本字符串拆成三个数字：主版本、次版本、补丁版本。
  const [major, minor, patch] = process.versions.node.split('.').map((v) => parseInt(v, 10))
  //  把最低要求版本也拆成三个数字，后面逐项比较。
  const [reqMajor, reqMinor, reqPatch] = MIN_NODE_VERSION
  //  开始一个多行 if 条件，下面几行会共同组成判断条件。
  if (
    //  比较主版本：当前主版本太低就不满足要求。
    major < reqMajor ||
    //  主版本相同时比较次版本，次版本太低也不满足要求。
    (major === reqMajor && minor < reqMinor) ||
    //  主版本和次版本都相同时再比较补丁版本。
    (major === reqMajor && minor === reqMinor && patch < reqPatch)
    //  执行这一行 TypeScript 代码，继续完成当前启动或清理流程。
  ) {
    //  开始向 stderr 打印错误或提示信息。
    console.error(
      //  执行这一行 TypeScript 代码，继续完成当前启动或清理流程。
      `Error: X-Code CLI requires Node.js >= ${MIN_NODE_VERSION.join('.')}, but you are running ${process.versions.node}.\n` +
        //  拼出提示用户升级 Node.js 的第二行英文信息。
        'Please upgrade Node.js: https://nodejs.org/',
      //  结束当前多行函数调用。
    )
    //  用退出码 1 结束进程，表示发生了错误。
    process.exit(1)
    //  结束当前代码块。
  }
  //  结束当前代码块。
}

// 优雅退出（graceful shutdown）相关代码。
// 单次 Ctrl+C 的退出路径：
// 会话保存以「即发即忘」（fire-and-forget，不等待它完成）方式运行，所以不会阻塞退出。
// 退出时不打印 token 用量统计——我们对比过的另外四款 CLI
// （claude-code、codex、gemini-cli、opencode）都不打印，而且延迟刷新的 stdout
// 会让统计信息出现在 shell 提示符之后，让用户困惑。

//  标记退出流程是否已经开始，防止重复执行。
//  声明退出状态标记，false 表示当前还没有进入退出流程。
let shutdownInProgress = false
//  启动时捕获的 MCP 注册表，用于在退出时关闭 MCP 服务器
// （杀掉 stdio 子进程、终止 HTTP 传输）。如果不显式关闭，stdio 服务器
// 会一直残留，直到它们发现父进程的 stdin 关闭——通常没问题，
// 但显式关闭更快、也更不容易出意外。
//  声明退出时要用的 MCP 注册表引用，初始为 null 表示还没加载。
let mcpRegistryForShutdown: McpRegistry | null = null
//  启动时捕获的插件钩子总线（hook bus），用于在退出前
// 向插件钩子触发 `SessionEnd`（会话结束）事件。同样「即发即忘」——
// 退出时只有 1 秒的宽限窗口，慢的钩子之后会被直接杀掉。
//  声明退出时要用的插件钩子总线引用，初始为 null 表示还没准备好。
let hookBusForShutdown: HookBus | null = null

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
    //  结束当前代码块。
  }
  //  结束当前代码块。
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
    //  结束当前代码块。
  }

  //  插件 SessionEnd（会话结束）钩子。即发即忘——不 await，
  // 因为慢的钩子会挡住用户的 shell 提示符返回；而且退出时的宽限窗口本就很小。
  // 需要保证可靠触发的钩子，应该同时订阅 TurnComplete（单轮完成）事件。
  //  如果插件钩子总线存在且有人监听 SessionEnd，就准备触发会话结束事件。
  if (hookBusForShutdown?.has('SessionEnd')) {
    //  发送 SessionEnd 事件，把当前工作目录和模型信息传给插件钩子。
    hookBusForShutdown.emit({ name: 'SessionEnd', session: { cwd: process.cwd(), modelId: '' } }).catch(() => undefined)
    //  结束当前代码块。
  }

  //  先恢复终端状态。
  //  调用终端恢复函数，确保退出后终端能正常使用。
  resetTerminal()
  //  在 resetTerminal 之后才打印，这样提示行能干净地落在 shell 提示符上方——
  // 颜色已重置、raw 模式已关闭、光标已可见。
  // 这个提示从一个同步捕获的快照里读取（由 App 通过 onSessionInfoReady 注册），
  // 所以不依赖仍在运行的异步清理。
  //  打印恢复会话提示，方便用户下次用 --resume 接着聊。
  printResumeHint()
  //  按传入的退出码真正结束 Node 进程。
  process.exit(exitCode)
  //  结束当前代码块。
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
  // 在 --print 模式和非 TTY 环境下不执行。
  //  后台启动版本更新检查；void 表示故意不等待这个 Promise。
  void checkForUpdate().catch(() => undefined)

  //  非交互式的插件管理子命令。
  // 必须在 yargs 解析其余参数之前就拦截——否则 `xc plugin install ./foo`
  // 会被当成一个「提示词」交给 agent 去回答。这个子命令不挂载 Ink，
  // 执行完就退出。
  //  取得用户输入的原始命令行参数，并去掉 node 和脚本路径。
  // 比如用户运行：xc plugin install ./foo
  // rawArgs 会变成：['plugin', 'install', './foo']
  const rawArgs = hideBin(process.argv)
  //  如果第一个参数是 plugin，就进入插件管理子命令分支。
  if (rawArgs[0] === 'plugin') {
    // 如果第一个参数是 plugin，就说明用户要执行插件管理命令，而不是进入聊天/agent 模式。
    //  运行插件 CLI 子命令，并等待它返回退出码。
    const exitCode = await runPluginCli(rawArgs.slice(1)) // 它会把后面的参数：['install', './foo']，交给 runPluginCli 去处理。执行完后拿到退出码，比如 0 成功、1 失败，然后用 process.exit(exitCode) 结束进程。
    //  按传入的退出码真正结束 Node 进程。
    process.exit(exitCode)
    //  结束当前代码块。
  }

  //  解析命令行参数（yargs），argv 里包含 model、print、resume 等
  //  解析普通 CLI 参数，得到结构化的 argv 对象。
  const argv = await parseCliArgs()

  //  把位置参数（比如 `xc 帮我写个函数` 里的「帮我写个函数」）拼成提示词
  //  把所有位置参数用空格拼成用户提示词；没有内容就设为 undefined。
  const prompt = (argv._ as string[]).join(' ') || undefined

  //  检查是否有通过管道传入的 stdin 输入（比如 `cat file.txt | xc 总结一下`）
  //  准备保存管道传入的 stdin 文本，默认是空字符串。
  let stdinContent = ''
  //  如果 stdin 不是终端，说明可能有管道输入，需要读取它。
  if (!process.stdin.isTTY) {
    //  读取 stdin 的全部文本，供后面和命令行提示词合并。
    stdinContent = await readStdin()
    //  结束当前代码块。
  }

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
    //  结束当前代码块。
  }

  //  解析模型 id（格式是 `provider:model`，比如 `anthropic:claude-...`）
  //  根据 --model 参数或用户配置解析最终要用的模型 id。
  let modelId = resolveModelId(argv.model) // 解析模型 id，优先使用命令行参数，如果没有就用用户配置的默认模型。resolveModelId 函数里面会判断用户配置的
  //  如果没能解析出模型，说明模型参数或供应商配置有问题。
  if (!modelId) {
    //  用户指定了一个模型，但它的供应商没有配置 key
    //  保存用户显式请求的模型名，后面用来判断该报错还是给普通提示。
    const requested = argv.model
    //  如果用户明确传了模型，就按明确错误处理。
    if (requested) {
      //  从 provider:model 字符串里取出 provider 部分。
      const provider = requested.split(':')[0]
      //  查这个 provider 应该使用哪个 API key 环境变量；查不到就拼一个默认名字。
      const envVar = getEnvVarName(provider) ?? `${provider.toUpperCase()}_API_KEY`
      //  向标准错误输出打印信息。
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${requested}.`)
      //  用退出码 1 结束进程，表示发生了错误。
      process.exit(1)
      //  进入 else 分支，也就是前面的 if 条件不成立时要执行的路径。
    } else {
      //  打印没有配置 API key 时的帮助信息。
      printNoApiKeyMessage()
      //  用退出码 0 结束进程，表示正常退出或只是给用户提示。
      process.exit(0)
      //  结束当前代码块。
    }
    //  结束当前代码块。
  }

  //  防范「过期模型 id」——即当前启动没有注册该供应商的情况。
  // “过期模型 id”可以理解成：保存的默认模型还在，但它依赖的 provider key 当前没了，导致这个模型在本次运行不可用。
  // 常见场景：用户删掉了某个环境变量 key，但 config.json 还指向它；
  // 或者某个供应商被整个移除出构建（比如 kimicode 在某次功能回滚后）。
  // 否则注册表会在 languageModel() 处抛出 NoSuchProviderError，
  // 在 UI 还没挂载前就致命退出。
  // 对于显式的 `--model`，我们仍然硬失败（用户意图明确）；
  // 对于持久化/智能默认的 id，我们回退到第一个可用的供应商，保证 CLI 仍可用。
  //  从已解析的模型 id 中取出供应商名，用来确认它当前真的可用。
  const requestedProvider = modelId.split(':')[0]
  //  如果解析出的供应商不在可用列表里，就处理过期模型配置。
  if (!availableProviders.includes(requestedProvider)) {
    //  查这个 provider 应该使用哪个 API key 环境变量；查不到就拼一个默认名字。
    const envVar = getEnvVarName(requestedProvider) ?? `${requestedProvider.toUpperCase()}_API_KEY`
    //  根据括号里的条件决定是否执行后面的代码块。
    if (argv.model) {
      //  向标准错误输出打印信息。
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${argv.model}.`)
      //  用退出码 1 结束进程，表示发生了错误。
      process.exit(1)
      //  结束当前代码块。
    }
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
      //  结束当前代码块。
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
    //  结束当前代码块。
  }

  //  应用持久化的 UI 主题。要尽早做（在 startApp 之前），
  // 这样第一行滚动历史——包括从恢复的会话里取出的含 edit/write 工具调用的消息——
  // 就已经按用户选的主题上色（差异背景 + 语法高亮配色）。
  // 未知值（过期配置、手工编辑的文件）会静默回退到默认主题。
  // 选定的主题同时驱动两件事：diff 背景色（渲染时由 render-diff.ts 读取）
  // 和语法高亮配色（在 syntax-highlight 模块上全局设置）。
  //  开始一个独立代码块，用来限制临时变量作用域。
  {
    //  从用户配置读取主题名，并解析成内部认识的主题枚举。
    const t = parseThemeName(loadUserConfig().theme)
    //  如果主题名有效，就应用它；无效则保持默认主题。
    if (t !== null) {
      //  把 UI 主题设置为用户选择的主题。
      setTheme(t)
      //  把语法高亮配色同步成当前主题对应的配色。
      setSyntaxTheme(getThemeColors(t).syntaxPalette)
      //  结束当前代码块。
    }
    //  结束当前代码块。
  }

  //  创建各注册表，并从模型注册表拿到具体的模型实例。
  // providerRegistry 是「模型供应商注册表」，languageModel() 根据 `provider:model` id 返回模型对象。
  //  创建模型供应商注册表。
  const providerRegistry = createModelRegistry()
  //  根据模型 id 从注册表中取得真正会调用的语言模型对象。
  const model = providerRegistry.languageModel(modelId as `${string}:${string}`)

  //  --plugin-debug 或环境变量 XC_PLUGIN_DEBUG=1：
  // 把插件/钩子/市场的 debugLog 面包屑镜像输出到 stderr，
  // 这样无需 tail 日志文件就能实时看到。要在 ensureDefaultMarketplaces 之前安装，
  // 这样首次运行的订阅消息也能显示。做成 debugLog 的全局钩子，而不是新建一个日志器——
  // 这样所有现有调用点都自动生效，避免出现两条平行的日志路径。
  //  如果用户开启插件调试，就进入调试镜像分支。
  if (argv['plugin-debug'] || process.env.XC_PLUGIN_DEBUG === '1') {
    //  打开插件调试日志到 stderr 的镜像输出。

    //  结束当前代码块。
  }

  //  首次运行的种子数据：如果还没有订阅文件，就把默认的
  // `anthropic-marketplace` 订阅写入 known_marketplaces.json。
  // 这是幂等操作——明确删除过该订阅的用户不会被重新加回来。
  // 要在 loadAllPlugins 之前做，这样首次运行就能看到一个已填充的市场列表。
  //  如果没有用 --no-plugins 禁用插件，就执行插件相关初始化。
  if (argv.plugins !== false) {
    //  确保默认插件市场订阅存在；失败只写调试日志，不中断启动。
    await ensureDefaultMarketplaces().catch((err) => {})
    //  结束当前代码块。
  }

  //  插件必须在 skill / 子 agent / MCP 注册表之前加载，
  // 这样插件的贡献才能被合并进各个注册表。`--no-plugins` 会短路整条链。
  // 非致命的加载错误会以和下面 `[mcp] config error in ...` 相同的样式输出到 stderr——
  // 一个坏插件绝不会阻塞其他插件。
  // 详细诊断（冲突、不支持的命令、钩子错误）通过 debugLogIntegrationDiagnostics 写入 debug.log，
  // 供 `/plugin doctor` 命令展示。
  //  加载所有插件，disabled 为 true 时返回禁用状态下的空结果。
  const pluginLoad = await loadAllPlugins({ cwd: process.cwd(), disabled: argv.plugins === false })
  //  遍历插件加载错误，把每个错误展示给用户。
  for (const e of pluginLoad.registry.loadErrors()) {
    //  向标准错误输出打印信息。
    console.error(chalk.yellow(`[plugin] ${e.id ?? e.path}: ${e.message}`))
    //  结束当前代码块。
  }
  //  把插件加载结果整合成后续注册表可消费的结构。
  const pluginIntegration = await buildPluginIntegration(pluginLoad)

  //  如果插件贡献的 MCP 配置有错误，就准备逐条打印。
  if (pluginIntegration.mcpErrors.length > 0) {
    //  遍历插件 MCP 错误。
    for (const e of pluginIntegration.mcpErrors) {
      //  向标准错误输出打印信息。
      console.error(chalk.yellow(`[plugin] ${e.pluginId}: ${e.message}`))
      //  结束当前代码块。
    }
    //  结束当前代码块。
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
  //  取得 OAuth 令牌存储，供 MCP 授权流程使用。
  const tokenStorage = getTokenStorage()
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
    //  这个「打开浏览器」钩子只在 /mcp auth（MCP 授权）期间触发
    // （被动启动模式从不调用 redirectToAuthorization）。
    // App.tsx 里的 /mcp auth 处理器已经通过 addCommandResult 展示了这个 URL；
    // 如果在这里再用 console.error 写一份，会落到 stderr，
    // 破坏 ChatInput 的单元格帧（`[` 字符会和输入框底部分隔线冲突）。
    // 所以发到 debug log，这样仍然可以被技术支持找回。
    //  创建 MCP OAuth provider，并把打开浏览器的 URL 记录到调试日志。
    oauthProviderFor: createOAuthProviderFactory(tokenStorage, (server, url) => {
      //  记录 MCP 授权需要打开的浏览器 URL。

      //  结束当前回调或函数调用。
    }),
    //  把 MCP 加载器请求退出时的处理方式设为正常退出进程。
    onExitRequested: () => process.exit(0),
    //  结束当前函数调用或回调表达式。
  })
  //  保存 MCP 注册表，用于退出时关闭。
  //  把 MCP 注册表保存到模块级变量，供退出清理时使用。
  mcpRegistryForShutdown = mcpLoadResult.registry
  //  设置 --no-hooks 时不保存 hookBus，退出时就不会触发 SessionEnd 钩子——
  // 用户明确表示这次会话不执行任何钩子。
  //  根据 --no-hooks 决定退出时是否保存并触发插件钩子总线。
  hookBusForShutdown = argv.hooks === false ? null : pluginIntegration.hookBus

  //  如果 MCP 配置加载时出现错误，就准备输出这些错误。
  if (mcpLoadResult.configErrors.length > 0) {
    //  遍历每一条 MCP 配置错误。
    for (const e of mcpLoadResult.configErrors) {
      //  向标准错误输出打印信息。
      console.error(chalk.yellow(`[mcp] config error in ${e.name}: ${e.message}`))
      //  结束当前代码块。
    }
    //  结束当前代码块。
  }
  //  如果项目级 MCP 因未信任而被跳过，就提示用户。
  if (mcpLoadResult.projectSkipped) {
    //  向标准错误输出打印信息。
    console.error(chalk.yellow(`[mcp] Project-level MCP servers skipped (not trusted).`))
    //  结束当前代码块。
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
    //  把信任模式参数放入 agent 选项。
    trustMode: argv.trust,
    //  把是否打印模式放入 agent 选项。
    printMode: argv.print,
    //  把最大轮数限制放入 agent 选项。
    maxTurns: argv['max-turns'],
    //  从磁盘读取持久化的 /thinking 开关。默认 false，这样在无配置的机器上启动
    // 与该功能引入前的行为一致（供应商默认的 thinking 行为，没有意外的延迟/成本跳变）。
    // App.tsx 里的 /thinking 命令可以通过 useAgent 的 setThinking 热替换这个标志，无需重启。
    //  把 /thinking 开关放入 agent 选项；配置缺失时默认 false。
    thinking: loadUserConfig().thinking ?? false,
    //  计划模式（plan mode）是「会话级」作用域（与 Claude Code 一致）——
    // 只有 `--plan` 命令行标志会在启动时启用。会话中用 /plan 切换不会持久化，
    // 所以每次新启动都从 'default'（默认模式）开始，除非显式请求。
    //  根据 --plan 决定权限模式是 plan 还是 default。
    permissionMode: argv.plan ? 'plan' : 'default',
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
    //  --no-plugins：把 pluginRegistry 留作 undefined，
    // 这样 /plugin 斜杠命令能显示「Plugin system is disabled...」，
    // 而不是落到通用的空状态（「No plugins installed」）。
    // loadAllPlugins 在 disabled:true 时仍会返回一个（非 null 的）空注册表，
    // 所以我们必须在这里连接的位置把它丢弃，而不能只依赖加载结果。
    //  根据 --no-plugins 决定是否把插件注册表交给 agent 引擎。
    pluginRegistry: argv.plugins === false ? undefined : pluginLoad.registry,
    //  把斜杠命令注册表交给 agent 引擎。
    commandRegistry,
    //  --no-hooks：换上一个空的 hookBus，这样所有 emit（触发）调用都是空操作，
    // 而不影响其余插件加载（skill / agent / mcp 仍然注册，只是没有东西监听生命周期事件）。
    //  根据 --no-hooks 决定使用空钩子总线还是真实插件钩子总线。
    hookBus: argv.hooks === false ? emptyHookBus() : pluginIntegration.hookBus,
    //  结束当前代码块。
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
    //  结束当前代码块。
  }

  //  恢复 / 继续之前的会话。有三个入口：
  //   1. `--continue`（-c）：在这里同步加载最近一次会话，不弹选择器。方便肌肉记忆式快速继续。
  //   2. `--resume <id>`：按 id / slug / 文件名前缀查找会话并直接加载。
  //      我们退出后打印的提示（"Resume: xc --resume <id>"）会反过来喂给这个分支。
  //   3. `--resume`（不带值）：交给 Ink 内的选择器（resumeIntent='pick'），让用户浏览挑选。
  // 如果同时设置了 --continue 和 --resume，--continue 优先（与 Claude Code 一致）。
  //  声明初始会话变量；没有恢复会话时保持 null。
  let initialSession: LoadedSession | null = null
  //  声明恢复意图；为 pick 时表示启动后打开会话选择器。
  let resumeIntent: 'pick' | null = null
  //  如果用户传了 --continue，就进入最近会话恢复流程。
  if (argv.continue) {
    //  --continue：找最近一次会话
    //  查找当前项目最近一次保存的会话。
    const latest = await pickLatestSession()
    //  如果没有历史会话，就提示用户并继续开新会话。
    if (!latest) {
      //  打印 --continue 找不到历史会话的提示。
      console.error('Note: --continue specified but no past sessions found in this project. Starting a fresh session.')
      //  进入 else 分支，也就是前面的 if 条件不成立时要执行的路径。
    } else {
      //  从指定文件读取并解析历史会话。
      const loaded = await loadSession(latest.filePath)
      //  如果会话加载成功，就把它作为启动时要恢复的会话。
      if (loaded) initialSession = loaded
      //  结束当前代码块。
    }
    //  如果用户传了 --resume，就按 resume 的值进入对应恢复流程。
  } else if (typeof argv.resume === 'string') {
    //  --resume 分支
    //  如果 --resume 没带具体值，就设置为稍后打开选择器。
    if (argv.resume === '') {
      //  `--resume` 不带值 → 弹选择器
      //  记录恢复意图为 pick，让 TUI 启动后弹出会话选择器。
      resumeIntent = 'pick'
      //  进入 else 分支，也就是前面的 if 条件不成立时要执行的路径。
    } else {
      //  `--resume <id>` → 按 id 查找
      //  根据用户输入的 id、slug 或前缀查找具体会话文件。
      const filePath = await findSessionFile(argv.resume)
      //  如果找不到对应会话文件，就打印错误并退出。
      if (!filePath) {
        //  开始向 stderr 打印错误或提示信息。
        console.error(
          //  执行这一行 TypeScript 代码，继续完成当前启动或清理流程。
          `Error: no session found matching "${argv.resume}". Run \`xc --resume\` to pick from the list, or \`xc -c\` for the most recent.`,
          //  结束当前多行函数调用。
        )
        //  用退出码 1 结束进程，表示发生了错误。
        process.exit(1)
        //  结束当前代码块。
      }
      //  从指定文件读取并解析历史会话。
      const loaded = await loadSession(filePath)
      //  如果会话文件存在但解析失败，就打印损坏提示并退出。
      if (!loaded) {
        //  向标准错误输出打印信息。
        console.error(`Error: failed to load session at ${filePath}. The file may be corrupted.`)
        //  用退出码 1 结束进程，表示发生了错误。
        process.exit(1)
        //  结束当前代码块。
      }
      //  把成功加载的会话设置为启动时要恢复的会话。
      initialSession = loaded
      //  结束当前代码块。
    }
    //  结束当前代码块。
  }

  //  把 stdin 内容和命令行提示词合并成完整提示词（用空行分隔）
  //  把管道输入和命令行提示词过滤掉空值后，用两个换行合成完整提示词。
  const fullPrompt = [stdinContent, prompt].filter(Boolean).join('\n\n')

  //  打印模式（-p / --print）：完全绕过 Ink（TUI 框架）。
  // 挂载 TUI 会引用 raw stdin，这让 Node 事件循环在排队卸载之后还保持存活——
  // 这就是为什么以前 -p 会卡到按键才退出的原因。详见 packages/cli/src/print.ts。
  // 打印模式是「非交互」的：给定提示词，跑完，把结果输出到 stdout，就退出。
  //  如果是 --print 模式，就走非交互执行分支。
  if (argv.print) {
    //  打印模式必须有提示词；没有就报错退出。
    if (!fullPrompt) {
      //  告诉用户 --print 需要从参数或 stdin 提供提示词。
      console.error('Error: -p / --print requires a prompt (as an argument or via stdin).')
      //  用退出码 1 结束进程，表示发生了错误。
      process.exit(1)
      //  结束当前代码块。
    }
    //  按需动态导入打印模式实现，避免普通交互启动提前加载它。
    const { runPrintMode } = await import('./print.js')
    //  运行打印模式，并取得它给出的退出码。
    const code = await runPrintMode(model, options, fullPrompt, initialSession)
    //  调用终端恢复函数，确保退出后终端能正常使用。
    resetTerminal()
    //  执行这一行 TypeScript 代码，继续完成当前启动或清理流程。
    process.exit(code)
    //  结束当前代码块。
  }

  //  提醒：WebSearch（联网搜索）需要 API key。
  // 在 Ink 接管之前打印一次，让提示落在 TUI 上方的滚动历史里。
  // 这不是致命错误——WebFetch（抓取网页）无需 key 也能工作，
  // 而且工具本身在没有配置 key 被调用时会返回详细错误。
  //  如果两个 WebSearch key 都没有配置，就打印联网搜索不可用提示。
  if (!process.env.TAVILY_API_KEY && !process.env.BRAVE_API_KEY) {
    //  打印 WebSearch 缺少 key 的非致命提示。
    printNoWebSearchKeyHint()
    //  结束当前代码块。
  }

  //  启动主应用（挂载 Ink TUI）。waitUntilExit 在 Ink 卸载时 resolve（包括 Ctrl+C 触发的卸载）。
  // startApp 接收：模型、选项、初始提示词、以及会话恢复信息。
  //  启动 Ink TUI，并拿到一个会在应用退出时完成的 Promise。
  const waitUntilExit = startApp(model, options, fullPrompt || undefined, {
    //  把要恢复的初始会话传给 App。
    initialSession,
    //  把是否打开恢复选择器的意图传给 App。
    resumeIntent,
    //  结束当前函数调用或回调表达式。
  })
  //  等待 TUI 卸载；用户退出或 Ctrl+C 都会走到这里。
  await waitUntilExit()

  //  正常退出路径（包括 Ctrl+C，它会先卸载 Ink）。
  //  TUI 正常结束后，用退出码 0 走统一清理流程。
  await gracefulShutdown(0)
  //  结束当前代码块。
}

//  把用户提供的「会话查找 key」解析成会话 jsonl 文件路径。
// 接受用户从我们退出后打印的提示里可能粘贴的各种形式：
//   - 纯 sessionId（`20260101-120000-000`）
//   - slug（任务别名，如 `fix-login`）
//   - 完整文件名主干（`fix-login-20260101-120000-000`）
// 优先精确匹配；如果没有精确匹配，就回退到 sessionId 的前缀匹配（长度要足够消歧）。
// 返回第一个匹配的文件路径（按从新到旧排序），找不到返回 null。
//  定义会话文件查找函数，输入是用户提供的查找字符串。
async function findSessionFile(input: string): Promise<string | null> {
  //  读取当前项目的历史会话列表，通常已经按新到旧排序。
  const sessions = await listSessions()
  //  遍历每个历史会话，先做精确匹配。
  for (const s of sessions) {
    //  如果输入正好等于 sessionId，就返回这个会话文件路径。
    if (s.sessionId === input) return s.filePath
    //  如果输入正好等于任务 slug，也返回这个会话文件路径。
    if (s.taskSlug && s.taskSlug === input) return s.filePath
    //  根据括号里的条件决定是否执行后面的代码块。
    if (s.taskSlug && `${s.taskSlug}-${s.sessionId}` === input) return s.filePath
    //  结束当前代码块。
  }
  //  只有输入长度至少 8 位时才允许前缀匹配，降低误匹配风险。
  if (input.length >= 8) {
    //  遍历每个历史会话，先做精确匹配。
    for (const s of sessions) {
      //  如果 sessionId 以前缀开头，就返回这个会话文件路径。
      if (s.sessionId.startsWith(input)) return s.filePath
      //  结束当前代码块。
    }
    //  结束当前代码块。
  }
  //  所有匹配都失败时返回 null，表示没有找到。
  return null
  //  结束当前代码块。
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
        //  结束当前代码块。
      }
      //  从当前函数返回，结束后续执行。
      return
      //  结束当前代码块。
    }
    //  取得当前目录的父目录，下一轮循环会继续往上找。
    const parent = path.dirname(dir)
    //  如果父目录等于自己，说明已经到根目录，跳出循环。
    if (parent === dir) break
    //  已经到根目录了，停止
    //  把搜索目录移动到父目录。
    dir = parent
    //  结束当前代码块。
  }
  //  结束当前代码块。
}

//  启动阶段（Ink 挂载之前）用的「朴素终端」提问函数。
// 目前唯一的调用方是 MCP 项目级信任对话框——
// loader.ts 把它的 `askUser` 回调传入一个任意选项列表，并期望拿回某个选项的 label。
// 当 stdin 不是 TTY（管道输入、CI 环境、--print 模式）时优雅回退：
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

  //  不是 TTY 就直接返回安全默认值（管道/CI/--print 模式）
  //  如果输入或输出不是终端，就不能交互提问，直接使用默认选项。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    //  返回前面算出的安全默认选项。
    return safeDefault
    //  结束当前代码块。
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
    //  结束当前代码块。
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
      //  结束当前代码块。
    }
    //  输入不合法就用安全默认值
    //  返回前面算出的安全默认选项。
    return safeDefault
    //  无论前面成功还是出错，都会进入 finally 做资源清理。
  } finally {
    //  关闭 readline 接口，释放 stdin/stderr 相关资源。
    rl.close()
    //  结束当前代码块。
  }
  //  结束当前代码块。
}

//  读取 stdin 的全部内容（用于管道输入场景，比如 `cat file | xc 总结`）。
// 带一个 1 秒超时，避免永远挂起。
//  定义读取 stdin 的函数，返回一个会解析成字符串的 Promise。
function readStdin(): Promise<string> {
  //  手动创建 Promise，因为 stdin 是事件驱动的数据流。
  return new Promise((resolve) => {
    //  准备累积收到的 stdin 文本。
    let data = ''
    //  把 stdin 数据解码方式设为 UTF-8 字符串。
    process.stdin.setEncoding('utf-8')

    //  定义 data 事件处理函数，每来一段文本就追加到 data。
    const onData = (chunk: string): void => {
      //  把当前收到的文本片段追加到总内容里。
      data += chunk
      //  结束当前代码块。
    }
    //  定义 end 事件处理函数，stdin 结束时清理并返回完整内容。
    const onEnd = (): void => {
      //  调用清理函数，移除监听器并清掉超时器。
      cleanup()
      //  把累积到的 stdin 内容作为 Promise 结果交出去。
      resolve(data)
      //  结束当前代码块。
    }
    //  定义清理函数，避免监听器和定时器残留。
    const cleanup = (): void => {
      //  移除 data 事件监听器。
      process.stdin.off('data', onData)
      //  移除 end 事件监听器。
      process.stdin.off('end', onEnd)
      //  清除读取 stdin 的兜底超时器。
      clearTimeout(timer)
      //  结束当前代码块。
    }

    //  注册 data 事件监听器，开始接收 stdin 数据。
    process.stdin.on('data', onData)
    //  注册 end 事件监听器，stdin 完成时收尾。
    process.stdin.on('end', onEnd)
    //  stdin 超时——别永远挂着
    //  设置 1 秒超时；如果 stdin 不结束，也会按已有内容继续启动。
    const timer = setTimeout(() => {
      //  调用清理函数，移除监听器并清掉超时器。
      cleanup()
      //  把累积到的 stdin 内容作为 Promise 结果交出去。
      resolve(data)
      //  结束超时回调，并把等待时间设为 1000 毫秒。
    }, 1000)
    //  结束当前函数调用或回调表达式。
  })
  //  结束当前代码块。
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
    //  结束当前代码块。
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
    //  结束当前代码块。
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
    //  打印恢复会话提示，方便用户下次用 --resume 接着聊。
    printResumeHint()
    //  用退出码 0 结束进程，表示正常退出或只是给用户提示。
    process.exit(0)
    //  结束当前代码块。
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
    //  结束当前代码块。
  }
  //  打印真正的致命错误，方便用户或开发者定位问题。
  console.error('Fatal error:', err)
  //  用退出码 1 结束进程，表示发生了错误。
  process.exit(1)
  //  结束当前函数调用或回调表达式。
})
