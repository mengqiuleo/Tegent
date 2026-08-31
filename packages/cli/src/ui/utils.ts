// 这里放多个 UI 模块都会用到的小型辅助函数。
// 集中维护可以避免同一段逻辑在不同文件里复制后逐渐不一致。
import type { DisplayToolCall } from '@tegent/core' // 导入工具调用的展示层类型，只在类型检查阶段使用。
import { getShellProvider } from '@tegent/core' // 导入当前 shell 提供方，用来展示对应 shell 名称。

// 布局常量

/**
 * 工具结果行的缩进。
 *
 * 这个缩进让结果正文对齐在 `   ⎿  ` 标记之后。
 * 宽度是 6 个终端单元格：3 个空格 + 括号符号 + 2 个空格。
 * stdout-writer 的回滚输出和 render-diff 的差量渲染都会使用它。
 */
export const RESULT_INDENT = '      ' // 固定为 6 个空格，匹配工具结果前缀的视觉宽度。

// 换行符归一化

/**
 * 将输入字符串里的换行符统一转换为 `\n`。
 *
 * @param s - 需要归一化换行符的原始字符串。
 * @returns 只包含 `\n` 换行符的字符串。
 *
 * 在写入终端前做这一步很重要。
 * Windows 粘贴内容和剪贴板文本经常包含 `\r\n` 或单独的 `\r`。
 * 单独的 `\r` 在终端里表示“把光标移动到当前行第 0 列”，后续字符会覆盖当前行已打印的内容。
 */
export function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n?/g, '\n') // 把 `\r\n` 和单独的 `\r` 都替换成标准换行。
}

// 布尔参数解析

/**
 * 将 CLI 参数字符串解析为布尔值。
 *
 * @param s - 用户输入的参数字符串。
 * @returns 能识别时返回 `true` 或 `false`，无法识别时返回 `null`，调用方可据此展示错误。
 *
 * 可识别的真值包括 `on`、`true`、`1`、`enable`、`enabled`。
 * 可识别的假值包括 `off`、`false`、`0`、`disable`、`disabled`。
 */
export function parseBooleanArg(s: string): boolean | null {
  const trimmed = s.trim().toLowerCase() // 去掉首尾空白并转成小写，避免大小写和空格影响匹配。
  if (trimmed === 'on' || trimmed === 'true' || trimmed === '1' || trimmed === 'enable' || trimmed === 'enabled')
    return true // 命中真值别名时返回 true。
  if (trimmed === 'off' || trimmed === 'false' || trimmed === '0' || trimmed === 'disable' || trimmed === 'disabled')
    return false // 命中假值别名时返回 false。
  return null
}

// 时长格式化

/**
 * 格式化时长时使用的选项。
 */
export interface DurationFmtOptions {
  /**
   * 秒数字段的小数位数。
   *
   * 只在时长小于 60 秒时使用。
   * 默认值是 1。
   */
  precision?: number

  /**
   * 是否使用更紧凑的分钟格式。
   *
   * 为 `true` 且秒数为 0 时，`2m 0s` 会被格式化为 `2m`。
   * 默认值是 `false`。
   */
  compact?: boolean
}

/**
 * 将毫秒时长格式化为便于人阅读的字符串。
 *
 * @param ms - 原始毫秒数。
 * @param opts - 格式化选项。
 * @returns 格式化后的时长字符串。
 *
 * 小于 1 秒时返回毫秒，例如 `"120ms"`。
 * 小于 60 秒时返回秒，例如 `"3.5s"`，小数位数由 `opts.precision` 决定。
 * 大于等于 60 秒时返回分钟和秒，例如 `"2m 15s"`；紧凑模式且秒为 0 时返回 `"2m"`。
 */
export function formatDuration(ms: number, opts: DurationFmtOptions = {}): string {
  const { precision = 1, compact = false } = opts 
  if (ms < 1000) return `${ms}ms` 
  const seconds = ms / 1000 
  if (seconds < 60) return `${seconds.toFixed(precision)}s`
  const minutes = Math.floor(seconds / 60) 
  const secs = Math.round(seconds % 60) 
  if (compact && secs === 0) return `${minutes}m` 
  return `${minutes}m ${secs}s` 
}

// 工具展示辅助函数

/**
 * 归一化工具名称，便于不同命名风格使用同一套匹配逻辑。
 *
 * @param name - 原始工具名称。
 * @returns 小写且移除 `_`、`-` 后的工具名称。
 */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '') 
}

