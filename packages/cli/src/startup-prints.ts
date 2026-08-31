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
  for (const { envKey } of PROVIDER_DETECTION_ORDER) {
    // 按核心包定义的检测顺序列出所有可用 provider key。
    const provider = envKey // 从环境变量名推导 provider 标识，用于查找申请地址。
      .replace(/_API_KEY$/, '') // 去掉统一的 _API_KEY 后缀，得到 provider 原始名称。
      .replace('GOOGLE_GENERATIVE_AI', 'google') // 把 Google 的长环境变量前缀映射到 key URL 表里的短名称。
      .replace('MOONSHOT', 'moonshotai') // 把 Moonshot 的环境变量前缀映射到官网使用的 moonshotai 名称。
      .toLowerCase() // 转成小写，匹配 PROVIDER_KEY_URLS 的键名格式。
    const url = PROVIDER_KEY_URLS[provider] ?? '' // 获取 provider key 申请地址；缺失时用空字符串避免输出 undefined。
    console.error(`  ${envName(envKey.padEnd(32))} ${chalk.dim(url)}`) // 输出对齐后的环境变量名和对应申请地址。
  }
  console.error(
    // 输出 OpenAI-compatible 自定义端点的额外配置提示。
    `\n  ${envName('OPENAI_COMPATIBLE_API_KEY'.padEnd(32))} ${chalk.dim('(custom OpenAI-compatible endpoint)')}`, // 展示自定义兼容端点的 key 名称和说明。
  )

  const shell = detectShell() // 检测当前用户使用的 shell，以便生成正确的持久化命令。
  const restartHint: Record<ShellType, string> = {
    // 为需要重启终端才生效的 shell 准备额外提示。
    powershell: '# restart PowerShell, then run:', // PowerShell 使用 # 作为注释前缀，提示重启后再运行。
    cmd: ':: restart CMD, then run:', // CMD 使用 :: 作为注释形式，提示重启后再运行。
    zsh: '', // zsh 通常写入配置文件后可按用户习惯重新加载，这里不强制提示重启。
    bash: '', // bash 不追加重启提示，避免对不同启动文件策略做过度假设。
    fish: '', // fish 不追加重启提示，保持提示简短。
    sh: '', // sh 不追加重启提示，因为持久化方式可能因环境而异。
  } // 结束各 shell 的重启提示映射。
  console.error(`\nDetected shell: ${chalk.bold(shell)}`) // 输出检测到的 shell 名称。
  console.error('Persist it so you do not need to set it every session:\n') // 说明下面的命令用于持久保存环境变量。
  console.error(`  ${code(formatPersistCommand('ANTHROPIC_API_KEY', 'sk-ant-...', shell))}`) // 输出一个以 Anthropic key 为例的持久化命令。
  const hint = restartHint[shell] // 取出当前 shell 对应的重启提示，可能为空字符串。
  if (hint) console.error(`  ${comment(hint)}  ${code('tegent')}`) // 如果需要重启提示，就输出重启后运行 tegent 的建议。
  console.error(`\nAlternatively, put keys in a project-local ${chalk.bold('.env')} file (loaded from cwd upward).`) // 提示也可以把 key 放在项目本地 .env 中。
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
  console.error(`  ${dim(`(${shell})`)}  ${code(cmd)}\n`) // 输出当前 shell 名称和可复制的配置命令。
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
  const info = getSessionExitInfo() // 读取当前会话的退出信息；没有有效会话时返回空值。
  if (!info) return // 如果没有会话信息，直接跳过恢复提示。
  const key = info.taskSlug ? `${info.taskSlug}-${info.sessionId}` : info.sessionId // 优先拼接 slug 和 sessionId，否则只使用 sessionId。
  const cmd = chalk.cyan('/resume') 
  const dim = chalk.gray
  process.stdout.write(`${dim('Resume this session:')} start tegent and run ${cmd} (session: ${key})\n`) // 写到 stdout，输出最终的恢复提示。
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
  const current = VERSION // 读取当前 CLI 版本。
  if (current === '0.0.0-dev') return // 开发版本没有发布比较意义，直接跳过更新检查。

  // 先检查磁盘缓存，命中且未过期时避免访问网络。
  try {
    // 尝试读取并解析本地更新检查缓存。
    const raw = fs.readFileSync(UPDATE_CHECK_CACHE, 'utf-8') // 从缓存文件中读取 JSON 字符串。
    const cache = JSON.parse(raw) as { checkedAt: number; latest: string } // 将缓存内容解析为检查时间和最新版本。
    if (Date.now() - cache.checkedAt < ONE_DAY_MS) {
      // 如果距离上次检查不到一天，就认为缓存仍然有效。
      if (compareVersions(cache.latest, current) > 0) {
        // 如果缓存中的最新版本大于当前版本，说明有更新可用。
        printUpdateHint(current, cache.latest) 
      } 
      return // 缓存已经给出结果，无需继续访问 npm。
    } 
  } catch {

  }

  // 从 npm 获取最新版本号。
  const controller = new AbortController() // 创建 AbortController，用于给 fetch 设置超时中止。
  const timeout = setTimeout(() => controller.abort(), 3000) // 三秒后主动中止请求，避免启动提示长期挂起。
  try {
    // 发起网络请求并在成功时更新缓存。
    const res = await fetch(NPM_REGISTRY_URL, {
      // 请求 npm latest 接口，获取当前发布版本元数据。
      signal: controller.signal, // 把 abort signal 传给 fetch，确保超时能中止请求。
      headers: { Accept: 'application/json' }, // 声明期望返回 JSON 响应。
    }) // 结束 fetch 调用。
    if (!res.ok) return // 如果 HTTP 状态不是成功，静默跳过更新检查。
    const data = (await res.json()) as { version?: string } // 解析 registry 响应，只关心 version 字段。
    const latest = data.version // 取出 npm 返回的最新版本号。
    if (!latest) return // 如果响应里没有版本号，静默跳过。

    // 写入缓存，供 24 小时内的后续启动复用。
    fs.mkdirSync(path.dirname(UPDATE_CHECK_CACHE), { recursive: true }) // 确保缓存目录存在。
    fs.writeFileSync(UPDATE_CHECK_CACHE, JSON.stringify({ checkedAt: Date.now(), latest }), 'utf-8') // 写入本次检查时间和最新版本。

    if (compareVersions(latest, current) > 0) {
      // 比较 npm 最新版本和当前版本，判断是否需要提示更新。
      printUpdateHint(current, latest) // 如果存在新版，打印更新提示。
    }
  } finally {
    // 无论请求成功、失败还是提前返回，都执行清理。
    clearTimeout(timeout) // 清理超时定时器，避免留下不必要的事件句柄。
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
