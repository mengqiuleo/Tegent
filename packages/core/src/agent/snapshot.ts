// 这个模块支撑 `/rewind` 命令。每个用户消息回合都会生成一个 checkpoint，
// 捕获 `state.filesModified` 中每个文件当时的磁盘状态。
//
// 文件内容按 sha256 blob 去重：同一个文件内容跨多个 checkpoint 重复出现时，
// 磁盘上只存一份。单个 session 的目录布局如下：
//
//   blobs/<sha256>           — 内容寻址的文件内容，可被多个 checkpoint 共享
//   checkpoints/<id>.json    — manifest，记录绝对路径 -> blob hash | absent | skip
//
// 为什么用内容寻址，而不是每个 checkpoint 复制一整份：
// 普通 agent 运行中，相邻用户消息之间大多数文件没有变化；
// 模型每轮通常只改 1-3 个文件，而 filesModified 可能已经累计 30+ 个。
// 去重后，一个新 checkpoint 的边际成本只是“真正变化的文件内容”，不是整个跟踪集合。
//
// 为什么不用 shadow git：
// 文件复制方案在非 git 项目也能工作，不会和 .gitignore 冲突，
// 也完全避免碰到用户真实 .git index 的风险。
//
// 整体心智模型：
// 1. `createCheckpoint`：在“新用户消息已经进入 messages，但模型还没开始改文件”时调用。
//    它会把当前已跟踪文件的磁盘状态写成 manifest + blob。
// 2. `restoreCheckpoint`：只恢复 agent 历史上碰过的文件，并修剪 checkpoint 列表。
// 3. `garbageCollectBlobs`：删除已经没有任何 manifest 引用的内容 blob。
// 4. session jsonl 里只存 checkpoint 指针；真正文件内容在 `.tegent/file-history/`。
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { TEGENT_DIR } from '../utils.js'
import type { LoopState } from './loop-state.js'

// `.tegent/file-history/<sessionId>`：单个会话的文件快照根目录。
const FILE_HISTORY_SUBDIR = 'file-history'

// `.tegent/file-history/<sessionId>/blobs/<sha256>`：真正保存文件内容的地方。
const BLOBS_SUBDIR = 'blobs'

// `.tegent/file-history/<sessionId>/checkpoints/<ckptId>.json`：保存每个 checkpoint 的 manifest。
const CHECKPOINTS_SUBDIR = 'checkpoints'

/** 超过这个大小的文件会在 manifest 里记录为 `skip: true`，restore 时保持不动。
 *
 * 这样可以避免某个构建产物或大二进制文件把 blob store 撑爆。
 * agent 跟踪的源码文件基本不会有这么大。 */
const MAX_FILE_BYTES = 10 * 1024 * 1024

/** checkpoint 环形缓冲上限。
 *
 * 超过上限后会淘汰最旧 checkpoint；失去引用的 blob 会在下一次 restore 或 eviction 后 GC。
 * 100 这个边界对齐 Claude Code。 */
const MAX_CHECKPOINTS = 100

/** checkpoint 的公开内存表示。
 *
 * 同时会镜像到 jsonl 的 `meta:checkpoint` 行里，
 * 这样 /resume 后 /rewind 历史仍然存在。 */
export interface CheckpointEntry {
  /** checkpoint id，也是 manifest 文件名的一部分：`checkpoints/<ckptId>.json`。 */
  ckptId: string

  /** 用户消息被 push 进 state.messages 后的 `state.messages.length`。
   *
   * Rewind 会把 messages 截断到 `messageCount - 1`：
   * 也就是丢掉触发该 checkpoint 的那条用户消息，以及它之后的所有内容。
   * 这个值在 compaction 后不稳定，所以 markBoundaryAndReflush 会清空内存 checkpoint 列表。 */
  messageCount: number

  /** 创建 checkpoint 时的 ISO 时间，用于展示、排序和排查问题。 */
  ts: string

  /** 触发这个 checkpoint 的用户消息前约 200 个字符，用于 picker 预览。 */
  userPrompt: string
}

/** manifest 中单个文件的快照记录。
 *
 * 这里是三选一语义：
 * - `hash`：成功捕获了普通文件内容；
 * - `absent`：当时不存在，restore 时要恢复“不存在”这个状态；
 * - `skip`：当时无法安全捕获，restore 时不要动它。 */
interface ManifestFileEntry {
  /** 快照时文件内容的 sha256 hex，指向 blobs/<hash>。 */
  hash?: string

  /** 快照时文件不存在，或不是普通文件。
   *  restore 时如果当前存在该路径，会尝试 unlink。 */
  absent?: boolean

