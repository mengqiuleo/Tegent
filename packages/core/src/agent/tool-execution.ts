// 这个文件负责把“模型说自己要调用工具”变成“真正执行了工具，并把结果写回 messages”。
// 你可以把它理解成 agent loop 里的工具调度器：
// - 先过滤掉不该执行的 tool_call
// - 再做 hook / loop guard / 权限判断
// - 然后执行真实工具
// - 最后把 tool_result 塞回 state.messages，供下一轮模型继续推理
//
// 这里最重要的约束不是“怎么写得短”，而是“怎么不破坏 provider 的消息顺序”。
// 一旦 assistant/tool/user 的顺序错了，某些模型提供方会直接 400。
import fs from 'node:fs/promises'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { aggregatePostToolUse, aggregatePreToolUse } from '../hooks/bus.js'
import { classifyDecision } from '../mcp/permissions.js'
import { checkPermission } from '../permissions/index.js'
import { truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, reportProgress } from '../tools/progress.js'
import { getShellProvider } from '../tools/shell-provider.js'
import type { AgentCallbacks, AgentOptions, LanguageModel } from '../types/index.js'

import { foldShellErrorNoise } from '../utils/shell-error.js'
import { computeEditDiff } from './diff.js'
import { checkForLoop, recordToolCall } from './loop-guard.js'
import type { LoopState } from './loop-state.js'
import { isToolErrorString, toolErrorFromUnknown, toolErrorString, toolResultMessage } from './messages.js'
import { handleEnterPlanMode, handleExitPlanMode, handleTodoWrite } from './plan-tools.js'
import { runSubAgent } from './sub-agents/runner.js'

// 中文导读：
// 这个文件是“模型工具调用 -> 实际执行 -> tool_result 写回消息历史”的调度中心。
// 主路径大致是：
// 1. processToolCalls 收到本轮模型提出的 toolCalls。
// 2. 过滤 SDK 已拒绝的 ghost call 和已经自动执行过的工具。
// 3. task 工具可并行，其它会串行跑，避免共享状态和终端输出互相打架。
// 4. handleToolCall 依次经过插件 hook、特殊工具处理、MCP 权限、loop guard、普通权限、实际执行。
// 5. 无论成功、失败、拒绝、取消，都尽量写入合法 tool_result，避免下一轮 provider 因工具配对不完整而 400。

/**
 * 判断某个错误是不是“用户中断”。
 *
 * 这个 helper 的目标非常朴素：只要能确认是 abort，就统一当成中断处理，
 * 不要把它继续抛到更上层变成真正的错误。
 */
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  // Abort 可能来自 AbortSignal 本身。
  if (signal?.aborted) return true

  // 也可能来自不同平台/库包装出来的 Error。
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
}

/**
 * 统计某个子串在字符串中出现了几次。
 *
 * 这里不用 split，因为 split 会额外分配数组；这个函数只用在 edit 的
 * “oldString 是否唯一” 检查上，写法尽量直接。
 */
function countOccurrences(content: string, search: string): number {
  let count = 0
  let pos = 0
  while ((pos = content.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

/**
 * 执行写文件相关工具。
 *
 * 这个函数只负责“文件系统副作用 + 生成短结果字符串”。
 * 如果 UI 需要展示 diff，会通过 callbacks.onFileEdit 额外拿到结构化 patch，
 * 但那只是展示用旁路数据，不会回写到模型消息里。
 */
async function executeWriteTool(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  callbacks: AgentCallbacks,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (toolName === 'writeFile') {
    // writeFile 是整文件写入：先读旧内容用于 diff，再覆盖写入。
    const filePath = input.filePath as string
    const content = input.content as string
    reportProgress(toolCallId, `Writing ${filePath}`)

    // 目录不存在就先补出来，避免上层工具还要自己处理父目录创建。
    await fs.mkdir(path.dirname(filePath), { recursive: true })

    // 先读旧内容，目的是生成 diff 和判断“这是创建还是覆盖”。
    // 这里把读取失败统一当成“没有旧文件”看待，因为真正要不要报错，
    // 交给后面的 writeFile 实际执行去决定。
    let oldContent: string | null = null
    try {
      oldContent = await fs.readFile(filePath, { encoding: 'utf-8', signal })
    } catch {
      oldContent = null
    }
    await fs.writeFile(filePath, content, { encoding: 'utf-8', signal })

    // 是否是首次创建，决定最终展示文案。
    const isNew = oldContent === null

    // 计算行数只是为了给模型一个直观反馈，不影响实际写入结果。
    const parts = content.split('\n')
    const lineCount = content.endsWith('\n') ? parts.length - 1 : parts.length

    // 把差异发送给 UI，方便在工具行下面显示彩色 patch。
    const payload = computeEditDiff(filePath, oldContent, content)
    if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)

    if (isNew) {
      return `File created: ${filePath} (${lineCount} lines)`
    }
    return `File written: ${filePath} (${lineCount} lines)`
  }

  if (toolName === 'edit') {
    // edit 是字符串替换：默认只允许唯一命中，replaceAll 显式开启才全量替换。
    const filePath = input.filePath as string
    const oldString = input.oldString as string
    const newString = input.newString as string
    const replaceAll = (input.replaceAll as boolean) ?? false

    reportProgress(toolCallId, `Editing ${filePath}`)

    // 读出完整文件内容，后面要先检查 oldString 是否存在且是否唯一。
    const content = await fs.readFile(filePath, { encoding: 'utf-8', signal })
    if (!replaceAll) {
      // 默认模式只允许一个命中，避免模型把多个相同片段一起改掉。
      const count = countOccurrences(content, oldString)
      if (count === 0) return toolErrorString(`old_string not found in ${filePath}`)
      if (count > 1)
        return toolErrorString(
          `old_string is not unique in ${filePath} (found ${count} occurrences). Provide more context or set replaceAll: true.`,
        )
    }

    // 真正替换内容。
    const newContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)
    await fs.writeFile(filePath, newContent, { encoding: 'utf-8', signal })

    // 同样给 UI 发 diff。
    const payload = computeEditDiff(filePath, content, newContent)
    if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)

    return `File edited: ${filePath}`
  }

  return toolErrorString('unknown write tool')
}