/**
 * 判断工具是否属于可折叠的只读工具。
 *
 * @param toolName - 原始工具名称。
 * @returns 工具可按只读分组折叠时返回 `true`，否则返回 `false`。
 */
export function isCollapsibleReadOnlyTool(toolName: string): boolean {
  return COLLAPSIBLE_READ_ONLY_TOOLS.has(normalizeToolName(toolName))
}

/**
 * 可折叠只读工具名称集合。
 *
 * 集合里保存的是归一化后的名称，因此查找前需要调用 `normalizeToolName`。
 */
const COLLAPSIBLE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'readfile', // 读取文件内容的工具。
  'read', // 读取文件内容的短名称。
  'glob', // 根据 glob 模式查找文件的工具。
  'grep', // 根据文本模式搜索内容的工具。
  'search', // 搜索工具的通用别名。
  'listdir', // 列出目录内容的工具。
  'ls', // 列出目录内容的短名称。
])

/**
 * 从路径字符串中取出最后一级文件名或目录名。
 *
 * @param p - 原始路径，兼容 `/` 和 `\` 分隔符。
 * @returns 路径最后一级名称；如果没有分隔符，则返回原始字符串。
 */
export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) 
  return i >= 0 ? p.slice(i + 1) : p 
}

/**
 * shell 提供方类型到展示名称的映射。
 */
const SHELL_LABELS: Record<string, string> = {
  bash: 'Bash', // Bash shell 的展示名称。
  zsh: 'Zsh', // Zsh shell 的展示名称。
  powershell: 'PowerShell', // PowerShell 的展示名称。
}

/**
 * 获取工具在 UI 中展示的短标签。
 *
 * @param toolName - 原始工具名称。
 * @returns 适合展示给用户的工具标签。
 */
export function getToolLabel(toolName: string): string {
  const n = normalizeToolName(toolName)
  if (n === 'shell' || n === 'bash') return SHELL_LABELS[getShellProvider().type] ?? 'Shell'
  if (n === 'readfile' || n === 'read') return 'Read'
  if (n === 'writefile' || n === 'write') return 'Write'
  if (n === 'edit' || n === 'update') return 'Update' 
  if (n === 'glob') return 'Glob' 
  if (n === 'grep' || n === 'search') return 'Grep' 
  if (n === 'listdir' || n === 'ls') return 'ListDir'
  if (n === 'websearch') return 'WebSearch' 
  if (n === 'webfetch') return 'WebFetch'
  if (n === 'askuser') return 'AskUser' 
  if (n === 'enterplanmode') return 'EnterPlanMode'
  if (n === 'exitplanmode') return 'ExitPlanMode' 
  if (n === 'task') return 'Task' 
  if (n === 'todowrite') return 'TodoWrite' 
  return toolName 
}

/**
 * 从工具输入中提取一段适合在 UI 中预览的文本。
 *
 * @param toolName - 原始工具名称。
 * @param input - 工具调用输入对象。
 * @returns 简短的输入预览；找不到合适字段时返回空字符串。
 */
export function getToolInputPreview(toolName: string, input: Record<string, unknown>): string {
  const n = normalizeToolName(toolName) 

  if (n === 'shell' || n === 'bash') {
    return (input.command as string) || '' 
  }

  if (n === 'readfile' || n === 'read' || n === 'writefile' || n === 'write' || n === 'edit' || n === 'update') {
    return (input.filePath as string) || (input.file_path as string) || (input.path as string) || '' 
  }

  if (n === 'listdir' || n === 'ls') {
    return (input.dirPath as string) || (input.dir_path as string) || (input.path as string) || ''
  }

  if (n === 'glob' || n === 'grep' || n === 'search') {
    return (input.pattern as string) || (input.query as string) || '' 
  }

  if (n === 'websearch' || n === 'webfetch') {
    return (input.query as string) || (input.url as string) || ''
  }

  if (n === 'task') {
    return (input.description as string) || '' 
  }

  if (n === 'askuser') {
    const q = (input.question as string) || ''
    const firstLine = q.split(/\r?\n/)[0]?.trim() || '' 
    return firstLine
  }


  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length <= 100) return val 
  }

  return '' 
}

/**
 * 将 token 数量格式化为紧凑展示字符串。
 *
 * @param tokens - 原始 token 数。
 * @returns 小于一千时返回完整数字，达到千或百万时使用 `k` 或 `M` 后缀。
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M` // 百万级 token 使用 M 后缀。
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k` // 千级 token 使用 k 后缀。
  return String(tokens) // 小数字直接转为字符串，保留完整精度。
}

/**
 * 多个只读工具折叠后在 UI 中显示的摘要。
 */
