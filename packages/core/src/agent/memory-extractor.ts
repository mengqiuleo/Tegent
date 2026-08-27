// agentLoop 每次以 finishReason === 'stop' 正常结束后，这里会以 fire-and-forget 方式运行。
// 它读取最近对话，判断是否有值得跨会话保存的长期知识，并直接写入 AutoMemory。
//
// 主 agent 没有暴露写记忆工具：saveKnowledge 已经从工具注册表移除。
// 记忆写入只能走这个抽取器，符合“主 agent 对记忆只读”的设计。
// 如果 ChatInput 里突然出现可见的 SaveKnowledge 工具行，会让用户感觉 AI 在背后写东西。
//
// 实现方式：只发起一次 generateText，并使用 output 配置返回结构化对象。
// 不走 agentLoop，没有 turn budget、tool filter、子回调等复杂机制。
// 模型返回 memories 数组后，我们逐条调用 AutoMemory.add()。
import { Output, generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import { z } from 'zod'

import { getAutoMemory } from '../knowledge/auto-memory.js'
import type { KnowledgeFact, MemoryWriteNotice } from '../types/index.js'
import type { LoopState } from './loop-state.js'

// 这个文件负责“回合结束后的自动记忆抽取”。主 agent 回复完用户以后，
// 这里会异步读取最近一小段对话，让模型判断有没有值得跨会话保存的长期事实，
// 然后直接写入 AutoMemory。主 agent 本身没有写记忆工具，避免它在对话中
// 随意把当前任务、临时猜测或错误推断保存成长期记忆。

/** 最多把最近多少条主循环消息回放给抽取器。
 *  12 条足够覆盖几轮“用户说 X -> assistant 做 Y -> 用户反馈 Z”，又不会拖入陈旧背景。 */
const MAX_TRANSCRIPT_MESSAGES = 12

/** 对话太短时跳过抽取：单次问候和回复通常没有长期价值。 */
const MIN_TRANSCRIPT_MESSAGES = 4

/** 限制模型发挥过头时的影响范围：单次最多写这么多条。 */
const MAX_MEMORIES_PER_PASS = 3

/** 串行化并发抽取调用。
 *  JS 是单线程，所以这只是防重入 guard，不是真锁；
 *  作用是避免两个连续 stop 同时处理同一段 transcript。 */
let inflight: Promise<void> = Promise.resolve()

// 模型必须输出的单条 memory 结构。
// zod schema 会在 generateText 的 Output.object 里做结构化校验：
// 不符合这个 schema 的模型输出不会进入后续 AutoMemory.add。
const MemoryItemSchema = z.object({
  // category 描述事实类型，scope 决定写入用户级还是项目级 AutoMemory。
  category: z.enum(['user', 'feedback', 'project', 'reference']),

  // scope 决定写到哪份 auto.md：project 是当前仓库，user 是全局用户记忆。
  scope: z.enum(['project', 'user']),

  // key 是同分类下的短标识；AutoMemory.add 用 category + key 判断是否覆盖旧事实。
  key: z.string().min(1).describe('Short slug. Same key under same category overwrites the previous fact.'),

  // fact 是真正要保存的内容；要求非空，避免写入空记忆。
  fact: z.string().min(1).describe('The fact itself. Lead with the rule; for feedback include a one-line reason.'),
})

// 模型整次输出的顶层结构。
const MemorySchema = z.object({
  /** 空数组表示“没有要保存的内容”，这是模型首选的 no-op。 */
  memories: z.array(MemoryItemSchema).max(MAX_MEMORIES_PER_PASS),
})

/** 把 AutoMemory 的两个作用域渲染成快照，供抽取器在决定写入前扫描。
 *  没有这个快照时，模型不知道已经保存过什么，容易用新 key 写出语义重复内容。
 *  AutoMemory.add() 的去重只看精确的 (category, key)，抓不到语义重叠，
 *  所以防重复必须发生在抽取 prompt 中。 */
function renderExistingMemory(): string {
  // 把 user/project 两个作用域的已保存记忆都放进提示词，让模型能主动去重。
  // 用户级记忆是跨项目共享的长期偏好。
  const user = getAutoMemory('user').getPromptContent().trim()

  // 项目级记忆只属于当前仓库。
  const project = getAutoMemory('project').getPromptContent().trim()

  // sections 用来拼出两段清楚分隔的 markdown。
  const sections: string[] = []

  // 没有内容时写 `(empty)`，明确告诉模型“这个作用域目前为空”。
  sections.push(`## User (~/.x-code/memory/auto.md)\n${user || '(empty)'}`)

  // 项目级同理，告诉模型当前项目 auto-memory 里已经有什么。
  sections.push(`## Project (.x-code/memory/auto.md)\n${project || '(empty)'}`)

  // 用空行分隔 user/project 两块，作为 prompt 的 Existing memory 区域。
  return sections.join('\n\n')
}

/** 把 transcript 尾部渲染成抽取器可读的纯文本。
 *  tool-call 和 tool-result 会折叠成方括号标记；
 *  抽取器只关心用户/assistant 的意图，不关心工具细节。 */
function renderTranscript(messages: ModelMessage[]): string {
  // 这里只保留角色和文本意图；工具细节压成标记，减少抽取器被工具输出带偏。
  // 只截取尾部消息，避免把很久之前的陈旧上下文拿来写长期记忆。
  const tail = messages.slice(-MAX_TRANSCRIPT_MESSAGES)

  // lines 是最终输出的 markdown-ish transcript。
  const lines: string[] = []

  // 逐条处理最近消息。
  for (const msg of tail) {
    // 先拿 role，后面会作为 `### user` / `### assistant` 标题。
    const role = msg.role

    // system prompt 不是用户对话内容，不应该参与记忆抽取。
    if (role === 'system') continue

    // ModelMessage.content 可能是字符串，也可能是多 part 数组。
    const content = msg.content

    // 字符串内容最简单：trim 后直接写进 transcript。
    if (typeof content === 'string') {
      lines.push(`### ${role}\n${content.trim()}`)
      continue
    }

    // 非字符串、非数组的内容不在本抽取器处理范围内，跳过。
    if (!Array.isArray(content)) continue

    // parts 收集这条消息中对记忆抽取有用的文本或工具标记。
    const parts: string[] = []

    // 遍历消息的每个 part。
    for (const part of content as Array<{
      // part 类型，例如 text/tool-call/tool-result。
      type?: string

      // text part 的自然语言内容。
      text?: string

      // tool-call part 里可能带工具名，用于生成 `[tool-call: name]` 标记。
      toolName?: string
    }>) {
      // 文本 part 保留原文本，因为它可能包含用户偏好或 assistant 的确认。
      if (part?.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text.trim())
      } else if (part?.type === 'tool-call' && typeof part.toolName === 'string') {
        // 工具调用只保留工具名，不带参数，避免把临时任务细节写进长期记忆。
        parts.push(`[tool-call: ${part.toolName}]`)
      } else if (part?.type === 'tool-result') {
        // 工具结果可能非常长，而且多半是代码/命令输出；这里只保留一个存在标记。
        parts.push('[tool-result]')
      }
    }

    // 去掉空 part 后用换行拼成这条消息的正文。
    const body = parts.filter(Boolean).join('\n').trim()

    // 只有正文非空时才写入 transcript。
    if (body) lines.push(`### ${role}\n${body}`)
  }

  // 多条消息之间空一行，方便模型区分轮次。
  return lines.join('\n\n')
}