/**
 * 执行 shell 命令，并把 stdout/stderr 流式转发给 UI。
 *
 * 这里的职责不是“把输出完整收集后再显示”，而是尽量让用户看到正在发生什么。
 * 最终返回给模型的仍然是完整输出，只是实时进度做了节流。
 */
async function executeShell(
  command: string,
  timeout: number,
  signal: AbortSignal | undefined,
  callbacks: AgentCallbacks,
  toolCallId: string,
): Promise<{ output: string; isError: boolean }> {
  // shell provider 封装了当前平台的 spawn/cancel/timeout 细节。
  const proc = getShellProvider().spawn(command, { timeout, signal })

  // 先告诉 UI：命令开始跑了。
  reportProgress(toolCallId, 'Running command...')

  // 把实时进度消息节流到最多每 50ms 一次。
  // 原因很简单：有些命令会在极短时间内喷很多行，如果每行都更新一次进度，
  // UI 会被打得很碎，而且会和最后的 tool_result 提交抢时间。
  let lastProgressTime = 0
  const PROGRESS_THROTTLE_MS = 50

  const onChunk = (chunk: Buffer) => {
    const s = chunk.toString()

    // 原始输出还是完整转发给 UI 输出区。
    callbacks.onShellOutput(s)
    const now = Date.now()
    if (now - lastProgressTime < PROGRESS_THROTTLE_MS) return

    // 取 chunk 里最后一条非空行作为进度消息。
    // 这样看起来最像“当前卡在哪一步”。
    const lines = s.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const last = lines[lines.length - 1]
    if (last) {
      lastProgressTime = now

      // 太长就截断，避免进度文本把 UI 顶乱。
      const trimmed = last.length > 120 ? last.slice(0, 117) + '...' : last
      reportProgress(toolCallId, trimmed)
    }
  }

  proc.stdout?.on('data', onChunk)
  proc.stderr?.on('data', onChunk)

  // 等待子进程结束。这里拿到的是完整结果，不是实时流。
  const result = await proc
  // 在错误到达模型前，把 PowerShell/cmd 多行错误块折叠成单行。
  // 这样做是为了减少“重复错误噪音”淹没真正诊断信息。
  const toStr = (v: unknown): string => (typeof v === 'string' ? v : '')
  let stdout = foldShellErrorNoise(toStr(result.stdout))
  let stderr = foldShellErrorNoise(toStr(result.stderr))

  // 如果输出太多导致 buffer 满了，就把正文截断并明确标记。
  const isMaxBuffer = result.isMaxBuffer ?? false
  if (isMaxBuffer) {
    const INLINE_CAP = 30_000
    if (stdout.length > INLINE_CAP)
      stdout = stdout.slice(0, INLINE_CAP) + '\n... [stdout truncated — exceeded buffer limit]'
    if (stderr.length > INLINE_CAP)
      stderr = stderr.slice(0, INLINE_CAP) + '\n... [stderr truncated — exceeded buffer limit]'
  }

  // 合并 stdout 和 stderr，给模型一个单独的输出块。
  const output = [stdout, stderr].filter(Boolean).join('\n').trim()
  if (result.exitCode !== 0 || isMaxBuffer) {
    const suffix = isMaxBuffer ? ' (output exceeded buffer limit)' : ''
    const text = output ? `${output}\nExit code ${result.exitCode}${suffix}` : `Exit code ${result.exitCode}${suffix}`
    return { output: text, isError: true }
  }
  return { output: output || 'Done', isError: false }
}

