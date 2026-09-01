// 这里以前放过 `saveSessionSummary` 和 `loadLatestSession`：
// 它们会把 `<sessionId>.json` 和 `latest.json` 写进 `.tegent/sessions/`。
// 这套结构现在已经移除。完整会话转录现在每个 session 只写一个 `.jsonl`
// （见 `agent/session-store.ts`），压缩摘要会作为 `compact-boundary` 元数据行
// 嵌入同一个 jsonl 文件里。也就是说：一个会话一个文件，没有额外的旁路摘要文件。
//
// 现在这个文件只保留 `generateSessionSummary`：
// 当上下文即将溢出、需要把旧消息压缩成短摘要时，agent loop 会单独调用一次
// `generateText` 生成结构化摘要。生成结果会交给 session-store 里的
// `markBoundaryAndReflush` 记录压缩边界，同时也会被包装成
// "[Previous conversation summary]" user message，替换掉 `state.messages`
// 中被丢弃的旧前缀。
import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import type { SessionSummary } from '../types/index.js'

/** 生成会话摘要时最多带上的最近消息数量。
 *  只取尾部消息是为了控制额外摘要调用的成本，同时保留离当前任务最近的上下文。 */
const SESSION_SUMMARY_MESSAGE_COUNT = 20

/** 使用当前模型根据消息生成会话摘要。
 *
 * 返回完整的结构化 `SessionSummary`，包括标题、状态、关键成果、待办事项和重要决策。
 * 调用方通常会把 `summary` 字段放回上下文，作为旧消息前缀的压缩替代；
 * 其他字段则更适合用于会话选择器、历史记录展示等 UI 场景。
 */
export async function generateSessionSummary(
  // 需要被压缩总结的完整消息列表；函数内部只会截取最后一部分发给模型。
  messages: ModelMessage[],
  model: LanguageModel,
  sessionId: string,
  startedAt: string,
  // 本会话已经修改过的文件列表；摘要生成失败时也会保留这份确定性元数据。
  filesModified: string[],

  // 可选取消信号；如果用户中断或 loop abort，摘要请求也应该跟着取消。
  signal?: AbortSignal,
): Promise<SessionSummary> {
  const { text } = await generateText({
    model,
    abortSignal: signal,
    messages: [
      {
        role: 'system',
        content: `Summarize this conversation as a structured JSON object with these fields:
- title: short descriptive title (string)
- summary: 2-3 sentence overview (string)
- keyResults: what was accomplished (string[])
- pendingWork: what remains to be done (string[])
- decisions: important decisions made (string[])
- status: "completed" | "in_progress" | "abandoned"

Return ONLY valid JSON, no markdown fencing.`,
      },

      ...messages.slice(-SESSION_SUMMARY_MESSAGE_COUNT),
    ],
  })

  try {
    const parsed = JSON.parse(text) as Partial<SessionSummary>

    return {
      id: sessionId,
      startedAt,
      endedAt: new Date().toISOString(),
      filesModified,
      title: parsed.title ?? 'Untitled session',
      summary: parsed.summary ?? '',
      keyResults: parsed.keyResults ?? [],
      pendingWork: parsed.pendingWork ?? [],
      decisions: parsed.decisions ?? [],
      status: parsed.status ?? 'completed',
    }
  } catch {
    return {
      id: sessionId,
      startedAt,
      endedAt: new Date().toISOString(),
      title: 'Session',
      summary: text.slice(0, 200),
      keyResults: [],
      pendingWork: [],
      filesModified,
      decisions: [],
      status: 'completed',
    }
  }
}
