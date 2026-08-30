import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useApp } from 'ink'

import {
  MODEL_ALIASES,
  PROVIDER_MODELS,
  createModelRegistry,
  estimateTokenCount,
  expandCommandBody,
  getAutoMemory,
  getAvailableProviders,
  getContextWindow,
  listSessions,
  loadSession,
  pickLatestSession,
  resolveModelId,
  saveUserConfig,
  wrapActivatedSkill,
} from '@tegent/core'
import type {
  AgentOptions,
  KnowledgeFact,
  LanguageModel,
  LoadedSession,
  SkillDefinition,
  TokenUsage,
} from '@tegent/core'

import { VERSION } from '../../version.js'
import { createDoctorCommandHandler } from '../commands/doctor.js'
import { createMcpCommandHandler } from '../commands/mcp.js'
import { createPluginCommandHandler } from '../commands/plugin.js'
import { createSkillCommandHandler } from '../commands/skill.js'
import { useAgent } from '../hooks/use-agent.js'
import { parseBooleanArg } from '../utils.js'
import { getHeaderRowCount } from './AppHeader.js'
// import { ChatInput } from './ChatInput.js'
import { ChatInput } from './ChatInputInk.js'

interface AppProps {
  model: LanguageModel
  options: AgentOptions
  /**
   * `xc --continue` 预先加载好的会话。
   *
   * 首次渲染时会用它恢复 agent 状态，这样用户还没发送新消息前，
   * 历史消息就已经出现在滚动区里。全新启动时为 null。
   */
  initialSession?: LoadedSession | null
  /**
   * 是否在挂载后立即打开恢复会话选择器。
   *
   * 值为 `pick` 时，对应 `xc --resume` 不带 id 的启动路径。等 Ink 准备好后，
   * 这里会复用和 `/resume` 相同的选择器逻辑。
   */
  resumeIntent?: 'pick' | null
  onCleanupReady?: (fn: () => Promise<void>) => void
  /**
   * 向 Ink 卸载后的恢复提示提供一份实时会话快照。
   *
   * app.tsx 会注册这个 getter；index.ts 的 gracefulShutdown 在终端复位后调用它，
   * 从而把 `xc --resume <id>` 提示打印在 shell prompt 区域，方便用户复制。
   */
  onSessionInfoReady?: (getter: () => { sessionId: string; taskSlug: string; messageCount: number } | null) => void
}

/**
 * 内置 slash command 列表。
 *
 * 这份静态列表用于 `/help` 文本和 Tab 补全；skill 注册表里的命令会在运行时
 * 动态追加，不写死在这里。
 */
export const SLASH_COMMANDS = [
  { name: '/help', description: 'Show this help message' },
  {
    name: '/model',
    description: 'Pick a model (no-arg = interactive) — choice is saved',
    argumentHint: '[model-id]',
  },
  {
    name: '/thinking',
    description: 'Toggle extended thinking on/off (no-arg = show status) — saved',
    argumentHint: '[on|off]',
  },
  {
    name: '/plan',
    description: 'Toggle plan mode on/off (no-arg = show status) — saved',
    argumentHint: '[on|off]',
  },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Manually compress context' },
  { name: '/resume', description: 'Pick a past session in this project to resume', argumentHint: '[id]' },
  {
    name: '/rewind',
    description: 'Roll back files + conversation to a previous user message (no-arg = picker)',
    argumentHint: '[checkpoint-id]',
  },
  { name: '/init', description: 'Initialize project knowledge' },
  { name: '/review', description: 'Review a pull request (no-arg = list open PRs)', argumentHint: '[PR]' },
  { name: '/usage', description: 'Show current-session token usage (input/output/cache)' },
  { name: '/usage-history', description: 'List past sessions in this project' },
  { name: '/memory', description: 'Show auto-memory entries (project + user)' },
  {
    name: '/mcp',
    description: 'Manage MCP servers',
    // 在输入 `/mcp ` 或 `/mcp <prefix>` 时显示子命令菜单。
    // 顺序和 handleMcp 内部 switch 保持一致，确保菜单覆盖所有分支。
    subcommands: [
      { name: 'list', description: 'List configured MCP servers' },
      { name: 'tools', description: 'List tools from connected servers (optionally filter by server)' },
      { name: 'add', description: 'Add a new MCP server (stdio or http) to user / project config' },
      { name: 'add-json', description: 'Add an MCP server from a raw JSON config object' },
      { name: 'remove', description: 'Remove an MCP server from config' },
      { name: 'refresh', description: 'Reload mcpServers from disk and reconnect' },
    ],
  },
  {
    name: '/skill',
    description: 'Manage skills',
    subcommands: [
      { name: 'install', description: 'Fetch and install a skill from a URL' },
      { name: 'list', description: 'List installed skills (with on/off state)' },
      { name: 'refresh', description: 'Re-scan skills dirs and apply changes without restart' },
      { name: 'disable', description: 'Disable a skill (kept on disk; run /skill refresh to apply now)' },
      { name: 'enable', description: 'Re-enable a previously disabled skill' },
      { name: 'uninstall', description: 'Delete a skill directory from disk' },
    ],
  },
  {
    name: '/plugin',
    description: 'Manage plugins (bundled skills / agents / mcp / hooks)',
    // 子命令顺序镜像 handlePlugin 的 switch。
    // `marketplace` 本身是一个二级命令组，下面还有 add/remove/list/refresh/info。
    subcommands: [
      { name: 'list', description: 'List installed plugins (with enable state + source)' },
      { name: 'info', description: "Show a plugin's manifest, contributions, and hooks" },
      {
        name: 'install',
        description: 'Install a plugin from <name@marketplace>, git, github:owner/repo, or local path',
      },
      { name: 'uninstall', description: 'Remove a plugin (cache + settings entry; data dir preserved)' },
      {
        name: 'enable',
        description: 'Enable a plugin (writes settings — restart for full effect; --scope=user|project)',
      },
      { name: 'disable', description: 'Disable a plugin without uninstalling (--scope=user|project)' },
      { name: 'search', description: 'Search subscribed marketplaces by keyword' },
      { name: 'update', description: 'Reinstall a plugin from its recorded source' },
      { name: 'refresh', description: 'Live-reload plugins + skills/agents/commands/hooks/MCP servers' },
      { name: 'doctor', description: 'Show plugin load errors and integration warnings' },
      { name: 'marketplace', description: 'Manage marketplace subscriptions (add | remove | list | refresh | info)' },
    ],
  },
  { name: '/doctor', description: 'Diagnose environment, API keys, MCP servers, plugins, and agents' },
  { name: '/exit', description: 'Exit (flushes session)' },
] as const