/**
 * 把 tool_result 写回 state，并通知 UI。
 *
 * 这是一个很核心的小函数：只要真的得到了一个“模型应该看见的结果”，
 * 最终都要经过这里落到 state.messages。
 */
function pushToolResult(
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError = false,
): void {
  // state.messages 里的 tool-result 是 provider 协议必需品，UI 回调只是展示层。
  state.messages.push(toolResultMessage(toolCallId, toolName, output))

  // 清理该 tool_call 对应的 progress reporter，避免后续进度继续刷同一个 id。
  // 自动执行工具会在 SDK 的流事件里自己清理，这里重复调用也不会有副作用。
  clearProgressReporter(toolCallId)
  callbacks.onToolResult(toolCallId, output, isError)
}

type ToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> }

/**
 * 每个工具 handler 的共享上下文。
 *
 * 这样做比在调用点不断堆位置参数更稳，也便于 hook 修改 input 以后往下传。
 */
interface HandlerCtx {
  // 当前工具名和输入；PreToolUse hook 可能会改写 input。
  toolName: string
  input: Record<string, unknown>
  toolCallId: string
  state: LoopState
  options: AgentOptions
  callbacks: AgentCallbacks
  parentModel: LanguageModel
}

/**
 * 在 pushToolResult 外包一层 PostToolUse hook。
 *
 * 这个 helper 只包“真实成功结果”，而不包拒绝/中断/错误合成结果，
 * 因为后者再发 PostToolUse 往往会让 hook 作者误判工具真的完成了。
 */
async function pushSuccessfulToolResult(ctx: HandlerCtx, output: string, isError: boolean): Promise<void> {
  let effectiveOutput = output
  if (ctx.options.hookBus?.has('PostToolUse')) {
    // PostToolUse 可以改写工具输出，再把改写后的结果写回模型历史。
    try {
      const decisions = await ctx.options.hookBus.emit(
        {
          name: 'PostToolUse',
          session: { cwd: process.cwd(), modelId: ctx.options.modelId },
          tool: { name: ctx.toolName, args: ctx.input, callId: ctx.toolCallId, output, isError },
        },
        { signal: ctx.options.abortSignal },
      )
      const effect = aggregatePostToolUse(decisions)
      if (effect.output !== undefined) effectiveOutput = effect.output
    } catch (err) {
      if (ctx.options.abortSignal?.aborted) return

    }
  }
  pushToolResult(ctx.state, ctx.callbacks, ctx.toolCallId, ctx.toolName, effectiveOutput, isError)
}

type ToolHandler = (ctx: HandlerCtx) => Promise<void>

/** askUser：让模型向用户追问。 */
async function handleAskUser(ctx: HandlerCtx): Promise<void> {
  // askUser 的答案也要作为 tool_result 回给模型，否则它拿不到用户选择。
  const { input, toolCallId, toolName, state, callbacks } = ctx
  const question = input.question as string
  const optionsList = input.options as { label: string; description: string }[]
  const answer = await callbacks.onAskUser(question, optionsList)
  pushToolResult(state, callbacks, toolCallId, toolName, `User answered: ${answer}`)
}

/** task：把工作交给隔离的子代理。 */
async function handleTask(ctx: HandlerCtx): Promise<void> {
  // task 会启动隔离的子 agentLoop，父状态只接收最终文本和统计。
  const { input, toolCallId, toolName, state, options, callbacks, parentModel } = ctx
  const agentName = input.subagent_type as string
  const description = input.description as string
  const taskPrompt = input.prompt as string

  reportProgress(toolCallId, `Task: ${description} (${agentName})`)

  const result = await runSubAgent(
    {
      parentState: state,
      parentOptions: options,
      callbacks,
      toolCallId,
      agentName,
      description,
      prompt: taskPrompt,
      knowledgeContext: state.knowledgeContext ?? '',
      isGitRepo: state.isGitRepo ?? false,
    },
    parentModel,
  )

  const statsLine = `<task_stats tool_calls="${result.toolCallCount}" tokens="${result.tokenUsage.totalTokens}" duration_ms="${result.durationMs}" />`
  pushToolResult(state, callbacks, toolCallId, toolName, `${result.resultText}\n${statsLine}`)
}

