// 主要用于 agent loop 的深度压缩路径。
//
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

  // 用来生成摘要的语言模型；通常就是当前 agent loop 正在使用的模型。
  model: LanguageModel,

  // 当前会话 id，会原样写入返回的 SessionSummary，方便之后关联到 session jsonl。
  sessionId: string,

  // 当前会话开始时间；由调用方传入，保证摘要记录和会话本身使用同一个 startedAt。
  startedAt: string,

  // 本会话已经修改过的文件列表；摘要生成失败时也会保留这份确定性元数据。
  filesModified: string[],

  // 可选取消信号；如果用户中断或 loop abort，摘要请求也应该跟着取消。
  signal?: AbortSignal,
): Promise<SessionSummary> {
  // generateText 会向模型发起一次独立请求，让模型把旧对话整理成 JSON 文本。
  const { text } = await generateText({
    // 使用调用方指定的模型，不在这里重新选择 provider 或模型能力。
    model,

    // 把 abortSignal 透传给 SDK，避免压缩阶段留下无法取消的请求。
    abortSignal: signal,

    // 发送给模型的消息：第一条是摘要任务说明，后面跟最近的若干条真实对话。
    messages: [
      {
        // system message 用来规定输出结构，让模型知道必须返回 JSON，而不是普通自然语言总结。
        role: 'system',

        // 这里明确列出字段名和类型，并要求“只返回 JSON”，方便下面 JSON.parse 直接解析。
        content: `Summarize this conversation as a structured JSON object with these fields:
- title: short descriptive title (string)
- summary: 2-3 sentence overview (string)
- keyResults: what was accomplished (string[])
- pendingWork: what remains to be done (string[])
- decisions: important decisions made (string[])
- status: "completed" | "in_progress" | "abandoned"

Return ONLY valid JSON, no markdown fencing.`,
      },

      // 只带最后 SESSION_SUMMARY_MESSAGE_COUNT 条，减少额外模型调用成本，并保留最近上下文。
      ...messages.slice(-SESSION_SUMMARY_MESSAGE_COUNT),
    ],
  })

  // 正常情况下，模型会按 system prompt 要求返回可解析的 JSON。
  try {
    // 先按 Partial<SessionSummary> 解析，因为模型可能漏字段，下面会逐个给默认值。
    const parsed = JSON.parse(text) as Partial<SessionSummary>

    // 返回完整 SessionSummary；确定性字段优先使用调用方传入的真实值。
    return {
      // 会话 id 不信模型生成，直接使用调用方传入的 sessionId。
      id: sessionId,

      // 开始时间同样来自调用方，表示这个摘要属于哪个会话生命周期。
      startedAt,

      // endedAt 在摘要完成时生成，表示这份摘要记录的结束时间。
      endedAt: new Date().toISOString(),

      // 文件列表来自 agent loop/session-store 的确定记录，不依赖模型。
      filesModified,

      // 如果模型漏掉 title，就给一个兜底标题，保证 UI 展示不拿到 undefined。
      title: parsed.title ?? 'Untitled session',

      // summary 是压缩后最重要的文本；漏字段时至少返回空字符串。
      summary: parsed.summary ?? '',

      // keyResults 用来展示“已经完成什么”；漏字段时返回空数组。
      keyResults: parsed.keyResults ?? [],

      // pendingWork 用来展示“还剩什么”；漏字段时返回空数组。
      pendingWork: parsed.pendingWork ?? [],

      // decisions 用来记录过程中做过的重要取舍；漏字段时返回空数组。
      decisions: parsed.decisions ?? [],

      // status 表示会话状态；模型漏掉时按 completed 处理，保持旧行为。
      status: parsed.status ?? 'completed',
    }
  } catch {
    // 如果模型没有返回合法 JSON，仍然不能让压缩流程崩掉，所以走纯文本兜底。
    return {
      // 这些确定性元数据仍然来自调用方。
      id: sessionId,
      startedAt,
      endedAt: new Date().toISOString(),

      // 解析失败时无法信任模型标题，使用通用标题。
      title: 'Session',

      // 至少把模型原文前 200 个字符放进 summary，保留一点可用信息。
      summary: text.slice(0, 200),

      // 结构化列表解析不出来，就用空数组保持返回类型完整。
      keyResults: [],
      pendingWork: [],

      // 即使 JSON 解析失败，文件修改列表仍然应该保留。
      filesModified,
      decisions: [],

      // 兜底状态沿用 completed，避免调用方还要处理 undefined。
      status: 'completed',
    }
  }
}
