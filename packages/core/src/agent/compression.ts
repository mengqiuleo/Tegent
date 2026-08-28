// 两条路径共用同一套基础逻辑：
//   - 主动压缩：checkAndCompressContext 每轮前运行，超过当前模型 token 阈值后裁剪旧消息。
//   - 响应式压缩：handleContextTooLong 在 stream 报“prompt 太长”时运行，压缩后通知外层重试。
//
// 两条路径都会先尝试便宜的进程内轻量压缩（删除 loop-guard 对，不调用 LLM）。
// 如果还不够，再进入 compressMessages，额外调用 generateText 生成 LLM 摘要。
import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import type { HookBus } from '../hooks/bus.js'
import { generateSessionSummary } from '../knowledge/session.js'
import type { AgentCallbacks } from '../types/index.js'
import { estimateTokenCount } from './context-window.js'
import { lightCompactMessages, truncateOldToolResults } from './light-compact.js'
import type { LoopState } from './loop-state.js'
import { markBoundaryAndReflush } from './session-store.js'

// 中文导读：
// 这个文件负责上下文窗口压缩。正常情况下每轮前会主动检查 token 阈值；
// 如果 provider 已经报“上下文太长”，则走响应式压缩并让外层重试本轮。
// 压缩优先级是：轻量删除重复工具调用 -> 截断旧工具结果 -> 调 LLM 生成摘要。

/** 两条压缩路径都会透传的可选 hook 上下文。
 *  插件可以观察 PreCompact，也可以在 PostCompact 后反应；
 *  常见用途是 checkpoint 持久化或审计。 */
export interface CompactionHookContext {
  // 插件事件总线；没有插件、插件关闭、或调用方不关心 hook 时可以不传。
  hookBus?: HookBus

  // 当前使用的模型 id，例如 `openai:gpt-4.1`；hook 可以用它做记录或分支判断。
  modelId: string

  // 当前工作目录；hook 需要知道这次压缩属于哪个项目。
  cwd: string

  // 可选取消信号；如果用户中断，hook 执行也能收到同一个 abortSignal。
  abortSignal?: AbortSignal
}

/** 压缩时最近多少条消息保持原文。 */
export const KEEP_RECENT = 6

/** 把旧消息压缩成一条摘要消息。 */
export async function compressMessages(messages: ModelMessage[], model: LanguageModel): Promise<ModelMessage[]> {
  // 保留最近消息原文，其余旧消息压成一条 user summary，保证模型能继续任务。
  // 确保 recent 切片不要以孤儿 tool result 开头。
  // provider 会拒绝没有前置 assistant tool_call 配对的 tool 消息。
  // keepCount 是最终要原样保留在上下文尾部的消息数量。
  let keepCount = KEEP_RECENT

  // 如果最近窗口开头正好是一条 tool result，就继续往前多保留一条。
  // 这样能把它前面的 assistant tool_call 也带上，避免恢复出“只有结果、没有调用”的非法结构。
  while (keepCount < messages.length && messages[messages.length - keepCount]?.role === 'tool') {
    // 每次发现窗口开头是 tool 消息，就扩大保留范围。
    keepCount++
  }

  // recent 是要完整保留的尾部消息，它们最贴近当前任务，不能压成摘要。
  const recent = messages.slice(-keepCount)

  // old 是要交给 LLM 总结的旧消息前缀。
  const old = messages.slice(0, -keepCount)

  // 如果没有旧消息可压缩，说明消息数太少或都被保护了，直接返回原数组。
  if (old.length === 0) return messages

  // 这是昂贵路径：会额外发起一次模型调用。
  const { text: summary } = await generateText({
    // 使用当前 agent loop 的同一个模型来写摘要。
    model,

    // system 指令要求模型保留继续任务所需的信息，而不是写闲聊总结。
    system:
      'Summarize the following conversation concisely, preserving key decisions, file changes, and context needed to continue.',

    // 只把旧消息发给摘要器；recent 消息会原样拼回去，不需要总结。
    messages: old,
  })

  // 用一条 user 消息承载摘要，再接上 recent 原文，形成新的压缩后上下文。
  return [{ role: 'user', content: `[Previous conversation summary]\n${summary}` }, ...recent]
}

/**
 * 主动压缩：当最近真实 input token 数或字符估算值超过阈值时运行。
 *
 * 先做一次轻量 O(n) 压缩（删除 loop-guard 对，不调用 LLM、不走网络）。
 * 如果这已经让上下文回到阈值下，就完全跳过昂贵的 LLM 摘要路径。
 * 对循环工具调用导致的膨胀来说，轻量路径通常已经够用。
 */
