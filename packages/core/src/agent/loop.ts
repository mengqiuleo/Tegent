// 上下文压缩放在 `./compression.ts`，这里主要负责每一轮的流式收集和工具派发。
import fs from 'node:fs/promises'
import path from 'node:path'

import { streamText } from 'ai'
import type { LanguageModel, UserContent } from 'ai'

import { aggregateUserPromptSubmit } from '../hooks/bus.js'
import type { HookEvent } from '../hooks/types.js'
import { buildKnowledgeContext } from '../knowledge/loader.js'
import { listMcpResources, readMcpResource } from '../mcp/resources.js'
import { bridgeMcpTool, toSystemPromptEntries } from '../mcp/tool-bridge.js'
import { applyCacheControl } from '../providers/cache-control.js'
import { getThinkingProviderOptions, mergeThinkingOptions } from '../providers/thinking.js'
import { createActivateSkillTool } from '../tools/activate-skill.js'
import { toolRegistry, truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, setProgressReporter } from '../tools/progress.js'
import { createTaskTool } from '../tools/task.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'

import { classifyApiError, isContextTooLongError } from './api-errors.js'
import { checkAndCompressContext, handleContextTooLong } from './compression.js'
import { getCompressionThreshold, getMaxOutputTokens } from './context-window.js'
import { createLoopState } from './loop-state.js'
import type { LoopState } from './loop-state.js'
import { runMemoryExtractor } from './memory-extractor.js'
import { generateTaskSlug, makePlanFilePath } from './plan-storage.js'
import { downgradeBinaryPartsForProvider } from './provider-compat.js'
import { appendCheckpoint, appendHeader, appendUsage, flushPendingMessages } from './session-store.js'
import { createCheckpoint } from './snapshot.js'
import { drainStreamResult } from './stream-utils.js'
import type { StreamResult } from './stream-utils.js'
import { buildSystemPrompt } from './system-prompt.js'
import { processToolCalls } from './tool-execution.js'
import { repairOrphanToolCalls, truncateToolResultsInMessages } from './tool-result-sanitize.js'

/** 把注入的上下文块前置到 UserContent 里。
 *  这是给 UserPromptSubmit hook 用的：插件可以在模型看到真实用户输入前，
 *  先塞一段上下文，比如当前迭代信息。
 *  这里选择“拼进同一条 user 消息”，而不是额外插一条 user 消息，
 *  是为了避免连续出现两条 user turn。有些供应商会拒绝这种结构，
 *  比如 Claude 不接受连续两个 role==='user'。 */
function prependContext(userMessage: UserContent, context: string): UserContent {
  const block = `<plugin_context>\n${context}\n</plugin_context>\n\n`
  if (typeof userMessage === 'string') return block + userMessage
  return [{ type: 'text', text: block }, ...userMessage]
}

/** 从 UserContent 里抽出纯文本，用来生成 slug。
 *  UserContent 可以是字符串，也可以是多段数组，
 *  比如 `buildUserContent` 吃掉 `@path` 后产生的 text/image/file 组合；
 *  这里我们只关心文本段，图片和文件不会帮助生成可读文件名。 */
function userContentToText(content: UserContent): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: 'text'; text: string } =>
          p?.type === 'text' && typeof (p as { text?: unknown }).text === 'string',
      )
      .map((p) => p.text)
      .join(' ')
  }
  return ''
}

export type { LoopState } from './loop-state.js'
// 重新导出给 CLI 的 resume / 手动 compact 路径使用（见 use-agent.ts）。
export { compressMessages } from './compression.js'

/** `agentLoop` 返回给调用方的结果。
 *
 *  - `state` 是会话级的长生命周期状态，保存 messages、tokenUsage 等信息。
 *    主交互 CLI 会把它存在 `loopStateRef` 里，并在下一次提交时作为 `existingState`
 *    传回来。
 *  - `turnCount` 表示这一次调用里，streamText 跑了多少轮。
 *    它不放在 `state` 上，因为那会让人误以为它会跨提交累加，
 *    实际上不会。子 Agent 和 `--print` 模式才真正关心它。 */
export interface AgentLoopResult {
  state: LoopState
  turnCount: number
}

/** 消费 streamText 的输出，并通过回调把 chunk 分发给 UI。
 *  reasoning-delta 这类 chunk 会被故意忽略，
 *  因为那是模型内部思考链路，不是给用户看的内容。
 *  真正要展示给用户的答案，会作为普通 text-delta chunk 到达。 */
