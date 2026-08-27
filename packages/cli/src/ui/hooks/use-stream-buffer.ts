//
// 文本增量会先累积到 `bufferRef`。
// 每收到一次增量后，我们都会寻找最近的单个 `\n` 位置。
// 这个位置之前的前缀不能结束在仍然打开的多行 markdown 结构中。
// 找到安全位置后，前缀会作为 `streamingChunk` 消息提交给 UI。
// 安全位置之后的内容继续留在缓冲区，等待和后续增量合并。
// 如果一直找不到安全位置，则等到流结束时由 `flushBuffer()` 强制排空。
//
// 为什么按行切，而不是按段落切：
// 如果只在段落分隔符 `\n\n` 处切分，长回答会一块一块跳出来。
// 这种方式可读，但在流式输出时颗粒感明显。
// 在每个安全的 `\n` 处切分，可以让内容按行出现。
// 这更接近 Claude Code 的体验：它在每个增量到达时重渲整段文本，
// 只是隐藏尚未完成的尾行，直到下一个 `\n` 到达。
// 当前架构一旦把内容追加到回滚区，就不能任意重渲过去的文本。
// 因此，在 append-only 架构里，带保护的按行切分是最接近的方案。
//
// 为什么需要打开块检查：
// marked 的 lexer 需要在一次解析中拿到完整结构，才能正确格式化表格、代码围栏、连续列表和引用块。
// 如果单独提交 `| a | b |\n`，它会被解析为普通段落，渲染结果里会出现原始管道符。
// 如果先提交 `- item 1\n`，再单独提交 `- item 2\n`，
// 它们会被解析成两个只有一项的列表，中间可能出现不该有的垂直间隔。
// 因此边界检查会在最后一行看起来仍属于未闭合结构时继续保留缓冲区。
// 只有遇到非延续行、普通段落、标题，或明确关闭块的空行时才释放。
//
// 更简单的“缓冲整段回复”会彻底牺牲流式体验。
// 更简单的“遇到每个 `\n` 都提交”会破坏表格和列表。
// 当前的带保护按行切分位于两者之间。
//
// 在安全边界切分之上，这里还会把短时间窗口内的连续提交合并成一次 appendMessage。
// 模型经常连续发出几个很短的段落或分隔符，例如 `...整理：\n\n`、`---\n\n`、`## 标题\n\n`。
// 如果每段都触发一次 setState，就会造成 ChatInput render 和 stdout 重绘过于密集。
// 在一些不能完美原子化 DEC 2026 同步更新的终端里，尤其是 VS Code 内嵌的 xterm.js，
// 同一帧内多次大块重绘会表现为可见闪烁。
// 约 32ms 的延迟窗口大约等于 60Hz 下两帧，短于 provider 常见的 80-200ms 增量间隔，
// 也低于人类可感知阈值，让同一窗口内的提交共用一次 React render 和一次 stdout 写入。
import { useCallback, useRef } from 'react' // 导入 React hook，用于创建稳定回调和跨渲染保存可变状态。

import type { DisplayMessage, ModelMessage } from '@tegent/core' // 导入展示消息和模型消息类型。

/**
 * 判断文本是否结束在未闭合的多行 markdown 结构内部。
 *
 * @param text - 要检查的 markdown 文本前缀。
 * @returns 如果文本末尾仍处于需要整体解析的结构中，则返回 `true`。
 *
 * 这里只保留拆开后视觉渲染会明显出错的结构：
 *
 * - 代码围栏：行首 ``` 数量为奇数时，说明围栏仍处于打开状态。
 * - 表格：最后一个非空行以 `|` 开头时，说明表格可能尚未完整。
 *
 * 列表和引用在这里有意不保留。
 * 普通单行列表项和引用行逐行解析后再拼接，视觉上与整块解析接近。
 * 少数多行列表项的懒延续行可能变成单独段落，但换来的是列表项可以逐项流式出现。
 */