/**
 * 把 TokenUsage 渲染成 `/usage` 使用的 markdown 文本块。
 *
 * cacheReadTokens 是 inputTokens 的子集，所以缓存命中率按
 * cacheReadTokens / inputTokens 计算；这正好对应用户关心的问题：
 * “我这次发出去的 prompt 里，有多少被缓存命中了？”
 *
 * @param usage - 要展示的 token 用量。
 * @param modelId - 该用量对应的模型 id。
 * @param source - 用量来源：当前会话、最近快照或历史会话。
 * @param sessionName - 可选的会话展示名。
 * @returns 格式化后的 markdown 用量报告。
 */
function formatUsageReport(
  usage: TokenUsage,
  modelId: string,
  source: 'live' | 'snapshot' | 'history',
  sessionName?: string,
): string {
  const fmt = (n: number) => n.toLocaleString('en-US')
  const hitRatio = usage.inputTokens > 0 ? `${((usage.cacheReadTokens / usage.inputTokens) * 100).toFixed(1)}%` : 'n/a'
  const headerMap = {
    live: '**Usage** (current session)',
    snapshot: '**Usage** (last session — no turns yet)',
    history: '**Usage** (history)',
  }
  const header = headerMap[source]
  const lines = [header, '']
  if (sessionName) lines.push(`- Session:         ${sessionName}`)
  lines.push(
    `- Model:           ${modelId}`,
    `- Input tokens:    ${fmt(usage.inputTokens)}`,
    `- Output tokens:   ${fmt(usage.outputTokens)}`,
    `- Cache read:      ${fmt(usage.cacheReadTokens)}  (${hitRatio} of input)`,
    `- Cache creation:  ${fmt(usage.cacheCreationTokens)}`,
    `- Total:           ${fmt(usage.totalTokens)}`,
    '',
    'Cache numbers depend on the provider — DeepSeek/Moonshot/Qwen may report 0 even when prefix caching is active.',
  )
  return lines.join('\n')
}

/**
 * 为恢复的会话生成“上下文已使用 X%，建议 /compact”的提示。
 *
 * 如果恢复会话上一次记录的输入 token 数，或基于字符估算出的 token 数，
 * 已经超过模型上下文窗口的 60%，就返回提示文本；否则返回 null。
 * 优先使用 provider 上次真实返回的 `tokenUsage.inputTokens`，如果没有记录
 * 用量行（例如首轮尚未完成就被中断），再回退到字符估算值。
 *
 * 阈值刻意低于自动压缩触发线 80%，这样用户在下一轮可能触发自动压缩前，
 * 还有机会主动执行 `/compact`。
 *
 * @param tokens - 上次真实记录的 input tokens；没有记录时为 null。
 * @param estimatedTokens - 根据消息内容估算的 token 数。
 * @param modelId - 用于查询上下文窗口大小的模型 id。
 * @returns 超过阈值时返回提示文本，否则返回 null。
 */
function compactionHintForResume(tokens: number | null, estimatedTokens: number, modelId: string): string | null {
  const window = getContextWindow(modelId)
  const used = Math.max(tokens ?? 0, estimatedTokens)
  if (used === 0) return null
  const pct = (used / window) * 100
  if (pct < 60) return null
  return `\n\n_Context is at **${pct.toFixed(0)}%** of the ${window.toLocaleString('en-US')}-token window — consider \`/compact\` before continuing, or it'll auto-compress on the next turn._`
}

/**
 * 把时间戳格式化成适合选择器阅读的相对时间。
 *
 * 输出类似 `5m ago`、`2h ago`、`3d ago`；超过天级展示范围后回退成日期。
 * 会话选择器会把它放在每条预览旁边，相比 ISO 时间戳更适合快速扫出
 * “我上周做的那条会话”。
 *
 * @param epochMs - 毫秒级时间戳。
 * @returns 相对时间或日期字符串。
 */
function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 48) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 14) return `${days}d ago`
  return new Date(epochMs).toISOString().slice(0, 10)
}

// 原来的 formatUsageHistory 已经被组件内部的交互式 handleUsageHistory 选择器取代。
// 详情见下方 handleUsageHistory()。

/**
 * 生成 `/help` 输出文本。
 *
 * 会合并内置命令、skill 注册表贡献的命令，以及用户/项目/插件提供的 markdown 命令。
 *
 * @param skillCommands - 已加载 skill 暴露的命令。
 * @param fileCommands - 文件型 slash commands。
 * @returns 最终展示给用户的帮助文本。
 */
function buildHelpText(
  skillCommands: readonly { name: string; description: string }[],
  fileCommands: readonly { name: string; description?: string }[],
): string {
  const allCommands = [
    ...SLASH_COMMANDS,
    ...skillCommands.map((s) => ({ name: `/${s.name}`, description: s.description })),
    // 用户、项目、插件提供的 markdown 命令。
    // 这些命令的 description 可选，因为没有 frontmatter 的命令文件也是合法的。
    ...fileCommands.map((c) => ({ name: `/${c.name}`, description: c.description ?? '' })),
  ]
  return (
    `TEGENT v${VERSION}\n\n` +
    allCommands.map((c) => `  ${c.name.padEnd(16)} ${c.description}`).join('\n') +
    `\n\nModel aliases: ${Object.keys(MODEL_ALIASES).join(', ')}` +
    `\nKeyboard: Esc to interrupt the current turn · ${process.platform === 'darwin' ? '⌃C' : 'Ctrl+C'} (twice) to exit`
  )
}

/**
 * `/init` 的 prompt 正文。
 *
 * 它会作为用户消息提交给 agent，让 agent 用完整工具链（Read/Glob/Grep/Edit/Write）
 * 检查代码库，再基于真实证据编写 AGENTS.md，而不是套静态模板。
 *
 * 相比 Claude Code 旧版 OLD_INIT，这里有几个设计取舍：
 * - 目标文件是 AGENTS.md，这是本项目约定，而不是 CLAUDE.md。
 * - 明确提到 AGENTS.local.md 是个人层，避免模型把用户个人偏好
 *   （沙箱 URL、角色、语气等）写进团队共享文件。
 * - 携带 NEW_INIT 的极简规则：如果删掉某一行不会让 agent 犯错，就删。
 *   这能显著避免 AGENTS.md 膨胀，因为该文件每轮都会被读取。
 * - 要求模型用 Edit 合并已有 AGENTS.md，而不是覆盖，
 *   这样用户手写内容在重复执行 /init 时不会丢失。
 */
