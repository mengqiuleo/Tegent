// 这个文件从 use-agent.ts 中拆出，让主 hook 更专注于状态管理。
// 这里属于纯 UI 层逻辑，不会触碰 core agent loop 的执行过程。
import type { DisplayMessage, DisplayToolCall, ModelMessage } from '@tegent/core' // 导入展示消息、展示工具调用和模型消息类型。
import { extractText } from '@tegent/core' // 导入通用文本提取函数，用于读取消息正文。

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
  const out = part.output as { type?: string; value?: unknown } | string | undefined // 把宽松 output 收窄到本函数支持的几类形态。
  if (typeof out === 'string') return { output: out, isError: false } // 直接字符串输出默认视为非错误。
  if (out && typeof out === 'object') {
    const isError = out.type === 'error-text' || out.type === 'error-json' // error-text 和 error-json 都表示工具执行错误。
    const value = out.value // 读取标准化对象中的真实输出值。
    if (typeof value === 'string') return { output: value, isError } // 字符串值可直接作为展示文本。
    if (value !== undefined) return { output: JSON.stringify(value), isError } // 非字符串值序列化后展示，避免丢失信息。
  }
  return { output: '', isError: false } // 无法识别输出时返回空文本和非错误状态。
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
  const toolResults = new Map<string, { output: string; isError: boolean }>() // 先建立 toolCallId 到工具结果的索引。
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue // 只处理 tool 角色且内容为数组的消息。
    for (const part of msg.content as ContentPartLike[]) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        toolResults.set(part.toolCallId, readToolOutput(part)) // 把工具结果挂到对应 toolCallId 下。
      }
    }
  }
  const out: DisplayMessage[] = [] // 收集最终输出给 ChatInput 的展示消息。
  let counter = 0 // 递增计数器，用于生成稳定且顺序相关的 hydrated id。
  const baseTs = Date.now() - messages.length // 生成一组递增时间戳的基准，保持恢复消息顺序。
  for (const msg of messages) {
    counter++ // 每处理一条原始消息就推进计数器。
    if (msg.role === 'system' || msg.role === 'tool') continue // system 不展示；tool 已经在前面拼到工具调用上。
    const id = `hydrated-${counter}` // 为当前原始消息生成恢复后的基础 id。
    const ts = baseTs + counter // 让每条恢复消息拥有递增时间戳。
    if (msg.role === 'user') {
      const text = extractText(msg.content) // 从用户消息内容中提取纯文本。
      if (text) out.push({ id, role: 'user', content: text, timestamp: ts }) // 有文本时追加用户展示消息。
      continue // 用户消息处理完毕，进入下一条原始消息。
    }
    // 走到这里说明当前消息是 assistant。
    const text = extractText(msg.content) // 从 assistant 消息内容中提取普通文本。
    if (text) out.push({ id: `${id}-text`, role: 'assistant', content: text, timestamp: ts }) // 有文本时先追加文本展示消息。
    if (Array.isArray(msg.content)) {
      let tcIdx = 0 // 记录当前 assistant 消息内第几个工具调用。
      for (const part of msg.content as ContentPartLike[]) {
        if (part?.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue // 只处理带 id 的 tool-call 片段。
        tcIdx++ // 进入一个有效工具调用，递增局部索引。
        const result = toolResults.get(part.toolCallId) // 查找对应工具调用的结果。
        const tc: DisplayToolCall = {
          id: `${id}-tc-${tcIdx}`, // 为展示层工具调用生成 id。
          toolName: part.toolName ?? 'unknown', // 没有工具名时使用 unknown 保底。
          input: (part.input as Record<string, unknown>) ?? {}, // 工具输入缺失时使用空对象，方便展示层读取字段。
          output: result?.output, // 有结果时带上输出文本。
          status: result ? (result.isError ? 'error' : 'completed') : 'pending', // 根据结果存在与否和错误标记确定展示状态。
        }
        out.push({
          id: `${id}-tcm-${tcIdx}`, // 为承载工具调用的展示消息生成 id。
          role: 'assistant', // 工具调用行作为 assistant 消息展示。
          content: '', // 工具调用展示消息本身不需要普通文本正文。
          toolCalls: [tc], // 每条展示消息只放一个工具调用，保留逐行渲染模式。
          timestamp: ts, // 使用当前 assistant 消息对应的恢复时间戳。
        })
      }
    }
  }
  return out // 返回完整的展示消息列表。
}

/**
 * 从子工具输入中提取一段短预览文本。
 *
 * @param input - 子工具调用输入对象。
 * @returns 最多 80 个字符的预览文本。
 */
export function previewSubInput(input: Record<string, unknown>): string {
  const val =
    (input.filePath as string) ?? // 文件路径字段优先级最高。
    (input.command as string) ?? // 其次展示 shell 命令。
    (input.pattern as string) ?? // 再尝试展示搜索或 glob 模式。
    (input.query as string) ?? // 再尝试展示查询文本。
    (input.dirPath as string) ?? // 再尝试展示目录路径。
    (input.path as string) ?? // 最后尝试通用 path 字段。
    '' // 所有候选字段都不存在时使用空字符串。
  return val.length > 80 ? val.slice(0, 77) + '...' : val // 超过 80 字符时截断并追加省略号。
}