function hasOpenMarkdownBlock(text: string): boolean {
  const fences = text.match(/^```/gm) // 查找所有位于行首的代码围栏起始标记。
  if (fences && fences.length % 2 !== 0) return true // 围栏数量为奇数表示代码块尚未关闭。

  const lines = text.split('\n') // 按换行符拆成行，便于检查最后一行。
  // 如果文本以换行结尾，split 会额外产生一个尾部空字符串。
  // 这个空字符串只是拆分副产物，不是真实的空白行，所以这里移除它。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return false // 没有实际行时，不可能处于打开的 markdown 块内。

  const lastLine = lines[lines.length - 1] // 读取最后一个实际行。
  if (lastLine.trim() === '') return false // 空行通常显式结束 markdown 块，因此视为安全。
  if (lastLine.trimStart().startsWith('|')) return true // 以管道符开头的末行可能是未完整解析的表格。
  return false // 其它情况视为没有未闭合块。
}

/**
 * 查找 `text` 中最近的安全换行边界。
 *
 * @param text - 当前滚动缓冲区里的文本。
 * @returns 安全边界后一位的索引；找不到安全边界时返回 `-1`。
 *
 * “安全”表示提交到该 `\n` 为止的前缀不会结束在未闭合的多行块中。
 * 这样 markdown 渲染器就能拿到足够完整的内容进行格式化。
 * 函数从末尾向前扫描，因此第一次命中的位置就是最新的安全切分点。
 */
function findSafeBoundary(text: string): number {
  let scan = text.length // 从文本末尾开始向前查找换行符。
  while (scan > 0) {
    const found = text.lastIndexOf('\n', scan - 1) // 查找当前扫描位置之前最近的换行符。
    if (found < 0) return -1 // 没有换行符时，说明不存在可提交的完整行。
    const prefix = text.slice(0, found + 1) // 截出包含该换行符的候选前缀。
    if (!hasOpenMarkdownBlock(prefix)) {
      return found + 1 // 候选前缀没有未闭合 markdown 块，可以在换行后切分。
    }
    scan = found // 候选不安全时，继续向更早的换行符扫描。
  }
  return -1 // 扫描结束仍未找到安全位置。
}

// 当代码围栏打开时，普通安全边界逻辑会一直保留内容直到围栏关闭。
// 对 100 行以上的长代码块来说，这会造成一次巨大的提交。
// 巨大提交中的预滚动换行会在终端回滚区留下可见空白行。
// 为避免这种情况，缓冲区在打开的代码围栏内超过阈值时，会强制按行提交一次。
// markdown 渲染器的 `code` token handler 输出原始文本，所以在围栏内部拆分视觉上等价。
const CODE_FENCE_COMMIT_THRESHOLD = 800 // 打开代码围栏内触发中间提交的字符阈值。

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
 * 流式缓冲 hook 暴露给调用方的操作集合。
 */
export interface StreamBufferApi {
  /**
   * 接收 agent loop 发来的文本增量。
   *
   * 每当滚动缓冲区中出现完整且安全的换行结尾子串时，
   * 就会发出一条 `streamingChunk` 消息。
   * 尾部尚未完成的一行会继续留在缓冲区。
   */
  appendTextDelta: (delta: string) => void

  /**
   * 把剩余的尾部文本作为最终 `streamingChunk` 发出。
   *
   * 通常在工具调用边界或本轮结束时调用，用于排空缓冲区。
   */
  flushBuffer: () => void

  /**
   * 丢弃所有尚未发出的缓冲文本。
   */
  resetBuffer: () => void
}

let streamChunkSeq = 0 // 全局递增序号，避免同一毫秒内生成重复 streaming chunk id。

/**
 * 创建一条 assistant 流式片段展示消息。
 *
 * @param content - 要追加到 UI 的流式文本内容。
 * @returns 带 `streamingChunk` 标记的展示消息。
 */
function makeStreamChunkMessage(content: string): DisplayMessage {
  return {
    id: `stream-${Date.now()}-${streamChunkSeq++}`, // 使用时间戳和递增序号组合生成唯一 id。
    role: 'assistant', // 流式文本属于 assistant 输出。
    content, // 保存本次提交的文本片段。
    streamingChunk: true, // 标记为流式片段，供渲染层使用连续输出样式。
    timestamp: Date.now(), // 记录片段生成时间。
  }
}

/**
 * 合并提交的固定延迟窗口。
 *
 * 第一次提交会启动计时器。
 * 在计时器触发前到达的后续提交会加入同一次发射。
 * 150ms 低于人对“停顿”的常见感知阈值，同时足够吸收多数段落、分隔符和标题的连续小突发。
 * 相比更短的 48ms 窗口，这能大约减半终端大帧重绘频率。
 * 代价是段落会以稍大一点的批次出现。
 */
const COMMIT_BATCH_MS = 150 // 合并多个安全提交的延迟毫秒数。

/**
 * 管理 assistant 流式文本的安全提交、合并和排空。
 *
 * @param appendMessage - 向 UI 展示状态追加消息的函数。
 * @returns 用于追加增量、排空缓冲和重置缓冲的 API。
 */
export function useStreamBuffer(appendMessage: (msg: DisplayMessage) => void): StreamBufferApi {
  /**
   * 累积缓冲区。
   *
   * 保存上一次安全边界提交或 flush 之后尚未发出的文本。
   */
  const bufferRef = useRef<string>('')

  /**
   * 等待合并发射的安全边界片段。
   *
   * 延迟计时器触发或 flushBuffer 排空时会清空它。
   */
  const pendingChunksRef = useRef<string[]>([])

  /**
   * 延迟发射计时器。
   *
   * 为 `null` 表示当前没有等待发射的片段。
   */
  const emitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 立即发射所有等待合并的片段。
   *
   * @returns 无返回值。
   */
  const drainPending = useCallback(() => {
    if (emitTimerRef.current !== null) {
      clearTimeout(emitTimerRef.current) // 已经准备立即发射时，先取消延迟计时器。
      emitTimerRef.current = null // 清空计时器引用，表示没有待触发任务。
    }
    const chunks = pendingChunksRef.current // 读取当前等待发射的片段列表。
    if (chunks.length === 0) return // 没有片段时无需追加消息。
    pendingChunksRef.current = [] // 先清空等待队列，避免 appendMessage 期间重复发射。
    // 只有一个片段时直接复用原字符串，避免不必要的 join 分配。
    // 这是段落稳定后最常见的情况。
    const combined = chunks.length === 1 ? chunks[0] : chunks.join('')

    appendMessage(makeStreamChunkMessage(combined)) // 把合并后的文本追加为一条流式展示消息。
  }, [appendMessage])

  /**
   * 把一个安全片段加入待发射队列。
   *
   * @param chunk - 已经通过安全边界检查的文本片段。
   * @returns 无返回值。
   */
  const queueChunk = useCallback(
    (chunk: string) => {
      pendingChunksRef.current.push(chunk) // 把新片段放入等待合并队列。
      if (emitTimerRef.current === null) {
        emitTimerRef.current = setTimeout(drainPending, COMMIT_BATCH_MS) // 首个片段启动延迟发射计时器。
      }
      // 如果计时器已经存在，新片段会搭乘当前截止时间一起发射。
      // 这样长突发不会不断延长等待时间。
    },
    [drainPending],
  )

  /**
   * 接收并处理一段模型文本增量。
   *
   * @param delta - provider 发来的新增文本。
   * @returns 无返回值。
   */
  const appendTextDelta = useCallback(
    (delta: string) => {
      if (!delta) return // 空增量没有任何状态变化，直接跳过。

      bufferRef.current += delta // 把新文本追加到滚动缓冲区。
      const boundary = findSafeBoundary(bufferRef.current) // 尝试寻找最新的安全换行边界。
      if (boundary > 0) {
        const chunk = bufferRef.current.slice(0, boundary) // 截出可安全提交的前缀。
        bufferRef.current = bufferRef.current.slice(boundary) // 把剩余尾部留在缓冲区等待后续增量。

        queueChunk(chunk) // 将安全片段放入合并发射队列。
      } else if (bufferRef.current.length > CODE_FENCE_COMMIT_THRESHOLD && hasOpenMarkdownBlock(bufferRef.current)) {
        // 大型打开代码围栏：在最后一个换行处强制中间提交。
        // 这样终端不需要一次性预滚动一百多行空白。
        const lastNL = bufferRef.current.lastIndexOf('\n')
        if (lastNL > 0) {
          const chunk = bufferRef.current.slice(0, lastNL + 1) // 截出到最后一个换行符为止的内容。
          bufferRef.current = bufferRef.current.slice(lastNL + 1) // 保留最后换行后的尾部内容。

          queueChunk(chunk) // 将强制切出的片段加入合并发射队列。
        }
      }
    },
    [queueChunk],
  )

  /**
   * 排空缓冲区和等待合并的片段。
   *
   * @returns 无返回值。
   */
  const flushBuffer = useCallback(() => {
    // turn 结束或工具调用边界意味着不会再有后续增量。
    // 因此无论剩余内容是否是未闭合表格，都必须排空。
    // 这里把 pending chunks 和剩余文本合并为单条消息。
    // 如果分别发射，会造成连续两次 setState、render 和 flush，正好抵消批处理想避免的闪烁。
    if (emitTimerRef.current !== null) {
      clearTimeout(emitTimerRef.current) // flush 要立即发射，因此取消延迟计时器。
      emitTimerRef.current = null // 清空计时器引用。
    }
    const remainder = bufferRef.current // 读取尚未提交的尾部文本。
    bufferRef.current = '' // 清空滚动缓冲区。
    if (remainder) pendingChunksRef.current.push(remainder) // 有尾部文本时并入待发射队列。
    if (pendingChunksRef.current.length === 0) return // 没有任何待发射内容时结束。
    const chunks = pendingChunksRef.current // 读取待发射片段。
    pendingChunksRef.current = [] // 清空队列，避免重复发射。
    const combined = chunks.length === 1 ? chunks[0] : chunks.join('') // 单片段复用，多片段拼接。

    appendMessage(makeStreamChunkMessage(combined)) // 追加最终流式片段消息。
  }, [appendMessage])

  /**
   * 丢弃所有缓冲内容并取消等待中的发射。
   *
   * @returns 无返回值。
   */
  const resetBuffer = useCallback(() => {
    if (emitTimerRef.current !== null) {
      clearTimeout(emitTimerRef.current) // 取消尚未触发的延迟发射。
      emitTimerRef.current = null // 清空计时器引用。
    }
    pendingChunksRef.current = [] // 丢弃等待合并的安全片段。
    bufferRef.current = '' // 丢弃滚动缓冲区中的尾部文本。
  }, [])

  return { appendTextDelta, flushBuffer, resetBuffer } // 暴露给调用方的三个缓冲控制函数。
}
