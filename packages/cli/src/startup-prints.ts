import { Chalk } from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import { PROVIDER_DETECTION_ORDER, PROVIDER_KEY_URLS, USER_TEGENT_DIR } from '@tegent/core'
import { getSessionExitInfo } from './app.js'
import { detectShell, formatPersistCommand } from './shell.js'
import type { ShellType } from './shell.js'
import { VERSION } from './version.js'

const chalk = new Chalk({ level: process.stderr.isTTY ? 3 : 0 }) // 根据 stderr 是否是 TTY 决定是否启用彩色输出。

/**
 * 打印缺少 provider API key 时的启动错误提示。
 *
 * 会列出当前支持的 provider 环境变量、对应的 key 获取地址，并根据用户 shell
 * 给出一条可复制的持久化配置命令。
 */
export function printNoApiKeyMessage(): void {
  const code = (s: string) => chalk.cyan(s) // 定义代码片段样式，让可复制命令更醒目。
  const comment = (s: string) => chalk.gray(s) // 定义辅助说明样式，让提示层级更弱。
  const envName = (s: string) => chalk.yellow(s) // 定义环境变量名样式，方便用户快速扫到 key 名称。

  console.error(chalk.red.bold('Error: No API key found.') + '\n') // 输出红色加粗错误标题，并额外空一行。
  console.error('Set at least one provider API key via environment variable:\n') // 提示用户至少配置一个 provider 环境变量。
} 

/**
 * 打印缺少 WebSearch API key 时的非阻塞提示。
 *
 * WebFetch 在没有搜索 key 时仍可使用，因此这里只提示如何配置 Tavily 或 Brave，
 * 不阻止 CLI 继续启动。
 */
export function printNoWebSearchKeyHint(): void {
  const shell = detectShell()
  const yellow = chalk.yellow 
  const bold = chalk.bold
  const dim = chalk.gray 
  const code = chalk.cyan 

  console.error(yellow('Note:') + ' WebSearch is disabled — no search API key configured.') // 输出 WebSearch 不可用的说明。
  console.error(dim('  (WebFetch still works key-less; the hint is only for web search.)')) // 说明 WebFetch 不受该 key 缺失影响。
  console.error('  Pick either (both free, signup only):') // 提示用户任选一个搜索服务 key 即可。
  console.error(`    ${bold('TAVILY_API_KEY')}  ${dim('1000/month — https://tavily.com')}`) // 输出 Tavily key 名和免费额度说明。
  console.error(`    ${bold('BRAVE_API_KEY')}   ${dim('2000/month — https://api.search.brave.com')}`) // 输出 Brave key 名和免费额度说明。

  const cmd = formatPersistCommand('TAVILY_API_KEY', 'tvly-...', shell) // 生成一个以 Tavily 为例的持久化环境变量命令。
  console.error(`  ${dim(`(${shell})`)}  ${code(cmd)}\n`)
}

/**
 * 在 Ink 已卸载且终端已经复位之后，打印一条会话恢复提示。
 *
 * 恢复入口是交互模式内的 /resume 斜杠命令（打开会话选择器）；
 * 这里同时打印会话标识，方便用户在选择器列表里认出目标会话。
 * 如果有 taskSlug，就优先使用带 slug 前缀的 id，因为它在列表里更容易阅读。
 * 如果没有 slug，例如首条消息完全由 CJK 字符组成，则回退到裸 sessionId。
 *
 * 当当前会话还没有任何消息时会抑制输出，避免指向一个空的 jsonl 文件。
 */
export function printResumeHint(): void {
  const info = getSessionExitInfo()
  if (!info) return
  const key = info.taskSlug ? `${info.taskSlug}-${info.sessionId}` : info.sessionId
  const cmd = chalk.cyan('/resume') 
  const dim = chalk.gray
  process.stdout.write(`${dim('Resume this session:')} start tegent and run ${cmd} (session: ${key})\n`)
} 

// ── 启动阶段更新检查 ──────────────────────────────────────────────────

const UPDATE_CHECK_CACHE = path.join(USER_TEGENT_DIR, 'cache', 'update-check.json') // 定义更新检查缓存文件路径。
const ONE_DAY_MS = 24 * 60 * 60 * 1000 // 定义一天的毫秒数，用于判断缓存是否过期。
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@tegent/cli/latest' // 定义 npm registry latest 接口地址。

/**
 * 比较两个三段式语义版本号。
 *
 * @param a - 左侧版本号。
 * @param b - 右侧版本号。
 * @returns 大于 0 表示 a 较新，小于 0 表示 b 较新，等于 0 表示相同。
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number) 
  const pb = b.split('.').map(Number) 
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0) 
    if (diff !== 0) return diff
  } 
  return 0 
}

/**
 * 执行启动后即发即忘的版本更新检查。
 * 只对比版本号并提示用户，不会帮用户自动更新。
 * 对比策略为：先检查本地缓存，缓存命中且未过期时直接使用缓存结果；否则访问 npm registry 获取最新版本。
 * 通过 24 小时磁盘缓存减少 npm registry 请求，并在发现新版时向 stderr 打印一行提示。
 * 该函数绝不向外抛错，所有网络、解析和文件缓存失败都会被静默吞掉。
 */
export async function checkForUpdate(): Promise<void> {
  if (!process.stderr.isTTY) return // 如果 stderr 不是交互终端，跳过提示，避免污染管道输出。
  const current = VERSION 
  if (current === '0.0.0-dev') return 

  try {
    const raw = fs.readFileSync(UPDATE_CHECK_CACHE, 'utf-8')
    const cache = JSON.parse(raw) as { checkedAt: number; latest: string }
    if (Date.now() - cache.checkedAt < ONE_DAY_MS) {
      if (compareVersions(cache.latest, current) > 0) {
        printUpdateHint(current, cache.latest) 
      } 
      return
    } 
  } catch {

  }

  const controller = new AbortController() 
  const timeout = setTimeout(() => controller.abort(), 3000) 
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    }) 
    if (!res.ok) return 
    const data = (await res.json()) as { version?: string } 
    const latest = data.version
    if (!latest) return

    fs.mkdirSync(path.dirname(UPDATE_CHECK_CACHE), { recursive: true }) 
    fs.writeFileSync(UPDATE_CHECK_CACHE, JSON.stringify({ checkedAt: Date.now(), latest }), 'utf-8')

    if (compareVersions(latest, current) > 0) {
      printUpdateHint(current, latest)
    }
  } finally {
    clearTimeout(timeout)
  }
}


function printUpdateHint(current: string, latest: string): void {
  console.error(
    chalk.yellow('Update available:') + 
      ` ${chalk.gray(current)} → ${chalk.green(latest)}` + 
      chalk.gray('  Run ') + 
      chalk.cyan('pnpm add -g @tegent/cli') + 
      chalk.gray(' to update.'),
  )
} 