async function streamChunksToUI(result: StreamResult, callbacks: AgentCallbacks): Promise<void> {
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'error') {
      // AI SDK 在 fullStream 遍历失败时不会直接 throw，
      // 它会把这个 chunk 排进去，然后关闭流。
      // 如果这里不重新 throw，外层循环会看起来像正常结束，
      // 接着 `await result.response` 才会以 NoOutputGeneratedError 失败，
      // 用户看到的就会是这个泛化错误，而不是更真实的供应商错误，
      // 比如“余额不足”。这里把原始包装错误重新抛出去，
      // 这样外层 try/catch 才能交给 classifyApiError 处理。
      throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
    }
    if (chunk.type === 'text-delta') {
      const text = chunk.text ?? ''

      callbacks.onTextDelta(text)
    } else if (chunk.type === 'tool-call') {

      const toolCallId = chunk.toolCallId ?? ''
      // 在工具开始执行前，先注册进度通道。
      // AI SDK 会在这个事件后立刻同步调用 `execute(input, { toolCallId })`，
      // 自动执行的工具也会通过 reportProgress(toolCallId, ...) 持续推送状态。
      if (toolCallId) {
        setProgressReporter(toolCallId, (msg) => callbacks.onToolProgress(toolCallId, msg))
      }
      callbacks.onToolCall(toolCallId, chunk.toolName ?? '', (chunk.input ?? {}) as Record<string, unknown>)
    } else if (chunk.type === 'tool-result') {
      // 告诉 UI：自动执行的工具已经有结果了（readFile、glob、grep 等）。
      const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output ?? '')

      if (chunk.toolCallId) clearProgressReporter(chunk.toolCallId)
      callbacks.onToolResult(chunk.toolCallId ?? '', truncateToolResult(raw))
    } else {

    }
    // reasoning-delta / reasoning-start / reasoning-end 会刻意不显示到 UI，
    // 但上面已经按 stream.other-chunk 记日志了，debug 模式下还能看见。
  }
}

/** 从完成的流里取出 response + usage，并合并回 state。 */
async function collectTurnResponse(
  result: StreamResult,
  state: LoopState,
  modelId: string,
  callbacks: AgentCallbacks,
): Promise<string> {
  const response = await result.response
  // 关键点：自动执行的工具（readFile / grep / glob / listDir / webFetch
  // / webSearch）会把结果直接放进 `response.messages`，
  // 不会经过手动 `pushToolResult` 路径。
  // 如果这里不做一次净化，读一个 800 行文件或者 grep 出 2000 条结果，
  // 这些内容就会整坨进 `state.messages`，然后在后续每一轮都跟着走。
  // 在这个过滤器出现之前，最糟糕的一次上下文甚至堆到了 900 万 token，
  // 原因是失败的 shell 栈和没截断的文件读取不断累积。
  // 这里要把结果截断到和别处一致的预算。
  truncateToolResultsInMessages(response.messages)

  // 把消息写回 state ，注意，自动执行工具就是在这里进行 push 操作的，
  // 而手动执行工具，在 runTurn 结束后，processToolCalls 中实现的
  state.messages.push(...response.messages)

  const usage = await result.usage
  if (usage) {
    state.tokenUsage.inputTokens += usage.inputTokens ?? 0
    state.tokenUsage.outputTokens += usage.outputTokens ?? 0
    // AI SDK v6 会把供应商的缓存字段统一塞进 inputTokenDetails：
    //   cacheReadTokens  ← Anthropic 的 cache_read_input_tokens / OpenAI 的 cached_tokens
    //   cacheWriteTokens ← Anthropic 的 cache_creation_input_tokens（其他供应商通常是 0）
    // 这两项都属于 inputTokens 的子集，所以 total 里不能重复计算。
    state.tokenUsage.cacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0
    state.tokenUsage.cacheCreationTokens += usage.inputTokenDetails?.cacheWriteTokens ?? 0
    state.tokenUsage.totalTokens = state.tokenUsage.inputTokens + state.tokenUsage.outputTokens
    // 这里记录的是“当前上下文窗占用”，每轮都覆盖写，不累加。
    // 它要包含 input + output，因为主流供应商（Anthropic、OpenAI、Google、
    // DeepSeek、Moonshot、Alibaba、xAI）对上下文窗口的定义，
    // 本质上都是 input + output 共享一份预算。
    // AI SDK 的 `inputTokens` 已经包含 cache_read + cache_write，
    // 所以这里反映的是“模型本轮看到了什么 + 刚刚写了什么”。
    // 这也正好能和页脚里的 `N / M · X%` 指示器对上。
    // 上面的累计字段仍然保留给 `/usage` 统计用。
    state.tokenUsage.currentContextTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    if (usage.inputTokens != null) state.lastInputTokens = usage.inputTokens
    callbacks.onUsageUpdate(state.tokenUsage)

    // ── 缓存断裂检测 ──
    // 上一轮明明读到了很多缓存 token，这一轮突然读到很少，就怀疑 prompt cache 被意外破坏了，然后写一条 debug 日志。

    const turnCacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0 // 取出这一轮命中的缓存 token 数。
    if (state.expectCacheMiss) { // true 表示下一轮 cache-read 下降是预期内的，例如刚压缩过或切了 permissionMode。
      state.expectCacheMiss = false // 则本轮置为 false
    } else if (state.prevTurnCacheRead > 2000 && turnCacheRead < state.prevTurnCacheRead * 0.5) { // 说明掉了超过 50%。

    }
    state.prevTurnCacheRead = turnCacheRead

    // 把 usage 快照顺手写进 jsonl transcript。
    // 这个步骤是按轮次做的：picker 其实只需要最后一条，
    // 但我们还是每轮都写，这样进程崩了也不会丢掉最后的统计。
    // 这里是 fire-and-forget，不会阻塞主循环。
    void appendUsage(state, modelId)
  }

  return result.finishReason
}

