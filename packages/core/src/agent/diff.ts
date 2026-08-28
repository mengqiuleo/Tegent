// tool-execution 在 writeFile / edit 成功后计算这里的结构，
// 再通过 AgentCallbacks.onFileEdit 发给 UI，让滚动区能在工具条目下展示彩色 diff。
// 模型仍然只会看到 executeWriteTool 返回的短结果字符串，例如 `File edited: ...`。
// diff payload 是 UI 侧旁路数据，不会进入 state.messages，也不会再发给模型。
import { structuredPatch } from 'diff'

// 中文导读：
// 这个文件把 writeFile/edit 的实际文件变化转成 UI 可渲染的结构化 diff。
// 它不参与模型上下文：模型只看到“文件已编辑”的短结果，彩色 diff 是给终端用户看的旁路数据。

/** 一个连续 diff hunk。
 *  形状和 diff 包的 StructuredPatchHunk 接近，但这里重新定义一份，
 *  这样外部消费者不需要为了类型依赖 diff 包。lines 中每行开头带标记：
 *  空格表示上下文，+ 表示新增，- 表示删除。 */
export interface EditDiffHunk {
  // 旧文件中该 hunk 的起始行号。
  oldStart: number
  // 旧文件中该 hunk 覆盖的行数。
  oldLines: number
  // 新文件中该 hunk 的起始行号。
  newStart: number
  // 新文件中该 hunk 覆盖的行数。
  newLines: number
  // 每行以空格/+/- 开头，分别表示上下文、增加、删除。
  lines: string[]
}

export interface EditDiffPayload {
  // 被编辑的文件路径。
  filePath: string
  // 结构化 diff hunk 列表。
  hunks: EditDiffHunk[]
  // 增加行数。
  additions: number
  // 删除行数。
  removals: number
  /** true 表示写入前文件不存在。
   *  UI 会把标题从“新增 X 行、删除 Y 行”切换成“创建 N 行”，
   *  并展示内容预览，而不是空 hunk 列表。 */
  isCreate: boolean
  /** 新文件完整内容。只在创建文件时填充，让 UI 能在“创建 N 行”标题下展示前若干行预览。
   *  更新已有文件时保持 undefined，因为那时已经有 hunk 列表可展示。 */
  content?: string
}

const CONTEXT_LINES = 3
const DIFF_TIMEOUT_MS = 5_000

/**
 * 为单个文件变化生成结构化 patch 和行数统计。
 * 如果实际没有变化，返回 null，让调用方完全省略 diff 展示。
 * 新建文件时传 oldContent: null；此时会返回无 hunk、只有新增行数和内容预览的 payload。
 */
export function computeEditDiff(
  filePath: string,
  oldContent: string | null,
  newContent: string,
): EditDiffPayload | null {
  if (oldContent === null) {
    // 新建文件没有旧内容可 diff，UI 会展示创建预览而不是 hunk。
    return {
      filePath,
      hunks: [],
      additions: countLines(newContent),
      removals: 0,
      isCreate: true,
      content: newContent,
    }
  }

  if (oldContent === newContent) return null

  // 用 diff 包生成带少量上下文的 patch；超时后仍会返回计数兜底。
  const result = structuredPatch(filePath, filePath, oldContent, newContent, undefined, undefined, {
    context: CONTEXT_LINES,
    timeout: DIFF_TIMEOUT_MS,
  })

  // structuredPatch 超时时可能返回假值。磁盘上的修改已经发生，只是没有 hunk 视图；
  // 这种情况下退回到行数摘要，比 UI 静默不显示 diff 更好。
  const hunks: EditDiffHunk[] = result?.hunks ? result.hunks.map(toHunk) : []

  let additions = 0
  let removals = 0
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) removals++
    }
  }

  if (additions === 0 && removals === 0 && hunks.length === 0) {
    // diff 超时且没有 hunk 时，手动估算行数，让标题至少合理。
    // 对纯替换来说这不是精确 diff，但比假装什么都没改更诚实。
    const oldLines = countLines(oldContent)
    const newLines = countLines(newContent)
    additions = Math.max(0, newLines - oldLines)
    removals = Math.max(0, oldLines - newLines)
  }

  return { filePath, hunks, additions, removals, isCreate: false }
}

function toHunk(h: {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}): EditDiffHunk {
  // 隔离第三方库类型，避免调用方直接依赖 diff 包的类型定义。
  return {
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }
}

/** 计算可见行数，把单个结尾换行视为行终止符。
 *  这和编辑器的行号习惯一致：一个 3 行文件无论是否以换行结尾，都算 3 行。 */
function countLines(s: string): number {
  if (s.length === 0) return 0
  const parts = s.split('\n')
  return s.endsWith('\n') ? parts.length - 1 : parts.length
}
