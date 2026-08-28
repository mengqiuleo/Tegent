// 每个 session 对应一个文件：`.tegent/sessions/<slug>-<sessionId>.jsonl`。
// slug 和 plan 文件使用同一个人类可读 token；如果用户第一条消息没有 ASCII 内容，
// 就退回纯 timestamp 命名。
//
// 文件采用 append-only 方式：关于一个 session 的所有记录都作为“一行一个 JSON 对象”写入：
// header、每条 ModelMessage、周期性的 token usage 快照、压缩边界、abort/interrupted 标记等。
//
// 为什么用 JSONL，而不是每次重写一个完整 JSON 文档：
//   - 更抗崩溃：进程被杀或磁盘写满时，最多丢当前正在写的一行；前面的内容仍完整。
//   - 追加便宜：每轮只追加几百字节，不需要重写整个历史文件。
//   - 语义贴近 Claude Code 的 `~/.claude/<project>/<uuid>.jsonl`，
//     包括 compact_boundary 的加载规则，见下面 loadSession。
//
// 这个模块替代旧的 `<id>.usage.json` 和 `<id>.json`（LLM summary）文件；
// 它们现在都变成 jsonl 内的 meta entry。/usage history 和 /resume 都从同一个文件读取。
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import type { PermissionMode, TokenUsage } from '../types/index.js'
import { TEGENT_DIR } from '../utils.js'
import { createLoopState } from './loop-state.js'
import type { LoopState } from './loop-state.js'
import type { CheckpointEntry } from './snapshot.js'

const SESSIONS_SUBDIR = 'sessions'

function sessionsDir(cwd: string = process.cwd()): string {
  return path.join(cwd, TEGENT_DIR, SESSIONS_SUBDIR)
}

/** 构造 session 在磁盘上的文件名。
 *
 * 形状和 plan 文件一致：`<slug>-<id>.<ext>`。
 * 这样 `ls .tegent/sessions/` 和 `ls .tegent/plans/` 的视觉扫描方式一致。
 * 如果 slug 为空（典型 CJK-only 第一条消息），就折叠成纯 timestamp 命名，
 * 和 plan 文件的兜底策略一致。 */
export function getSessionFilePath(
  state: { sessionId: string; taskSlug: string },
  cwd: string = process.cwd(),
): string {
  const base = state.taskSlug ? `${state.taskSlug}-${state.sessionId}` : state.sessionId
  return path.join(sessionsDir(cwd), `${base}.jsonl`)
}

// ---- 写入 jsonl 的 entry 类型 ----

interface HeaderEntry {
  t: 'meta'
  kind: 'header'
  cwd: string
  gitBranch?: string
  modelId: string
  startedAt: string
  /** 截断到约 500 字符。
   *  这足够 picker 展示可识别预览，也不用为了列表读取整条第一用户消息。 */
  firstPrompt: string
  taskSlug: string
  sessionId: string
}

interface MsgEntry {
  t: 'msg'
  message: ModelMessage
  ts: string
}

interface UsageEntry {
  t: 'meta'
  kind: 'usage'
  usage: TokenUsage
  modelId: string
  ts: string
}

interface CompactBoundaryEntry {
  t: 'meta'
  kind: 'compact-boundary'
  /** 深度压缩（LLM summary）时存在；轻量压缩（loop-guard pruning）时省略。
   *  摘要文本也会嵌入后续重新 flush 的 msg 行中，所以这里主要是信息用途：
   *  listSessions 可以不用重读 boundary 后消息，就在 picker 里显示“已压缩”的提示。 */
  summary?: string
  ts: string
}

interface InterruptedEntry {
  t: 'meta'
  kind: 'interrupted'
  ts: string
}

/** rewind checkpoint 指针。
 *
 * loadSession 会把它暴露出来，这样 /resume 后仍能恢复同一套 /rewind 历史。
 * 真正的文件备份单独存在 `.tegent/file-history/<sessionId>/` 下。 */
interface CheckpointJsonlEntry {
  t: 'meta'
  kind: 'checkpoint'
  ckptId: string
  messageCount: number
  ts: string
  userPrompt: string
}

type Entry = HeaderEntry | MsgEntry | UsageEntry | CompactBoundaryEntry | InterruptedEntry | CheckpointJsonlEntry

// ---- 追加写辅助：best-effort，不向 agent loop 抛错 ----
async function appendLine(filePath: string, entry: Entry): Promise<void> {
  await appendRawLines(filePath, [JSON.stringify(entry)])
}