export async function checkAndCompressContext(
  // 当前 agent loop 的可变状态；压缩会直接改 state.messages。
  state: LoopState,

  // 用来做 LLM 摘要的模型。
  model: LanguageModel,

  // 当前模型触发压缩的 token 阈值，一般是上下文窗口的 80%。
  threshold: number,

  // UI/CLI 回调，用来展示“正在压缩”“压缩完成”等提示。
  callbacks: AgentCallbacks,

  // 可选 hook 上下文，用来通知插件 PreCompact/PostCompact。
  hookCtx?: CompactionHookContext,
): Promise<void> {
  // 用真实 input token 和字符估算双保险：有些 provider 不稳定返回 usage，只靠一个指标不够稳。
  // state.lastInputTokens 是 provider 上次返回的真实 input token。
  // estimateTokenCount 是本地按字符估算的兜底值。
  const needsCompression = state.lastInputTokens > threshold || estimateTokenCount(state.messages) > threshold

  // 不需要压缩，或者消息数量少到连最近消息都不够保留时，直接退出。
  if (!needsCompression || state.messages.length <= KEEP_RECENT) return

  // PreCompact 在任一压缩路径执行前触发。
  // 压缩一旦越过阈值就是必要动作，不等待 hook 决定来影响行为，所以这里是 fire-and-forget。
  // 先记录压缩前消息数，作为 PreCompact hook 的输入。
  const messageCountBefore = state.messages.length

  // 再记录压缩前 token 估算，hook 或日志可以用它衡量压缩收益。
  const tokenEstimateBefore = estimateTokenCount(state.messages)

  // 通知插件：马上要主动压缩了。这个 helper 内部会补 session 信息并吞掉 hook 错误。
  emitCompactionHook(hookCtx, {
    name: 'PreCompact',
    trigger: 'proactive',
    messageCount: messageCountBefore,
    tokenEstimate: tokenEstimateBefore,
  })

  // 告诉 UI：第一步先尝试删除重复/无价值的工具调用。
  callbacks.onCompressionProgress?.('Removing duplicate tool calls...')

  // 轻量删除 loop-guard tool-call/result 对；不调用 LLM，也不改原数组。
  const light = lightCompactMessages(state.messages)

  // dropped > 0 表示确实删掉了一些完整消息。
  if (light.dropped > 0) {
    // 用轻量压缩后的新数组替换当前上下文。
    state.messages = light.messages

    // 删除后重新估算 token，看是否已经低于阈值。
    const stillOver = estimateTokenCount(state.messages) > threshold

    // 告诉 UI 这一步回收了多少消息，以及是否还要继续进入摘要路径。
    callbacks.onContextCompressed(
      `Dropped ${light.dropped} looped tool-call message(s) to reclaim context${stillOver ? ' — still over threshold, summarising' : ''}.`,
    )

    // 如果轻量删除已经足够，就不用花钱调用 LLM 摘要。
    if (!stillOver) {
      // 轻量压缩成功：写入 boundary，避免 resume 时把已删除的 loop-guard 对复活。
      // 它们仍在 boundary 前的磁盘记录里，但 loader 会从最新 boundary 后开始取。
      // 没有真正摘要，所以 boundary 不带 summary 文本。
      // fire-and-forget：保存失败不影响本轮继续，但 session-store 内部会尽力落盘。
      void markBoundaryAndReflush(state)

      // 通知插件：主动压缩已经结束；summary 为空表示这次没有 LLM 摘要文本。
      emitCompactionHook(hookCtx, {
        name: 'PostCompact',
        trigger: 'proactive',
        messageCount: state.messages.length,
        summary: '',
      })
      return
    }
  }

  // 告诉 UI：第二步尝试把老旧的大型工具输出截短成 stub。
  callbacks.onCompressionProgress?.('Truncating old tool results...')

  // 截断旧 tool-result。这个函数为了效率会原地修改 state.messages。
  const trunc = truncateOldToolResults(state.messages)

  // truncatedCount > 0 表示至少有一个旧工具输出被替换成短 stub。
  if (trunc.truncatedCount > 0) {
    // 截断后重新估算 token，看是否已经低于阈值。
    const stillOver = estimateTokenCount(state.messages) > threshold

    // charsSaved / 3 用和 estimateTokenCount 接近的比例粗略换算成 token。
    callbacks.onContextCompressed(
      `Truncated ${trunc.truncatedCount} old tool result(s), saved ~${Math.round(trunc.charsSaved / 3)} tokens${stillOver ? ' — still over threshold, summarising' : ''}.`,
    )

    // 如果截断已经足够，就不继续做 LLM 摘要。
    if (!stillOver) {
      // 轻量截断也改变了 state.messages，所以同样要写 compact-boundary 并重刷当前消息。
      void markBoundaryAndReflush(state)

      // 通知插件：主动压缩结束；summary 为空表示没有生成 LLM 会话摘要。
      emitCompactionHook(hookCtx, {
        name: 'PostCompact',
        trigger: 'proactive',
        messageCount: state.messages.length,
        summary: '',
      })
      return
    }
  }

  // 前两种便宜压缩还不够，才进入真正昂贵的 LLM 摘要路径。
  callbacks.onCompressionProgress?.('Generating session summary...')

  // summaryText 会写入 compact-boundary 元数据，供恢复/会话选择器等路径使用。
  let summaryText = ''

  // 先尝试生成结构化会话摘要；这份摘要不是直接替换 state.messages 的那条摘要。
  try {
    // generateSessionSummary 会返回带 title/keyResults/pendingWork 等字段的结构化结果。
    const summary = await generateSessionSummary(state.messages, model, state.sessionId, state.startedAt, [
      // 复制一份 filesModified，避免摘要函数意外持有可变数组引用。
      ...state.filesModified,
    ])

    // compact-boundary 只需要其中的 summary 文本。
    summaryText = summary.summary
  } catch {
    // 结构化摘要生成失败：用空文本继续。
    // 下面的 compressMessages 仍会做自己的 LLM 摘要，所以上下文仍会缩小；
    // 只是 boundary line 上少了给 picker UX 使用的结构化摘要。
  }

  // 告诉 UI：现在开始真正改写对话上下文。
  callbacks.onCompressionProgress?.('Summarizing conversation...')

  // 记录压缩前估算 token，稍后用于展示压缩效果。
  const tokensBefore = estimateTokenCount(state.messages)

  // 把旧消息压成一条 `[Previous conversation summary]`，最近消息保持原文。
  state.messages = await compressMessages(state.messages, model)

  // 压缩后不能再信任上一轮 provider 返回的 input token，所以清零。
  state.lastInputTokens = 0

  // 压缩改变了消息前缀，下一次请求大概率无法命中 prompt cache。
  state.expectCacheMiss = true

  // 记录压缩后的估算 token，用于 UI 提示。
  const tokensAfter = estimateTokenCount(state.messages)

  // 写入 compact-boundary，并重新 flush 裁剪后的消息，
  // 让 boundary 后的 jsonl 内容等于新的内存状态。
  // summaryText 会跟 boundary 写在一起；如果为空，也会保留正常 boundary 语义。
  void markBoundaryAndReflush(state, summaryText)

  // UI 展示用 k token 粗略数字，避免显示太细的估算值。
  const beforeK = Math.round(tokensBefore / 1000)

  // 同上，压缩后的估算 token。
  const afterK = Math.round(tokensAfter / 1000)

  // 告诉 UI 压缩完成，以及大约从多少 token 降到多少 token。
  callbacks.onContextCompressed(`Context compressed: ~${beforeK}k → ~${afterK}k tokens.`)

  // 通知插件：主动压缩完成，并附上结构化摘要里的 summary 文本。
  emitCompactionHook(hookCtx, {
    name: 'PostCompact',
    trigger: 'proactive',
    messageCount: state.messages.length,
    summary: summaryText,
  })
}