/** listMcpResources：列出当前可见的 MCP 资源。 */
async function handleListMcpResources(ctx: HandlerCtx): Promise<void> {
  // 这里只读本地 registry，不访问远端 server。
  const { input, toolCallId, toolName, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  if (!registry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('MCP not configured'), true)
    return
  }
  const filter = (input.server as string | undefined)?.trim() || undefined
  const items = registry.listResources().filter((r) => !filter || r.serverName === filter)
  if (items.length === 0) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      filter ? `No resources on server "${filter}".` : 'No resources from any connected MCP server.',
    )
    return
  }
  const lines = items.map((r) => {
    const mime = r.mimeType ? ` (${r.mimeType})` : ''
    const desc = r.description ? `\n    ${r.description}` : ''
    return `${r.uri}\t[${r.serverName}] ${r.name}${mime}${desc}`
  })
  pushToolResult(state, callbacks, toolCallId, toolName, lines.join('\n'))
}

/** readMcpResource：按 URI 读取一个 MCP 资源。 */
async function handleReadMcpResource(ctx: HandlerCtx): Promise<void> {
  // 通过 URI 找到拥有它的 MCP server，再发起读取。
  const { input, toolCallId, toolName, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  if (!registry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('MCP not configured'), true)
    return
  }
  const uri = (input.uri as string | undefined) ?? ''
  if (!uri) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('Missing `uri` argument'), true)
    return
  }
  const client = registry.resourceServer(uri)
  if (!client) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      toolErrorString(`Resource URI not known: ${uri} — call listMcpResources first`),
      true,
    )
    return
  }
  reportProgress(toolCallId, `Reading ${uri}`)
  try {
    const result = await client.readResource(uri, options.abortSignal)
    pushToolResult(state, callbacks, toolCallId, toolName, truncateToolResult(result.text))
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(err), true)
  }
}

/**
 * 这些工具会绕过 loop guard 和后面的 writeFile/edit/shell 流水线。
 *
 * 原因是它们本身没有本地副作用，或者已经有独立的执行/权限机制。
 */
const BYPASS_LOOP_GUARD_HANDLERS: Record<string, ToolHandler> = {
  askUser: handleAskUser,
  task: handleTask,
  todoWrite: ({ input, toolCallId, state, callbacks }) =>
    handleTodoWrite(input, toolCallId, state, callbacks, pushToolResult),
  enterPlanMode: ({ input, toolCallId, state, options, callbacks }) =>
    handleEnterPlanMode(input, toolCallId, state, options, callbacks, pushToolResult),
  exitPlanMode: ({ input, toolCallId, state, callbacks }) =>
    handleExitPlanMode(input, toolCallId, state, callbacks, pushToolResult),
  listMcpResources: handleListMcpResources,
  readMcpResource: handleReadMcpResource,
}

/**
 * 对非 bypass 工具运行 loop guard。
 *
 * 返回 true 表示已经拦截了这次调用，调用方不要再继续执行真实工具。
 */
async function applyLoopGuard(ctx: HandlerCtx, deferred: ModelMessage[]): Promise<boolean> {
  // 从上下文里取出这个函数需要用到的字段。
  // toolName/input/toolCallId 用来判断“这次工具调用是不是重复调用”。
  // state 用来读取和记录最近工具调用历史。
  // callbacks 用来在硬阻断时询问用户。
  const { toolName, input, toolCallId, state, callbacks } = ctx

  // 检查当前工具调用是否命中重复调用熔断规则。
  // 返回值可能是：
  // - ok：没有重复到阈值，可以继续执行真实工具
  // - soft-block：重复到软阻断阈值，跳过真实工具，并把提醒作为 tool_result 给模型
  // - hard-block：重复到硬阻断阈值，除了跳过真实工具，还要问用户要不要暂停
  const loopCheck = checkForLoop(state, toolName, input, toolCallId)

  // ok 表示没有检测到危险重复。
  if (loopCheck.kind === 'ok') {
    // 即使没触发阻断，也要把这次调用记进最近工具调用历史，
    // 这样后面的调用才能知道“之前已经试过这个工具+参数”。
    recordToolCall(state, toolName, input, loopCheck.hash)

    // 返回 false 的意思是：没有拦截，调用方可以继续执行真实工具。
    return false
  }

  // 走到这里说明已经触发 soft-block 或 hard-block。
  // 仍然要记录本次调用，避免模型继续重复时计数断掉。
  recordToolCall(state, toolName, input, loopCheck.hash)

  // 组装一段给模型看的提醒文本。
  // 前缀 [loop-guard] 用来明确告诉模型：这是重复调用熔断器给出的结果。
  const guardMessage = `[loop-guard] ${loopCheck.message}`

  // 这里不是真执行工具，而是直接给模型一个合成的错误结果。
  // 这样可以保持 provider 协议合法：assistant 发了 tool_call，就一定有对应 tool_result。
  // 最后的 true 表示这是错误结果，UI 通常会按错误状态展示。
  pushToolResult(state, callbacks, toolCallId, toolName, guardMessage, true)

  // hard-block 比 soft-block 更严重。
  // soft-block 到上面的 synthetic tool_result 就结束了；
  // hard-block 还会进一步问用户：要暂停，还是继续让模型试。
  if (loopCheck.kind === 'hard-block') {
    // 通过 UI 回调问用户如何处理。
    // onAskUser 返回用户选项文字，比如 Pause 或 Continue。
    const answer = await callbacks
      .onAskUser(`The model keeps calling ${toolName} with identical arguments. How do you want to proceed?`, [
        // Pause：暂停本轮，让用户重新输入新指令。
        { label: 'Pause', description: 'Pause the turn — you can type a new instruction.' },
        // Continue：不暂停，但这次工具仍然已经被 loop guard 拦截。
        { label: 'Continue', description: 'Let the model keep trying; the loop guard stays armed.' },
      ])
      // 如果询问用户本身失败，就默认 Pause。
      // 这是保守选择：交互失败时不要继续让模型无限重试。
      .catch(() => 'Pause')

    // 用户选择 Pause 时，准备让本轮停止在一个清晰状态。
    if (answer.toLowerCase().startsWith('pause')) {
      // 清空最近调用窗口，避免用户指导后模型合法地重试一次时又立刻触发 guard。
      state.recentToolCalls = []

      // 把提示延迟到本轮末尾再写，保持 assistant -> tool -> tool -> user 的顺序。
      // 不能马上 push 到 state.messages，因为当前模型回合里可能还有别的 tool_result 没写完。
      // 如果 user 消息夹在多个 tool_result 中间，某些 provider 会认为消息顺序非法。
      deferred.push({
        role: 'user',
        content: '[loop-guard] User paused the loop. Wait for further instructions rather than calling more tools.',
      })
    }
  }

  // 返回 true 的意思是：这次工具调用已经被 loop guard 处理掉了。
  // 调用方看到 true 后，不会再继续执行真实工具。
  return true
}