/** 批量追加已经序列化好的 jsonl 行。
 *
 * 成功返回 true，让调用方能遵守“只有磁盘写成功才推进内存状态”的规则。
 * 例如 markBoundaryAndReflush 只有在 boundary 真正落盘后，才能清空内存 checkpoint 列表。 */
async function appendRawLines(filePath: string, lines: string[]): Promise<boolean> {
  if (lines.length === 0) return true
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.appendFile(filePath, lines.join('\n') + '\n', 'utf-8')
    return true
  } catch {
    // 持久化是 best-effort：文件系统错误不能阻塞 agent loop。
    return false
  }
}

/** 尝试从 `.git/HEAD` 读取当前 git branch。
 *
 * 这是很便宜的读文件操作。不存在 .git、detached HEAD、非 git 项目都会静默返回 undefined。 */
async function readGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const head = await readFile(path.join(cwd, '.git', 'HEAD'), 'utf-8')
    const m = head.match(/^ref: refs\/heads\/(.+)$/m)
    return m?.[1]?.trim()
  } catch {
    return undefined
  }
}

/** 写入 session header。
 *
 * 幂等：如果文件已经存在（resume 路径），直接跳过。
 * 保留原始 header 能让 picker metadata 在多次 resume 后保持稳定。 */
export async function appendHeader(
  state: LoopState,
  modelId: string,
  firstPrompt: string,
  cwd: string = process.cwd(),
): Promise<void> {
  const filePath = getSessionFilePath(state, cwd)
  try {
    await fs.access(filePath)
    return // 文件已存在：保留原 session 的 header。
  } catch {
    // 文件不存在：继续写 header。
  }
  const gitBranch = await readGitBranch(cwd)
  const entry: HeaderEntry = {
    t: 'meta',
    kind: 'header',
    cwd,
    gitBranch,
    modelId,
    startedAt: state.startedAt,
    firstPrompt: firstPrompt.slice(0, 500),
    taskSlug: state.taskSlug,
    sessionId: state.sessionId,
  }
  await appendLine(filePath, entry)
}

/** 把 state.messages 中尚未持久化的消息 flush 到 jsonl。
 *
 * 只写 `state.persistedMessageCount` 之后的增量。
 * 这种 diff-based 设计让 writer 不必知道 agent loop 的每个 mutation 点：
 * collectTurnResponse、processToolCalls、length-finish nudge 等地方都会直接改 state.messages，
 * 但我们只要在回合边界统一 sweep，就能全部捕获。
 *
 * 深度/轻量压缩后，内存里的消息数组会缩短。
 * 这时调用方必须用 markBoundaryAndReflush，而不是本函数。
 * 那条路径会先写 compact-boundary，让 loader 恢复时能按边界截断，
 * 再重新追加裁剪后的消息，使 boundary 后 jsonl 内容与新的内存状态一致。 */
export async function flushPendingMessages(state: LoopState): Promise<void> {
  if (state.persistedMessageCount >= state.messages.length) return
  const filePath = getSessionFilePath(state)
  const ts = new Date().toISOString()
  const lines: string[] = []
  for (let i = state.persistedMessageCount; i < state.messages.length; i++) {
    const message = state.messages[i]
    if (!message) continue
    const entry: MsgEntry = { t: 'msg', message, ts }
    lines.push(JSON.stringify(entry))
  }
  // 保留重构前的早退行为：如果本轮没有任何真实待写消息，
  // 不推进 persistedMessageCount，避免未来出现真实消息时误以为范围已经覆盖。
  if (lines.length === 0) return
  if (await appendRawLines(filePath, lines)) {
    state.persistedMessageCount = state.messages.length
  }
}

/** 追加当前回合的 token usage 快照。
 *
 * agent loop 在 collectTurnResponse 接受 provider usage 对象后调用。
 * picker 只读最后一条 usage 行来展示 session 总量；
 * 历史快照继续留在文件里，但读取时无需更复杂的数据结构。 */
export async function appendUsage(state: LoopState, modelId: string): Promise<void> {
  const filePath = getSessionFilePath(state)
  const entry: UsageEntry = {
    t: 'meta',
    kind: 'usage',
    usage: { ...state.tokenUsage },
    modelId,
    ts: new Date().toISOString(),
  }
  await appendLine(filePath, entry)
}