type TurnOutcome =
  /** 这一轮正常完成，`finishReason` 决定下一步怎么走。 */
  | { kind: 'done'; finishReason: string; result: StreamResult }
  /** 致命错误（已经通知过 callbacks 了），调用方应该直接退出循环。 */
  | { kind: 'error' }
  /** 上下文超了，已经压缩过了，调用方应该重试这一轮。 */
  | { kind: 'retry' }
  /** 用户中止了请求（Esc / Ctrl+C）。
   *  这里不会走 onError，UI 会单独显示 `[Request interrupted by user]`。 */
  | { kind: 'aborted' }

/** streamText / fetch 抛出的 AbortError 表示这次请求被取消了。
 *  另外，如果 abortSignal 已经处于 aborted 状态，
 *  我们也认为当前错误属于取消流程。
 *  有些供应商会把底层 AbortError 包成自己的错误类，
 *  但它们通常还是会先把 signal 置为 aborted。 */
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
}

/** 构建这一轮实际可用的工具集合，按以下规则叠加：
 *  1. 永远保留静态工具表
 *  2. 如果有 subAgentRegistry，就补上 task 工具
 *  3. 如果传了 options.toolFilter，就再做 allow / deny 过滤
 *
 *  这个集合只在会话内计算一次并缓存，
 *  因为同一个会话里工具注册表和过滤规则都不会变。 */
function buildTools(options: AgentOptions) {
  // 这里先用更宽松的记录类型来接工具表，
  // 因为 AI SDK 的工具组合类型会随着注册内容变化。
  const tools: Record<string, unknown> = { ...toolRegistry }

  // 子 agent 是作为工具调用触发的
  if (options.subAgentRegistry) {
    tools.task = createTaskTool(options.subAgentRegistry)
  }

  if (options.skillRegistry && options.skillRegistry.names().length > 0) {
    tools.activateSkill = createActivateSkillTool(options.skillRegistry)
  }

  // MCP 工具这里不提供 `execute`，这样 AI SDK 会把它们留在 `result.toolCalls` 里，
  // 交给 processToolCalls 统一走权限、循环护栏和 abortSignal 管线。
  if (options.mcpRegistry) {
    // 这两个是通用的 MCP 感知内建工具。
    // 只有在 MCP 开启时才注册，避免模型在没有 MCP 上下文时乱猜资源 URI。
    tools.listMcpResources = listMcpResources
    tools.readMcpResource = readMcpResource
    for (const entry of options.mcpRegistry.list()) {
      tools[entry.callableName] = bridgeMcpTool(entry)
    }
  }

  const filter = options.toolFilter
  if (filter) {
    if (filter.allow) {
      const allowSet = new Set(filter.allow)
      for (const name of Object.keys(tools)) {
        if (!allowSet.has(name)) delete tools[name]
      }
    }
    if (filter.deny) {
      for (const name of filter.deny) {
        delete tools[name]
      }
    }
  }

  return tools
}

/** 跑一轮 Agent：流式输出到 UI，再把响应收回来。
 *  这层要尽量抗错误。 */
