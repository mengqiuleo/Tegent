// AI SDK 自动执行的工具（readFile / grep / glob / listDir / webFetch / webSearch）
// 会把结果作为 tool-result part 放在 response.messages 里。
// 手动工具路径 tool-execution.ts 会把每个输出都交给 truncateToolResult，
// 但自动执行结果会绕过那条路径，完整落入 state.messages。
// 本模块遍历一次 stream 完成后产生的消息，在它们持久化进会话状态前，
// 原地应用同样的按工具截断策略。
//
// 按工具策略：
//   - shell / edit / writeFile：手动路径已经截断过。
//   - readFile：保留头尾，保留文件开头和结尾。
//   - grep / glob / listDir：只保留开头；这些结果的词典序有意义，头部足够代表时尾部信号有限。
//   - webFetch：保留头尾；页面顶部/底部常有导航噪声，但尾部锚点仍可能有用。
//   - 默认：保留头尾。
import type { ModelMessage } from 'ai'

import { truncateToolResult } from '../tools/truncate.js'
import type { TruncateOptions } from '../tools/truncate.js'

// 这个文件专门清理“模型历史里的工具结果”。AI SDK 自动执行的工具会把 tool-result
// 直接塞进 response.messages，绕过手动工具执行路径，所以这里补上两件事：
// 1. 修复 tool_call/tool_result 不成对的问题，避免下一次请求被 provider 拒绝。
// 2. 对过长的工具输出做按工具策略截断，避免历史消息把上下文窗口撑爆。

const PER_TOOL_POLICY: Record<string, TruncateOptions> = {
  readFile: { direction: 'head-tail' },
  grep: { direction: 'head', maxLines: 500 },
  glob: { direction: 'head', maxLines: 500 },
  listDir: { direction: 'head', maxLines: 500 },
  webFetch: { direction: 'head-tail' },
  webSearch: { direction: 'head-tail' },
  shell: { direction: 'head' },
}

function policyFor(toolName: string | undefined): TruncateOptions {
  if (!toolName) return { direction: 'head-tail' }
  return PER_TOOL_POLICY[toolName] ?? { direction: 'head-tail' }
}

/** 窄化后的类型。
 *  AI SDK 在线上大致会产出这种 tool-result part 形状。
 *  我们只修改认识的那一小部分，其它字段保持原样。 */
type ToolResultLike = {
  type: 'tool-result'
  toolName?: string
  output?: {
    type?: 'text' | 'content' | string
    value?: unknown
  }
}

/**
 * 遍历 messages，并从两个方向修复 tool_call 与 tool_result 的配对。
 * provider 严格要求：
 *   - 每个 assistant tool_call 都必须有配对的 tool_result。
 *   - 每个 tool_result 前面都必须有匹配 toolCallId 的 assistant tool_call。
 * 任意方向的孤儿消息都会污染下一次 API 请求，导致 provider 报工具消息配对错误。
 *
 * 孤儿消息来源：
 *   - 正向孤儿：tool_call 没有 result。模型偶尔会生成 malformed tool input，
 *     例如 todoWrite 缺必填字段。SDK 校验失败并发出 tool-error，有时不会把配对 tool-result
 *     放进 response.messages。这里会合成一个错误结果。
 *   - 反向孤儿：tool_result 前面没有 tool_call。模型工具输入校验失败时，
 *     SDK 可能把 tool_call 排除在 response.messages 外；
 *     但 processToolCalls 仍可能从 result.toolCalls promise 拿到它并执行工具，
 *     从而把 tool_result 推进 state.messages。这里会删除这种孤儿。
 *
 * 原地修改 messages。幂等，重复运行不会继续改变结果。
 */