/** writeFile/edit/shell 的权限门。 */
async function checkWriteOrShellPermission(ctx: HandlerCtx): Promise<boolean> {
  // 只有会产生本地副作用的内置工具走这道权限门；其它工具各自处理权限。
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  if (toolName !== 'writeFile' && toolName !== 'edit' && toolName !== 'shell') return true

  // 统一走项目里的权限分类器，决定当前调用是否能继续。
  const approved = await checkPermission(
    { toolCallId, toolName, input },
    options.trustMode,
    callbacks.onAskPermission,
    state.permissionMode,
    process.cwd(),
  )
  if (options.abortSignal?.aborted) {
    pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
    return false
  }
  if (!approved) {
    pushToolResult(state, callbacks, toolCallId, toolName, 'Permission denied by user.')
    return false
  }
  return true
}

/**
 * 运行 writeFile/edit/shell 的底层副作用工具主体。
 *
 * 自动执行工具会在这里直接返回 null，因为 AI SDK 已经把结果写回了。
 */
async function executeWriteOrShell(ctx: HandlerCtx): Promise<{ output: string; isError: boolean } | null> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  try {
    if (toolName === 'writeFile' || toolName === 'edit') {
      const output = await executeWriteTool(toolName, input, toolCallId, callbacks, options.abortSignal)

      // executeWriteTool 对“旧字符串找不到/不唯一”这类失败会返回错误字符串而不是 throw。
      // 这里把它识别成错误结果，方便 UI 用红色展示。
      const isError = isToolErrorString(output)
      if (!isError) state.filesModified.add(input.filePath as string)
      return { output, isError }
    }
    if (toolName === 'shell') {
      const timeout = (input.timeout as number) ?? 30000
      const shellResult = await executeShell(
        input.command as string,
        timeout,
        options.abortSignal,
        callbacks,
        toolCallId,
      )
      return { output: shellResult.output, isError: shellResult.isError }
    }

    // 带 execute 的工具（readFile、glob、grep 等）已经由 AI SDK 自动执行。
    return null
  } catch (err) {
    return { output: toolErrorFromUnknown(err), isError: true }
  }
}

/**
 * 处理单个工具调用，直到这次调用完全分发结束才返回。
 *
 * parentModel 是当前 loop 的 LanguageModel 实例；task 工具在子代理没显式覆盖模型时会拿它兜底。
 * deferred 是本轮延迟消息队列，主要用来避免把 user 消息插进 tool_result 中间。
 */