async function runTurn(
  state: LoopState,
  model: LanguageModel,
  options: AgentOptions,
  systemPrompt: string,
  callbacks: AgentCallbacks,
  effectiveTools: Record<string, any>,
  turn: number,
): Promise<TurnOutcome> {
  // 在每次发 API 请求前先做一遍防御性检查：
  // 如果上一轮留下了 assistant tool_call，但整个 history 里找不到配套的 tool_result，
  // 就补一个合成的错误结果，保证这次请求体结构合法。
  // 这种问题通常来自两种情况：
  // 1. 模型吐了坏输入，SDK 拒绝执行，结果没落下来；
  // 2. 某一轮中途报错，tool_call 没来得及收尾。
  // 供应商对 tool_call ↔ tool_result 的配对要求很死，
  // 否则就会报出类似 “tool must be a response to a preceding message with tool_calls” 的错。
  // 这里每轮都跑一次，成本很低，但很稳。
  repairOrphanToolCalls(state.messages)

  // 纯文本供应商（例如 DeepSeek 或一些自定义供应商）看到剩下的 image/file
  // 部分会直接 400，所以在流开始前要先把这些二进制内容改写成 OCR 文本。
  // 多模态供应商会在 helper 里根据能力标记直接短路。
  await downgradeBinaryPartsForProvider(state.messages, options.modelId)

  // 每家供应商的 prompt 缓存方式不同：
  // Anthropic 会在 system prompt + 最近一个 tool + 最近两条消息上打 cache_control；
  // OpenAI 会用一个稳定的 promptCacheKey，并且和 sessionId 绑定；
  // OpenAI-compatible 供应商则依赖 LoopState 里的 systemPromptCache 保持前缀字节稳定。
  const cached = applyCacheControl({
    system: systemPrompt,
    messages: state.messages,
    tools: effectiveTools,
    modelId: options.modelId,
    sessionId: state.sessionId,
  })

  // extended thinking / reasoning 开关。
  // 用户在界面里执行 `/thinking on|off` 时，会改动 `options.thinking`。
  // 这里把这个布尔值翻译成各家供应商自己的字段：
  // Anthropic 用 `thinking`，Google 用 `thinkingConfig`，Alibaba 用 `enableThinking` 等。
  // 对于没有 thinking 概念的模型（比如 gpt-4.1、grok-3、glm-4-plus），
  // 就传一个空对象，SDK 会自动忽略无关字段。
  // 默认值设为关闭，这样旧配置里少一个字段时，不会突然让用户感觉质量/延迟变了。
  const thinkingOptions = getThinkingProviderOptions(options.modelId, options.thinking ?? false)
  const mergedProviderOptions = mergeThinkingOptions(cached.providerOptions, thinkingOptions)

  let result: StreamResult
  try {
    result = streamText({
      model,
      system: cached.system,
      messages: cached.messages,
      tools: cached.tools ?? effectiveTools,
      maxRetries: 3,
      abortSignal: options.abortSignal,
      // 这里显式设置上限，避免供应商默认值把长回复悄悄截断。
      // 大多数供应商会把过高的值自动夹住，但也有的会直接 400。
      // getMaxOutputTokens 会按模型套一个上限；不认识的模型就回落到模块默认值。
      maxOutputTokens: getMaxOutputTokens(options.modelId),
      // AI SDK 把 `providerOptions` 类型收得比较死，写成 `SharedV3ProviderOptions`
      // 这种嵌套 JSONObject。
      // 但我们的 cache-control helper 会返回更宽松的 `Record<string, unknown>`，
      // 因为各家供应商字段变化太快，没法一直维持严格联合类型同步。
      // 运行时其实只要求是窄 JSON，这里就在唯一的调用点做一次类型断言。
      providerOptions: mergedProviderOptions as Parameters<typeof streamText>[0]['providerOptions'],
      // 这里关掉 SDK 默认的 onError。
      // 默认行为是 `console.error(error)`，还会通过 util.inspect
      // 把完整的 RetryError 对象 dump 到 stderr，
      // 里面会带 stack、嵌套 APICallError 数组和供应商响应体。
      // 我们已经会在下面的 try/catch 里通过 classifyApiError + callbacks.onError
      // 输出一行更友好的错误信息，所以这个原始 dump 既吓人又不实用。
      // 但保留一个 debug 后门，方便调试。
      onError: ({ error }) => {
        if (process.env.DEBUG_STDOUT) { }
      },
    }) as unknown as StreamResult
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }

  // 在 await 流之前，先给 SDK 暴露出来的兄弟 Promise 都挂上 .catch(noop)。
  // 这些 Promise 包括 response / usage / finishReason / toolCalls。
  // 一旦请求失败，SDK 会在同一个 tick 里把它们一起 reject。
  // 如果我们等 fullStream 先 throw，再去 drain，Node 的未处理拒绝扫描
  // 可能会抢先触发，进而把进程打掉。
  // 这里提前挂 catch 是幂等的，后面 `await result.response` 还是会照常 reject。
  drainStreamResult(result)

  try {
    await streamChunksToUI(result, callbacks) // 它会读 result.fullStream
  } catch (err) {
    // 静默把 AI SDK 里还挂着的 Promise 都 drain 掉，
    // 这样未处理拒绝警告（比如 NoOutputGeneratedError）就不会漏到 stderr。
    drainStreamResult(result)

    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    if (isContextTooLongError(err)) {
      // 如果报错是上下文超长，尝试压缩上下文再重试
      const compressed = await handleContextTooLong(state, model, callbacks, {
        // compressed 代表压缩成功
        hookBus: options.hookBus,
        modelId: options.modelId,
        cwd: process.cwd(),
        abortSignal: options.abortSignal,
      })
      // 压缩本身也要额外跑一轮 LLM，请求通常要 2–5 秒，而且不接收 abort signal。
      // 如果用户在压缩期间按了 Esc，下一次 runTurn 会立刻因为 aborted signal
      // 被 SDK 拒掉，等于白白做一遍请求准备。
      // 所以这里直接退出。
      if (options.abortSignal?.aborted) return { kind: 'aborted' }
      if (compressed) return { kind: 'retry' } // 如果压缩成功，返回 retry，让调用方重试这一轮
    }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }

  try {
    const finishReason = await collectTurnResponse(result, state, options.modelId, callbacks)
    return { kind: 'done', finishReason, result }
  } catch (err) {
    drainStreamResult(result)
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }
}