export interface ReadGroupSummary {
  /**
   * 摘要主标题。
   */
  label: string

  /**
   * 可选的摘要详情，通常是若干文件名。
   */
  detail?: string
}

/**
 * 将一组只读工具调用格式化为折叠组摘要。
 *
 * @param tools - 等待汇总展示的工具调用列表。
 * @returns 包含主标题和可选详情的摘要对象。
 */
export function formatReadGroupSummary(tools: readonly DisplayToolCall[]): ReadGroupSummary {
  let readCount = 0 // 统计读取文件工具的调用次数。
  let grepCount = 0 // 统计 grep/search 工具的调用次数。
  let globCount = 0 // 统计 glob 工具的调用次数。
  let lsCount = 0 // 统计 listdir/ls 工具的调用次数。
  const readPaths: string[] = [] // 收集读取过的文件名，用于生成详情行。

  for (const tc of tools) {
    const n = normalizeToolName(tc.toolName) // 对当前工具名做归一化，便于分类。
    if (n === 'read' || n === 'readfile') {
      readCount++ // 记录一次文件读取。
      const p = (tc.input.filePath as string) || (tc.input.file_path as string) || (tc.input.path as string) || '' // 兼容不同字段名读取路径。
      if (p) readPaths.push(basename(p)) // 有路径时只保存最后一级名称，详情更短。
    } else if (n === 'grep' || n === 'search') {
      grepCount++ // 记录一次文本搜索。
    } else if (n === 'glob') {
      globCount++ // 记录一次 glob 查找。
    } else if (n === 'listdir' || n === 'ls') {
      lsCount++ // 记录一次目录列表读取。
    }
  }

  const clauses: string[] = [] // 用多个短句拼出最终摘要标题。
  if (readCount > 0) clauses.push(`read ${readCount} file${readCount === 1 ? '' : 's'}`) // 有读取时加入读取文件数量。
  if (grepCount > 0) clauses.push(`searched for ${grepCount} pattern${grepCount === 1 ? '' : 's'}`) // 有搜索时加入搜索模式数量。
  if (globCount > 0) clauses.push(`globbed ${globCount} pattern${globCount === 1 ? '' : 's'}`) // 有 glob 时加入 glob 模式数量。
  if (lsCount > 0) clauses.push(`listed ${lsCount} director${lsCount === 1 ? 'y' : 'ies'}`) // 有目录读取时加入目录数量，并处理英文复数。

  if (clauses.length > 0) {
    const first = clauses[0]! // 取出第一个短句，用来把首字母改成大写。
    clauses[0] = first.charAt(0).toUpperCase() + first.slice(1) // 只大写第一个短句的首字母，保持整体自然。
  }
  const label = clauses.join(', ') // 用逗号连接所有短句，得到摘要主标题。

  let detail: string | undefined // 详情默认不存在，只有读到文件路径时才生成。
  if (readPaths.length > 0) {
    const shown = readPaths.slice(0, 3).join(', ') // 最多直接展示前三个文件名。
    const rest = readPaths.length > 3 ? `, +${readPaths.length - 3} more` : ''
    detail = shown + rest 
  }

  return detail ? { label, detail } : { label }
}

/**
 * 根据工具名称、输出和状态生成工具结果摘要。
 *
 * @param toolName - 原始工具名称。
 * @param output - 工具输出文本，可能为空。
 * @param status - 工具执行状态。
 * @returns 适合展示在工具结果标题行的摘要；没有摘要需求时返回 `null`。
 */