/** 标记一次压缩事件，并重新 flush 刚缩短过的 message array。
 *
 * 本函数返回后，jsonl 中最后一个 boundary 之后的内容会精确等于 `state.messages`。
 * loadSession 恢复时也会重建出相同的内存状态。
 *
 * 为什么要重新追加，而不是依赖 boundary 前的消息：
 * compressMessages 会保留 recent N 条原文，但这些 recent 消息早已在 boundary 前持久化过。
 * loader 的规则是“最后一个 boundary 之后的内容为准”，如果不重新追加，
 * 那些 recent 消息会在恢复时被丢掉。重复写约 6 条消息很便宜，却能让加载逻辑非常简单。
 *
 * 轻量压缩（loop-guard pruning）会传 summary=undefined。
 * 即使没有摘要，也仍需要 boundary，避免 loader 恢复时把已删除的 loop-guard 对复活。 */
export async function markBoundaryAndReflush(state: LoopState, summary?: string): Promise<void> {
  const filePath = getSessionFilePath(state)
  const ts = new Date().toISOString()
  const boundary: CompactBoundaryEntry = { t: 'meta', kind: 'compact-boundary', ts }
  // boundary  它的意思是：
  // 这儿发生过一次压缩
  // 这条 boundary 之后的消息，才是恢复时该认的“最新有效内容”
  // boundary 之前那些旧消息，恢复时可以忽略
  if (summary !== undefined) boundary.summary = summary
  const lines = [JSON.stringify(boundary)] // 创建一个数组，第一条是 boundary

  // 发生压缩之后，state.messages 已经不是所有消息了。
  // 压缩前可能是： state.messages = [A, B, C, D, E, F, G, H, I, J]
  // 压缩后可能是： state.messages = [Summary(A-F), G, H, I, J]
  // 所以此时 state.messages 是“压缩后的当前有效上下文”，不是完整历史。
  // 现在我们要把 boundary 写入文件，然后把 state.messages 中的 G-J 重新写入文件。
  // 这样 loader 恢复时，看到 boundary 后的消息就是 [Summary(A-F), G, H, I, J]。

  for (const message of state.messages) {
    //
    const entry: MsgEntry = { t: 'msg', message, ts }
    lines.push(JSON.stringify(entry))
  }
  if (!(await appendRawLines(filePath, lines))) return
  state.persistedMessageCount = state.messages.length
  // 压缩会缩短或重写 messages 数组，之前每个 checkpoint 的 messageCount 都可能指向错误位置。
  // 清空内存列表，和 loader 的行为保持一致：resume 时也会丢弃 boundary 前的 checkpoint 行。
  state.checkpoints = []
}

/** 追加 rewind checkpoint 标记。
 *
 * 和其它 append helper 一样是 fire-and-forget。
 * resume 时 loadSession 会把这些行收集到 LoadedSession.checkpoints，
 * 让 picker 可以展示跨 CLI 重启后仍可用的 rewind 点。
 * “最后一个 boundary 之后为准”的 loader 规则会自然丢弃被压缩 invalidated 的 checkpoint。
 * 把一个 /rewind 恢复点的“索引信息”追加到 session 的 JSONL 文件里。
 * 
 *  */
export async function appendCheckpoint(state: LoopState, entry: CheckpointEntry): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const jsonl: CheckpointJsonlEntry = {
    t: 'meta',
    kind: 'checkpoint',
    ckptId: entry.ckptId,
    messageCount: entry.messageCount,
    ts: entry.ts,
    userPrompt: entry.userPrompt,
  }
  await appendLine(filePath, jsonl)
}

/** 追加 interrupted 标记。
 *
 * 这只是信息用途：loader 重建状态时会忽略它。
 * picker 可以在会话中途被打断时显示 “interrupted”，
 * 让用户知道 resume 时会回到一个中途状态。 */
export async function appendInterrupted(state: LoopState): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const entry: InterruptedEntry = { t: 'meta', kind: 'interrupted', ts: new Date().toISOString() }
  await appendLine(filePath, entry)
}

// ---- 读取路径：load + list ----

export interface LoadedSession {
  sessionId: string
  taskSlug: string
  startedAt: string
  modelId: string
  cwd: string
  gitBranch?: string
  firstPrompt: string
  messages: ModelMessage[]
  tokenUsage: TokenUsage
  /** 最后一个 compact-boundary 之后仍然有效的 rewind checkpoint。
   *  真实文件备份 manifest 位于 `.tegent/file-history/<sid>/`。 */
  checkpoints: CheckpointEntry[]
  /** jsonl 文件路径。agent loop resume 后会继续向同一个文件追加。 */
  filePath: string
}

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  currentContextTokens: 0,
}