/**
 * 响应式压缩：当 stream 因 prompt 太长而报错时，压缩并通知调用方重试。
 * 行为对应 Claude Code 的 reactiveCompact。
 * 返回 true 表示已经压缩，调用方应该重试本轮。
 */
export async function handleContextTooLong(
  // 当前 agent loop 状态；响应式压缩会直接替换 state.messages。
  state: LoopState,

  // 用于生成摘要的模型。
  model: LanguageModel,

  // UI/CLI 回调，用来显示压缩和重试信息。
  callbacks: AgentCallbacks,

  // 可选 hook 上下文，用来通知插件 PreCompact/PostCompact。
  hookCtx?: CompactionHookContext,
): Promise<boolean> {
  // 消息太少时无法安全压缩，因为至少要保留最近 KEEP_RECENT 条原文。
  if (state.messages.length <= KEEP_RECENT) return false

  // 通知插件：provider 已经报上下文太长，现在准备响应式压缩。
  emitCompactionHook(hookCtx, {
    name: 'PreCompact',
    trigger: 'reactive',
    messageCount: state.messages.length,
    tokenEstimate: estimateTokenCount(state.messages),
  })

  // 告诉 UI：正在总结对话；响应式路径直接走 LLM 摘要，不再尝试轻量路径。
  callbacks.onCompressionProgress?.('Summarizing conversation...')

  // 记录压缩前 token 估算，稍后用于展示。
  const tokensBefore = estimateTokenCount(state.messages)

  // 把旧消息压成摘要消息，保留最近消息原文。
  state.messages = await compressMessages(state.messages, model)

  // 压缩后清空真实 input token 记录，避免用旧 usage 继续判断。
  state.lastInputTokens = 0

  // 消息前缀已改写，下一次重试通常会 cache miss。
  state.expectCacheMiss = true

  // 记录压缩后的 token 估算。
  const tokensAfter = estimateTokenCount(state.messages)

  // 和主动路径保持同样的 boundary 纪律。
  // 响应式压缩也会原地缩小 state.messages，所以 jsonl 需要 compact-boundary 标记，
  // 才能让 loader 语义保持一致。
  // 这里不带 summary，因为响应式路径没有先跑 generateSessionSummary。
  void markBoundaryAndReflush(state)

  // UI 展示用的压缩前 k token。
  const beforeK = Math.round(tokensBefore / 1000)

  // UI 展示用的压缩后 k token。
  const afterK = Math.round(tokensAfter / 1000)

  // 告诉 UI：上下文太长问题已经通过压缩处理，外层马上重试本轮。
  callbacks.onContextCompressed(`Context too long — compressed (~${beforeK}k → ~${afterK}k tokens). Retrying...`)

  // 通知插件：响应式压缩完成；summary 为空表示没有独立结构化摘要。
  emitCompactionHook(hookCtx, {
    name: 'PostCompact',
    trigger: 'reactive',
    messageCount: state.messages.length,
    summary: '',
  })

  // true 表示“我已经处理过上下文太长了，调用方应该重试刚才失败的请求”。
  return true
}

