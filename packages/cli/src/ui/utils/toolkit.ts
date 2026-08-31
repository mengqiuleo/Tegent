import { getContextWindow, MODEL_ALIASES, type DisplayMessage, type DisplayToolCall, type ModelMessage, type TokenUsage } from '@tegent/core'
import { SLASH_COMMANDS } from '../components/constants.js'
import { VERSION } from '../../version.js'
import { getToolInputPreview } from '../utils.js'


/**
 * 从最近一条 assistant 消息中提取文本。
 *
 * @param messages - agent loop 中的模型消息列表。
 * @returns 最近 assistant 消息里的文本内容；没有可用文本时返回空字符串。
 *
 * 这是一个兜底方案。
 * 某些 reasoning provider 可能不发送 text-delta 事件，
 * 但最终响应消息里仍包含文本片段，此函数用于把那部分文本展示出来。
 */
export function extractLastAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] // 从后往前读取消息，优先找到最近的 assistant 回复。
    if (msg.role !== 'assistant') continue // 只关心 assistant 消息，其它角色跳过。
    const content = msg.content // 读取 assistant 消息内容。
    if (typeof content === 'string') return content // 字符串内容可直接返回。
    if (!Array.isArray(content)) return '' // 非数组且非字符串的内容无法提取文本。
    const parts: string[] = [] // 收集数组内容中的 text 片段。
    for (const part of content as Array<{ type: string; text?: string }>) {
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text) // 只拼接显式 text 片段。
      }
    }
    return parts.join('') // 同一条 assistant 消息内的文本片段按顺序拼接。
  }
  return '' // 没有 assistant 消息时返回空字符串。
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
export function formatRelativeTime(epochMs: number): string {
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
export function formatUsageReport(
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
export function compactionHintForResume(tokens: number | null, estimatedTokens: number, modelId: string): string | null {
  const window = getContextWindow(modelId)
  const used = Math.max(tokens ?? 0, estimatedTokens)
  if (used === 0) return null
  const pct = (used / window) * 100
  if (pct < 60) return null
  return `\n\n_Context is at **${pct.toFixed(0)}%** of the ${window.toLocaleString('en-US')}-token window — consider \`/compact\` before continuing, or it'll auto-compress on the next turn._`
}


/**
 * 生成 `/help` 输出文本。
 *
 * 会合并内置命令、skill 注册表贡献的命令，以及用户/项目/插件提供的 markdown 命令。
 *
 * @param skillCommands - 已加载 skill 暴露的命令。
 * @param fileCommands - 文件型 slash commands。
 * @returns 最终展示给用户的帮助文本。
 */
export function buildHelpText(
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
 * 把字符串截断到大致可读的长度。
 *
 * 用字符数保护菜单和工具预览不要无限变宽。
 *
 * @param s 原始文本。
 * @param max 最大字符数。
 * @returns 可能带省略号的文本。
 */
export function truncate(s: string, max: number): string {
  // 没超过上限时直接返回原字符串，避免无意义分配。
  if (s.length <= max) return s
  // 超过上限时预留 1 个字符放省略号，让最终长度大致不超过 max。
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

/**
 * 生成工具调用的单行入参预览。
 *
 * @param toolName 工具名。
 * @param input 工具入参。
 * @param max 最大字符数。
 * @returns 可直接显示在工具标题后的预览文本。
 */
export function toolPreview(toolName: string, input: Record<string, unknown>, max = 90): string {
  // getToolInputPreview 会按工具类型挑选最有用的字段，例如 shell command 或 file path。
  const preview = getToolInputPreview(toolName, input)
  // 有预览就截断到 UI 可接受长度；没有可读字段时返回空字符串。
  return preview ? truncate(preview, max) : ''
}


/**
 * 根据工具结果状态选择 Ink 颜色。
 *
 * @param status 工具状态。
 * @returns Ink Text 可接受的颜色名。
 */
export function toolStatusColor(status: DisplayToolCall['status']): 'green' | 'yellow' | 'red' | 'gray' {
  // 成功完成用绿色，表示这条工具结果已经落定。
  if (status === 'completed') return 'green'
  // 工具报错或被用户拒绝都属于需要注意的失败状态，用红色。
  if (status === 'error' || status === 'denied') return 'red'
  // running 只会出现在运行区或未完成工具展示中，用黄色表示进行中。
  if (status === 'running') return 'yellow'
  // 其它 pending/未知状态用灰色，降低视觉权重。
  return 'gray'
}



/**
 * 根据消息类型生成左侧短标签。
 *
 * @param msg 要渲染的 display message。
 * @returns 适合在 TUI 中显示的标签。
 */
export function renderMessageLabel(msg: DisplayMessage): string {
  // slash command 回显用短 `$` 标签，和普通用户消息区分开。
  if (msg.kind === 'command-echo') return '$'
  // slash command 结果和系统提示类消息用 info。
  if (msg.kind === 'command-result') return 'info'
  // 用户输入显示为 you。
  if (msg.role === 'user') return 'you'
  // tool 角色理论上很少直接进入此 Ink 展示路径，保留标签兜底。
  if (msg.role === 'tool') return 'tool'
  // 其它默认按 assistant 输出处理。
  return 'assistant'
}



/**
 * 判断 slash command 是否 fuzzy 命中。
 *
 * 逻辑和原 ChatInput 一致：query 是 target 的子序列即可，比如 `mc` 能命中 `mcp`。
 *
 * @param target 候选命令名。
 * @param query 用户输入的查询。
 * @returns 是否命中。
 */
export function fuzzyMatches(target: string, query: string): boolean {
  // qi 指向 query 当前等待匹配的字符。
  let qi = 0
  // ti 从左到右扫描 target；只要顺序能对上，就认为 fuzzy 命中。
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    // 当前 target 字符命中 query 当前字符时，推进 query 指针。
    if (target[ti] === query[qi]) qi++
  }
  // query 每个字符都被按顺序匹配到，才算命中。
  return qi === query.length
}
