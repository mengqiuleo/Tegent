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
// 开头保留 20%，结尾保留 80%。这样既能看到文件/结果的起始上下文，
// 又能保留通常更接近最新状态的结尾内容。
//
// 为什么不再单独增加“字符数限制”：
// - ASCII 文本中，一个字符基本就是一个 UTF-8 字节，字符限制和字节限制重复。
// - 中文等非 ASCII 字符通常占多个 UTF-8 字节，字节数更接近真实传输体积。
// - JavaScript 的 string.length 统计的是 UTF-16 code unit，并不等于真实 UTF-8 大小。

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
  // Buffer.byteLength 会按指定编码计算真实字节数，但不会创建完整 Buffer 副本。
  return Buffer.byteLength(str, 'utf-8')
}

/**
 * 按字节数从 Buffer 的开头或结尾截取内容。
 *
 * 截取位置必须落在完整 UTF-8 字符边界上。
 * 如果直接在一个多字节字符中间切开，toString('utf-8') 会产生乱码或替代字符 “�”。
 */
function sliceBytes(buf: Buffer, bytes: number, direction: 'head' | 'tail'): Buffer {
  // Buffer 本来就没有超过预算，不需要创建切片，直接返回原对象。
  if (buf.length <= bytes) return buf

  // head 表示从开头保留指定字节数。
  if (direction === 'head') {
    // 先假设截断终点就是字节预算位置。
    let end = bytes

    // UTF-8 延续字节的高两位是 10，即 `(byte & 0xc0) === 0x80`。
    // 如果 end 落在延续字节上，就不断向前退，直到完整字符的起始边界。
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--

    // 返回从 Buffer 开头到安全终点的视图。
    return buf.subarray(0, end)
  }

  // tail 表示从结尾向前保留指定字节数。
  // 先计算理论起点。
  let start = buf.length - bytes

  // 如果理论起点落在 UTF-8 延续字节中间，就向后移动到下一个完整字符边界。
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++

  // 返回安全起点到 Buffer 结尾的视图。
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
  // 按换行符拆分。数组长度就是当前行数。
  const lines = result.split('\n')

  // 行数没有超过预算时，保持原文不变，也没有删除任何行。
  if (lines.length <= maxLines) return { result: { sliced: result, headEnd: null }, linesDropped: 0 }

  // head 模式只保留前 maxLines 行。
  if (direction === 'head') {
    return {
      // slice(0, maxLines) 取前 maxLines 行，再重新用换行符连接。
      result: { sliced: lines.slice(0, maxLines).join('\n'), headEnd: null },

      // 原始行数减去保留行数，就是删除行数。
      linesDropped: lines.length - maxLines,
    }
  }

  // tail 模式只保留最后 maxLines 行。
  if (direction === 'tail') {
    return {
      // 负数下标表示从数组末尾向前取。
      result: { sliced: lines.slice(-maxLines).join('\n'), headEnd: null },
      linesDropped: lines.length - maxLines,
    }
  }

  // head-tail 模式至少给开头保留 1 行。
  const headLines = Math.max(1, Math.floor(maxLines * headRatio))

  // 剩余行数全部分配给结尾。
  const tailLines = maxLines - headLines

  // 拼出开头片段。
  const head = lines.slice(0, headLines).join('\n')

  // 拼出结尾片段。
  const tail = lines.slice(-tailLines).join('\n')

  // 先用一个换行连接两段。
  // headEnd 记录开头片段的字符串长度，最终会在这个位置插入截断标记。
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
  // 把字符串编码成 UTF-8 Buffer，后续按真实字节数裁剪。
  const buf = Buffer.from(input.sliced, 'utf-8')

  // 字节数没有超过预算时，保持行截断结果不变。
  if (buf.length <= maxBytes) return input

  // head 模式从 Buffer 开头保留 maxBytes，并转回 UTF-8 字符串。
  if (direction === 'head') return { sliced: sliceBytes(buf, maxBytes, 'head').toString('utf-8'), headEnd: null }

  // tail 模式从 Buffer 结尾保留 maxBytes，并转回 UTF-8 字符串。
  if (direction === 'tail') return { sliced: sliceBytes(buf, maxBytes, 'tail').toString('utf-8'), headEnd: null }

  // head-tail 模式给开头至少保留 256 字节。
  // 这能避免 maxBytes 较小时，开头片段小到几乎没有上下文。
  const headBudget = Math.max(256, Math.floor(maxBytes * headRatio))

  // 剩余字节预算全部分给结尾。
  const tailBudget = maxBytes - headBudget

  // 从完整 Buffer 开头安全截取 headBudget 字节。
  const head = sliceBytes(buf, headBudget, 'head').toString('utf-8')

  // 从完整 Buffer 结尾安全截取 tailBudget 字节。
  const tail = sliceBytes(buf, tailBudget, 'tail').toString('utf-8')

  // 两段先直接连接，最终由 truncateToolResult 在 headEnd 位置插入标记和换行。
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
  // 读取最大行数配置；未传时使用默认值。
  const maxLines = options.maxLines ?? MAX_TOOL_RESULT_LINES

  // 读取最大字节数配置；未传时使用默认值。
  const maxBytes = options.maxBytes ?? MAX_TOOL_RESULT_BYTES

  // 读取截断方向；默认保留开头和结尾。
  const direction = options.direction ?? 'head-tail'

  // 读取 head-tail 的开头比例；默认是 20%。
  const headRatio = options.headRatio ?? DEFAULT_HEAD_RATIO

  // 换行符数量加 1，得到原始行数。
  // 即使字符串为空，这个公式也会得到 1 行。
  const origLines = (result.match(/\n/g)?.length ?? 0) + 1

  // 计算原始 UTF-8 字节数。
  const origBytes = byteLength(result)

  // 保存原始 JavaScript 字符串长度，用于计算最终删除了多少字符。
  const origChars = result.length

  // 行数和字节数都没有超限，直接返回原始字符串。
  if (origLines <= maxLines && origBytes <= maxBytes) return result

  // 第一步先按行截断。
  // 这样能尽量保留 grep、listDir 等工具输出的完整行结构。
  const lineSlice = applyLineSlice(result, maxLines, direction, headRatio)

  // 第二步再按 UTF-8 字节截断。
  // 行数合格并不代表字节数合格，例如超长单行或中文密集内容。
  const byteSlice = applyByteSlice(lineSlice.result, maxBytes, direction, headRatio)

  // 用原始字符串长度减去最终字符串长度，计算删除的字符数量。
  // 这里仅用于提示模型，不作为预算判断依据。
  const droppedChars = origChars - byteSlice.sliced.length

  // 构造截断说明。
  // 如果按行截断过，就同时报告删除行数和字符数；
  // 否则说明是因为超过字节预算而截断。
  const marker =
    lineSlice.linesDropped > 0
      ? `[truncated: ${lineSlice.linesDropped} lines / ${droppedChars.toLocaleString()} chars dropped — narrow the tool args or read specific ranges]`
      : `[truncated: ${droppedChars.toLocaleString()} chars dropped — output exceeded byte budget]`

  // head 模式把截断说明放在保留内容的后面。
  if (direction === 'head') return `${byteSlice.sliced}\n\n${marker}`

  // tail 模式把截断说明放在保留内容的前面。
  if (direction === 'tail') return `${marker}\n\n${byteSlice.sliced}`

  // head-tail 模式如果存在有效分界位置，
  // 就把截断说明插入开头片段和结尾片段之间。
  if (byteSlice.headEnd != null && byteSlice.headEnd > 0 && byteSlice.headEnd < byteSlice.sliced.length) {
    return `${byteSlice.sliced.slice(0, byteSlice.headEnd)}\n\n${marker}\n\n${byteSlice.sliced.slice(byteSlice.headEnd)}`
  }

  // 如果没有有效的 head-tail 分界，例如某个预算极端到只留下单侧内容，
  // 就把标记放在保留内容之前。
  return `${marker}\n\n${byteSlice.sliced}`
}