const INIT_PROMPT = `Please analyze this codebase and create an AGENTS.md file at the project root. AGENTS.md is loaded into every TEGENT (\`xc\`) session, so future agents will read it as their primary project context.

What to include:
1. Common commands the agent should prefer: how to build, lint, run tests, run a single test. Only include what's non-obvious from manifest files.
2. High-level architecture that requires reading multiple files to understand — module boundaries, key data flows, the "big picture" a new contributor needs.
3. Important conventions that DIFFER from language defaults (e.g. "prefer type over interface", "errors live in errors.ts, never inline").
4. Non-obvious gotchas, required env vars, repo etiquette (branch naming, commit style).

Usage notes:
- If AGENTS.md already exists, read it first and use the Edit tool to merge improvements rather than overwriting — preserve the user's hand-written content.
- Apply the minimalism test to every line: "If I removed this line, would the agent make a mistake?" If no, cut it. AGENTS.md is read every turn — bloat costs tokens forever.
- If a README.md exists, mine it for project overview / commands / setup steps. If \`.cursor/rules/\`, \`.cursorrules\`, \`.github/copilot-instructions.md\`, \`.windsurfrules\`, or \`.clinerules\` exist, fold the important parts in.
- Do not list every file or component — those are discoverable via Glob/Grep. Focus on what's NOT discoverable.
- Do not invent sections like "Common Development Tasks", "Tips for Development", or "Support and Documentation" — only write what's expressly grounded in files you've read.
- Do not include generic engineering advice ("write clean code", "add tests"), standard language conventions, or obvious commands ("npm test", "cargo test").
- Personal preferences (the user's role, sandbox URLs, communication style) belong in AGENTS.local.md — gitignored, loaded alongside AGENTS.md. Mention this only if the user has clearly personal context to record; otherwise leave AGENTS.local.md alone.

Prefix the file with:

\`\`\`
# AGENTS.md

This file is loaded into the agent's context at the start of every session. Keep it concise — the agent reads it every turn.
\`\`\`

When you finish, summarize what you wrote (or what you changed if updating an existing file) in a few bullets so the user can review.`

/**
 * 构造 `/review` 使用的 prompt 正文。
 *
 * 该模板对齐 Claude Code 本地 /review：引导 agent 直接调用 `gh`，
 * 然后输出结构化代码评审。不带参数的分支被刻意收紧：
 * 如果 `gh pr list` 为空，就说明没有 open PR，直接停止。
 * 否则模型很容易额外花很多工具调用去检查 gh auth、分支、未提交 diff 等，
 * 再转去评审它碰巧发现的东西，既浪费也不是用户请求。
 * “直接用 gh，不要 wrappers”这句是为了抑制模型幻觉出 rtk、gh-aux 等包装命令。
 *
 * @param args - `/review` 后面的原始参数，通常是 PR 编号，也可能为空。
 * @returns 提交给 agent 的 review prompt。
 */
const REVIEW_PROMPT = (args: string) => `You are an expert code reviewer. Use \`gh\` directly — no wrappers.

If no PR number is provided in the args:
1. Run \`gh pr list\` to show open PRs.
2. If the output is empty, reply with exactly: "No open PRs in this repository — re-run \`/review <number>\` to review a specific PR." and stop.
3. Otherwise, list the open PRs and ask the user which to review. Stop and wait.
4. Do NOT investigate further — no \`gh auth\`, no branch / diff / status checks, no reviewing uncommitted changes. The user will re-invoke /review.

If a PR number is provided:
1. Run \`gh pr view <number>\` to get PR details.
2. Run \`gh pr diff <number>\` to get the diff.
3. Write a concise but thorough review with clear sections and bullet points covering:
   - Overview of what the PR does
   - Code correctness
   - Project conventions
   - Performance implications
   - Test coverage
   - Security considerations
   - Specific suggestions and risks

PR number: ${args}`

/**
 * 交互式 CLI 的根 React 组件。
 *
 * App 负责把 core 层的 agent 状态、slash command 处理器、会话恢复、
 * 主题设置、权限弹窗和最终 ChatInput 渲染连接起来。真正的终端绘制由
 * ChatInput 接管，App 更像是“状态和命令调度层”。
 *
 * @param props - App 启动所需的模型、agent 选项和恢复意图。
 * @returns 渲染完整终端交互界面的 ChatInput。
 */
