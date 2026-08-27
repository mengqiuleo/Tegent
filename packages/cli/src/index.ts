// CLI 的启动流程：环境变量 → 参数解析 → provider/模型解析 → 挂载 Ink TUI。
import chalk from 'chalk'

import {
  PROVIDER_DETECTION_ORDER,
  ToolRegistry,
  closeMcpServers,
  createModelRegistry,
  createSkillRegistry,
  getAvailableProviders,
  getEnvVarName,
  loadMcpServers,
  registerMcpServers,
  resolveModelId,
} from '@tegent/core'
import type { AgentOptions } from '@tegent/core'

import { getCleanupFn, startApp } from './app.js'
import { parseCliArgs } from './cli-args.js'
import { printNoApiKeyMessage } from './startup-prints.js'
import { loadEnvFile } from './utils/toolkit.js'

async function main() {
  // 加载 .env（从当前目录往上找，和 dotenv 的约定一致）。
  loadEnvFile()

  const argv = await parseCliArgs()
  // 位置参数可以直接跟一段初始提示词，比如 `tegent 帮我看看这个报错`。
  const prompt = (argv._ as string[]).join(' ').trim() || undefined

  // 一个可用的 provider 都没有，打印配置指引后退出。
  // 退出码用 0：这只是配置提示，避免 pnpm dev 堆出 ELIFECYCLE 噪音。
  const availableProviders = getAvailableProviders()
  if (availableProviders.length === 0) {
    printNoApiKeyMessage()
    process.exit(0)
  }

  // 模型 id 形如 provider:model；依次看命令行 --model、用户配置、
  // 环境变量里第一个可用的 provider。
  let modelId = resolveModelId(argv.model)
  if (!modelId) {
    if (argv.model) {
      // 用户显式指定了模型，按明确错误处理。
      const provider = argv.model.split(':')[0] ?? ''
      const envVar = getEnvVarName(provider) ?? `${provider.toUpperCase()}_API_KEY`
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${argv.model}.`)
      process.exit(1)
    }
    printNoApiKeyMessage()
    process.exit(0)
  }

  // 防范「过期模型 id」：保存的默认模型还在，但它依赖的 provider key 当前没了。
  // 否则注册表会在 languageModel() 处抛 NoSuchProviderError，在 UI 挂载前就致命退出。
  // 显式 --model 仍然硬失败（用户意图明确）；持久化的 id 回退到第一个可用 provider。
  const requestedProvider = modelId.split(':')[0] ?? ''
  if (!availableProviders.includes(requestedProvider as never)) {
    const envVar = getEnvVarName(requestedProvider) ?? `${requestedProvider.toUpperCase()}_API_KEY`
    if (argv.model) {
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${argv.model}.`)
      process.exit(1)
    }
    const fallback = PROVIDER_DETECTION_ORDER.find(({ envKey }) => process.env[envKey])
    if (!fallback) {
      // 防御分支：availableProviders 非空，理论上走不到这里。
      printNoApiKeyMessage()
      process.exit(0)
    }
    console.error(
      chalk.yellow(
        `Note: saved model '${modelId}' needs ${envVar}, which is not set. ` +
          `Falling back to '${fallback.defaultModel}'. Use /model to pick a different default.`,
      ),
    )
    modelId = fallback.defaultModel
  }

  // 创建模型供应商注册表，并根据模型 id 拿到真正会调用的模型实例。
  const providerRegistry = createModelRegistry()
  const model = providerRegistry.languageModel(modelId)

  // skill 注册表整个进程只创建一次（扫描 ~/.tegent/skills 和 .tegent/skills）。
  // loop 每轮从它重建 activateSkill 工具，因此 /skill refresh 原地 reload 后立即生效。
  const skillRegistry = await createSkillRegistry()

  // MCP：读 .tegent/mcp.json，逐个连接 Server 并把工具注册进会话注册表。
  // 连接失败的服务器在 registerMcpServers 内部 fail-soft，只打警告不阻塞启动流程之外的主逻辑。
  const mcpRegistry = new ToolRegistry()
  const mcpServers = await registerMcpServers(mcpRegistry, loadMcpServers())

  const options: AgentOptions = {
    modelId,
    trustMode: argv.trust,
    skillRegistry,
    mcpRegistry,
    ...(argv['max-turns'] !== undefined ? { maxTurns: argv['max-turns'] } : {}),
  }

  // 挂载 Ink TUI；waitUntilExit 在 Ink 卸载（/exit 或双击 Ctrl+C）时 resolve。
  const waitUntilExit = startApp(model, options, prompt)
  await waitUntilExit()

  // 卸载后补一次清理（保存会话）；/exit 路径已经在 App 里清理过，这里幂等兜底。
  await getCleanupFn()?.()

  // 关掉所有 MCP 子进程，别让 stdio Server 活得比 CLI 久。
  await closeMcpServers(mcpServers)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
