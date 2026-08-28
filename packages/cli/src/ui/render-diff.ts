// 把 core 传来的 EditDiffPayload 渲染成终端可打印的 ANSI diff。
//
// 渲染不再自己实现:unified diff 文本交给三方包 @npmcli/disparity-colors
// 着色(`-` 行红、`+` 行绿、`@@` 头品红、---/+++ 文件头黄),经典
// git diff 风格。diff 计算侧本来就用的 jsdiff(core/agent/diff.ts),
// 这个文件只剩三件事:
//   1. 把 hunk 结构序列化回 unified diff 文本(那个包只吃文本);
//   2. 行数 / 列宽两维截断 —— 必须发生在着色之前,按列宽切彩色
//      字符串会把 ANSI 转义序列从中间切断;
//   3. 加 RESULT_INDENT,让 diff 对齐滚动区里工具调用条目的缩进。
//
// 两条渲染路径:
//   - 更新路径(renderHunks):unified diff + 三方着色
//   - 新建路径(renderCreatePreview):新内容前 N 行预览,无 diff 着色
//     (整个文件都是"新增",没有可对比的旧版本,逐行涂色只是噪音)。
import { Chalk } from 'chalk'
import disparityColors from '@npmcli/disparity-colors'

import type { EditDiffPayload } from '@tegent/core'

import { sliceByWidth, visualWidth } from './text-width.js'
import { RESULT_INDENT } from './utils.js'

const c = new Chalk({ level: 3 })

/** diff 正文最多渲染的行数。几百行的大补丁在滚动区里没有可读性
 *  (用户反正会直接划过去),超过的部分折叠成 `… +N more lines`。 */
const MAX_DIFF_LINES = 60

/** 新建文件的内容预览行数。对齐 CC FileWriteToolCreatedMessage 的
 *  MAX_LINES_TO_RENDER = 10:刚创建的 package.json / 配置文件展示得
 *  够用,又不至于刷屏。 */
const MAX_CREATE_PREVIEW_LINES = 10

/** 格式化统计标题行("Added 3 lines, removed 1 line")。 */
function formatCounts(p: EditDiffPayload): string {
  if (p.isCreate) {
    const n = p.additions
    return `Created ${c.bold(String(n))} ${n === 1 ? 'line' : 'lines'}`
  }
  const parts: string[] = []
  if (p.additions > 0) {
    parts.push(`Added ${c.bold(String(p.additions))} ${p.additions === 1 ? 'line' : 'lines'}`)
  }
  if (p.removals > 0) {
    const verb = parts.length > 0 ? 'removed' : 'Removed'
    parts.push(`${verb} ${c.bold(String(p.removals))} ${p.removals === 1 ? 'line' : 'lines'}`)
  }
  if (parts.length === 0) return 'No changes'
  return parts.join(', ')
}

/** 把 hunk 列表序列化回 unified diff 文本。前两行 ---/+++ 文件头
 *  会被 disparity-colors 按 headerLength(默认 2)涂成黄色;
 *  hunk 的 lines 每行已带空格/+/- 前缀,原样透传。 */
function hunksToUnified(payload: EditDiffPayload): string {
  const out = [`--- a/${payload.filePath}`, `+++ b/${payload.filePath}`]
  for (const h of payload.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    out.push(...h.lines)
  }
  return out.join('\n')
}

/** 按可视宽度截断一行,行尾用 UTF 省略号标记截断点。
 *  用可视列数而不是 JS 字符串长度:CJK 全角字符占 2 个终端单元格
 *  但 length === 1,按 length 截断会让中文行实际溢出终端宽度,
 *  触发行中折行、在每行下面多出一个幽灵空行。 */
function fitLine(line: string, width: number): string {
  if (visualWidth(line) <= width) return line
  if (width < 1) return ''
  return sliceByWidth(line, Math.max(0, width - 1)) + '…'
}

/** 更新路径:unified 文本 → 行数/列宽截断 → 三方着色 → 加缩进。 */
function renderHunks(payload: EditDiffPayload, terminalWidth: number): string[] {
  const cols = Math.max(40, terminalWidth)
  // 预算 = 终端宽 - RESULT_INDENT 缩进,再留 1 格安全余量:行宽恰好
  // 打满最后一列时终端会进入延迟换行状态,某些 Windows 终端配置
  // 会把它记作一次换行,在行下插入幽灵空行。
  const width = Math.max(1, cols - RESULT_INDENT.length - 1)

  const allLines = hunksToUnified(payload).split('\n')
  // 前 2 行是 ---/+++ 文件头,不占 MAX_DIFF_LINES 预算。
  const header = allLines.slice(0, 2)
  const body = allLines.slice(2)
  const visible = body.slice(0, MAX_DIFF_LINES)
  const truncated = body.length - visible.length

  const lines = [...header, ...visible.map((l) => fitLine(l, width))]
  const out = disparityColors(lines.join('\n'))
    .split('\n')
    .map((l) => `${RESULT_INDENT}${l}`)
  if (truncated > 0) {
    out.push(`${RESULT_INDENT}${c.gray(`… +${truncated} more line${truncated === 1 ? '' : 's'}`)}`)
  }
  return out
}

/** 新建路径:预览新内容前 ~10 行,灰色行号 gutter,无 diff 着色。 */
function renderCreatePreview(content: string, terminalWidth: number): string[] {
  const cols = Math.max(40, terminalWidth)
  const width = Math.max(1, cols - RESULT_INDENT.length - 1)
  const allLines = content.split('\n')
  // 去掉末尾单个空行 —— 文件内容基本都以 \n 结尾,split 会多出一个
  // 不需要渲染的空字符串。
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()
  if (allLines.length === 0) return []

  const visible = allLines.slice(0, MAX_CREATE_PREVIEW_LINES)
  const truncated = allLines.length - visible.length
  const numWidth = Math.max(1, String(allLines.length).length)

  const out = visible.map((line, i) => {
    const num = String(i + 1).padStart(numWidth)
    return `${RESULT_INDENT}${c.gray(` ${num} `)}${fitLine(line, width)}`
  })
  if (truncated > 0) {
    out.push(`${RESULT_INDENT}${c.gray(`… +${truncated} ${truncated === 1 ? 'line' : 'lines'}`)}`)
  }
  return out
}

/** 渲染完整 diff 块(统计标题 + hunk 正文或内容预览),作为工具调用
 *  结果行的正文。首行会跟在 stdout-writer 输出的 `   ⎿  ` 前缀后面,
 *  所以这里不加前缀,由调用方拼接。
 *
 *  返回:
 *   - line[0]: 统计标题("Added 3 lines, removed 1 line" /
 *              "Created 20 lines")
 *   - line[1..]: diff hunk(更新路径)或内容预览(新建路径)
 *
 *  没有 hunk 的更新 payload(diff 超时兜底)只渲染标题。 */
export function renderEditDiff(payload: EditDiffPayload, terminalWidth: number): string[] {
  const header = formatCounts(payload)
  if (payload.isCreate) {
    if (!payload.content) return [header]
    return [header, ...renderCreatePreview(payload.content, terminalWidth)]
  }
  if (payload.hunks.length === 0) return [header]
  return [header, ...renderHunks(payload, terminalWidth)]
}