/** 带会话上下文触发 PreCompact / PostCompact hook。
 *  这是 best-effort：压缩已经发生或必定要发生，hook 失败和 abort 都不能向外冒泡。 */
function emitCompactionHook(
  // ctx 是调用方传进来的 hook 运行环境；没有它就什么都不发。
  ctx: CompactionHookContext | undefined,

  // partial 是事件主体里“压缩相关”的部分。
  // PreCompact 必须带 tokenEstimate；PostCompact 必须带 summary。
  partial:
    | { name: 'PreCompact'; trigger: 'proactive' | 'reactive'; messageCount: number; tokenEstimate: number }
    | { name: 'PostCompact'; trigger: 'proactive' | 'reactive'; messageCount: number; summary: string },
): void {
  // 如果没有 hookBus，或者当前事件名没有任何插件订阅，就直接返回。
  // 这一步避免每次压缩都构造无意义的 Promise。
  if (!ctx?.hookBus?.has(partial.name)) return

  // `void` 表示故意不 await：压缩主流程不等插件跑完。
  // hook 是通知/审计用途，不应该阻塞或改变压缩本身。
  void ctx.hookBus
    .emit(
      {
        // 把 PreCompact/PostCompact 自己的数据摊进事件对象。
        ...partial,

        // 补上 HookEvent 要求的 session 信息：当前项目 cwd 和模型 id。
        session: { cwd: ctx.cwd, modelId: ctx.modelId },
      },

      // 把 abortSignal 交给 hook executor；用户中断时 hook 有机会一起停。
      { signal: ctx.abortSignal },
    )

    // hook 失败不能让 agent loop 崩掉；这里只写 debug 日志。
    .catch((err) => {})
}

