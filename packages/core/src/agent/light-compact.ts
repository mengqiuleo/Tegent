// 主压缩路径 compression.ts 里的 compressMessages 会额外调用一次 generateText，
// 既有网络往返，也要完整扫一遍消息。若上下文膨胀主要来自很明确的来源，
// 例如 loop guard 已经标记过的重复工具失败，这种完整摘要就有点浪费。
//
// 本模块做一次便宜的 O(n) 扫描，删除那些可以安全丢弃、且不会损失有效信号的消息：
//   - tool-call + tool-result 成对出现，且 result 是 [loop-guard] 提醒的消息。
//     模型已经被告知停止，回放这些被阻断的调用不会提供新信息。
//   - 旧的 PowerShell 噪声错误栈 tool-result，只保留最新一个错误形状供模型参考。
//
// 调用方应在调用 LLM 摘要器之前先运行这里，让摘要器处理更有信号密度的剩余消息。
import type { ModelMessage } from 'ai'

// 这里是“不调用模型”的轻量上下文瘦身层。它只删除或替换明显低价值的历史：
// loop-guard 已经阻断过的重复工具调用，以及老旧的大型 tool_result。
// 目标是在不破坏消息结构的前提下尽量延后真正的 LLM 摘要压缩。

/** 一看到就应删除的 tool-result 内容前缀。 */
const LOOP_GUARD_SENTINEL = '[loop-guard]'

// SDK 里的 tool-result part 类型比较宽，这里不需要完整建模，只取 type/toolCallId/output。
type ToolResultPartLike = {
  // part 类型，例如 `tool-result`、`tool-call`、`text` 等；这里用可选是为了容忍未知结构。
  type?: string

  // tool-call 和 tool-result 通过同一个 toolCallId 配对。
  toolCallId?: string

  // 工具返回内容；文本输出通常长在 output.value 里。
  output?: { type?: string; value?: unknown }
}

// 判断一个 tool-result part 是不是“可以直接删除”的目标。
function isToolResultDropTarget(part: ToolResultPartLike): boolean {
  if (part?.type !== 'tool-result') return false

  const output = part.output
  if (!output) return false

  // 只有纯文本输出才检查前缀；非文本输出可能是结构化数据，保守保留。
  if (output.type === 'text' && typeof output.value === 'string') {
    return output.value.startsWith(LOOP_GUARD_SENTINEL)
  }

  return false
}

// 判断整条消息里是否包含应删除的 loop-guard tool-result。
function hasDropTargetResult(msg: ModelMessage): boolean {
  if (msg.role !== 'tool') return false

  const parts = msg.content as unknown as ToolResultPartLike[]

  if (!Array.isArray(parts)) return false

  return parts.some(isToolResultDropTarget)
}

/** 从 assistant 消息里删除指定 id 集合对应的 tool-call part。
 *  如果无需修改，原样返回；如果有修改，返回过滤后的浅拷贝；
 *  如果所有 part 都被删掉，返回 null，让调用方删除整条消息。 */
function stripToolCallParts(msg: ModelMessage, idsToRemove: Set<string>): ModelMessage | null {
  // 删除 tool-result 的同时，也要从对应 assistant 消息里删掉 tool-call，否则会留下 forward orphan。
  // “orphan” 指 assistant 说要调用某个工具，但后续历史里已经没有对应 tool-result。
  if (msg.role !== 'assistant') return msg

  // assistant 消息可能是字符串，也可能是 part 数组；只有数组里才可能有 tool-call part。
  const content = msg.content as unknown as Array<{ type?: string; toolCallId?: string }>

  // 非数组内容没有 tool-call part 可以删，直接保留原消息。
  if (!Array.isArray(content)) return msg

  // changed 用来记录这条 assistant 消息是否真的被改过。
  let changed = false

  // 过滤掉 toolCallId 在 idsToRemove 里的 tool-call part，其它 part 原样保留。
  const filtered = content.filter((part) => {
    // 只有 tool-call part 且有字符串 id 时，才参与删除判断。
    if (part?.type === 'tool-call' && typeof part.toolCallId === 'string' && idsToRemove.has(part.toolCallId)) {
      // 标记发生过修改，后面需要返回浅拷贝或 null。
      changed = true

      // 返回 false 表示把这个 part 从 filtered 结果中删除。
      return false
    }

    // 其它 part，例如文本解释、其它工具调用，都继续保留。
    return true
  })

  // 如果没有删掉任何 part，直接返回原对象，减少不必要的对象创建。
  if (!changed) return msg

  // 如果删完后 assistant 消息没有任何 part 了，整条消息也没有保留价值。
  if (filtered.length === 0) return null

  // 返回浅拷贝：其它字段沿用原消息，只替换 content 为过滤后的 part 列表。
  return { ...msg, content: filtered } as ModelMessage
}

