#!/usr/bin/env node
// SessionStart hook：从 stdin 读取事件 JSON，把一行会话记录追加到
// ${pluginDataDir}/sessions.log。不向 stdout 输出决策 JSON，即默认 allow ——
// 通知型 hook 只负责副作用。
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
  // stdin 不是合法 JSON 时照常记录，只是字段少一些。
}

const line = JSON.stringify({
  time: new Date().toISOString(),
  event: payload.event ?? 'SessionStart',
  cwd: payload.session?.cwd ?? '',
  modelId: payload.session?.modelId ?? '',
})

fs.mkdirSync(dataDir, { recursive: true })
fs.appendFileSync(path.join(dataDir, 'sessions.log'), line + '\n')