// 记忆抽取器的 system prompt。
// 这段是实际发给模型的英文指令，不是注释；它严格规定“什么能保存、什么不能保存”。
const SYSTEM_PROMPT = `You are a post-turn memory extractor for a coding-assistant CLI.

The main agent has just finished replying to the user. Scan the recent transcript and decide whether anything in it is **durable cross-session knowledge** worth saving. Output a JSON object matching the provided schema: \`{ "memories": [...] }\`. **Empty array means save nothing — that is the default and often correct.**

# Hard rules

1. **Quality over quantity.** Output AT MOST 1-2 memories per pass; an empty array is fine.
2. **Never save the user's CURRENT TASK or REQUEST.** "User wanted me to refactor X" / "user asked me to debug Y" is transient and has zero value next session.
3. **Never save anything derivable from code or git history.** Tech stack, dependencies, file layout, commit author, when something changed — the agent can re-read these next session.
4. **Save EXACTLY what the user said. No inference, no generalization, no padding, no fabricated rules.**
   - If they said "Node.js engineer", save "Node.js engineer" — do NOT generalize to "frontend engineer" or specialize to "backend engineer".
   - If they said "reply in Chinese", save "User wants replies in Chinese" — do NOT add "user has limited English", "is from mainland China", or any implication.
   - Do NOT invent rules the user did not state ("keep variable names in English", "explain by analogy", "use simple words"). If they didn't say it, it isn't a fact.
   - When tempted to add motivation, audience, or implication, stop. Quote the user.
   - One stated fact = one short fact in the output. Do not pad a single sentence into a paragraph.
5. **Don't write near-duplicates. Reuse keys to update.** The user message includes an "Existing memory" snapshot of everything already saved.
   - If your candidate fact is already covered there — even under a different key, different category, or slightly different phrasing — RETURN EMPTY for it. The fact is already in the system prompt next session; writing it again under a fresh key just clutters memory.
   - If you want to REFINE an existing fact (more accurate, more complete), REUSE its exact \`(category, key)\` so \`AutoMemory.add()\` overwrites it in place. Different key = duplicate, not update.
   - Common pitfall: writing \`role\` AND \`user-stack\` AND \`user-profile\` for the same person. Pick whichever canonical key already exists in the snapshot and reuse it; if none exists, pick one and don't drift later.

# What to save (pick the matching category)

**user** — durable facts about who the human is, changing how you'd talk to them next session.
  Trigger: role, expertise, working environment, language preferences, long-term constraints.
  Example: User says "I've been writing Go for ten years but this is my first time touching the React side."
  → \`{ category: "user", scope: "user", key: "user-stack", fact: "Ten years of Go; first time touching React in this repo." }\`
  (Note: the fact is a direct paraphrase. Do NOT add "explain by analogy" or any other prescriptive action — that's inference, not what the user said.)

**feedback** — corrections OR validated approaches. Both count. Lead with the rule, include a one-line reason.
  Trigger A (correction): "no", "stop", "don't do X", "you got Y wrong because…".
    Example: "Stop using --no-verify on commits, last time we did that CI went red."
    → \`{ category: "feedback", scope: "project", key: "no-skip-hooks", fact: "Never use git --no-verify; previously bypassed pre-commit hook and broke CI." }\`
  Trigger B (validated approach): user accepts a non-obvious choice without pushback. Quieter than corrections — watch for them.
    Example: "yeah that's right, splitting would be churn" after assistant suggested bundling.
    → \`{ category: "feedback", scope: "project", key: "refactor-bundling", fact: "Bundle related refactors into one PR rather than splitting; user-validated as reducing churn." }\`

**project** — ongoing work, decisions, deadlines, or non-obvious project state. Convert relative dates to absolute.
  Example: "Mobile release branch cuts Thursday — non-critical merges blocked after that."
  → \`{ category: "project", scope: "project", key: "release-freeze", fact: "Mobile release freeze begins 2026-03-05. Flag non-critical merges past that date." }\`

**reference** — pointers to external systems (tickets, dashboards, docs).
  Example: "Pipeline bugs are tracked in Linear project INGEST."
  → \`{ category: "reference", scope: "project", key: "linear-pipeline", fact: "Pipeline bugs tracked in Linear project INGEST." }\`

# What NOT to save

- Current request, task, file edits, bug fix, or anything tied to "what we just did". → empty.
- The model's own opinion about the user. → empty.
- Vague impressions ("user prefers concise answers") with no concrete trigger sentence. → empty.
- Single-word reactions ("nice", "ok", "thanks") without context. → empty.
- **Inferences from the user's words.** If they say "Node.js engineer", do NOT save "frontend engineer" or "backend engineer" — both are guesses. Save what they literally wrote.
- **Demographic/skill assumptions** the user did NOT state (nationality, English level, seniority beyond what was claimed, team size). → empty.
- **Self-invented rules** dressed up as user preferences ("keep variable names English", "use markdown headings"). If the user did not say it this session, it is not a fact. → empty.

# Scope rule

- Project-specific facts (this repo / team / release): \`scope: "project"\`.
- Cross-project facts about the user themselves (stack expertise, OS, name): \`scope: "user"\`.

When in doubt, prefer empty array. The user can always type the durable fact again next session if it really matters.`

