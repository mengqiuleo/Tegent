// 工具输出截断。
// 这个文件负责限制工具结果的大小，避免 readFile、grep、shell 等工具输出过长，
// 占满模型上下文窗口，或者让下一次 API 请求携带过多内容。
//
// 这里同时使用两个限制：
// 1. 最大行数：适合约束 grep、目录列表、普通文本文件等按行组织的输出。
// 2. 最大 UTF-8 字节数：适合约束压缩 JSON、超长单行文本和包含大量中文的内容。
//
// 只要超过其中任意一个限制，就会执行截断。
//
// 截断支持三种方向：
// - head-tail：保留开头和结尾，删除中间内容。
// - head：只保留开头。
// - tail：只保留结尾。
//
// 默认 head-tail 按 20% / 80% 分配：

/**
 * 单个工具结果默认允许的最大行数。
 *
 * 超过 2000 行时，会根据 direction 保留开头、结尾或两端内容。
 */
export const MAX_TOOL_RESULT_LINES = 2000

/**
 * 单个工具结果默认允许的最大 UTF-8 字节数。
 *
 * 50 * 1024 等于 50 KiB。
 * 这个限制既能约束超长 ASCII 单行，也能约束中文等多字节内容。
 */
export const MAX_TOOL_RESULT_BYTES = 50 * 1024

/**
 * head-tail 模式下，分配给开头内容的默认比例。
 *
 * 0.2 表示开头占 20%，剩余 80% 留给结尾。
 */
export const DEFAULT_HEAD_RATIO = 0.2

/**
 * truncateToolResult 支持的可选配置。
 */
export interface TruncateOptions {
  /**
   * 最大行数。
   *
   * 未传时使用 MAX_TOOL_RESULT_LINES。
   */
  maxLines?: number

  /**
   * 最大 UTF-8 字节数。
   *
   * 未传时使用 MAX_TOOL_RESULT_BYTES。
   */
  maxBytes?: number

  /**
   * 截断时保留哪个方向的内容：
   *
   * - head-tail：默认模式，保留开头和结尾，删除中间。
   * - head：只保留开头，适合重点信息位于前面的输出。
   * - tail：只保留结尾，适合日志等最新信息位于末尾的输出。
   */
  direction?: 'head-tail' | 'head' | 'tail'

  /**
   * head-tail 模式中，开头内容所占的比例。
   *
   * 未传时使用 DEFAULT_HEAD_RATIO。
   */
  headRatio?: number
}

/**
 * 计算字符串编码成 UTF-8 后占用的字节数。
 *
 * 不能直接使用 str.length，因为它返回的是 UTF-16 code unit 数量。
 */
function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf-8')
}

/**
 * 按字节数从 Buffer 的开头或结尾截取内容。
 *
 * 截取位置必须落在完整 UTF-8 字符边界上。
 * 如果直接在一个多字节字符中间切开，toString('utf-8') 会产生乱码。
 * @param buf 字节数
 * @param bytes 大小限制
 */
function sliceBytes(buf: Buffer, bytes: number, direction: 'head' | 'tail'): Buffer {
  if (buf.length <= bytes) return buf

  if (direction === 'head') {
    let end = bytes

    while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--

    return buf.subarray(0, end)
  }

  let start = buf.length - bytes

  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++

  return buf.subarray(start)
}

/**
 * 一次截断操作的中间结果。
 */
type SliceResult = {
  // 已经截取后的字符串。
  sliced: string

  /**
   * head-tail 模式中，开头片段结束、结尾片段开始的位置。
   *
   * 这个位置是 JavaScript 字符串下标，不是 UTF-8 字节下标。
   * 最终会在这里插入 “[truncated: ...]” 标记。
   *
   * head 或 tail 模式没有中间分界，因此值为 null。
   */
  headEnd: number | null
}

/**
 * 按最大行数截断字符串。
 *
 * 返回：
 * - result：截断后的字符串和 head-tail 分界位置。
 * - linesDropped：一共删除了多少行。
 */
function applyLineSlice(
  // 原始工具结果。
  result: string,

  // 允许保留的最大行数。
  maxLines: number,

  // 保留方向。
  direction: 'head-tail' | 'head' | 'tail',

  // head-tail 模式中分给开头的比例。
  headRatio: number,
): { result: SliceResult; linesDropped: number } {
  const lines = result.split('\n')

  if (lines.length <= maxLines) return { result: { sliced: result, headEnd: null }, linesDropped: 0 }

  if (direction === 'head') {
    return {
      result: { sliced: lines.slice(0, maxLines).join('\n'), headEnd: null },

      linesDropped: lines.length - maxLines,
    }
  }

  if (direction === 'tail') {
    return {
      result: { sliced: lines.slice(-maxLines).join('\n'), headEnd: null },
      linesDropped: lines.length - maxLines,
    }
  }

  const headLines = Math.max(1, Math.floor(maxLines * headRatio))

  const tailLines = maxLines - headLines

  const head = lines.slice(0, headLines).join('\n')
  const tail = lines.slice(-tailLines).join('\n')

  return { result: { sliced: head + '\n' + tail, headEnd: head.length }, linesDropped: lines.length - maxLines }
}