export function App({
  model,
  options,
  initialSession,
  resumeIntent,
  onCleanupReady,
  onSessionInfoReady,
}: AppProps) {
  const { exit } = useApp()
  const {
    state,
    submit,
    resolvePermission, // 解析队首权限请求
    resolveQuestion, // 解析当前 pendingQuestion
    abort,
    cleanup, // 保存会话并退出
    clear,
    compact, // 手动压缩上下文
    resume,
    rewind,
    getCheckpoints,
    getSessionInfo,
    switchModel,
    setThinking,
    getThinking,
    invalidateSystemPromptCache, // 清掉 system prompt cache
    addInfoMessage,
    addUserMessage,
    echoCommand, // 追加命令回显
    addCommandMessage, // 追加命令消息
    addCommandResult, // 追加命令结果
    askQuestion, // 弹出选择器问题
    setPermissionMode, // 直接设置权限模式
  } = useAgent(model, options, initialSession)

  // 每次 `/skill refresh` 原地修改注册表时递增。
  // 注册表对象本身的引用在 refresh 前后保持不变，reload() 只是重写内部 map。
  // 因此 React 需要一个显式依赖，才能知道可见 skill 列表已经变化；
  // 否则下面 memo 出来的 skillCommands 会一直停留在旧快照。
  const [skillRegistryVersion, setSkillRegistryVersion] = useState(0)

  // 从 options.skillRegistry 派生出的 skill 命令列表。
  // 当 /skill refresh 推高版本号后重新计算，让 Tab 补全和 /help 无需重启即可看到新 skill。
  const skillCommands = useMemo(
    () => (options.skillRegistry ? options.skillRegistry.list() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skillRegistryVersion],
  )

  // 基于文件的 slash commands，包括用户、项目和插件提供的 markdown 命令文件。
  // 它和 skills 共用同一个版本计数；/plugin refresh 重载两个注册表后也会触发刷新。
  const fileCommands = useMemo(
    () => (options.commandRegistry ? options.commandRegistry.list() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skillRegistryVersion],
  )

  // 合并后的命令列表：内置命令 + 已加载 skill + 文件型命令，主要提供给 Tab 补全。
  const allCommands = useMemo(
    () => [
      ...SLASH_COMMANDS,
      ...skillCommands.map((s) => ({ name: `/${s.name}`, description: s.description })),
      ...fileCommands.map((c) => ({ name: `/${c.name}`, description: c.description ?? '' })),
    ],
    [skillCommands, fileCommands],
  )

  /**
   * 等待注入的 skill。
   *
   * 当用户只输入 `/skillname` 且没有追加具体问题时设置它。这样不会因为单独的
   * skill XML 立即触发一次 AI 回复；skill 内容会被前置到下一条非 slash command
   * 用户消息中。执行 `/clear` 或成功消费后会清空。
   */
  const pendingSkillRef = useRef<SkillDefinition | null>(null)

  // 输入框下方的临时单行提示，渲染在 ChatInput footer 区域，
  // 和 plan mode / accept edits 等状态提示共享位置。
  // 目前只用于 “Press Ctrl+C again to exit” 双击退出提醒。
  // 这里刻意保持为单一窄槽位，方便未来其他短提示复用；位置对齐 Claude Code 的 PromptInputFooter。
  const [notice, setNotice] = useState<string | null>(null)
  // 最近一次 Ctrl+C 的时间戳。
  // 如果下一次 Ctrl+C 落在 arm window 内，就真正退出；
  // 如果已经超时，则只是重新布防，并在必要时取消当前运行中的 turn。
  // 行为对齐 Claude Code 的 `useExitOnCtrlCD` 两秒窗口。
  const ctrlCArmedAtRef = useRef(0)
  const ctrlCArmWindowMs = 2000
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // arm window 过期后自动清除 notice，避免退出提示长期停留。
  useEffect(() => {
    if (!notice) return
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), ctrlCArmWindowMs)
    return () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = null
      }
    }
  }, [notice])

  /**
   * 处理 Ctrl+C：双击退出，单击取消当前 turn 并展示退出提示。
   *
   * 行为对齐 Claude Code：
   * 空闲 + 第一次按下：显示 “Press Ctrl+C again to exit”，开启 2 秒窗口。
   * 空闲 + 第二次按下：退出。
   * 加载中 + 第一次按下：中断当前 turn，显示提示，开启 2 秒窗口。
   * 加载中 + 第二次按下：退出。
   *
   * arm window 会自动过期，上面的 effect 会负责清除 notice。
   */
  const handleCtrlC = useCallback(() => {
    const now = Date.now()
    const armed = now - ctrlCArmedAtRef.current < ctrlCArmWindowMs
    if (armed) {
      // 在窗口期内第二次按下，说明用户确认要退出。
      // exit 会触发 Ink 卸载，并经由 onCleanupReady 走 gracefulShutdown。
      exit()
      return
    }
    ctrlCArmedAtRef.current = now
    if (state.isLoading) {
      abort()
    }
    setNotice('Press Ctrl+C again to exit')
  }, [exit, abort, state.isLoading])

  // 注册清理函数，供外层 SIGINT / graceful exit 调用。
  useEffect(() => {
    onCleanupReady?.(cleanup)
  }, [cleanup]) // eslint-disable-line react-hooks/exhaustive-deps

  // 注册退出后的会话信息 getter。
  // index.ts 会在 resetTerminal 之后调用它，向 shell 区域打印 `Resume: xc --resume <id>`。
  // getSessionInfo 直接读取 loopStateRef，因此跨渲染保持稳定，挂载时注册一次即可。
  useEffect(() => {
    onSessionInfoReady?.(getSessionInfo)
  }, [getSessionInfo]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 执行 `/resume`：列出当前项目所有历史会话，并让用户选择一个恢复。
   *
   * 复用 askQuestion 选择器，也就是 `/model` 和 askUser tool 使用的同一个对话框，
   * 因此天然获得一致的键盘导航、Other 自由输入逃生口和 Esc 取消行为。
   *
   * 选择器标签格式是：`[短 prompt] <相对时间> · N msgs`。
   * 每个选项的 description 会带上绝对文件路径，方便用户确认自己选择的是哪个会话。
   * 用户选中后，调用 `loadSession` 完整读取文件，再交给 `useAgent.resume`
   * 热替换 agent 状态。这里包成 useCallback，是为了给挂载 effect 稳定引用，
   * 避免 react-hooks lint 对组件体后方函数声明的闭包新鲜度发出警告。
   */
  const handleResume = useCallback(async () => {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      addInfoMessage(
        '**No past sessions found in this project.** Sessions are saved automatically — start working and one will appear here next time.',
      )
      return
    }
    const choices = sessions.slice(0, 30).map((s) => {
      const preview = (s.firstPrompt || '(empty)').slice(0, 60).replace(/\s+/g, ' ').trim()
      const ago = formatRelativeTime(s.mtime)
      const totalTokens = s.tokenUsage ? s.tokenUsage.totalTokens.toLocaleString('en-US') : '—'
      return {
        label: `${preview}  ·  ${ago}`,
        description: `${s.modelId}  ·  ${totalTokens} tokens  ·  ${s.sessionId}`,
        filePath: s.filePath,
      }
    })
    const answer = await askQuestion(
      `Pick a session to resume (${sessions.length} total in this project):`,
      choices.map((c) => ({ label: c.label, description: c.description })),
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      // 用户在 Other 里输入了自由文本时，这里按取消处理。
      // 不对 session id 做模糊匹配；当前支持的选择方式就是 picker。
      addInfoMessage('Resume cancelled.')
      return
    }
    const loaded = await loadSession(picked.filePath)
    if (!loaded) {
      addInfoMessage(`Failed to load session at ${picked.filePath}. The file may be corrupted.`)
      return
    }
    resume(loaded)
    const hint =
      compactionHintForResume(
        loaded.tokenUsage.inputTokens || null,
        estimateTokenCount(loaded.messages),
        loaded.modelId,
      ) ?? ''
    addInfoMessage(
      `**Resumed session:** ${loaded.firstPrompt.slice(0, 80) || '(no first prompt)'}\n\nContinuing from ${loaded.messages.length} message${loaded.messages.length === 1 ? '' : 's'}.${hint}`,
    )
  }, [addInfoMessage, askQuestion, resume])

  /**
   * 执行 `/rewind` 的选择器和回滚逻辑。
   *
   * 带参数时，直接跳到命名 checkpoint，支持完整 id 或 sha1 风格前缀。
   * 不带参数时，按新到旧列出当前会话的所有 checkpoint，并用触发 checkpoint
   * 的用户 prompt 作为预览。如果还没有任何 checkpoint，例如第一轮用户消息尚未落地，
   * 选择器会安静地提示并返回。
   */
  const handleRewind = useCallback(
    async (arg: string) => {
      const checkpoints = getCheckpoints()
      if (checkpoints.length === 0) {
        addInfoMessage(
          '**No rewind points yet.** A checkpoint is taken at the start of every user message — type something first, then `/rewind` will offer it.',
        )
        return
      }

      // 直接参数路径：先做精确 ckptId 匹配，再做前缀匹配。
      // 不做模糊匹配，因为歧义前缀可能静默回滚到错误位置。
      let pickedId: string | null = null
      if (arg) {
        const exact = checkpoints.find((c) => c.ckptId === arg)
        if (exact) pickedId = exact.ckptId
        else {
          const prefixed = checkpoints.filter((c) => c.ckptId.startsWith(arg))
          if (prefixed.length === 1) pickedId = prefixed[0]!.ckptId
          else if (prefixed.length > 1) {
            addInfoMessage(
              `Ambiguous checkpoint prefix \`${arg}\` (${prefixed.length} matches). Run \`/rewind\` and pick.`,
            )
            return
          } else {
            addInfoMessage(`No checkpoint matches \`${arg}\`. Run \`/rewind\` and pick.`)
            return
          }
        }
      }

      if (!pickedId) {
        // 新的 checkpoint 放在前面，符合用户“退一步/两步”的直觉。
        // 最近的决策点应该出现在列表顶部。
        const ordered = [...checkpoints].reverse()
        const choices = ordered.slice(0, 30).map((c) => {
          const preview = (c.userPrompt || '(empty prompt)').slice(0, 60).replace(/\s+/g, ' ').trim()
          const ago = formatRelativeTime(new Date(c.ts).getTime())
          return {
            label: `${preview}  ·  ${ago}`,
            description: `${c.ckptId}  ·  message #${c.messageCount}`,
            ckptId: c.ckptId,
          }
        })
        const answer = await askQuestion(
          `Pick a checkpoint to rewind to (${ordered.length} total in this session):`,
          choices.map((c) => ({ label: c.label, description: c.description })),
        )
        const picked = choices.find((c) => c.label === answer)
        if (!picked) {
          addInfoMessage('Rewind cancelled.')
          return
        }
        pickedId = picked.ckptId
      }

      const result = await rewind(pickedId)
      if (!result.ok) {
        addInfoMessage(`**Rewind failed:** ${result.reason}`)
        return
      }
      addInfoMessage(
        `**Rewound to:** ${result.preview || '(empty prompt)'}\n\nFiles and conversation restored. Continue from here.`,
      )
    },
    [addInfoMessage, askQuestion, getCheckpoints, rewind],
  )

  // 挂载时处理启动路径。CLI 入口会准备三条互斥路径：
  //   - initialSession 存在：`xc -c` 已经同步加载了最近会话。
  //     useAgent 已经把滚动历史恢复出来；这里只需要放一条 banner，
  //     让用户知道自己恢复了会话，而不是误以为消息莫名其妙预填充。
  //     这条路径没有额外异步工作，只是视觉提示。
  //   - resumeIntent === 'pick'：`xc -r` 需要打开选择器。
  //     这里弹出和 `/resume` 相同的对话框。
  //   - 都没有：普通启动，无需额外处理。
  // askQuestion 只有在用户选择后才会 resolve，因此这里把它包在 effect 中并忽略 promise；
  // Ink 不关心 effect 内仍在等待的异步任务。
  useEffect(() => {
    if (initialSession) {
      const preview = initialSession.firstPrompt.slice(0, 80) || '(no first prompt)'
      const hint =
        compactionHintForResume(
          initialSession.tokenUsage.inputTokens || null,
          estimateTokenCount(initialSession.messages),
          initialSession.modelId,
        ) ?? ''
      addInfoMessage(
        `**Resumed session** — ${preview}\n\nRestored ${initialSession.messages.length} message${initialSession.messages.length === 1 ? '' : 's'}. Continuing the same conversation.${hint}`,
      )
      return
    }
    if (resumeIntent === 'pick') {
      void handleResume()
      return
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 早期这里曾尝试通过 effect 执行 `cleanup().then(exit)`，
  // 但 usePromptInput 持有的 raw stdin 引用会让事件循环在卸载后继续存活，
  // 导致退出挂起，直到用户按键或调整终端大小。

  /**
   * 处理用户提交的输入，包括 slash command 和普通消息。
   *
   * slash command 在这里被分发到对应 handler；普通消息会直接提交给 agent。
   * 如果之前用户只激活了某个 skill 而没有给具体任务，这里会把 pending skill
   * 包装后注入到下一条普通消息前面。
   *
   * @param text - 用户从输入框提交的原始文本。
   */
  async function handleSubmit(text: string) {
    // slash command 路径：以 `/` 开头的输入不会直接作为普通用户消息提交。
    if (text.startsWith('/')) {
      const parts = text.slice(1).trim().split(/\s+/)
      const command = parts[0].toLowerCase()
      const arg = parts.slice(1).join(' ')

      switch (command) {
        case 'help':
          echoCommand(text)
          addInfoMessage(buildHelpText(skillCommands, fileCommands))
          return

        case 'model':
          handleModelSwitch(text, arg)
          return

        case 'thinking':
          handleThinkingToggle(text, arg)
          return

        case 'plan':
          handlePlanToggle(text, arg)
          return

        case 'clear':
          // 不 echo，也不输出结果消息。
          // ChatInput 的 shrink-detection 路径会清空可见终端和滚动历史，
          // 让用户看到只剩输入框的空视口。若再加一行 “Conversation cleared.”，
          // 清空后的屏幕会立刻从第 1 行重新绘制，破坏用户想要的“刚启动”观感。
          pendingSkillRef.current = null
          clear()
          return

        case 'compact':
          echoCommand(text)
          await handleCompact()
          return

        case 'resume':
          echoCommand(text)
          await handleResume()
          return

        case 'rewind':
          echoCommand(text)
          await handleRewind(arg)
          return

        case 'init':
          echoCommand(text)
          await submit(INIT_PROMPT, { silent: true })
          return

        case 'review':
          echoCommand(text)
          await submit(REVIEW_PROMPT(arg), { silent: true })
          return

        case 'usage':
          echoCommand(text)
          await handleUsage()
          return

        case 'usage-history':
          echoCommand(text)
          await handleUsageHistory()
          return

        case 'memory':
          echoCommand(text)
          handleMemory()
          return

        case 'skill':
          await handleSkill(text, arg)
          return

        case 'mcp':
          await handleMcp(text, arg)
          return

        case 'plugin':
          await handlePlugin(text, arg)
          return

        case 'doctor':
          handleDoctor(text)
          return

        case 'exit':
          await cleanup()
          exit()
          return

        default: {
          // 先检查命令是否命中已加载的 skill。
          const skill = options.skillRegistry?.get(command)
          if (skill) {
            if (arg) {
              // skill 后面紧跟具体请求：先 echo 命令，再把 skill 内容和用户请求一起提交。
              // 这样模型会把 skill persona 应用到用户的具体问题上。
              // submit 设置 silent，由 echoCommand 提供可见的命令回显。
              // wrapActivatedSkill 会构造和 activateSkill 工具相同的 <activated_skill> 包裹，
              // 包含正文、base directory 和文件列表，保证用户手动触发与工具触发在模型看来字节一致。
              echoCommand(text)
              await submit(`${wrapActivatedSkill(skill)}\n\n${arg}`, {
                silent: true,
              })
            } else {
              // 暂时没有后续请求：保存完整 SkillDefinition。
              // 等用户下一条真实消息到达时，再用相同 wrapper 重新格式化并注入。
              // addCommandMessage 负责这里的命令回显。
              pendingSkillRef.current = skill
              addCommandMessage(text, `Skill **${skill.name}** loaded. Type your request.`)
            }
            return
          }

          // 再检查插件贡献的 slash commands。
          // 已安装插件中的 `commands/<name>.md` 会映射成 `/<name>`；
          // 命令正文会在替换 $ARGUMENTS / ${CLAUDE_PLUGIN_ROOT} 后作为模型 prompt 提交。
          const cmd = options.commandRegistry?.get(command)
          if (cmd) {
            echoCommand(text)
            const expanded = expandCommandBody(cmd, arg)
            await submit(expanded, { silent: true })
            return
          }
          addCommandMessage(text, `Unknown command: /${command}. Type /help for available commands.`)
          return
        }
      }
    }

    // 普通消息路径：如果存在等待注入的 skill，就把 skill 上下文前置到用户消息前面并清空。
    const pendingSkill = pendingSkillRef.current
    if (pendingSkill) {
      pendingSkillRef.current = null
      await submit(`${wrapActivatedSkill(pendingSkill)}\n\n${text}`, { silent: true })
      return
    }
    await submit(text)
  }

  /**
   * 根据模型 id 查找面向用户展示的模型标签。
   *
   * @param modelId - 完整模型 id，例如 `anthropic:claude-sonnet-4-6`。
   * @returns 模型选择器里的友好标签；找不到时回退为原始 id。
   */
  function renderModelLabel(modelId: string): string {
    for (const models of Object.values(PROVIDER_MODELS)) {
      for (const m of models) if (m.id === modelId) return m.label
    }
    return modelId
  }

  /**
   * 提交一次模型切换。
   *
   * 会重新创建 provider 注册表，确保新 provider 的环境变量 API key 被读取；
   * 然后切换运行中的 language model 引用、持久化到用户配置，并输出确认消息。
   *
   * @param commandText - 用户输入的原始命令文本，用于回显。
   * @param newModelId - 要切换到的新模型 id。
   */
  function commitModelChange(commandText: string, newModelId: string) {
    try {
      const registry = createModelRegistry()
      const newModel = registry.languageModel(newModelId as `${string}:${string}`)
      switchModel(newModelId, newModel)
      saveUserConfig({ model: newModelId })
      addCommandMessage(commandText, `Set model to ${renderModelLabel(newModelId)}`)
    } catch (err) {
      addCommandMessage(commandText, `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 处理 `/model` 命令。
   *
   * 带参数时走脚本友好的直接路径，支持别名或完整 model id；
   * 不带参数时打开交互式模型选择器，只展示当前已配置 API key 的 provider 下的模型。
   *
   * @param commandText - 用户输入的原始命令文本。
   * @param arg - `/model` 后面的参数。
   */
  async function handleModelSwitch(commandText: string, arg: string) {
    // 带显式参数时，保留原本适合脚本调用的路径：参数可以是别名，也可以是完整 id。
    if (arg) {
      const newModelId = resolveModelId(arg)
      if (!newModelId) {
        addCommandMessage(commandText, `Could not resolve model: ${arg}`)
        return
      }
      commitModelChange(commandText, newModelId)
      return
    }

    // 不带参数时打开交互式选择器。
    // 只列出 provider 已配置 API key 的模型，确保列表里的选择都能实际使用。
    const providers = new Set(getAvailableProviders())
    const choices: { id: string; label: string; description: string }[] = []
    for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
      if (!providers.has(provider)) continue
      for (const m of models) {
        const marker = m.id === state.modelId ? `● ` : '  '
        choices.push({ id: m.id, label: `${marker}${m.label}`, description: `${m.id} — ${m.description}` })
      }
    }

    if (choices.length === 0) {
      addCommandMessage(
        commandText,
        'No models available — set an API key (e.g. `ANTHROPIC_API_KEY`, `ALIBABA_API_KEY`) and restart.',
      )
      return
    }

    // askQuestion resolve 的是用户选中项的 label，而不是 model id。
    // SelectOptions 面向可读选项设计，所以这里需要通过刚才 push 的 label 反查 id。
    const answer = await askQuestion(
      `Current: ${state.modelId}\nPick a model (● = current):`,
      choices.map((c) => ({ label: c.label, description: c.description })),
      { noOther: true },
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      // 空 answer 表示用户按 Esc 关闭了对话框。
      // 静默取消即可，不要把空字符串丢给 resolveModelId，
      // 否则会出现空 model id 的“无法解析模型”提示。
      if (!answer) {
        addCommandMessage(commandText, `Cancelled — model stays **${renderModelLabel(state.modelId)}**.`)
        return
      }
      // 用户选择 Other 或输入了自由文本时，把它当成模型 id / 别名处理。
      // 这样高级用户仍然可以跳到选择器没有列出的冷门模型。
      const resolved = resolveModelId(answer)
      if (!resolved) {
        addCommandMessage(commandText, `Could not resolve model: ${answer}`)
        return
      }
      commitModelChange(commandText, resolved)
      return
    }
    if (picked.id === state.modelId) {
      addCommandMessage(commandText, `Already on ${renderModelLabel(picked.id)} — no change.`)
      return
    }
    commitModelChange(commandText, picked.id)
  }

  /**
   * 提交 extended thinking 模式变更。
   *
   * 会更新运行时 ref，让下一轮 agent turn 使用新值；同时写入磁盘配置，
   * 并输出一条 Claude 风格的命令结果消息。
   *
   * @param commandText - 用户输入的原始命令文本。
   * @param next - 下一步是否启用 extended thinking。
   */
  function commitThinkingChange(commandText: string, next: boolean) {
    setThinking(next)
    saveUserConfig({ thinking: next })
    addCommandMessage(commandText, `Extended thinking → **${next ? 'on' : 'off'}**. Takes effect on the next message.`)
  }

  /**
   * 处理 `/thinking`：切换 extended thinking 开关。
   *
   * 不带参数时打开交互式选择器，体验和 `/model` 一致：当前状态用 `●` 标记，
   * 用户可用方向键和 Enter 选择。取消或选择当前状态都不会产生变化。
   *
   * `on` / `off` 以及 `true` / `false` / `enable` / `disable` 等别名
   * 会走直接切换路径，适合脚本和肌肉记忆。其他参数会被拒绝并给出提示。
   *
   * 该开关对所有 provider 使用统一语义，具体实现见 providers/thinking.ts：
   * ON 会启用各 provider 支持的最大 reasoning；
   * OFF 会请求最小或禁用 reasoning。Gemini 2.5 Pro 不能完全关闭，
   * 因此会被限制到它的 128 token 最小值。
   *
   * 选择会持久化到 ~/.tegent/config.json。agent loop 每轮都会通过 useAgent
   * 里的 thinkingRef 读取它，因此切换后的下一条消息立即生效；
   * 这不同于 `/model`，不需要重建模型实例。
   *
   * @param commandText - 用户输入的原始命令文本。
   * @param arg - `/thinking` 后面的参数。
   */
  async function handleThinkingToggle(commandText: string, arg: string) {
    const current = getThinking()
    const trimmed = arg.trim().toLowerCase()

    // 直接切换路径：用户显式输入 on/off 或别名。
    if (trimmed) {
      const next = parseBooleanArg(trimmed)
      if (next === null) {
        addCommandMessage(
          commandText,
          `Unknown value: \`${arg}\`. Use \`/thinking\`, \`/thinking on\`, or \`/thinking off\`.`,
        )
        return
      }

      if (next === current) {
        addCommandMessage(commandText, `Extended thinking is already **${next ? 'on' : 'off'}** — no change.`)
        return
      }

      commitThinkingChange(commandText, next)
      return
    }

    // 不带参数时打开交互式选择器。
    // 始终展示 On 和 Off 两个选项，让用户看到完整状态空间；
    // 当前选项用 `● ` 标记，和 `/model` 的渲染保持一致。
    const onMarker = current ? `● ` : '  '
    const offMarker = current ? '  ' : `● `
    const choices = [
      {
        label: `${onMarker}On`,
        description: 'Opt every supported provider into max reasoning. Slower, costs more, better on hard problems.',
      },
      {
        label: `${offMarker}Off`,
        description: 'Each provider runs its non-thinking default. Faster, cheaper, sufficient for most chat.',
      },
    ]
    const answer = await askQuestion(
      `Extended thinking is currently **${current ? 'on' : 'off'}**. Pick a mode (● = current):`,
      choices,
      { noOther: true },
    )
    const wantOn = answer === choices[0].label
    const wantOff = answer === choices[1].label
    if (!wantOn && !wantOff) {
      // 用户在选择器里输入了自由文本时，仍然识别标准别名；
      // 如果无法识别，就按取消处理，通常说明用户只是想退出选择器。
      const free = (answer ?? '').trim().toLowerCase()
      if (free === 'on' || free === 'true' || free === '1' || free === 'enable' || free === 'enabled') {
        if (current) {
          addCommandMessage(commandText, 'Extended thinking is already **on** — no change.')
          return
        }
        commitThinkingChange(commandText, true)
        return
      }
      if (free === 'off' || free === 'false' || free === '0' || free === 'disable' || free === 'disabled') {
        if (!current) {
          addCommandMessage(commandText, 'Extended thinking is already **off** — no change.')
          return
        }
        commitThinkingChange(commandText, false)
        return
      }
      addCommandMessage(commandText, `Cancelled — extended thinking stays **${current ? 'on' : 'off'}**.`)
      return
    }
    const next = wantOn
    if (next === current) {
      addCommandMessage(commandText, `Already **${next ? 'on' : 'off'}** — no change.`)
      return
    }
    commitThinkingChange(commandText, next)
  }

  /**
   * 处理 `/plan`：切换 plan 模式。
   *
   * 这里不做选择器，因为 `/plan` 本身就是用户明确请求进入或退出 plan 模式。
   * `/plan` 会在 plan 与默认模式之间切换；`/plan on` 和 `/plan off`
   * 是幂等 setter，方便脚本化流程。确认输出对齐 Claude Code 的单行格式。
   *
   * @param commandText - 用户输入的原始命令文本。
   * @param arg - `/plan` 后面的参数。
   */
  function handlePlanToggle(commandText: string, arg: string) {
    const current = state.permissionMode === 'plan'
    const trimmed = arg.trim().toLowerCase()

    let next: boolean
    if (!trimmed) {
      next = !current
    } else {
      const parsed = parseBooleanArg(trimmed)
      if (parsed === null) {
        addCommandMessage(commandText, `Unknown value: \`${arg}\`. Use \`/plan\`, \`/plan on\`, or \`/plan off\`.`)
        return
      }
      next = parsed
    }

    if (next === current) {
      addCommandMessage(commandText, `Plan mode is already **${current ? 'on' : 'off'}** — no change.`)
      return
    }

    // /plan 直接在 plan 和 default 之间切换。
    // 这里通过 setPermissionMode 更新 loopState，并复用现有 onPlanModeChange
    // 回调路径完成 React state 和 UI 同步。
    setPermissionMode(next ? 'plan' : 'default')
    addCommandMessage(commandText, next ? 'Enabled plan mode' : 'Disabled plan mode')
  }

  /**
   * 执行 `/compact`：手动压缩当前上下文。
   *
   * @returns 无显式返回值；结果会写入命令结果消息。
   */
  async function handleCompact() {
    const result = await compact()
    if (!result) {
      addCommandResult('Nothing to compress — conversation is too short.')
      return
    }
    const beforeK = Math.round(result.beforeTokens / 1000)
    const afterK = Math.round(result.afterTokens / 1000)
    addCommandResult(`Context compressed: ~${beforeK}k → ~${afterK}k tokens.`)
  }

  /**
   * 执行 `/usage`：展示当前会话或最近会话快照的 token 用量。
   *
   * 当前会话还没有任何用量时，会尝试回退到最近一次已保存会话的 tokenUsage，
   * 让用户刚启动时也能看到上一段工作的用量概览。
   *
   * @returns 无显式返回值；报告会写入滚动消息区。
   */
  async function handleUsage() {
    let usage: TokenUsage = state.usage
    let modelId = state.modelId
    let source: 'live' | 'snapshot' = 'live'
    let sessionName: string | undefined
    const info = getSessionInfo()
    if (info?.firstPrompt) {
      sessionName = info.firstPrompt
    }
    if (usage.totalTokens === 0) {
      const latest = await pickLatestSession()
      if (latest && latest.tokenUsage) {
        usage = latest.tokenUsage
        modelId = latest.modelId
        source = 'snapshot'
        sessionName = latest.firstPrompt.slice(0, 80) || undefined
      }
    }
    addInfoMessage(formatUsageReport(usage, modelId, source, sessionName))
  }

  /**
   * 执行 `/usage-history`：用交互式选择器查看历史会话用量。
   *
   * 用户先从会话列表中选一个会话，再查看该会话的 usage 报告；
   * 每次查看后可以回到列表继续选择，或按 Esc 退出。
   *
   * @returns 无显式返回值；报告会写入滚动消息区。
   */
  async function handleUsageHistory() {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      addInfoMessage('**Usage history** — no past sessions found in this project.')
      return
    }

    const fmt = (n: number) => n.toLocaleString('en-US')
    const choices = sessions.map((s) => {
      const preview = (s.firstPrompt || '(empty)').slice(0, 50).replace(/\s+/g, ' ').trim()
      const ago = formatRelativeTime(s.mtime)
      const total = s.tokenUsage ? fmt(s.tokenUsage.totalTokens) : '—'
      return {
        label: `${preview}  ·  ${ago}`,
        description: `${s.modelId}  ·  ${total} tokens`,
        session: s,
      }
    })

    const BACK_LABEL = '← Back to list'
    const tick = () => new Promise<void>((r) => setTimeout(r, 50))

    while (true) {
      const answer = await askQuestion(
        `**Usage history** — ${sessions.length} session${sessions.length === 1 ? '' : 's'}. Pick one to view details:`,
        choices.map((c) => ({ label: c.label, description: c.description })),
        { noOther: true },
      )

      const picked = choices.find((c) => c.label === answer)
      if (!picked) break

      const s = picked.session
      const usage = s.tokenUsage
      if (!usage) {
        addInfoMessage(
          `**${(s.firstPrompt || '(empty)').slice(0, 60)}**\n\nNo usage data recorded (interrupted before first turn).`,
        )
      } else {
        addInfoMessage(formatUsageReport(usage, s.modelId, 'history', s.firstPrompt.slice(0, 80) || undefined))
      }

      await tick()

      const back = await askQuestion(
        'Press Enter to return, or Esc to exit.',
        [{ label: BACK_LABEL, description: 'Go back to the session list.' }],
        { noOther: true },
      )

      if (!back) break
    }
  }

  /**
   * 把 auto-memory fact 列表格式化成滚动消息区可展示的 markdown。
   *
   * @param scope - memory 范围，项目级或用户级。
   * @param facts - 要展示的 memory facts。
   * @returns 格式化后的 markdown 文本。
   */
  function formatMemoryList(scope: 'project' | 'user', facts: KnowledgeFact[]): string {
    if (facts.length === 0) {
      return `**Auto memory (${scope})** — empty.`
    }
    const byCategory = new Map<string, KnowledgeFact[]>()
    for (const f of facts) {
      const list = byCategory.get(f.category) ?? []
      list.push(f)
      byCategory.set(f.category, list)
    }
    const lines: string[] = [`**Auto memory (${scope})** — ${facts.length} fact${facts.length === 1 ? '' : 's'}.`, '']
    for (const [category, items] of byCategory) {
      lines.push(`### ${category}`)
      for (const f of items) {
        lines.push(`- \`${f.key}\` — ${f.fact} _(${f.date})_`)
      }
      lines.push('')
    }
    return lines.join('\n').trimEnd()
  }

  /**
   * 执行 `/memory`：展示项目级和用户级 auto-memory 条目。
   *
   * memory extractor 会在后台写底层文件；如果用户想删除或编辑条目，
   * 需要直接打开对应的 `auto.md`。
   */
  function handleMemory() {
    const sections: string[] = []
    sections.push(formatMemoryList('project', getAutoMemory('project').getAll()))
    sections.push('')
    sections.push(formatMemoryList('user', getAutoMemory('user').getAll()))
    addInfoMessage(sections.join('\n'))
  }

  // skill、plugin、mcp 的 slash-command handler 位于 ../commands/{skill,plugin,mcp}.ts。
  // 每个工厂函数都会闭包捕获 App 当前 render 的依赖，并返回上方 dispatcher 调用的 handler。
  // 这种每次 render 重新创建的身份行为，和它们以前写成组件内联函数声明时保持一致。
  const { handleSkill } = createSkillCommandHandler({
    options,
    addCommandMessage,
    invalidateSystemPromptCache,
    pendingSkillRef,
    bumpSkillRegistryVersion: () => setSkillRegistryVersion((v) => v + 1),
  })

  const { handlePlugin } = createPluginCommandHandler({
    options,
    addCommandMessage,
    askQuestion,
    invalidateSystemPromptCache,
    bumpSkillRegistryVersion: () => setSkillRegistryVersion((v) => v + 1),
  })

  const { handleMcp } = createMcpCommandHandler({
    options,
    addCommandMessage,
    addCommandResult,
    askQuestion,
    invalidateSystemPromptCache,
  })

  const handleDoctor = createDoctorCommandHandler({
    options,
    modelId: state.modelId,
    addInfoMessage,
    echoCommand,
  })

  // 渲染架构
  //
  // `ChatInput` 拥有初始 header 下面的整个终端区域：
  //   - 滚动历史消息通过直接写 stdout 提交；
  //   - spinner、输入框、分隔线、补全、错误、Permission 对话框、
  //     SelectOptions 对话框都渲染到同一个 cell 级 diff buffer 中。
  //
  // Ink 的动态区域必须始终为空，也就是不向 Ink 自己的子树里渲染任何可见内容。
  // 如果 Ink 往那里写内容，它内部使用的 `\x1b7` / `\x1b8` 会破坏我们的光标锚点，
  // 留下清不掉的旧帧。早期版本曾把 SelectOptions 作为直接 Ink 子组件，
  // 但当对话框高度超过 ChatInput 时，终端自动滚动会在对话框关闭后
  // 在 scrollback 中留下永久空行；所以它现在也被移入 ChatInput 的 cell buffer。
  const permissionRequest = state.permissionQueue[0]
  const selectActive = !!state.pendingQuestion

  return (
    <ChatInput
      messages={state.messages}
      initialContentRows={getHeaderRowCount(state.modelId)}
      onSubmit={handleSubmit}
      onInterrupt={handleCtrlC}
      onEscapeCancel={abort}
      permissionMode={state.permissionMode}
      isLoading={state.isLoading}
      notice={notice}
      // 选择器对话框打开时，隐藏 spinner 的 “Thinking” 行，但保留 ChatInput 本体。
      // 现在对话框渲染在 ChatInput 的 cell buffer 里面，而不是 Ink 顶层子树里。
      //
      // Permission 对话框不能隐藏 spinner：active-tool 列表渲染在 ChatInput 的
      // `if (spinner)` 分支里。如果把 spinner 置空，Running 指示也会一起消失，
      // 用户会看到一个像卡住一样、没有可见权限提示的屏幕。
      spinner={
        state.isLoading && !selectActive
          ? {
              // 当一串可折叠 read 工具正在执行时，单个工具的实时指示会被抑制，
              // 否则每次快速读取都会闪一下“出现 → 消失”。但如果只显示通用
              // “Thinking...”，多秒读取链又会看起来像卡住。
              // `bufferingReads` 会在连续 read 之间 50-200ms 的间隙里保持粘性；
              // 没有它的话，标签会在每个工具之间反复 Reading/Thinking/Reading 闪烁。
              // 该状态由 useAgent 在 tool-call、text-delta、loop-end、abort 时更新。
              label: state.compressionLabel
                ? `Compressing — ${state.compressionLabel}`
                : state.bufferingReads
                  ? 'Reading'
                  : 'Thinking',
              mode: state.activeToolCalls.length > 0 ? 'tool-use' : 'requesting',
            }
          : null
      }
      contextUsage={
        // footer 上的上下文用量指示，例如 `6.6k / 200k · 3%`。
        // 它使用最近一次 API 响应里的快照，而不是累计会话计数。
        // 累计值会在每一轮重复计入消息历史；即便输入命中缓存，
        // 也仍会体现在 `inputTokens` 中，导致数字远大于实际账单意义上的用量。
        // 第一轮完成前没有快照，因此隐藏该指示。
        state.usage.currentContextTokens > 0
          ? { used: state.usage.currentContextTokens, window: getContextWindow(state.modelId) }
          : null
      }
      activeToolCalls={state.activeToolCalls}
      todos={state.todos}
      errorMessage={state.error}
      permission={
        permissionRequest
          ? {
              toolName: permissionRequest.toolName,
              input: permissionRequest.input,
              mcp: permissionRequest.mcp,
              onResolve: resolvePermission,
            }
          : null
      }
      selectRequest={
        state.pendingQuestion
          ? {
              question: state.pendingQuestion.question,
              options: state.pendingQuestion.options,
              onResolve: resolveQuestion,
              dismissible: state.pendingQuestion.dismissible,
              layout: state.pendingQuestion.layout,
            }
          : null
      }
      commands={allCommands}
    />
  )
}