async function handleToolCall(
  tc: ToolCall,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  parentModel: LanguageModel,
  deferred: ModelMessage[],
): Promise<void> {
  // 为本次工具调用组装统一上下文，后续 hook/handler 都在这个对象上读写。
  const ctx: HandlerCtx = {
    toolName: tc.toolName,
    input: tc.input,
    toolCallId: tc.toolCallId,
    state,
    options,
    callbacks,
    parentModel,
  }

  // ---- 插件 hook：PreToolUse ----
  // 在任何真正执行之前先让插件看一眼，必要时可以改参数、拒绝工具。
  if (ctx.options.hookBus?.has('PreToolUse')) {
    try {
      const decisions = await ctx.options.hookBus.emit(
        {
          name: 'PreToolUse',
          session: { cwd: process.cwd(), modelId: ctx.options.modelId },
          tool: { name: ctx.toolName, args: ctx.input, callId: ctx.toolCallId },
        },
        { signal: ctx.options.abortSignal },
      )
      const effect = aggregatePreToolUse(decisions)
      if (effect.decision === 'deny') {
        const reason = effect.reason ?? 'blocked by plugin hook'
        pushToolResult(
          state,
          callbacks,
          ctx.toolCallId,
          ctx.toolName,
          toolErrorString(`Tool denied by plugin hook: ${reason}`),
          true,
        )
        return
      }

      // 如果 hook 改写了参数，就把新的 input 往下传。
      if (effect.args && typeof effect.args === 'object' && !Array.isArray(effect.args)) {
        ctx.input = effect.args as Record<string, unknown>
      }
    } catch (err) {
      if (ctx.options.abortSignal?.aborted) return

    }
  }

  // 先处理明确的 bypass 工具。
  // bypass 在这里的意思是：某些特殊工具不走普通工具执行流程，直接交给专门的 handler 处理。
  // 看看当前工具名是不是特殊工具。如果是，就用它自己的处理函数执行。执行完直接 return，不再往下面走。
//   为什么要 bypass？
// 因为这些工具比较特殊。
// 比如 askUser：
// 它本来就是问用户问题。如果模型连续问两次一样的问题，可能是用户刚才回答不清楚，不应该被 loop guard 拦掉。
// 比如 task：
// 它不是普通工具，而是启动子代理，有自己的一整套执行逻辑。
// 比如 todoWrite / enterPlanMode / exitPlanMode：
// 它们主要是改 agent 内部状态，不是读写文件或跑 shell，所以不走普通权限判断。
// 比如 listMcpResources：
// 只是读本地 MCP registry，没有实际副作用，不需要普通工具那套权限和 loop guard。
// 所以 bypass 的作用就是：
// 把特殊工具从普通流水线里提前分流出去。

// 普通工具流程像这样：
// PreToolUse hook
// -> bypass 检查
// -> MCP 检查
// -> loop guard
// -> 权限检查
// -> 真正执行 writeFile/edit/shell
// -> push tool_result

// 如果是 bypass 工具：
// PreToolUse hook
// -> bypass 检查命中
// -> 专门 handler 执行
// -> push tool_result
// -> return
  const bypassHandler = BYPASS_LOOP_GUARD_HANDLERS[ctx.toolName]
  if (bypassHandler) {
    await bypassHandler(ctx)
    return
  }

  // MCP 工具有独立权限路径，不走 writeFile/edit/shell 的那套逻辑。
  // 是否是 MCP 工具，不靠名字猜，而是直接查 registry。
  if (ctx.options.mcpRegistry?.get(ctx.toolName)) {
    await handleMcpToolCall(ctx, deferred)
    return
  }

  // 普通本地副作用工具先做 loop guard，再做权限门。
  // 在这个函数中，不论有没有熔断，都要记录 recordToolCall（这个数组是记录最近调用的工具）。然后如果是熔断的情况下直接推送消息进pushToolResult，不再向下执行 execute 
  if (await applyLoopGuard(ctx, deferred)) return 

  // 走到这里，证明没有熔断。校验是否有权限，没有权限则pushToolResult中推送消息然后直接返回
  if (!(await checkWriteOrShellPermission(ctx))) return

  // 只剩下真正要执行的本地副作用工具了。
  const result = await executeWriteOrShell(ctx)
  if (result == null) return

  await pushSuccessfulToolResult(ctx, truncateToolResult(result.output), result.isError)
}

/**
 * 分发 MCP 工具调用。
 *
 * 它和 writeFile/edit/shell 并列，但权限和执行入口都走 MCP 自己的注册表。
 */
