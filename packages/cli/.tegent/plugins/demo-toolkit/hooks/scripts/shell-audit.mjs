#!/usr/bin/env node
// PostToolUse hook（matcher: shell）：把 agent 执行过的 shell 命令追加到
// ${pluginDataDir}/shell-audit.log。PostToolUse 不参与决策，因此不输出决策 JSON。
import fs from 'node:fs'
import path from 'node:path'

const dataDir = process.argv[2]
if (!dataDir) process.exit(0)

let payload = {}
try {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
} catch {
  // 无法解析时保持退出码 0，避免 hook 失败干扰主流程。
}

const tool = payload.tool ?? {}
const line = JSON.stringify({
  time: new Date().toISOString(),
  tool: tool.name ?? 'shell',
  command: typeof tool.args?.command === 'string' ? tool.args.command : JSON.stringify(tool.args ?? {}),
  isError: tool.isError === true,
})

fs.mkdirSync(dataDir, { recursive: true })
fs.appendFileSync(path.join(dataDir, 'shell-audit.log'), line + '\n')