export function getToolResultSummary(toolName: string, output: string | undefined, status: string): string | null {
  if (status === 'denied') return 'Denied by user'
  if (!output) return 'Done' 

  // 下面的逐工具成功摘要只适用于成功路径。
  // 例如 "Wrote file" 或 "Applied changes" 在错误场景里会误导用户。
  // 当工具报错、权限钩子拒绝或抛出异常时，列表项会被渲染为红色，但文字仍可能像成功消息。
  // 因此这里先返回简短错误标签，让下方 markdown 正文承载真实错误文本。
  if (status === 'error') return 'Failed' // 错误状态统一展示 Failed，避免误用成功摘要。

  const n = normalizeToolName(toolName)

  if (n === 'writefile' || n === 'write') {
    const m = output.match(/\((\d+) lines?\)/) // 从写入结果里提取行数，例如 `(12 lines)`。
    if (m) return `Wrote ${m[1]} lines` // 成功提取行数时展示写入行数。
    return 'Wrote file' // 没有行数时使用通用写入摘要。
  }

  if (n === 'edit' || n === 'update') {
    return 'Applied changes' // 编辑类工具成功时展示已应用变更。
  }

  if (n === 'readfile' || n === 'read') {
    const lineCount = (output.match(/\n/g) || []).length + 1 // 通过换行符数量估算输出行数。
    return `${lineCount} lines` // 展示读取结果的行数。
  }

  if (n === 'listdir' || n === 'ls') {
    const entries = output
      .trim() 
      .split('\n') 
      .filter((l) => l.trim())
    return entries.length <= 6
      ? entries.join('\n') // 条目较少时完整展示。
      : entries.slice(0, 3).join('\n') + `\n... +${entries.length - 3} items` // 条目较多时展示前三项和剩余数量。
  }

  if (n === 'glob') {
    const files = output
      .trim()
      .split('\n') 
      .filter((l) => l.trim()) 
    return `${files.length} file${files.length !== 1 ? 's' : ''} matched` // 展示匹配文件数量，并处理复数。
  }

  if (n === 'grep' || n === 'search') {
    const lines = output
      .trim() 
      .split('\n') 
      .filter((l) => l.trim()) 
    return `${lines.length} result${lines.length !== 1 ? 's' : ''}` // 展示搜索结果数量，并处理复数。
  }

  if (n === 'task') {
    const statsMatch = output.match(/<task_stats\s+tool_calls="(\d+)"\s+tokens="(\d+)"\s+duration_ms="(\d+)"\s*\/>/) // 提取子任务统计信息。
    const resultMatch = output.match(/<task_result>\n?([\s\S]*?)\n?<\/task_result>/) // 提取子任务正文结果。
    const body = resultMatch ? resultMatch[1]! : output.replace(/<task_stats[^/]*\/>/, '').trim() // 优先使用正文标签内容，否则移除统计标签后作为正文。
    const lines = body
      .trim() 
      .split('\n') 
      .filter((l) => l.trim()) 

    if (statsMatch) {
      const toolCalls = parseInt(statsMatch[1]!, 10) // 解析子任务内部工具调用次数。
      const tokens = parseInt(statsMatch[2]!, 10) // 解析子任务消耗的 token 数。
      const durationMs = parseInt(statsMatch[3]!, 10) // 解析子任务耗时毫秒数。
      const toolStr = toolCalls === 1 ? '1 tool use' : `${toolCalls} tool uses` // 根据数量选择单复数文案。
      const tokenStr = formatTokenCount(tokens) // 把 token 数压缩成便于展示的形式。
      const durStr = formatDuration(durationMs, { compact: true, precision: 0 }) // 把耗时压缩成任务摘要里的短格式。
      return `Done (${toolStr} · ${tokenStr} tokens · ${durStr})` // 汇总展示子任务状态、工具次数、token 和耗时。
    }

    if (lines.length === 0) return 'Done' // 没有正文行时只展示完成状态。
    if (lines.length <= 3) return lines.join('\n') // 正文较短时完整展示。
    return lines.slice(0, 2).join('\n') + `\n... +${lines.length - 2} lines` // 正文较长时展示前两行和剩余行数。
  }

  if (n === 'websearch') {
    return 'Did 1 search' // 网页搜索工具固定展示完成一次搜索。
  }

  if (n === 'webfetch') {
    return 'Fetched page' // 网页抓取工具固定展示页面已获取。
  }

  if (n === 'shell' || n === 'bash') {
    let text = output.trim() 
    text = text.replace(/^exit code: 0\n?/, '') // 去掉成功退出码前缀，保留真正有用的输出。
    const lines = text.split('\n').filter((l) => l.trim()) 
    if (lines.length === 0) return 'Done' // 没有有效输出时展示完成状态。
    if (lines.length <= 4) return lines.join('\n') // 输出较短时完整展示。
    return lines.slice(0, 3).join('\n') + `\n... +${lines.length - 3} lines` // 输出较长时展示前三行和剩余行数。
  }

  const lines = output
    .trim() 
    .split('\n')
    .filter((l) => l.trim())
  if (lines.length === 0) return 'Done' // 没有有效输出时展示完成状态。
  if (lines.length <= 3) return lines.join('\n') // 输出较短时完整展示。
  return lines.slice(0, 2).join('\n') + `\n... +${lines.length - 2} lines` // 输出较长时展示前两行和剩余行数。
}