/** 遍历 session jsonl，重建 LoadedSession。
 *
 * compact-boundary 语义与 Claude Code 一致：
 * 每次遇到 `compact-boundary` 行，就清空消息累加器。
 * 因此返回的 messages 只包含最后一个 boundary 之后的内容；
 * 按 markBoundaryAndReflush 的写入规则，这正好等于压缩当时的内存状态。
 *
 * 尾部孤儿 tool_call / tool_result 会被裁剪掉。
 * 否则下一次 API 请求会拒绝这组消息。
 * 具体规则见 sanitizeMessageTail。 */
export async function loadSession(filePath: string): Promise<LoadedSession | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
  let header: HeaderEntry | null = null
  let lastUsage: UsageEntry | null = null
  let messages: ModelMessage[] = []
  let checkpoints: CheckpointEntry[] = []

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry
    } catch {
      continue // 静默跳过坏行。
    }
    if (entry.t === 'meta') {
      if (entry.kind === 'header') {
        header = entry
      } else if (entry.kind === 'usage') {
        lastUsage = entry
      } else if (entry.kind === 'compact-boundary') {
        messages = []
        // 压缩前 messageCount 锚定的 checkpoint 已经无意义：
        // messages 数组在压缩后缩短了，所以 checkpoint 要跟消息一起丢掉。
        checkpoints = []
      } else if (entry.kind === 'checkpoint') {
        checkpoints.push({
          ckptId: entry.ckptId,
          messageCount: entry.messageCount,
          ts: entry.ts,
          userPrompt: entry.userPrompt,
        })
      }
      // interrupted 只是信息标记，不影响状态重建。
    } else if (entry.t === 'msg') {
      messages.push(entry.message)
    }
  }
  if (!header) return null

  return {
    sessionId: header.sessionId,
    taskSlug: header.taskSlug,
    startedAt: header.startedAt,
    modelId: header.modelId,
    cwd: header.cwd,
    gitBranch: header.gitBranch,
    firstPrompt: header.firstPrompt,
    messages: sanitizeMessageTail(messages),
    tokenUsage: lastUsage?.usage ?? EMPTY_USAGE,
    checkpoints,
    filePath,
  }
}

type ToolCallPart = { type?: string; toolCallId?: string }

/** 删除尾部没有匹配 tool_result 的 assistant tool_call。
 *
 * provider 会拒绝任何 “tool_use without tool_result” 的孤儿。
 * 如果 session 在工具执行中途结束，resume 时必须回退到最后一个完整解析的边界。
 *
 * 算法：
 * 1. 先收集消息数组里所有已经有 tool_result 的 toolCallId。
 * 2. 从尾部向前扫描，删除任何包含未解析 tool_call id 的 assistant 消息。
 * 3. 遇到第一条干净消息就停止：
 *    可能是纯文本 assistant，也可能是所有 tool_call 都已解析的 assistant。 */
function sanitizeMessageTail(messages: ModelMessage[]): ModelMessage[] {
  const resolvedIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as ToolCallPart[]) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        resolvedIds.add(part.toolCallId)
      }
    }
  }
  let cutAt = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) {
      cutAt = i
      continue
    }
    if (msg.role !== 'assistant') {
      // 尾部裸 tool 或 user 没有上游 tool_call 也合法。
      // 继续向前看；真正决定裁剪点的是孤儿 tool_call。
      break
    }
    const content = msg.content
    if (typeof content === 'string') break // 纯文本 assistant，尾部干净。
    if (!Array.isArray(content)) break
    const hasOrphan = (content as ToolCallPart[]).some(
      (p) => p?.type === 'tool-call' && typeof p.toolCallId === 'string' && !resolvedIds.has(p.toolCallId),
    )
    if (hasOrphan) {
      cutAt = i
      continue
    }
    break
  }
  return cutAt < messages.length ? messages.slice(0, cutAt) : messages
}

// ---- picker 列表读取 ----

export interface SessionListEntry {
  filePath: string
  sessionId: string
  taskSlug: string
  firstPrompt: string
  startedAt: string
  modelId: string
  /** 文件 mtime，epoch milliseconds；picker 用它排序。 */
  mtime: number
  tokenUsage: TokenUsage | null
}