  /** 快照时文件过大或不可读。
   *  restore 时保留当前文件不动，因为我们没能捕获它，也就无法安全撤销它。 */
  skip?: boolean
}

/** 单个 checkpoint 的完整磁盘 manifest。
 *
 * 它不直接存文件内容，只存“绝对路径 -> 文件状态”的账本。
 * 文件内容通过 `hash` 间接指向 blobs 目录，这样多个 checkpoint 可以共享同一份内容。 */
interface Manifest {
  /** 和 CheckpointEntry.ckptId 相同，便于独立读取 manifest 时自描述。 */
  ckptId: string

  /** 创建 manifest 的时间。 */
  ts: string

  /** 这个 checkpoint 对应的 messages 截断锚点。 */
  messageCount: number

  /** 用户提示词预览，给 /rewind picker 展示。 */
  userPrompt: string

  /** key 是绝对路径，也就是 state.filesModified 里存的内容。 */
  files: Record<string, ManifestFileEntry>
}

/** 返回当前 session 的文件历史根目录。
 *
 * 为什么传 cwd：测试可以传临时目录，真实运行默认用 process.cwd()。
 * 为什么带 sessionId：不同会话的 rewind 历史必须隔离。 */
function historyDir(sessionId: string, cwd: string): string {
  return path.join(cwd, TEGENT_DIR, FILE_HISTORY_SUBDIR, sessionId)
}

/** 返回内容 blob 目录。 */
function blobsDir(sessionId: string, cwd: string): string {
  return path.join(historyDir(sessionId, cwd), BLOBS_SUBDIR)
}

/** 返回 checkpoint manifest 目录。 */
function checkpointsDir(sessionId: string, cwd: string): string {
  return path.join(historyDir(sessionId, cwd), CHECKPOINTS_SUBDIR)
}

/** 返回某个 checkpoint 的 manifest 文件路径。 */
function manifestPath(sessionId: string, ckptId: string, cwd: string): string {
  return path.join(checkpointsDir(sessionId, cwd), `${ckptId}.json`)
}

/** 返回某个内容 hash 对应的 blob 文件路径。 */
function blobPath(sessionId: string, hash: string, cwd: string): string {
  return path.join(blobsDir(sessionId, cwd), hash)
}

/** 生成本地时间格式的 checkpoint id：YYYYMMDD-HHMMSS-mmm。
 *
 * 形状和 sessionId 一致，所以 checkpoint 目录列表按字典序也能按时间排序。 */
function genCkptId(now: Date = new Date()): string {
  // 小工具：把数字左侧补零，比如 7 -> 07，毫秒 5 -> 005。
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')

  // 用本地时间而不是 ISO 字符串，是为了 id 简短、适合作为文件名，并且字典序等于时间序。
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  )
}

/** 判断路径是否存在。
 *
 * 这里只用于“blob 已经写过就复用”的快速判断；失败统一视为不存在即可。
 * 对用户工作区文件不能用这个函数判断 absent，因为权限错误不能等同于不存在。 */
async function exists(p: string): Promise<boolean> {
  try {
    // access 成功表示当前进程能访问这个路径。
    await fs.access(p)
    return true
  } catch {
    // access 失败可能是不存在，也可能是权限问题；本函数调用点只需要一个布尔值。
    return false
  }
}

/** 区分“文件真的不存在”和“因为其它原因无法 stat”。
 *
 * 如果把权限受限文件误判成 ENOENT，就会在 manifest 里标成 absent，
 * restore 时可能静默尝试删除它。相比之下，标成 unreadable/skip 并保留原文件更安全。
 *  文件不存在：manifest 记 { absent: true }     文件太大、不可读、不是普通文件：manifest 记 { skip: true }
 * */
type StatOutcome = { kind: 'ok'; stat: Stats } | { kind: 'absent' } | { kind: 'unreadable' }

/** 安全 stat：把 fs.stat 的异常分类成业务语义。
 *
 * 关键原因：rewind 的默认策略必须偏保守。
 * 不确定能不能恢复的文件，宁可标记 skip，也不要误删。 */
async function statSafe(p: string): Promise<StatOutcome> {
  try {
    // stat 成功后，调用方还会继续判断它是不是普通文件、大小是否可接受。
    return { kind: 'ok', stat: await fs.stat(p) }
  } catch (err) {
    // ENOENT/ENOTDIR 才是真正意义上的“路径不存在”。
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }

    // 其它错误比如 EACCES、EPERM、EBUSY 都不能当成 absent。
    return { kind: 'unreadable' }
  }
}

