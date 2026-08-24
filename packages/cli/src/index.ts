import readline from 'node:readline/promises'

import {
  agentLoop,
  createModelRegistry,
  getAvailableProviders,
  resolveModelId,
  saveSession,
} from '@tegent/core'
import type { LoopState } from '@tegent/core'

import { printNoApiKeyMessage } from './startup-prints.js'
import { loadEnvFile } from './utils/toolkit.js'
import { parseCliArgs } from './cli-args.js'

async function main() {
  loadEnvFile()

  const argv = await parseCliArgs()

  // 命令行可以直接跟一段初始提示词；不跟也没关系，进入交互循环后再输入。
  const initialPrompt = (argv._ as string[]).join(' ').trim()

  // 一个可用的 provider 都没有，打印配置指引后退出。
  if (getAvailableProviders().length === 0) {
    // 退出码用 0：这只是配置提示，避免 pnpm dev 堆出 ELIFECYCLE 噪音。
    printNoApiKeyMessage()
    process.exit(0)
  }

  // 模型 id 形如 provider:model；依次看命令行 --model、用户配置、环境变量里第一个可用的 provider。
  const modelId = resolveModelId(argv.model)
  if (!modelId) {
    printNoApiKeyMessage()
    process.exit(0)
  }

  // 创建模型供应商注册表，并根据模型 id 拿到真正会调用的模型实例。
  const providerRegistry = createModelRegistry()
  const model = providerRegistry.languageModel(modelId)

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  // Ctrl+C 时关闭接口，让 pending 中的 question 变成 rejected promise，下面的循环才能退出。
  rl.on('SIGINT', () => rl.close())

  // 会话状态在多次提交之间复用，整个交互过程共享同一份上下文。
  let state: LoopState | undefined
  let totalTurns = 0

  // 跑一次用户提交：把当前 state 传进去续聊，跑完把最新状态和轮数记回来。
  const runSubmission = async (userMessage: string): Promise<void> => {
    const result = await agentLoop(
      userMessage,
      model,
      { modelId, trustMode: false, maxTurns: 20 },
      {
        onTextDelta: (text) => process.stdout.write(text),
        onToolCall: (_id, name, input) => console.log(`\n[tool-call] ${name} ${JSON.stringify(input)}`),
        onToolProgress: (_id, message) => console.log(`[tool-progress] ${message}`),
        onToolResult: (_id, result, isError) =>
          console.log(`[tool-result${isError ? ' ERROR' : ''}] ${result.slice(0, 300)}`),
        onShellOutput: (chunk) => process.stdout.write(chunk),
        onUsageUpdate: (usage) =>
          console.log(`[usage] in=${usage.inputTokens} out=${usage.outputTokens} ctx=${usage.currentContextTokens}`),
        onContextCompressed: (summary) => console.log(`[compressed] ${summary.slice(0, 120)}`),
        onError: (error) => console.error(`\n[error] ${error.message}`),
        onMemoryWrite: (notice) => console.log(`[memory] ${notice}`),
        onAskPermission: async (call) => {
          const answer = await rl.question(`\n允许执行 ${call.toolName} ${JSON.stringify(call.input)} ? (y/n) `)
          return answer.trim().toLowerCase().startsWith('y') ? 'yes' : 'no'
        },
      },
      state,
    )
    state = result.state
    totalTurns += result.turnCount
  }

  console.log(`模型：${modelId}。直接输入内容开始对话，exit/quit 或 Ctrl+C 退出。`)

  // 命令行带了初始提示词就先跑这一轮，然后照常进入交互循环。
  if (initialPrompt) {
    await runSubmission(initialPrompt)
  }

  // 交互主循环：每读一行算一次新的用户提交，直到用户退出。
  while (true) {
    let line: string
    try {
      line = await rl.question('\n(tegent) > ')
    } catch {
      // readline 关闭（Ctrl+C / Ctrl+D）后 question 会 reject，直接退出循环。
      break
    }

    const text = line.trim()
    if (!text) continue
    if (text === 'exit' || text === 'quit') break

    await runSubmission(text)
  }

  if (state) {
    await saveSession(state, model)
    console.log(`\n\n--- 结束：共 ${totalTurns} 轮，消息数 ${state.messages.length} ---`)
  }
  rl.close()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