/** 收集那些 tool-result 是 loop-guard 提醒的 toolCallId。 */
function collectLoopGuardedIds(messages: ModelMessage[]): Set<string> {
  const ids = new Set<string>()

  for (const msg of messages) {
    if (msg.role !== 'tool') continue

    const parts = msg.content as unknown as ToolResultPartLike[]

    if (!Array.isArray(parts)) continue

    for (const part of parts) {
      if (isToolResultDropTarget(part) && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }

  return ids
}

export interface LightCompactResult {
  // 压缩后的消息数组；可能是原数组，也可能是新数组。
  messages: ModelMessage[]

  /** 删除的消息数。UI/telemetry 可以展示它；如果为 0，调用方可能仍要继续走 LLM 摘要器。 */
  dropped: number
}

/**
 * 从消息数组里删除 loop-guard 的 tool-call/result 对。
 * 其它消息完全不动，并且不修改输入数组。
 * lightCompactMessages：删除已经被 loop-guard 阻断的工具调用记录。也就是 assistant 发起的 tool-call 和对应的 [loop-guard] tool-result 一起删掉，避免历史里留下没意义的失败循环。
 */
export function lightCompactMessages(messages: ModelMessage[]): LightCompactResult {
  const idsToRemove = collectLoopGuardedIds(messages)
  if (idsToRemove.size === 0) return { messages, dropped: 0 }

  const out: ModelMessage[] = []

  let dropped = 0

  for (const msg of messages) {
    if (hasDropTargetResult(msg)) {
      dropped++
      continue
    }

    const stripped = stripToolCallParts(msg, idsToRemove)

    if (stripped == null) {
      dropped++
      continue
    }

    out.push(stripped)
  }

  return { messages: out, dropped }
}

// ---- 智能截断 tool-result ----
//
// 这是 loop-guard 删除器和昂贵 LLM 摘要器之间的中间压缩层。
// 它把老旧的大型 tool_result 替换成短 stub，保留“做过什么”的元数据，
// 同时回收大部分 token。stub 包含工具名、输出规模和少量预览，
// 让模型能决定是否需要重新运行工具。
//
// 设计目标是延后完整压缩。完整压缩会让整个 prompt cache 失效；
// 这里则在不改写消息结构的前提下释放上下文。

/** 这些工具的结果代表决策，或本来已经很紧凑，永远不截断。 */
const NEVER_TRUNCATE_TOOLS = new Set([
  // edit/writeFile 的输出代表真实文件修改结果，截断可能让模型忘记已经改过什么。
  'edit',
  'writeFile',

  // task 是子代理结果，通常已经是摘要或决策信息，不宜再截掉。
  'task',

  // activateSkill/todoWrite/askUser/plan mode 相关结果通常很短，并且影响控制流或状态。
  'activateSkill',
  'todoWrite',
  'askUser',
  'enterPlanMode',
  'exitPlanMode',
])

/** 只有文本超过这个字符数才截断。 */
const MIN_TRUNCATABLE_CHARS = 500

/** 最近多少条消息受保护，不参与截断。 */
const KEEP_RECENT_MESSAGES = 10

/** stub 预览中保留原输出前几行。 */
const PREVIEW_LINES = 3

// 把一段很长的工具输出替换成短说明，保留元数据和开头预览。
function buildStub(toolName: string | undefined, value: string): string {
  const lineCount = value.split('\n').length

  const preview = value.split('\n').slice(0, PREVIEW_LINES).join('\n')

  const name = toolName ?? 'unknown'

  return (
    `[Truncated: ${name} output — ${lineCount} lines, ${value.length} chars. ` +
    `Content removed to save context. Re-run the tool if you need the full output.]\n` +
    preview
  )
}

export interface TruncateOldToolResultsResult {
  // 返回同一个 messages 引用；函数会原地改旧 tool-result 的 output.value。
  messages: ModelMessage[]

  // 本次实际截断了多少个 tool-result part。
  truncatedCount: number

  // 粗略统计节省了多少字符，方便调用方判断压缩收益。
  charsSaved: number
}

/**
 * 把老旧的大型 tool_result 文本替换成紧凑 stub。
 * 为了效率会原地修改 messages，因为这里运行在本来就可变的 state.messages 上。
 * 返回统计信息，调用方据此决定是否继续做完整压缩。
 * truncateOldToolResults：不删消息，只把很旧、很长的工具输出压成短 stub。最近 10 条消息不动，edit/writeFile/task 这些关键工具也不截断，避免模型忘掉重要状态。
 */
export function truncateOldToolResults(messages: ModelMessage[]): TruncateOldToolResultsResult {
  // protectedStart 是“受保护的最近消息区间”的起点。
  // 例如总共 30 条，KEEP_RECENT_MESSAGES=10，则只考虑下标 0..19 的旧消息。
  const protectedStart = Math.max(0, messages.length - KEEP_RECENT_MESSAGES)

  // 最近消息通常是模型下一步最需要的上下文，所以只压缩 protectedStart 之前的旧消息。
  let truncatedCount = 0

  // 统计截断前后字符串长度差；只是估算，不等于真实 token 数。
  let charsSaved = 0

  for (let i = 0; i < protectedStart; i++) {
    const msg = messages[i]

    if (!msg || msg.role !== 'tool') continue

    if (!Array.isArray(msg.content)) continue

    for (const part of msg.content as unknown as ToolResultPartLike[]) {
      if (part?.type !== 'tool-result') continue

      const output = part.output
      if (!output) continue

      const toolName = (part as { toolName?: string }).toolName

      // 决策类或本来很短的工具永远不截断，避免丢掉关键状态。
      if (toolName && NEVER_TRUNCATE_TOOLS.has(toolName)) continue

      if (output.type === 'text' && typeof output.value === 'string') {
        if (output.value.length < MIN_TRUNCATABLE_CHARS) continue
        if (output.value.startsWith('[Truncated:')) continue

        const original = output.value
        output.value = buildStub(toolName, original)
        charsSaved += original.length - (output.value as string).length
        truncatedCount++
      }
    }
  }

  return { messages, truncatedCount, charsSaved }
}
