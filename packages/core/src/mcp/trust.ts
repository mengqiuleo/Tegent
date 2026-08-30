// Git 仓库中的 `.tegent/config.json` 可以声明任意 `command`。
// 如果不做确认，用户只要克隆一个恶意仓库并启动 CLI，
// 就可能悄悄执行仓库配置中的命令。
// 因此在加载任何项目级 mcpServers 之前，都必须针对项目绝对路径
// 获得一次明确同意。
//
// 持久化文件为 ~/.tegent/trusted-projects.json，权限模式为 0600。
// 格式：{ trusted: [{ path: <absolute>, trustedAt: <ISO> }, ...] }
//
// 用户级配置 ~/.tegent/config.json 不经过该门控，因为它由用户自己维护，
// 默认视为已获得信任。
import fs from 'node:fs/promises'
import path from 'node:path'

import { userTeCodeDir } from '../utils.js'

/**
 * 
 * @returns `~/.tegent/trusted-projects.json`
 */
function trustedFile(): string {
  return path.join(userTeCodeDir(), 'trusted-projects.json')
}

interface TrustedEntry {
  path: string
  trustedAt: string
}

interface TrustedStore {
  trusted: TrustedEntry[]
}

/**
 * 规范化路径，以便跨平台稳定比较。
 *
 * 路径会先转为绝对路径并解析；Windows 的文件系统通常不区分大小写，
 * 所以 Windows 上额外转为小写，macOS/Linux 则保留原大小写。
 *
 * @param p 待规范化的路径。
 * @returns 用于比较的规范化路径。
 */
function normalize(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 
 * @returns TrustedEntry[] 返回 TrustedEntry 的数组（项目绝对路径的数组），如果文件不存在或格式不正确，则返回空数组。
 */
async function readStore(): Promise<TrustedStore> {
  try {
    const raw = await fs.readFile(trustedFile(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as TrustedStore).trusted)) {
      return parsed as TrustedStore
    }
  } catch {
    // 文件缺失或格式损坏时从空列表开始。
  }
  return { trusted: [] }
}

async function writeStore(store: TrustedStore): Promise<void> {
  await fs.mkdir(userTeCodeDir(), { recursive: true })
  // 采用临时文件加重命名的原子写入，避免进程中途被终止时留下半个 JSON。
  // 文件虽然很小，但不能因为写入中断就让用户失去 MCP 使用权限。
  const tmp = trustedFile() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  await fs.rename(tmp, trustedFile())
}

/**
 * 判断项目是否已经获得信任。
 *
 * @param projectPath 项目路径。
 * @returns 信任文件中存在同一路径时返回 `true`。
 */
export async function isProjectTrusted(projectPath: string): Promise<boolean> {
  const normalized = normalize(projectPath)
  const store = await readStore()
  return store.trusted.some((e) => normalize(e.path) === normalized)
}

/**
 * 将项目加入信任列表。
 *
 * 如果项目已经存在则不重复写入；新条目会保存绝对路径和 UTC 时间。
 *
 * @param projectPath 要信任的项目路径。
 */
export async function trustProject(projectPath: string): Promise<void> {
  const normalized = normalize(projectPath)
  const store = await readStore()
  if (store.trusted.some((e) => normalize(e.path) === normalized)) return
  store.trusted.push({ path: path.resolve(projectPath), trustedAt: new Date().toISOString() })
  await writeStore(store)
}

export type TrustChoice = 'trust' | 'skip' | 'exit'

/**
 * 询问用户是否信任项目的 MCP 配置。
 *
 * 调用方传入通用的 askUser 回调，因此信任对话可以沿用 agent loop
 * 的交互样式。提示中展示实际命令，用户可以审查即将执行的内容。
 *
 * @param projectPath 当前项目路径。
 * @param serverSummaries 要展示给用户的 mcp server 名称和命令摘要。
 * @param askUser 用于渲染选择对话框的回调。
 * @returns `trust` 表示同意，`skip` 表示本次跳过，`exit` 表示退出 CLI。
 */
export async function promptForTrust(
  projectPath: string,
  serverSummaries: Array<{ name: string; preview: string }>,
  askUser: (question: string, options: Array<{ label: string; description: string }>) => Promise<string>,
): Promise<TrustChoice> {
  const lines = serverSummaries.map((s) => `  • ${s.name}: ${s.preview}`).join('\n')
  const question =
    `This project wants to load ${serverSummaries.length} MCP server(s):\n` +
    lines +
    `\n\nThese commands will run on your machine. Trust only if you trust this project.`

  const answer = await askUser(question, [
    { label: 'Trust this project', description: 'Remember this choice. The project MCP servers will load.' },
    { label: 'Skip project MCP', description: 'Use only user-level mcpServers for this session. No write to disk.' },
    { label: 'Exit tegent', description: 'Close the CLI without loading any MCP servers.' },
  ])

  const lower = answer.toLowerCase()
  if (lower.startsWith('trust')) return 'trust'
  if (lower.startsWith('exit')) return 'exit'
  return 'skip'
}

/**
 * 生成信任对话中展示的单行服务器摘要。
 *
 * stdio 服务器展示完整命令和参数，HTTP 服务器展示 URL。
 * 这里故意不截断，因为用户需要看到完整内容后才能做出知情决定。
 *
 * @param config 可能是 stdio 或 HTTP 配置的最小字段集合。
 * @returns 可展示给用户的一行文本。
 */
export function buildServerPreview(config: { command?: string; args?: string[]; url?: string }): string {
  if (config.url) return config.url
  if (config.command) {
    const parts = [config.command, ...(config.args ?? [])]
    return parts.join(' ')
  }
  return '(invalid config)'
}
