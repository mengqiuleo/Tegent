#!/usr/bin/env node
// demo-toolkit 自带的 stdio MCP server：零依赖（仅 node: 内置模块）、
// newline-delimited JSON-RPC。tegent 的 McpClient 用官方 SDK 的
// StdioClientTransport 拉起本进程并完成 initialize 握手；这里只实现
// demo 所需的最小方法集：
//   initialize / notifications/*（静默）
//   tools/list / tools/call          —— 工具面：模型主动调用的动作
//   resources/list / resources/read  —— 资源面：模型按 URI 读取的只读资料
//   ping
// .mcp.json 里的 `${pluginDir}` 由 tegent 在启动前展开成插件根目录绝对路径。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const SERVER_INFO = { name: 'demo-toolkit-mcp', version: '0.1.0' }

const TOOLS = [
  {
    name: 'get-time',
    description: '返回服务器当前时间（本地格式、ISO 8601 和 Unix 毫秒时间戳）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'word-count',
    description: '统计一段文本的字符数、单词数和行数。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要统计的文本' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
]

// ── resources 面 ──────────────────────────────────────────────────────
// 与 tools（模型主动调用的“动作”）相对，resources 是服务器“拥有”的
// 只读资料，每个条目有稳定 URI。模型先用内置工具 listMcpResources
// 拿到清单，再用 readMcpResource 按 URI 取内容。这里把插件自带的
// markdown 文档暴露出去；`file` 是相对插件根目录的路径（私有字段，
// 不会出现在协议响应里）。
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const RESOURCES = [
  {
    uri: 'demo-toolkit://readme',
    name: '插件 README',
    description: 'demo-toolkit 的用途和目录结构说明。',
    file: 'README.md',
  },
  {
    uri: 'demo-toolkit://agents/code-reviewer',
    name: 'code-reviewer agent 定义',
    description: '内置 code-reviewer 子代理的 prompt 原文。',
    file: 'agents/code-reviewer.md',
  },
  {
    uri: 'demo-toolkit://agents/test-runner',
    name: 'test-runner agent 定义',
    description: '内置 test-runner 子代理的 prompt 原文。',
    file: 'agents/test-runner.md',
  },
]

function readResource(uri) {
  const r = RESOURCES.find((x) => x.uri === uri)
  if (!r) throw new Error(`unknown resource: ${uri}`)
  return {
    uri: r.uri,
    mimeType: 'text/markdown',
    text: readFileSync(path.join(PLUGIN_ROOT, r.file), 'utf8'),
  }
}

function callTool(name, args) {
  if (name === 'get-time') {
    const now = new Date()
    return { local: now.toString(), iso: now.toISOString(), epochMs: now.getTime() }
  }
  if (name === 'word-count') {
    const text = String(args?.text ?? '')
    const words = text.split(/\s+/).filter(Boolean).length
    return { characters: text.length, words, lines: text === '' ? 0 : text.split(/\r?\n/).length }
  }
  throw new Error(`unknown tool: ${name}`)
}

function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return {
        // 回显客户端请求的协议版本，握手总是兼容。
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
      }
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const result = callTool(msg.params?.name, msg.params?.arguments)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false }
    }
    case 'resources/list':
      return { resources: RESOURCES.map(({ file, ...rest }) => rest) }
    case 'resources/read':
      return { contents: [readResource(msg.params?.uri)] }
    case 'ping':
      return {}
    default:
      throw new Error(`method not found: ${msg.method}`)
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return // 坏行直接忽略；stdio 传输按行分帧，无法构造对应的响应对象。
  }
  // notification（没有 id）不需要响应；initialized 之外的通知同样静默。
  if (msg.id === undefined || msg.id === null) return

  let payload
  try {
    payload = { result: handle(msg) }
  } catch (err) {
    payload = { error: { code: -32601, message: err instanceof Error ? err.message : String(err) } }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }) + '\n')
})