/** 按内容 hash 写 blob；如果同内容已经存在，就直接复用。
 *
 * 为什么不覆盖：hash 来自内容本身，同一个 hash 对应同一份内容，重复写没有意义。
 * 为什么 mkdir recursive：第一次写某个 session 的 blob 时目录可能还不存在。 */
async function writeBlobIfMissing(sessionId: string, hash: string, content: Buffer, cwd: string): Promise<void> {
  // blob 的文件名就是 sha256，天然去重。
  const p = blobPath(sessionId, hash, cwd)

  // 已经存在时直接返回，避免每次 checkpoint 重复写相同内容。
  if (await exists(p)) return

  // 确保 blobs 目录存在。
  await fs.mkdir(path.dirname(p), { recursive: true })

  // 把原始文件内容写入 blob store。
  await fs.writeFile(p, content)
}

/** 捕获 state.filesModified 中每个文件当前的磁盘状态，写成新的内容寻址 checkpoint，
 *  并把 entry 追加到 state.checkpoints。
 *
 * 成功时返回 entry；如果 checkpoint 自身写入失败，返回 null。
 * 返回 null 时，调用方应认为这个 rewind 点不可用，不能静默跳过继续假装有快照，
 * 因为回滚到一个不完整快照是不安全的。
 *
 * 每个文件的快照是 best-effort：单个路径读取失败只会把该路径标为 skip 并继续，
 * 不会让整个 checkpoint 失败。这样某个临时 EACCES 不会毁掉整轮快照。 */
export async function createCheckpoint(
  state: LoopState,
  userPromptPreview: string,
  cwd: string = process.cwd(),
): Promise<CheckpointEntry | null> {
  // 每个 checkpoint 用独立 id 作为 manifest 文件名。
  const ckptId = genCkptId()

  // ISO 时间适合机器读写和跨时区排查；id 则适合作为本地排序文件名。
  const ts = new Date().toISOString()

  // 记录消息锚点：之后 /rewind 会把对话历史截断到这条用户消息之前。
  const messageCount = state.messages.length

  // manifest 里的文件表；key 是绝对路径，value 是 hash/absent/skip 三种状态之一。
  const files: Record<string, ManifestFileEntry> = {}

  // 只快照 agent 已经触碰过的文件。这样不会扫描整个仓库，也不会误动用户未涉及文件。
  for (const absPath of state.filesModified) {
    // 先 stat 分类，决定这个路径能不能安全读取。
    const outcome = await statSafe(absPath)

    if (outcome.kind === 'absent') {
      // 文件在 checkpoint 时不存在，也是一种需要恢复的状态。
      // 之后如果 agent 创建了它，rewind 到这里时应该删除它。
      files[absPath] = { absent: true }
      continue
    }

    if (outcome.kind === 'unreadable') {
      // 不是“文件不存在”，而是其它原因无法 stat，最常见是权限问题。
      // 标为 skip，restore 时不要删除用户或其它进程可能正在使用的文件。
      files[absPath] = { skip: true }
      continue
    }

    // stat 成功，继续判断它是不是适合被内容快照保存的普通文件。
    const stat = outcome.stat

    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      // 符号链接、目录、超大 blob 都标为 skip。
      // restore 时应保留它们，而不是误判 absent 后删除。
      files[absPath] = { skip: true }
      continue
    }

    try {
      // 读取文件当前内容。这里读到的是“本轮用户输入刚进入后、下一批工具运行前”的状态。
      const buf = await fs.readFile(absPath)

      // 用内容 hash 作为 blob id，实现跨 checkpoint 去重。
      const hash = createHash('sha256').update(buf).digest('hex')

      // 如果相同内容之前已经保存过，这里不会重复写。
      await writeBlobIfMissing(state.sessionId, hash, buf, cwd)

      // manifest 只保存 hash 指针，不直接嵌入文件内容。
      files[absPath] = { hash }
    } catch {
      // 文件可能在 stat 后被其它进程删除/锁定。不能安全捕获时，保守标记 skip。
      files[absPath] = { skip: true }
    }
  }

  // manifest 是“这个 checkpoint 到底捕获了什么”的完整账本。
  const manifest: Manifest = {
    ckptId,
    ts,
    messageCount,
    // 只保留前 200 字符，避免很长的用户输入把 manifest/session jsonl 撑大。
    userPrompt: userPromptPreview.slice(0, 200),
    files,
  }

  try {
    // 第一次创建 checkpoint 时，checkpoints 目录可能不存在。
    await fs.mkdir(checkpointsDir(state.sessionId, cwd), { recursive: true })

    // manifest 写入成功，才算 checkpoint 可用。
    await fs.writeFile(manifestPath(state.sessionId, ckptId, cwd), JSON.stringify(manifest, null, 2), 'utf-8')
  } catch {
    // manifest 如果写不出来，就不能返回半成品 checkpoint。
    // 调用方会认为本轮 rewind 点不可用，但主流程继续运行。
    return null
  }

  // 内存里只放 picker 和 restore 需要的轻量索引。
  const entry: CheckpointEntry = { ckptId, messageCount, ts, userPrompt: manifest.userPrompt }

  // 追加到当前 LoopState；appendCheckpoint 会再把这个 entry 镜像到 session jsonl。
  state.checkpoints.push(entry)

  // 环形缓冲淘汰：删除最旧 manifest。
  // blob GC 延迟到下面的摊销 sweep，避免每次淘汰都重读剩余 manifest。
  let evicted = false

  // 最多保留最近 MAX_CHECKPOINTS 个 rewind 点，避免长期会话无限占磁盘。
  while (state.checkpoints.length > MAX_CHECKPOINTS) {
    // 从队头淘汰最旧 checkpoint，因为 checkpoints 按创建顺序 append。
    const dropped = state.checkpoints.shift()

    // 理论上 length > MAX_CHECKPOINTS 时一定有 dropped；这里防御性处理。
    if (!dropped) break

    // 删除被淘汰 checkpoint 的 manifest。失败不影响当前 checkpoint 可用性。
    void fs.unlink(manifestPath(state.sessionId, dropped.ckptId, cwd)).catch(() => undefined)

    // 标记发生过淘汰，后面需要清理可能已经无人引用的 blob。
    evicted = true
  }

  if (evicted) {
    // 这里 await，而不是 fire-and-forget，主要为了测试里 blob 数量可预测；
    // 也避免下一次淘汰和仍在运行的 sweep 竞态，误删新 manifest 仍引用的 blob。
    // GC 复杂度是 O(剩余 checkpoint * 每个 manifest 的文件数)，最多几百次读取，
    // 摊到上百次普通 checkpoint 之间，成本可接受。
    await garbageCollectBlobs(state, cwd).catch(() => undefined)
  }

  // 返回轻量 entry，调用方可以把它写进 session jsonl。
  return entry
}

