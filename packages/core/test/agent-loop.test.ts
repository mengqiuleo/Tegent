// agentLoop 冒烟测试：真实调用 DeepSeek，观察流式输出 / 工具调用 / 权限流程。
//
// 用法（在仓库根目录执行）：
//   1. 根目录建 .env 文件，写入 DEEPSEEK_API_KEY=sk-xxx
//   2. pnpm exec tsx packages/core/test/smoke.ts "你的指令"
//   3. 不带参数则跑默认的纯文本任务（不碰任何工具）
import 'dotenv/config'
import readline from 'node:readline/promises'

import { createDeepSeek } from '@ai-sdk/deepseek'

import { agentLoop, saveSession } from '../src/index.js'

const apiKey = process.env.DEEPSEEK_API_KEY
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY：请在仓库根目录的 .env 里配置后重试。')
  process.exit(1)
}

const deepseek = createDeepSeek({ apiKey })
const model = deepseek('deepseek-chat')

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

// 默认任务不涉及工具；想测工具就传参数，比如：
//   pnpm exec tsx packages/core/test/smoke.ts "读取 d:/a_project/log/Tegent/package.json，告诉我项目名"
//   pnpm exec tsx packages/core/test/smoke.ts "在 d:/a_project/log/Tegent/tmp/hello.txt 里写入 hi"
const prompt = process.argv[2] ?? '用一句话介绍你自己。'

console.log(`[task] ${prompt}\n`)

const { state, turnCount } = await agentLoop(
  prompt,
  model,
  { modelId: 'deepseek-chat', trustMode: false, maxTurns: 20 },
  {
    onTextDelta: (text) => process.stdout.write(text),
    onToolCall: (id, name, input) => console.log(`\n[tool-call] ${name} ${JSON.stringify(input)}`),
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