/** 主 Agent 循环。 */
export async function agentLoop(
  userMessage: UserContent,
  model: LanguageModel,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  existingState?: LoopState,
): Promise<AgentLoopResult> {
  const state = existingState ?? createLoopState(options.permissionMode ?? 'default')

  // ── 插件钩子：SessionStart ──
  // 这是会话第一次进入的标记。这里是 fire-and-forget，
  // 但仍然会 await 一下，这样 hooks 才有机会在会话级别注入 env / state。
  // 以前 SessionStart 是在第一次 agentLoop 调用时触发的。
  // 现在它改到 CLI 启动路径 packages/cli/src/index.ts 去触发，
  // 这样 hooks 能在用户真正交互前就完成初始化。
  // 如果一个会话只跑了 slash 命令就退出、没有任何用户消息，
  // 那么旧位置会悄悄跳过这个事件。
  // 子 Agent 一直都会传 existingState，所以它们本来也不会进到这里；
  // 直接调用 agentLoop 的库使用者，则需要自己在会话边界触发 SessionStart。

  // ── 插件钩子：UserPromptSubmit ──
  // 这里要在消息真正进 state.messages 之前执行，
  // 这样如果钩子决定 deny，transcript 就不会留下一个半截 prompt。
  // 如果钩子返回 modify + context，
  // 我们会把注入文本直接拼到用户消息里，而不是额外加第二条 user 消息，
  // 因为连续两条 user 消息会干扰一些供应商的 tool-call 顺序判断。
  let effectiveUserMessage = userMessage
  if (options.hookBus?.has('UserPromptSubmit')) {
    const promptText = userContentToText(userMessage)
    try {
      const decisions = await options.hookBus.emit(
        { name: 'UserPromptSubmit', session: { cwd: process.cwd(), modelId: options.modelId }, prompt: promptText },
        { signal: options.abortSignal },
      )
      const effect = aggregateUserPromptSubmit(decisions)
      if (effect.decision === 'deny') {
        const reason = effect.reason ?? 'blocked by plugin hook'
        const notice = `[Prompt blocked by plugin hook: ${reason}]`
        callbacks.onTextDelta(notice)
        // 这里要同时压入用户原始消息和一条合成的 assistant 响应，
        // 这样 state.messages 还能保持“user / assistant 交替”的合法结构，
        // 下一次提交也能接着往下跑。
        state.messages.push({ role: 'user', content: userMessage })
        state.messages.push({ role: 'assistant', content: notice })
        return { state, turnCount: 0 }
      }
      if (effect.context) {
        effectiveUserMessage = prependContext(userMessage, effect.context)
      }
    } catch (err) {
      if (options.abortSignal?.aborted) {
        return { state, turnCount: 0 }
      }

    }
  }

  state.messages.push({ role: 'user', content: effectiveUserMessage })

  // ── 回滚检查点 ──
  // 这里会把 `state.filesModified` 里每个文件的工作区状态做一次快照，
  // 同时记录消息索引锚点，这样以后 `/rewind` 就能把文件状态和对话
  // 一起回退到这里。
  //
  // 子 Agent 不会走这一段，因为它们有自己临时的 LoopState，
  // 用户在 picker 里也看不到它们，没必要为此制造磁盘开销。
  // `subAgentRegistry` 只在主循环里有，`runSubAgent` 会显式清掉。
  //
  // 这里要 await，是为了避免后续工具太快启动，和快照读取抢时序。
  // 代价通常就是一次 mkdir + N 次小读，哪怕有几十个文件也一般在 30ms 以内，
  // 因为内容地址去重会跳过已经写过的 blob。
  // createCheckpoint 本身不会 throw，FS 失败时直接返回 null，
  // 这样回滚功能只是不可用，但不会把 UI 搞崩。

  // subAgentRegistry 就是“子 agent 注册表”。它里面保存当前 CLI 会话可用的子 agent 定义，
//   为什么用它判断？因为代码里主 agent 和子 agent 的区别刚好是：
// 主 agent：CLI 启动时传入 subAgentRegistry
// 子 agent：runSubAgent 会显式设置 subAgentRegistry: undefined
// 也就是说，subAgentRegistry 被当成了“主循环标记”。
  if (options.subAgentRegistry) {
    const promptPreview = userContentToText(effectiveUserMessage).slice(0, 200)
    const ckpt = await createCheckpoint(state, promptPreview)
    if (ckpt) void appendCheckpoint(state, ckpt)
  }

  // 这是单次调用的轮次计数器。
  // 它只属于这一轮 agentLoop，等函数重新进入（下一次用户提交）时会从 0 重新开始。
  // 这就是之前那个“Reached maximum turns” bug 的结构性修复：
  // 以前计数器放在 state 上，会跨整个 CLI 会话累加。
  let turn = 0

  // session 的 task-slug 只在第一轮生成一次，后面不再改。
  // 它会影响 session-usage 文件名（`<slug>-<sessionId>.usage.json`），
  // 计划模式下也会影响 plan 文件名。
  // 这是一个“设置后不变”的值：如果中途改掉，前一轮已经写出去的文件
  // 就会变成孤儿文件，找不到对应关系。
  //
  // 如果第一条消息不是纯 ASCII（比如 CJK 或只有 emoji），
  // `generateTaskSlug` 会单独跑一轮 generateText，把任务概括成 2~4 个英文词；
  // 如果是 ASCII，就直接本地 slugify，不需要网络。
  // 我们把它和 knowledge / git 检测并行启动，这样 LLM 往返能和磁盘操作重叠，
  // 不会给首轮增加串行延迟。
  // 在写 session usage 或 plan 文件之前，这个 slug 一定要先 await 出来，
  // 不然文件名可能还是空的。
  const taskText = userContentToText(userMessage)
  // 去掉 `<activated_skill>` XML 块，这样 session slug 和首条 prompt
  // 才能反映用户真实意图，而不是被注入的 skill 内容污染。
  const taskTextForMeta = taskText.replace(/<activated_skill\b[^>]*>[\s\S]*?<\/activated_skill>/gi, '').trim()
  const taskSlugPromise: Promise<string> = state.taskSlug
    ? Promise.resolve(state.taskSlug)
    : generateTaskSlug(taskTextForMeta || taskText, model, options.modelId, options.abortSignal)

  // 会话续接由 UI 显式处理：如果用户接受 resume 提示，
  // 待办内容会直接放进第一条用户消息里。
  // 以前把它自动塞进每个 system prompt，会让模型连打个招呼都像在继续探索，
  // 所以现在不这么做了。
  const fullKnowledgeContext = await buildKnowledgeContext()

  // 只探测一次是不是 git 仓库，简单 stat 就够了，没必要每轮都碰磁盘。
  const isGitRepo = await fs
    .stat(path.join(process.cwd(), '.git'))
    .then(() => true)
    .catch(() => false)

  // 把知识上下文和 git 状态缓存到 state 上，给子 Agent 复用。
  state.knowledgeContext = fullKnowledgeContext
  state.isGitRepo = isGitRepo

  // 这里把 slug 真正落定。
  // 它必须在任何 persistUsageSnapshot（每轮）或下面的 plan 文件写入前就准备好。
  // `generateTaskSlug` 失败时会返回 ''，这时候 session / plan 文件
  // 会回落到以前那套纯时间戳命名。
  state.taskSlug = await taskSlugPromise

  // plan 文件路径也是懒加载的。
  // 只在 plan 模式的第一轮、并且还没有 currentPlanPath 时，才从任务文本里推导一次。
  // 如果每一轮都重新推导，就会覆盖模型已经在编辑的路径，所以这个判断很关键。
  // 这里把 session 级 slug 也带上，这样非 ASCII 任务文本仍然能得到可读文件名，
  // 而不是只有时间戳。
  if (state.permissionMode === 'plan' && !state.currentPlanPath) {
    state.currentPlanPath = makePlanFilePath(taskText, { slug: state.taskSlug })
  }

  // 把 session header 写进 jsonl 文件。
  // 对 resume 场景这是幂等的，header 行已经存在的话就直接跳过。
  // 这一步必须在 taskSlug 解析之后做，因为文件名是 `<slug>-<id>.jsonl`。
  // 这里也是 fire-and-forget，不会因为 FS 错误卡住主循环。
  void appendHeader(state, options.modelId, taskTextForMeta || taskText)

  const compressionThreshold = getCompressionThreshold(options.modelId)

  // 每个会话只构建一次有效工具集。
  // 如果有 subAgentRegistry，就会补上 task 工具；
  // 如果是子 Agent，还会应用 toolFilter。
  // 这个集合在会话生命周期里是稳定的。
  const effectiveTools = buildTools(options)

  // 针对 `length` 的自动续写。
  // reasoning 模型有可能在用户可见回复还没说完时，就把输出 token 用光。
  // 老行为是直接停在半句上，然后抛错误，用户体验像坏掉了一样。
  // 现在改成塞一条简短的“继续”提示再跑一轮，同时加上上限，
  // 避免某些失控回复无限续下去。
  const MAX_CONTINUATIONS = 3 // 自动续写的最大次数。作用是 模型没说完 -> 自动继续
  let continuationAttempts = 0 // 当前已经续写了几次的计数器。一开始是 0。每次遇到 finishReason === 'length' 并触发自动续写时，它会加 1。
  // 记录我们是不是因为一个干净的 `stop` 退出的。
  // 只有这种情况，后面的记忆提取器才应该运行。
  let completedNormally = false // 这个表示这次 agent loop 最后是不是“正常完成”
  // 为什么需要它？因为后面有“记忆提取器”。只有当本轮对话正常结束时，才应该从对话中提取长期记忆。

  while (options.maxTurns === undefined || turn < options.maxTurns) {
    turn++

    // 把上一轮还没刷盘的消息扫进 jsonl。
    // 这是基于 diff 的增量追加，只会写 `state.messages.slice(persistedMessageCount)`，
    // 所以如果没变化就是 no-op。
    // 它必须放在 checkAndCompressContext 之前，
    // 因为一旦触发压缩，数组会被原地改写，而且压缩流程会自己写 boundary 再重刷。
    // 这要求压缩前的尾巴已经先落盘。
    void flushPendingMessages(state)

    await checkAndCompressContext(state, model, compressionThreshold, callbacks, {
      hookBus: options.hookBus,
      modelId: options.modelId,
      cwd: process.cwd(),
      abortSignal: options.abortSignal,
    })

    // 系统提示词只在会话里构建一次，然后跨轮复用。
    // 对 OpenAI-compatible 供应商来说，字节级稳定的前缀是自动 prefix caching
    // 的前提（DeepSeek、Moonshot、Alibaba、Zhipu、xAI 等都依赖这个思路）。
    // 如果这段字符串每轮都变，比如 buildSystemPrompt 里插了一个新时间戳，
    // 那缓存就会每次都 miss。
    //
    // plan-mode 的 overlay 也会一起放进这个字节稳定缓存里。
    // 当 permissionMode 切换时，tool-execution 会把 cache 置空，
    // 这样每种模式都能在持续期内保持缓存友好。只有边界那一轮会付出一次 miss。
    if (!state.systemPromptCache) {
      // 这里是即将进入 system prompt 的技能名字。
      // 用它可以确认被禁用的 skill 已经被过滤掉了，
      // 并且你在 prompt 里看到的名字和 registry 的 enabled 集合一致。
      // 这段日志只会在每个会话里打一次，因为 prompt 只构建一次。
      if (options.skillRegistry) {
        const enabled = options.skillRegistry.list().map((s) => s.name)
        const disabled = options.skillRegistry
          .listAll()
          .filter((s) => s.disabled)
          .map((s) => s.name)

      }
      state.systemPromptCache = buildSystemPrompt({
        knowledgeContext: fullKnowledgeContext,
        modelId: options.modelId,
        isGitRepo,
        planMode: state.permissionMode === 'plan',
        planFilePath: state.currentPlanPath ?? undefined,
        // 把 MCP 工具传进去，这样 system prompt 里就会追加 `## MCP Tools` 段落。
        // 如果 registry 为空或不存在，buildSystemPrompt 的占位符会解析成 ""，
        // 这时 prompt 就和没有 MCP 时完全一致，
        // 可以保住没配置 MCP 的会话的 prefix cache。
        mcpTools: options.mcpRegistry ? toSystemPromptEntries(options.mcpRegistry.list()) : undefined,
        skills: options.skillRegistry ? options.skillRegistry.list() : undefined,
      })
    }
    const systemPrompt = state.systemPromptCache

    const outcome = await runTurn(state, model, options, systemPrompt, callbacks, effectiveTools, turn)

    // ── 插件钩子：TurnComplete ──
    // 不管 finish reason 是什么，这里都会触发，包括 error / abort。
    // 这样通知类和审计类 hook 才能看到每一轮，而不只是干净结束的那几轮。
    // 它是并行 + best-effort 的，hook 失败或 abort 都不应该阻塞下面的结果分发。
    if (options.hookBus?.has('TurnComplete')) {
      const event: HookEvent = {
        name: 'TurnComplete',
        session: { cwd: process.cwd(), modelId: options.modelId },
        turn,
        tokenUsage: {
          inputTokens: state.tokenUsage.inputTokens,
          outputTokens: state.tokenUsage.outputTokens,
          totalTokens: state.tokenUsage.totalTokens,
        },
      }
      void options.hookBus
        .emit(event, { signal: options.abortSignal })
        .catch((err) => {})
    }

    if (outcome.kind === 'error') break
    if (outcome.kind === 'aborted') break
    if (outcome.kind === 'retry') {
      // 通过 reactive compaction 恢复回来的失败尝试，不要算进轮次。
      turn--
      continue
    }

    if (outcome.finishReason === 'tool-calls') {
      // 意思是模型说：“我现在需要调用工具，比如读文件、改文件、跑命令。”
      // 只要有一次成功的 tool round，就说明模型真的在往前走，
      // 这时要把连续截断计数清零。
      continuationAttempts = 0
      let toolCalls: Awaited<StreamResult['toolCalls']>
      try {
        toolCalls = await outcome.result.toolCalls
      } catch (err) {
        if (isAbortError(err, options.abortSignal)) break
        callbacks.onError(new Error(classifyApiError(err).message))
        break
      }

      // 拿到这些工具调用后，再交给 processToolCalls(...) 真正执行。
      await processToolCalls(toolCalls, state, options, callbacks, model)
      // processToolCalls 在 abort 时会用合成结果短路掉，
      // 所以下一轮就不要再发 streamText 了，否则只会立刻再抛一次 AbortError。
      if (options.abortSignal?.aborted) break
      // 为啥 aborted 放在 processToolCalls 后面处理，
      // 因为中断可能发生在工具执行期间。如果把 aborted 放在 processToolCalls 中，中断了会执行 continue，
      // 然后进入下一轮，再调用 streamText。但这时 abortSignal 已经是 aborted，下一轮请求会立刻抛 AbortError，等于多跑了一圈没意义的错误流程。

      // 然后主循环 continue，下一轮再把这些工具结果发给模型，让模型基于结果继续回答。
      continue
    }

    if (outcome.finishReason === 'length') {
      if (continuationAttempts < MAX_CONTINUATIONS) {
        continuationAttempts++

        // 给模型一个提示，让它准确接着上次停下的位置继续。
        // 这条消息会进 state.messages，但不会走 UI 消息通道，
        // 所以用户看到的还是一段连续输出，只是中间最多顿一下。
        state.messages.push({
          role: 'user',
          content:
            'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.',
        })
        continue
      }
      callbacks.onError(
        new Error(
          `Response still truncated after ${MAX_CONTINUATIONS} continuation attempts — ask a narrower question.`,
        ),
      )
      break
    }

    // stop            模型正常说完了
    // content-filter  模型被安全过滤器打断了
    // length          模型因为输出 token 不够被截断了
    // tool-calls      模型要调用工具，还没最终回答

    // 比如模型本来要继续输出，但 provider 判断内容可能涉及不允许生成的内容，就停止生成，并把结束原因标成：'content-filter'
    if (outcome.finishReason === 'content-filter') {
      callbacks.onError(new Error('Response stopped by the provider content filter.'))
    } else if (outcome.finishReason === 'stop') {
      completedNormally = true
    }

    break
  }

  // 只有在下面三个条件都满足时，才报告“达到最大轮次”：
  //   1. 真的设置了上限（交互模式没有上限，也就不存在“达到”）；
  //   2. 我们确实碰到了这个上限；
  //   3. 模型没有在同一轮里已经干净结束。
  //      `!completedNormally` 这个 guard 就是在处理 `stop` 刚好落在 maxTurns-th 那一轮的边界。
  if (options.maxTurns !== undefined && turn >= options.maxTurns && !completedNormally) {
    callbacks.onError(new Error(`Reached maximum turns (${options.maxTurns}). Stopping agent loop.`))
  }

  void flushPendingMessages(state)

  // 轮后记忆提取器：只会在干净的 `stop` 结束时运行，
  // 也就是没有 error、没有 abort、没有 content-filter、也没有 length 上限放弃的情况。
  // 它也是 fire-and-forget，用户可以立刻输入下一条 prompt，
  // 而一轮 generateText + Output.object 会在后台扫描 transcript，
  // 提炼出值得持久保存的知识点。
  // 写入会直接走 AutoMemory 的静默路径，
  // 这样 ChatInput 就不会在用户回复结束后再冒出一条工具行。
  if (completedNormally && !options.abortSignal?.aborted) {
    // “本轮回答正常完成之后”。后台异步抽取并写入记忆
    // 用户交互窗口没关闭时会写入吗？会。
    // 回答结束后，-> 后台开始抽取记忆 -> 用户界面仍然可用
    // 如果用户此时把终端关了呢？那后台任务可能来不及完成。
    // 如果进程被终端关闭杀掉，正在进行的模型请求或文件写入就可能中断。结果就是：这次记忆可能不会写入。
    // 已写入成功的部分会留下；没来得及写的就丢了。
    // 如果用户此时又发起了新消息呢？新消息可以继续处理。
    // memory-extractor.ts 里有这个变量：let inflight: Promise<void> = Promise.resolve()
    // inflight 的作用是排队。如果上一轮记忆抽取还没结束，下一轮又正常结束并触发新的抽取，那么新的抽取不会并发乱跑，而是接到队列后面：
    // 这就是 inflight 的作用：防止多个记忆抽取同时写同一份 AutoMemory。
    void runMemoryExtractor({
      parentState: state,
      parentModel: model,
      abortSignal: options.abortSignal,
      onWrite: callbacks.onMemoryWrite,
    })
  }

  return { state, turnCount: turn }
}

/** 把内存里的消息同步到 session jsonl。
 *  这个函数会在退出 / 清理路径上调用，
 *  这样进程被杀掉时，最后一轮也尽量不会丢。
 *  每轮里的追加动作已经在 agentLoop 里做过了，
 *  这里只是兜底把剩下的内容再冲一遍。
 *  它能容忍半初始化状态（比如还没有 taskSlug），
 *  因为没东西可写时 flushPendingMessages 会直接 no-op。
 *  这里保留 `model` 参数只是为了和旧的“生成摘要”版本保持 API 稳定，
 *  现在它已经不用了，因为摘要已经跟着 `compact-boundary` 一起写了。 */
export async function saveSession(state: LoopState, _model: LanguageModel): Promise<void> {
  await flushPendingMessages(state)
}