/** 把工作区恢复到 ckptId 捕获的状态。
 *
 * 对“当前 filesModified 与 manifest keys 的并集”执行以下算法：
 *   - manifest 中有 hash：把 blob 内容写回。
 *   - manifest 中有 absent：如果当前文件存在，就 unlink。
 *   - manifest 中有 skip：保持不动，因为当时没能捕获。
 *   - 不在 manifest 中：unlink，表示这是 checkpoint 之后新建的文件。
 *
 * 并集之外的文件完全不碰：我们只撤销 agent 历史上碰过的文件。
 *
 * restore 成功后：
 *   - state.filesModified 会从 manifest keys 重建，
 *     让 agent 对“已触碰文件”的认知与恢复点一致。
 *   - 目标之后的 checkpoint 会从 state.checkpoints 删除，对应 manifest 也会删除；
 *     不再引用的 blob 会被 GC。
 *
 * 调用方（use-agent）负责把 state.messages 截断到 entry.messageCount - 1，
 * 并重写 session jsonl。这里的 restore 只处理工作区文件和 checkpoint 账本。 */
export async function restoreCheckpoint(
  state: LoopState,
  ckptId: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  // 先读取目标 checkpoint 的 manifest。读不到说明这个 rewind 点不可用。
  let raw: string
  try {
    raw = await fs.readFile(manifestPath(state.sessionId, ckptId, cwd), 'utf-8')
  } catch {
    return false
  }

  // manifest 是 JSON 文件；解析失败也不能继续恢复，避免按错误账本改工作区。
  let manifest: Manifest
  try {
    manifest = JSON.parse(raw) as Manifest
  } catch {
    return false
  }

  // 需要处理两类文件：
  // 1. 当前 state.filesModified：现在仍被 agent 认为碰过的文件；
  // 2. manifest.files：目标 checkpoint 当时已经跟踪的文件。
  // 用并集是为了能删除“checkpoint 之后新建”的文件，也能恢复“当时存在、现在不在集合里”的文件。
  const allFiles = new Set<string>([...state.filesModified, ...Object.keys(manifest.files)])

  // 逐个文件恢复到 manifest 描述的状态。
  for (const absPath of allFiles) {
    // entry 不存在表示：这个文件在目标 checkpoint 当时还没被跟踪。
    const entry = manifest.files[absPath]

    if (!entry) {
      // 这是 checkpoint 之后某一轮新建的文件，删除它即可回滚。
      await fs.unlink(absPath).catch(() => undefined)
      continue
    }

    // 当时无法安全捕获的文件，现在也不要动；这是保守恢复策略。
    if (entry.skip) continue

    if (entry.absent) {
      // 目标状态是“不存在”，所以当前如果存在就删除。unlink 失败通常表示本来就不存在或无权限。
      await fs.unlink(absPath).catch(() => undefined)
      continue
    }

    if (entry.hash) {
      try {
        // 根据 manifest 中的 hash 找到当时保存的文件内容。
        const buf = await fs.readFile(blobPath(state.sessionId, entry.hash, cwd))

        // 如果文件所在目录后来被删了，恢复前需要重新创建父目录。
        await fs.mkdir(path.dirname(absPath), { recursive: true })

        // 把 blob 内容写回原绝对路径。
        await fs.writeFile(absPath, buf)
      } catch {
        // blob 缺失时无法恢复这个文件。不要让整个 rewind 失败；
        // 恢复其它文件仍比把全部文件留在半新半旧状态更好。
      }
    }
  }

  // 从 manifest 重建 filesModified，让后续 checkpoint 覆盖正确集合。
  // absent/skip 项也要保留：这些文件历史上被 agent 碰过，仍应在跟踪范围内。
  state.filesModified.clear()

  // 恢复后，agent 的“已触碰文件集合”应等于目标 checkpoint 的账本。
  for (const absPath of Object.keys(manifest.files)) {
    state.filesModified.add(absPath)
  }

  // 删除目标 checkpoint 之后的 checkpoint；目标本身保留。
  // 用户现在已经“站在”目标点上，仍可以再次 rewind 到它。
  const cutoffIndex = state.checkpoints.findIndex((c) => c.ckptId === ckptId)

  // 如果内存里找得到目标 checkpoint，就把它之后的未来历史全部丢掉。
  if (cutoffIndex >= 0) {
    // splice 返回被删除的 checkpoint entry，后面要同步删除它们的 manifest 文件。
    const dropped = state.checkpoints.splice(cutoffIndex + 1)

    for (const d of dropped) {
      // 删除未来 checkpoint 的 manifest。失败不影响当前已完成的工作区恢复。
      void fs.unlink(manifestPath(state.sessionId, d.ckptId, cwd)).catch(() => undefined)
    }
  }

  // 删除未来 checkpoint 后，部分 blob 可能已经没人引用，需要清理。
  await garbageCollectBlobs(state, cwd).catch(() => undefined)

  // 返回 true 表示 manifest 可读且恢复流程已经执行完。
  return true
}