export function repairOrphanToolCalls(messages: ModelMessage[]): void {
  // 第一遍：找出 assistant 消息里模型真正提交过的 tool_call。
  const expected = new Set<string>()
  const toolNameById = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string; toolName?: string }>) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') {
        expected.add(part.toolCallId)
        if (typeof part.toolName === 'string') toolNameById.set(part.toolCallId, part.toolName)
      }
    }
  }

  // 删除那些 toolCallId 从未出现在 assistant tool_call 中的 tool-result part。
  // 如果整条 tool message 都是孤儿，则删除整条；如果只有部分孤儿，则原地过滤。
  for (let i = messages.length - 1; i >= 0; i--) {
    // 倒序删除更安全，不会因为 splice 影响尚未扫描的索引。
    const msg = messages[i]
    if (!msg || msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    const parts = msg.content as Array<{ type?: string; toolCallId?: string }>
    const kept = parts.filter((part) => {
      if (part?.type !== 'tool-result') return true
      if (typeof part.toolCallId !== 'string') return true
      return expected.has(part.toolCallId)
    })
    if (kept.length === 0) {
      // 删除整条 tool message 可能留下 assistant -> assistant 相邻。
      // 常见形状是 assistant tool_calls -> tool results -> assistant continuation。
      // Anthropic 严格要求 user/assistant 交替；虽然 @ai-sdk/anthropic converter
      // 当前会帮我们合并连续同角色消息，但 sanitizer 的正确性不应依赖下游 SDK 行为。
      // 如果前后邻居都是 assistant，就用一条 user 文本占位替换，保住边界；
      // 否则直接删除是安全的。
      const prev = messages[i - 1]
      const next = messages[i + 1]
      if (prev?.role === 'assistant' && next?.role === 'assistant') {
        messages[i] = {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '[Stale tool result discarded — no matching tool_call in history.]',
            },
          ],
        } as ModelMessage
      } else {
        messages.splice(i, 1)
      }
    } else if (kept.length !== parts.length) {
      // AI SDK 的窄 union 类型不允许这里操作的部分 part 形状。
      // 运行时前面已经判定过结构，所以这里做结构性 cast 是安全的。
      ;(msg as { content: unknown }).content = kept
    }
  }

  // 反向孤儿处理完之后，收集已经有 tool-result 覆盖的 tool_call_id。
  const fulfilled = new Set<string>()
  // 第二遍：统计已经有 tool-result 的调用，后面只给缺失结果的调用补 synthetic result。
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        fulfilled.add(part.toolCallId)
      }
    }
  }

  // 给正向孤儿追加合成结果，并保持整体顺序。
  // 正向孤儿永远放在末尾，因为它们本来没有真实结果；位置只是为了让下一次 API 请求合法。
  // 所有孤儿 part 会收集进同一条 tool message，而不是每个 id 推一条。
  // Anthropic converter 目前会合并连续同角色消息，但 Google converter 不会；
  // OpenAI-compatible 路径反正会按 tool_call_id 拆分。发一条 tool ModelMessage
  // 对会拆分的路径等价，对不会合并的 provider 更安全。
  const orphanParts: Array<{
    // 所有补出来的 orphan result 会合并成一条 tool message，尽量符合各 provider 的历史格式。
    type: 'tool-result'
    toolCallId: string
    toolName: string
    output: { type: 'text'; value: string }
  }> = []
  for (const id of expected) {
    if (fulfilled.has(id)) continue
    const name = toolNameById.get(id) ?? 'unknown'
    orphanParts.push({
      type: 'tool-result',
      toolCallId: id,
      toolName: name,
      output: {
        type: 'text',
        value:
          'Error: Tool input failed validation (likely missing required fields). The assistant should retry with the correct schema.',
      },
    })
  }
  if (orphanParts.length > 0) {
    // 防御性处理：如果其它路径已经留下尾部 tool message，
    // 例如 processToolCalls 推了真实结果而上面没碰到，就把孤儿 part 合并进去，
    // 避免再发出第二条相邻 tool ModelMessage。
    const tail = messages[messages.length - 1]
    if (tail && tail.role === 'tool' && Array.isArray(tail.content)) {
      ;(tail.content as unknown[]).push(...(orphanParts as unknown[]))
    } else {
      messages.push({
        role: 'tool',
        content: orphanParts as never,
      } as ModelMessage)
    }
  }
}

/**
 * 原地遍历 messages，截断过大的 tool-result part。
 * 只修改 output.value 字段，其余消息结构完全保留 provider 返回的样子。
 */
export function truncateToolResultsInMessages(messages: ModelMessage[]): void {
  // 原地修改，调用点刚拿到 response.messages，还没有对外共享，复制没有收益。
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue

    for (const part of msg.content as unknown as ToolResultLike[]) {
      if (part?.type !== 'tool-result') continue
      const output = part.output
      if (!output) continue

      // 文本输出：`{ type: 'text', value: string }`
      if (output.type === 'text' && typeof output.value === 'string') {
        const truncated = truncateToolResult(output.value, policyFor(part.toolName))
        if (truncated.length !== output.value.length) {
          output.value = truncated
        }
        continue
      }

      // 内容数组输出：`{ type: 'content', value: Array<{ type: string, text?: string, ... }> }`
      // 只有 text 条目可改；image-data / file-data / file-url 是二进制 payload，
      // 交给 provider-compat 层处理。
      if (output.type === 'content' && Array.isArray(output.value)) {
        const entries = output.value as Array<{ type?: string; text?: string }>
        for (const entry of entries) {
          if (entry?.type === 'text' && typeof entry.text === 'string') {
            const truncated = truncateToolResult(entry.text, policyFor(part.toolName))
            if (truncated.length !== entry.text.length) {
              entry.text = truncated
            }
          }
        }
      }
    }
  }
}
