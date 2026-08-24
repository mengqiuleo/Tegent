import readline from 'node:readline/promises'

import {
  agentLoop,
  createModelRegistry,
  getAvailableProviders,
  resolveModelId,
  saveSession,
} from '@tegent/core'

import { printNoApiKeyMessage } from './startup-prints.js'
import { loadEnvFile } from './utils/toolkit.js'

// 本步骤只跑通主链路：解析模型 → agentLoop → 保存会话（对齐 core/test/agent-loop.test.ts）。
// 参数解析、stdin 管道、Ink TUI、插件/MCP 等后续步骤再逐步加回来。
async function main() {
  loadEnvFile()

  // 位置参数即用户指令：tegent 帮我写个函数
  const prompt = process.argv.slice(2).join(' ').trim()
  if (!prompt) {
    console.error('用法：tegent <指令>    例：tegent 用一句话介绍你自己')
    process.exit(1)
  }

  // 一个可用的 provider 都没有，打印配置指引后退出。
  if (getAvailableProviders().length === 0) {
    // 退出码用 0：这只是配置提示，避免 pnpm dev 堆出 ELIFECYCLE 噪音。
    printNoApiKeyMessage()
    process.exit(0)
  }

  // 模型 id 形如 provider:model；依次看用户配置、环境变量里第一个可用的 provider。
  const modelId = resolveModelId()
  if (!modelId) {
    printNoApiKeyMessage()
    process.exit(0)
  }

  // 创建模型供应商注册表，并根据模型 id 拿到真正会调用的模型实例。
  const providerRegistry = createModelRegistry()
  const model = providerRegistry.languageModel(modelId)

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  const { state, turnCount } = await agentLoop(
    prompt,
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
  )

  await saveSession(state, model)
  rl.close()

  console.log(`\n\n--- 结束：${turnCount} 轮，消息数 ${state.messages.length} ---`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