const USER_TEMPLATE = (transcript: string, existing: string) =>
  // 这个 user prompt 把“已有记忆快照”和“最近对话 transcript”一起发给抽取器。
  // existing 放前面，是为了让模型先看到哪些事实已经保存过，从而避免重复写。
  `# Existing memory (already saved — DO NOT duplicate, see Hard rule 5)

${existing}

---

# Recent main-loop transcript

${transcript}

---

Output a JSON object matching the schema. Empty \`memories\` array means save nothing — that is the default and often correct. Anything already present in the Existing memory snapshot above is by definition not new — return empty for it unless you are deliberately reusing its exact (category, key) to overwrite with a refined version.`

export interface RunMemoryExtractorArgs {
  // 父 agent 的 LoopState，抽取器从这里读取最近消息。
  parentState: LoopState

  // 复用父 agent 的模型，避免另开一套路由配置。
  parentModel: LanguageModel

  // 父回合取消时，抽取器也应尽快停止。
  abortSignal?: AbortSignal

  /** 每次 AutoMemory 成功写入后触发一次，让 UI 能在滚动区展示“Remembered: ...”。
   *  抽取器是 fire-and-forget，所以这个回调可能在父 agentLoop 返回后才触发；
   *  调用方闭包不能依赖单轮临时状态。 */
  onWrite?: (notice: MemoryWriteNotice) => void
}

