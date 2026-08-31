import type { DisplayMessage, DisplayToolCall, ModelMessage } from '@tegent/core'
import { extractText } from '@tegent/core'

/**
 * 对模型消息内容片段的宽松描述。
 *
 * 不同 provider 或 SDK 版本可能带来略有差异的字段形态，
 * 因此这里把字段都声明为可选，读取时再做防御式判断。
 */
type ContentPartLike = {
  type?: string // 内容片段类型，例如 `tool-call`、`tool-result` 或 `text`。
  text?: string // 文本片段中的正文。
  toolCallId?: string // 工具调用 id，用于把 tool-result 对回对应的 tool-call。
  toolName?: string // 工具名称，用于展示工具调用。
  input?: unknown // 工具输入，来源可能不稳定，所以先保持 unknown。
  output?: unknown // 工具输出，来源可能是字符串或结构化对象。
}

/**
 * 从工具结果片段中读取字符串输出和错误标记。
 *
 * @param part - 可能包含工具结果的内容片段。
 * @returns 标准化后的工具输出文本，以及该输出是否表示错误。
 *
 * AI SDK 通常会把工具输出规范化为 `{ type: 'text' | 'error-text' | ..., value: string }`。
 * 旧版本或 provider 特定实现也可能直接透传其它形态，所以这里会防御式转换。
 */
function readToolOutput(part: ContentPartLike): { output: string; isError: boolean } {
  const out = part.output as { type?: string; value?: unknown } | string | undefined 
  if (typeof out === 'string') return { output: out, isError: false } 
  if (out && typeof out === 'object') {
    const isError = out.type === 'error-text' || out.type === 'error-json' // error-text 和 error-json 都表示工具执行错误。
    const value = out.value // 读取标准化对象中的真实输出值。
    if (typeof value === 'string') return { output: value, isError } 
    if (value !== undefined) return { output: JSON.stringify(value), isError } 
  }
  return { output: '', isError: false }
}

/**
 * 将已加载的 `ModelMessage[]` 还原为 ChatInput 可渲染的 `DisplayMessage[]`。
 *
 * @param messages - 来自模型或持久化历史的消息列表。
 * @returns 供 UI 渲染的展示消息列表。
 *
 * 含有 N 个工具调用的 assistant 消息会拆成 N+1 条 DisplayMessage：
 * 如果有文本，先产生一条纯文本消息，再为每个工具调用产生一条工具调用消息。
 * 这样可以逐字保持实时 agent 流程里的渲染模式。
 * 即使一个 turn 中出现多个并行工具调用，它们仍会显示成分开的 `⎿` 行。
 *
 * tool 角色消息不会直接成为独立 DisplayMessage。
 * 它们的输出会通过 `toolCallId` 拼接到匹配的工具调用 DisplayMessage 上。
 */
export function modelMessagesToDisplay(messages: ModelMessage[]): DisplayMessage[] {
  const toolResults = new Map<string, { output: string; isError: boolean }>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as ContentPartLike[]) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        toolResults.set(part.toolCallId, readToolOutput(part)) // 把工具结果挂到对应 toolCallId 下。
      }
    }
  }
  const out: DisplayMessage[] = [] 
  let counter = 0
  const baseTs = Date.now() - messages.length 
  for (const msg of messages) {
    counter++
    if (msg.role === 'system' || msg.role === 'tool') continue // system 不展示；tool 已经在前面拼到工具调用上。
    const id = `hydrated-${counter}` // 为当前原始消息生成恢复后的基础 id。
    const ts = baseTs + counter // 让每条恢复消息拥有递增时间戳。
    if (msg.role === 'user') {
      const text = extractText(msg.content)
      if (text) out.push({ id, role: 'user', content: text, timestamp: ts })
      continue 
    }
    // 走到这里说明当前消息是 assistant。
    const text = extractText(msg.content) 
    if (text) out.push({ id: `${id}-text`, role: 'assistant', content: text, timestamp: ts })
    if (Array.isArray(msg.content)) {
      let tcIdx = 0
      for (const part of msg.content as ContentPartLike[]) {
        if (part?.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue // 只处理带 id 的 tool-call 片段。
        tcIdx++
        const result = toolResults.get(part.toolCallId) // 查找对应工具调用的结果。
        const tc: DisplayToolCall = {
          id: `${id}-tc-${tcIdx}`, // 为展示层工具调用生成 id。
          toolName: part.toolName ?? 'unknown',
          input: (part.input as Record<string, unknown>) ?? {}, // 工具输入缺失时使用空对象，方便展示层读取字段。
          output: result?.output, // 有结果时带上输出文本。
          status: result ? (result.isError ? 'error' : 'completed') : 'pending', // 根据结果存在与否和错误标记确定展示状态。
        }
        out.push({
          id: `${id}-tcm-${tcIdx}`,
          role: 'assistant', 
          content: '',
          toolCalls: [tc], 
          timestamp: ts,
        })
      }
    }
  }
  return out
}

/**
 * 从子工具输入中提取一段短预览文本。
 *
 * @param input - 子工具调用输入对象。
 * @returns 最多 80 个字符的预览文本。
 */
export function previewSubInput(input: Record<string, unknown>): string {
  const val =
    (input.filePath as string) ??
    (input.command as string) ??
    (input.pattern as string) ??
    (input.query as string) ??
    (input.dirPath as string) ?? 
    (input.path as string) ?? 
    '' 
  return val.length > 80 ? val.slice(0, 77) + '...' : val 
}