/**
 * 按最大 UTF-8 字节数继续截断一次中间结果。
 *
 * 行数截断后仍可能超出字节预算，例如：
 * - 单行压缩 JSON 特别长。
 * - 每行包含大量中文或其它多字节字符。
 */
function applyByteSlice(
  // 行截断产生的中间结果。
  input: SliceResult,

  // 最大 UTF-8 字节数。
  maxBytes: number,

  // 保留方向。
  direction: 'head-tail' | 'head' | 'tail',

  // head-tail 模式中分给开头的比例。
  headRatio: number,
): SliceResult {
  const buf = Buffer.from(input.sliced, 'utf-8')

  if (buf.length <= maxBytes) return input

  if (direction === 'head') return { sliced: sliceBytes(buf, maxBytes, 'head').toString('utf-8'), headEnd: null }
  if (direction === 'tail') return { sliced: sliceBytes(buf, maxBytes, 'tail').toString('utf-8'), headEnd: null }

  const headBudget = Math.max(256, Math.floor(maxBytes * headRatio))

  const tailBudget = maxBytes - headBudget

  const head = sliceBytes(buf, headBudget, 'head').toString('utf-8')
  const tail = sliceBytes(buf, tailBudget, 'tail').toString('utf-8')

  return { sliced: head + tail, headEnd: head.length }
}

/**
 * 按行数和 UTF-8 字节数预算截断工具输出。
 *
 * 如果原文同时满足两个预算，直接原样返回。
 * 如果发生截断，会插入一行 “[truncated: ...]” 标记，
 * 让模型知道内容是系统主动省略，而不是工具结果损坏。
 * 这个文件采用的是 “行数预算 + UTF-8 字节预算”双重截断策略。
 * 也就是默认：最多保留约 2000 行，最多保留约 50 KiB，保留开头和结尾，开头占 20%，结尾占 80%，只要同时满足行数和字节数限制，就原样返回
 * 截断顺序： 原始工具结果 -> 先按行数截断 -> 再按 UTF-8 字节数截断 -> 插入截断说明
 * 先按行截断，是为了尽量保留完整的文本行。例如 grep 输出、目录列表和源代码，不会优先从某一行的中间切开。
 * 一旦原始结果超过任意一个限制，代码就会依次调用“行截断”和“字节截断”。但每个截断函数内部都会先判断是否真的超限，不超限就原样返回。
 * 两个函数都会按顺序经过：先检查/处理行数，再检查/处理 UTF-8 字节数。但不超限的那一步只是原样返回，不会真的截断。
 */
export function truncateToolResult(result: string, options: TruncateOptions = {}): string {
  const maxLines = options.maxLines ?? MAX_TOOL_RESULT_LINES
  const maxBytes = options.maxBytes ?? MAX_TOOL_RESULT_BYTES

  const direction = options.direction ?? 'head-tail'

  const headRatio = options.headRatio ?? DEFAULT_HEAD_RATIO

  const origLines = (result.match(/\n/g)?.length ?? 0) + 1

  const origBytes = byteLength(result)

  const origChars = result.length

  if (origLines <= maxLines && origBytes <= maxBytes) return result

  const lineSlice = applyLineSlice(result, maxLines, direction, headRatio)
  const byteSlice = applyByteSlice(lineSlice.result, maxBytes, direction, headRatio)

  const droppedChars = origChars - byteSlice.sliced.length

  const marker =
    lineSlice.linesDropped > 0
      ? `[truncated: ${lineSlice.linesDropped} lines / ${droppedChars.toLocaleString()} chars dropped — narrow the tool args or read specific ranges]`
      : `[truncated: ${droppedChars.toLocaleString()} chars dropped — output exceeded byte budget]`

  if (direction === 'head') return `${byteSlice.sliced}\n\n${marker}`
  if (direction === 'tail') return `${marker}\n\n${byteSlice.sliced}`

  if (byteSlice.headEnd != null && byteSlice.headEnd > 0 && byteSlice.headEnd < byteSlice.sliced.length) {
    return `${byteSlice.sliced.slice(0, byteSlice.headEnd)}\n\n${marker}\n\n${byteSlice.sliced.slice(byteSlice.headEnd)}`
  }

  return `${marker}\n\n${byteSlice.sliced}`
}