/**
 * 
主动压缩：还没报错，提前发现快超了，于是先尝试便宜压缩。
响应式压缩：已经被 provider 拒绝，说 context too long，于是直接做 LLM 摘要压缩，然后重试。

主动压缩例子 1：只删 loop-guard 就够了
压缩前：
state.messages = [
  user('帮我跑测试'),
  assistant(tool_call: 'run-tests', id: 'a1'),
  tool_result(id: 'a1', '[loop-guard] same command repeated'),
  assistant(tool_call: 'run-tests', id: 'a2'),
  tool_result(id: 'a2', '[loop-guard] same command repeated'),
  user('换个方式排查'),
]
主动压缩第一步会调用：
lightCompactMessages(state.messages)
它会删掉 loop-guard 对应的 tool_result，也删掉配对的 assistant tool_call。
压缩后：
state.messages = [
  user('帮我跑测试'),
  user('换个方式排查'),
]
如果这时 token 已经低于阈值，就结束，不再调用 LLM 摘要。


主动压缩例子 2：截断旧的大工具输出就够了
压缩前：
state.messages = [
  user('读这个大文件'),
  assistant(tool_call: 'readFile', id: 'r1'),
  tool_result(id: 'r1', '这里是 20000 字的大文件内容...'),
  assistant('我看完了，发现问题在 parser'),
  user('继续修复'),
  assistant('好的，我来改'),
]
如果这个大 tool_result 很旧，而且不是受保护工具，就会变成 stub：
state.messages = [
  user('读这个大文件'),
  assistant(tool_call: 'readFile', id: 'r1'),
  tool_result(
    id: 'r1',
    '[Truncated: readFile output, 900 lines, 20000 chars. Content removed to save context...]\n这里是前几行预览...'
  ),
  assistant('我看完了，发现问题在 parser'),
  user('继续修复'),
  assistant('好的，我来改'),
]
注意：这里数组长度没变，变的是某条消息里的内容变短了。


主动压缩例子 3：前两步还不够，走 LLM 摘要
假设压缩前：
state.messages = [
  user('需求 A'),
  assistant('分析 A'),
  user('改文件 1'),
  assistant(tool_call: 'edit', id: 'e1'),
  tool_result(id: 'e1', 'edit success'),
  user('现在继续做 B'),
  assistant('开始做 B'),
  user('再检查 C'),
  assistant('检查结果 C'),
  user('最后修复 D'),
]
KEEP_RECENT = 6，所以最近 6 条保留原文：
recent = [
  tool_result(id: 'e1', 'edit success'),
  user('现在继续做 B'),
  assistant('开始做 B'),
  user('再检查 C'),
  assistant('检查结果 C'),
  user('最后修复 D'),
]
旧消息被摘要：
old = [
  user('需求 A'),
  assistant('分析 A'),
  user('改文件 1'),
  assistant(tool_call: 'edit', id: 'e1'),
]
但这里有个保护：如果 recent 开头是 tool_result，它不能孤零零地存在，所以会多保留前面的 assistant tool_call。
最终可能变成：
state.messages = [
  user('[Previous conversation summary]\n用户提出需求 A，助手分析后编辑了文件 1。'),
  assistant(tool_call: 'edit', id: 'e1'),
  tool_result(id: 'e1', 'edit success'),
  user('现在继续做 B'),
  assistant('开始做 B'),
  user('再检查 C'),
  assistant('检查结果 C'),
  user('最后修复 D'),
]
这个数组明显比原来短，因为很多旧消息被合成了一条 summary。
 */

/**
 * 响应式压缩例子
响应式压缩发生在：请求已经发给 provider，但 provider 报错：context too long
这时候代码不会再尝试 lightCompactMessages 和 truncateOldToolResults，而是直接：
state.messages = await compressMessages(state.messages, model)
其实就是直接调用大模型把旧消息压缩成一条摘要消息，保留最近消息原文6条。
压缩前：
state.messages = [
  user('很早的问题 1'),
  assistant('回答 1'),
  user('很早的问题 2'),
  assistant('回答 2'),
  user('中间很多内容 3'),
  assistant('中间很多内容 4'),
  user('最近任务 5'),
  assistant('最近回答 6'),
  user('最近任务 7'),
  assistant('最近回答 8'),
]
KEEP_RECENT = 6，所以旧的前 4 条被总结：
old = [
  user('很早的问题 1'),
  assistant('回答 1'),
  user('很早的问题 2'),
  assistant('回答 2'),
]
最近 6 条保留：
recent = [
  user('中间很多内容 3'),
  assistant('中间很多内容 4'),
  user('最近任务 5'),
  assistant('最近回答 6'),
  user('最近任务 7'),
  assistant('最近回答 8'),
]
压缩后：
state.messages = [
  user('[Previous conversation summary]\n用户先问了问题 1 和问题 2，助手分别给出了回答。'),
  user('中间很多内容 3'),
  assistant('中间很多内容 4'),
  user('最近任务 5'),
  assistant('最近回答 6'),
  user('最近任务 7'),
  assistant('最近回答 8'),
]
 */