/** 枚举当前项目中的所有 session jsonl，按最新修改时间排序。
 *
 * 每个文件只读头部约 8KB（找 header 行）和尾部约 4KB（找最后 usage 行），
 * 不做全文件 load。这样即使有几百个历史 session，picker 也能快速响应。
 * 没有可解析 header 的文件会静默丢弃。 */
export async function listSessions(cwd: string = process.cwd()): Promise<SessionListEntry[]> {
  const dir = sessionsDir(cwd)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const jsonlFiles = entries.filter((f) => f.endsWith('.jsonl'))
  const results = await Promise.all(
    jsonlFiles.map(async (f) => {
      const filePath = path.join(dir, f)
      try {
        const stat = await fs.stat(filePath)
        const head = await readRange(filePath, 0, Math.min(8 * 1024, stat.size))
        const headerLine = head.split('\n').find((l) => l.includes('"kind":"header"'))
        if (!headerLine) return null
        let header: HeaderEntry
        try {
          header = JSON.parse(headerLine) as HeaderEntry
        } catch {
          return null
        }
        const tailStart = Math.max(0, stat.size - 4 * 1024)
        const tail = await readRange(filePath, tailStart, stat.size - tailStart)
        let tokenUsage: TokenUsage | null = null
        const tailLines = tail.split('\n').reverse()
        for (const l of tailLines) {
          if (!l.trim()) continue
          if (l.includes('"kind":"usage"')) {
            try {
              const e = JSON.parse(l) as UsageEntry
              tokenUsage = e.usage
              break
            } catch {
              // 坏行：继续向更早的行扫描。
            }
          }
        }
        return {
          filePath,
          sessionId: header.sessionId,
          taskSlug: header.taskSlug,
          firstPrompt: header.firstPrompt,
          startedAt: header.startedAt,
          modelId: header.modelId,
          mtime: stat.mtimeMs,
          tokenUsage,
        } satisfies SessionListEntry
      } catch {
        return null
      }
    }),
  )
  return results.filter((r): r is SessionListEntry => r !== null).sort((a, b) => b.mtime - a.mtime)
}

/** 按 utf-8 读取文件 `[offset, offset + length)` 字节范围。
 *
 * listSessions 用它只抓 head/tail，避免把完整历史文件读进内存。 */
async function readRange(filePath: string, offset: number, length: number): Promise<string> {
  if (length <= 0) return ''
  const fh = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, offset)
    return buf.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await fh.close()
  }
}

/** 选择当前项目中最近修改的 session 文件。
 *
 * 如果不存在则返回 null。`xc --continue` / `-c` 用它跳过 picker，
 * 无条件恢复最近一次 session。 */
export async function pickLatestSession(cwd: string = process.cwd()): Promise<SessionListEntry | null> {
  const all = await listSessions(cwd)
  return all[0] ?? null
}

/** picker UI 中 session 的稳定短标识。
 *
 * 不能直接用文件名，因为多个 session 可能共享 slug，视觉上容易混淆；
 * 单独 sessionId 也不一定覆盖未来重命名场景。
 * 文件路径天然唯一，所以用 sha1 hash 后取前 8 位，让 choice label 保持紧凑。 */
export function shortIdFor(filePath: string): string {
  return createHash('sha1').update(filePath).digest('hex').slice(0, 8)
}

/** 从已保存 session 构造 LoopState。
 *
 * agent loop 接受 existingState 后，会继续追加到同一个 jsonl 文件。
 * 文件名来自 sessionId + taskSlug，这两个字段都会在这里保留。
 *
 * persistedMessageCount 设置为已加载消息长度，
 * 这样下一次用户提交后的第一次 flush 只会追加新消息；
 * 已加载尾部本来就已经在磁盘上。 */
export function hydrateLoopState(loaded: LoadedSession, initialMode: PermissionMode = 'default'): LoopState {
  const state = createLoopState(initialMode)
  state.sessionId = loaded.sessionId
  state.taskSlug = loaded.taskSlug
  state.startedAt = loaded.startedAt
  state.messages = loaded.messages.slice()
  state.tokenUsage = { ...loaded.tokenUsage }
  state.lastInputTokens = loaded.tokenUsage.inputTokens
  state.persistedMessageCount = loaded.messages.length
  state.checkpoints = loaded.checkpoints.slice()
  return state
}