/** 扫描 blobs/，删除所有不再被剩余 manifest 引用的 blob。
 *
 * 成本很低：读取剩余 checkpoint * 每个 manifest 的文件数，再做一次 readdir。
 * 只在 eviction 和 restore 后运行，因为只有这两条路径会制造孤儿 blob。 */
async function garbageCollectBlobs(state: LoopState, cwd: string): Promise<void> {
  // 收集仍被保留 checkpoint 引用的所有 blob hash。
  const referenced = new Set<string>()

  // 逐个读取剩余 checkpoint 的 manifest。
  for (const ckpt of state.checkpoints) {
    try {
      // manifest 里保存了每个文件对应的 hash/absent/skip。
      const raw = await fs.readFile(manifestPath(state.sessionId, ckpt.ckptId, cwd), 'utf-8')

      // 这里信任内部写出的 JSON；坏文件会被 catch 跳过。
      const m = JSON.parse(raw) as Manifest

      // 只有 hash 项引用 blob；absent/skip 不引用任何内容文件。
      for (const entry of Object.values(m.files)) {
        if (entry.hash) referenced.add(entry.hash)
      }
    } catch {
      // manifest 已消失或不可读：跳过。
      // 它引用的 blob 会和其它未引用 blob 一起成为回收候选。
    }
  }

  // 读取当前 blob 目录下的所有 blob 文件名，也就是所有已保存的 hash。
  let names: string[]
  try {
    names = await fs.readdir(blobsDir(state.sessionId, cwd))
  } catch {
    // blob 目录不存在时没有东西可清理。
    return
  }

  // 删除没有被任何剩余 manifest 引用的 blob。
  for (const name of names) {
    if (!referenced.has(name)) {
      await fs.unlink(blobPath(state.sessionId, name, cwd)).catch(() => undefined)
    }
  }
}