/** fire-and-forget 的记忆抽取。调用方应使用 `void runMemoryExtractor(...)`；
 *  如果 await 它，会阻塞用户输入下一条 prompt。
 *
 *  写入直接落到 AutoMemory 文件层。没有面向用户的写记忆工具：
 *  主 agent 自己无法写记忆，所以抽取器是唯一写入路径。
 *  静默执行也符合“主 agent 对记忆只读”的约定。 */
export async function runMemoryExtractor(args: RunMemoryExtractorArgs): Promise<void> {
  // 调用方通常用 void runMemoryExtractor(...)；这里内部排队，避免并发写同一份记忆。
  // inflight 永远指向“当前队列尾部”的 Promise：
  // 新任务会通过 `.then(() => doExtract(args))` 接到旧任务后面。
  // 这样即使 agentLoop 连续正常结束两次，也不会同时跑两个抽取器。
  inflight = inflight.then(() => doExtract(args)).catch(() => undefined)

  // 返回队列尾部 Promise；调用方如果 await，就能等到当前及之前排队的抽取完成。
  // 主 loop 通常不 await，因为记忆抽取不能阻塞用户继续输入。
  return inflight
}

// 真正执行一次记忆抽取。
// runMemoryExtractor 负责排队，doExtract 负责：检查早退条件 -> 渲染 prompt -> 调模型 -> 写 AutoMemory。
async function doExtract(args: RunMemoryExtractorArgs): Promise<void> {
  // 解构参数，后面使用更清楚。
  const { parentState, parentModel, abortSignal, onWrite } = args

  // 早退条件都放在真正发起模型调用之前，省 token，也避免取消后继续写记忆。
  // 如果父回合已经取消，就不再启动后台模型调用。
  if (abortSignal?.aborted) return

  // 对话太短通常没有长期事实；跳过可以省一次 generateText 调用。
  if (parentState.messages.length < MIN_TRANSCRIPT_MESSAGES) return

  // 把最近消息渲染成简化 transcript。
  const transcript = renderTranscript(parentState.messages)

  // 如果渲染后没有任何可读内容，也没有抽取价值。
  if (!transcript) return

  // 快照现有记忆，让模型能发现和已保存事实的语义重叠。
  // AutoMemory.add 的去重只抓精确 (category, key) 冲突。
  // 这会多花几百个 prompt token，但比让记忆文件无限长出重复 key 便宜得多。
  // existing 会被放进 USER_TEMPLATE 的 Existing memory 区域。
  const existing = renderExistingMemory()

  // debugLog 只有 DEBUG_STDOUT=1 时才写日志；这里记录输入规模，方便排查抽取成本。
  debugLog('memory-extractor.start', `transcript-bytes=${transcript.length} existing-bytes=${existing.length}`)

  // 记录开始时间，done 日志里会输出耗时。
  const startTime = Date.now()

  try {
    // 发起一次独立的模型调用，要求模型按 MemorySchema 返回结构化对象。
    const { output: object } = await generateText({
      // 使用父 agent 同一个模型。
      model: parentModel,

      // 抽取规则：哪些可以保存、哪些必须忽略、如何分类。
      system: SYSTEM_PROMPT,

      // 用户消息里包含现有记忆和最近 transcript。
      prompt: USER_TEMPLATE(transcript, existing),

      // 要求 AI SDK 把模型输出解析成符合 zod schema 的对象。
      output: Output.object({ schema: MemorySchema }),

      // 透传取消信号，父回合 abort 时这次后台请求也可以被取消。
      abortSignal,
    })

    // 记忆日期由本地生成，避免模型自己编日期。
    const today = new Date().toISOString().slice(0, 10)

    // 统计本次实际写入了多少条。
    let written = 0

    // 虽然 schema 已经限制 max，这里再 slice 一次做纵深防御。
    for (const m of object.memories.slice(0, MAX_MEMORIES_PER_PASS)) {
      // 只把 schema 校验后的字段转成 AutoMemory 的事实结构，日期由本地生成。
      const fact: KnowledgeFact = {
        // key 决定同分类下是否覆盖旧事实。
        key: m.key,

        // fact 是要写入 auto.md 的实际内容。
        fact: m.fact,

        // category 已经过 zod 校验，只能是 user/feedback/project/reference。
        category: m.category,

        // 使用本地 today，而不是信任模型输出日期。
        date: today,
      }
      try {
        // 根据模型给出的 scope 写入用户级或项目级 AutoMemory。
        getAutoMemory(m.scope).add(fact)

        // 写入成功后更新计数。
        written++


        // 写入成功后再通知 UI。这里单独 try/catch，避免 UI 回调异常中断本批其它写入。
        if (onWrite) {
          try {
            // UI 只需要展示 scope/category/key/fact，不需要内部 date 字段。
            onWrite({ scope: m.scope, category: m.category, key: m.key, fact: m.fact })
          } catch {
            // 故意吞掉。
          }
        }
      } catch (err) {
        // AutoMemory.add 内部把 FS 写入排队；这里通常只会捕获校验类异常。
        // category 已经被 zod 校验过，所以理论上不该发生。
        // 这里吞掉单条失败，继续处理后面的 memories。
        const msg = err instanceof Error ? err.message : String(err)

      }
    }


  } catch (err) {
    // 如果是父回合取消导致的失败，不当作真正错误记录。
    if (abortSignal?.aborted) {

      return
    }

    // 捕获 NoOutputGeneratedError、网络错误、schema 重试耗尽等问题。
    // 用户没有在等待这个后台任务，所以只写 debugLog 然后结束。
    const msg = err instanceof Error ? err.message : String(err)

  }
}