async function handleMcpToolCall(ctx: HandlerCtx, deferred: ModelMessage[]): Promise<void> {
  // MCP 工具有独立 registry 和权限存储，所以和 writeFile/edit/shell 分开处理。
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  const permissions = options.mcpPermissionStore

  if (!registry) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      toolErrorString(`MCP not configured; tool ${toolName} unavailable`),
      true,
    )
    return
  }

  // 先做 loop guard，防止模型对同一个 MCP 工具无脑重复失败。
  const entry = registry.get(toolName)
  if (!entry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString(`MCP tool not found: ${toolName}`), true)
    return
  }

  if (await applyLoopGuard(ctx, deferred)) return

  // plan 模式下 MCP 工具视为不透明副作用，默认拒绝。
  if (state.permissionMode === 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      'MCP tools are disabled in plan mode. Call exitPlanMode first if you need this tool.',
      true,
    )
    return
  }

  // 权限门：trustMode 直接放行；否则先查 store，再问用户。
  let approved = options.trustMode
  if (!approved && permissions) approved = await permissions.isApproved(toolName)

  if (!approved) {
    let decision: 'yes' | 'always' | 'no'
    try {
      decision = await callbacks.onAskPermission({ toolCallId, toolName, input })
    } catch (err) {
      if (isAbortError(err, options.abortSignal)) {
        pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
        return
      }
      throw err
    }
    if (options.abortSignal?.aborted) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }

    // 把用户答案转成统一的权限分类。
    const choice = classifyDecision(decision)
    if (choice === 'deny') {
      pushToolResult(state, callbacks, toolCallId, toolName, 'Permission denied by user.')
      return
    }
    if (permissions) {
      if (choice === 'allow-always') await permissions.approvePermanently(toolName)
      else permissions.approveForSession(toolName)
    }
  }

  // 真正执行 MCP 调用：abortSignal 一路传下去，用户按 Esc 可以中断。
  reportProgress(toolCallId, `Calling ${entry.serverName}/${entry.rawName}`)
  try {
    const result = await registry.callTool(toolName, ctx.input, options.abortSignal)
    await pushSuccessfulToolResult(ctx, truncateToolResult(result.text), result.isError)
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(err), true)
  }
}

/**
 * 收集本轮真正写进 assistant 消息（模型消息）的 tool_call_id。
 *
 * 这一步专门用来过滤 SDK 的 ghost call：有些 tool_call 在流里出现过，
 * 但最终没进入 response.messages。那种调用不该再执行一次。
 */
function collectActiveAssistantToolCallIds(state: LoopState): Set<string> {
  // 只执行 assistant 消息里真实存在的 tool_call。
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

/**
 * 收集当前回合里已经有 tool-result 的 tool_call_id。
 *
 * 这些调用通常已经被 AI SDK 自动执行或自动拒绝过了，所以不能再执行一遍。
 */
function collectFulfilledToolCallIds(state: LoopState): Set<string> {
  // 用于跳过 SDK 已自动执行并写入 tool_result 的调用，避免重复执行。
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

/**
 * 把连续的 task 调用合并成一个批次，方便并行。
 *
 * 只有 task 适合并发，因为它本身会启动隔离的子代理。
 * 其它工具都共享父状态，串行更安全。
 * 
举例 1：没有 task
输入：[
  { toolName: 'readFile', toolCallId: '1', input: {} },
  { toolName: 'shell', toolCallId: '2', input: {} },
  { toolName: 'edit', toolCallId: '3', input: {} },
]
返回：[
  [{ toolName: 'readFile', toolCallId: '1', input: {} }],
  [{ toolName: 'shell', toolCallId: '2', input: {} }],
  [{ toolName: 'edit', toolCallId: '3', input: {} }],
]
意思是：一个一个执行。


举例 2：连续两个 task
输入：[
  { toolName: 'task', toolCallId: '1', input: { description: '分析 A' } },
  { toolName: 'task', toolCallId: '2', input: { description: '分析 B' } },
  { toolName: 'shell', toolCallId: '3', input: { command: 'pnpm test' } },
]
返回：[
  [
    { toolName: 'task', toolCallId: '1', input: { description: '分析 A' } },
    { toolName: 'task', toolCallId: '2', input: { description: '分析 B' } },
  ],
  [
    { toolName: 'shell', toolCallId: '3', input: { command: 'pnpm test' } },
  ],
]
意思是：
第 1 批：task 1 和 task 2 并行执行
第 2 批：shell 单独执行


举例 3：task 不连续
输入：[
  { toolName: 'task', toolCallId: '1', input: {} },
  { toolName: 'shell', toolCallId: '2', input: {} },
  { toolName: 'task', toolCallId: '3', input: {} },
]
返回：[
  [{ toolName: 'task', toolCallId: '1', input: {} }],
  [{ toolName: 'shell', toolCallId: '2', input: {} }],
  [{ toolName: 'task', toolCallId: '3', input: {} }],
]
因为两个 task 中间隔了一个 shell，所以不会合并。
 */
export function partitionToolCalls(calls: ToolCall[]): ToolCall[][] {
  // 只有连续 task 会合并成并行批次，其它工具都保持单个批次串行执行。
  const batches: ToolCall[][] = []
  let i = 0
  while (i < calls.length) {
    let end = i + 1
    if (calls[i]!.toolName === 'task') {
      while (end < calls.length && calls[end]!.toolName === 'task') {
        end++
      }
    }
    batches.push(calls.slice(i, end))
    i = end
  }
  return batches
}

/**
 * 处理单个模型回合里的全部工具调用。
 *
 * 连续 task 会并行分发，其它工具保持串行。
 * 这里是本文件对外最重要的入口。
 */
export async function processToolCalls(
  toolCalls: ToolCall[],
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  parentModel: LanguageModel,
): Promise<void> {
  // 本函数只处理“当前模型回合”的工具调用；历史工具结果不会在这里重放。
  const activeIds = collectActiveAssistantToolCallIds(state)
  const fulfilledIds = collectFulfilledToolCallIds(state)

  // 本轮延迟队列：这些消息必须在本轮所有 tool-result 之后落地。
  // 这样可以避免把 user 消息插在 tool_result 中间。
  const deferred: ModelMessage[] = []

  // 先做预过滤：丢掉 ghost call 和已经 fulfilled 的调用。
  const liveCalls: ToolCall[] = []
  for (const tc of toolCalls) {
    // 跳过 SDK 在 stream 中途拒绝的 ghost call。
    if (activeIds.size > 0 && !activeIds.has(tc.toolCallId)) {

      continue
    }

    // 这段处理的是一种特殊情况：
// 工具已经被 AI SDK 自动执行过了，tool_result 已经在 state.messages 里了，但 toolCalls 列表里仍然会出现它。
// 这个 toolCall 已经有结果了，不要再执行一次。那为什么还要： checkForLoop recordToolCall
// 因为虽然它已经执行过了，但它仍然代表：模型这一次确实又尝试调用了这个工具。
// 如果这里直接 continue，不记录到 loop guard，那么系统永远不知道模型在重复读同一个文件。
// checkForLoop 是检查：“这个工具 + 这组参数是不是重复太多次了？”
// recordToolCall 是记账：“这次调用也算一次模型尝试。”
// 那为什么要推进 deferred？大模型既然要求执行这个工具，那么我又不想执行，但是又不能把之前执行过的结果直接推进去，
// 所以这里只能换一种提醒方式：追加一条 user 消息告诉模型：[loop-guard] 你一直重复这个调用，别再原样重试了
// 但这条 user 消息不能立刻插进去。因为同一轮可能还有别的 tool_result 没处理完，如果中间插 user，会变成：
// assistant: tool-call A, tool-call B
// tool:      result A
// user:      loop guard warning
// tool:      result B
// 这个顺序有些 provider 会拒绝。
// 所以先放进 deferred，等本轮所有 tool_result 都处理完，再统一追加到最后：
// assistant: tool-call A, tool-call B
// tool:      result A
// tool:      result B
// user:      loop guard warning
// 一句话总结：虽然这个工具已经执行过了，但它仍然是一次“模型重复尝试”。所以要记录给 loop guard；如果发现重复，就把警告延迟到本轮最后告诉模型，避免重复执行工具，也避免破坏消息顺序。
    if (fulfilledIds.has(tc.toolCallId)) { // 检查这个工具是不是已经有结果了。如果当前工具已经有结果了
      const loopCheck = checkForLoop(state, tc.toolName, tc.input, tc.toolCallId) // 检查当前工具是否是最近调用了，是否触发软阻断，硬阻断
      recordToolCall(state, tc.toolName, tc.input, loopCheck.hash) // 虽然不再执行，但还是记录一下，给 loop guard 判断“模型是不是一直重复调用同一个工具”。
      if (loopCheck.kind !== 'ok') {
        deferred.push({ role: 'user', content: `[loop-guard] ${loopCheck.message}` })
      }
      continue
    }

    liveCalls.push(tc)
  }

  // 按批次分发。
  const batches = partitionToolCalls(liveCalls)
  let dispatched = 0
  for (const batch of batches) {
    // 用户按了 Esc / Ctrl+C。当前正在跑的工具可能已被 cancelSignal 取消。
    if (options.abortSignal?.aborted) {
      for (let j = dispatched; j < liveCalls.length; j++) {
        pushToolResult(
          state,
          callbacks,
          liveCalls[j]!.toolCallId,
          liveCalls[j]!.toolName,
          '[Tool execution interrupted by user]',
          true,
        )
      }
      break
    }

    // task 批次并行，其它批次通常只有一个调用。
    await Promise.all(batch.map((tc) => handleToolCall(tc, state, options, callbacks, parentModel, deferred)))
    dispatched += batch.length
  }

  // 本轮所有 tool_result 处理完后，再统一 flush 延迟消息。
  if (deferred.length > 0) state.messages.push(...deferred)
}
