// 这个文件负责支持 Up/Down 调出历史输入。
// 历史记录持久化到 `.tegent/history.jsonl`。
// 文件里每一行是一个 JSON 对象，只追加写入，不在写入时重写整个文件。
// 历史文件放在项目本地，这样两个无关项目不会共享同一份输入历史。
// 这和项目里的 `.tegent/sessions/`、`.tegent/plans/`、`.tegent/memory/` 约定一致。
// Claude Code 使用单个全局历史文件，并在每条记录里写 `project:` 字段。
// 这里选择更简单的每项目一个文件：
// 1. 不需要处理全局文件的跨进程 flush 队列和 lockfile。
// 2. 历史记录和其它 `.tegent/` 内容一样，是 gitignored、项目内聚、可随项目丢弃的状态。
//
// 加载时会读取整个历史文件，然后只保留最后 `HISTORY_MAX` 条。
// 这个文件通常很小，因为每次提交只追加一行，并且按项目分开保存。
// 因此使用类似 Claude Code `readLinesReverse` 的反向流式读取会过度设计。
// 只有真实用户把单个项目的历史文件增长到几 MB 以上时，才需要考虑切换成流式读取。
//
// 写入使用 fire-and-forget 的 `fs.appendFile`。
// POSIX 保证小于等于 PIPE_BUF 的 append 写入是原子的，PIPE_BUF 通常是 4096 字节。
// Windows 的 append-mode handle（`O_APPEND` 到 `FILE_APPEND_DATA`）也会按单次写调用原子追加。
// 一条输入历史通常远小于这个预算。
// 因此这里刻意不加 lockfile：项目本地文件、少见的并发 xc 进程、单次 append 原子性，
// 这些条件加起来已经足够，lockfile 的复杂度大于收益。
import fs from 'node:fs/promises' // 导入 promise 版 fs，用于异步读写历史文件。
import path from 'node:path' // 导入路径工具，用于拼接项目内历史文件路径。

import type { PastedContents } from './paste-refs.js' // 导入粘贴引用内容类型，只在类型检查阶段使用。

const HISTORY_FILE = '.tegent/history.jsonl' // 相对项目根目录的历史文件路径。

/**
 * 内存中最多保留的历史条目数量。
 *
 * 这个值对应 Claude Code 的 `MAX_HISTORY_ITEMS`。
 * 它只影响读取侧：磁盘上的历史文件会持续追加，不会在这里裁剪。
 * 用户按 Up 时最多看到最近 100 条。
 * 如果文件里有更多行，加载时只在内存中截取尾部 100 条。
 */
export const HISTORY_MAX = 100

/**
 * 单条输入历史记录。
 */
export interface InputHistoryEntry {
  /**
   * 提交前的输入框文本。
   *
   * 如果启用了大段粘贴引用，这里保存的是含 `[Pasted text #N]` 占位符的形式。
   * 恢复历史时这样能让输入框保持紧凑，而不是直接把整段粘贴内容展开到当前画面。
   */
  text: string

  /**
   * 粘贴引用内容表。
   *
   * key 是粘贴 id，value 是对应的原始粘贴内容。
   * 当前 Ink 第一版可以为空对象，但保留字段用于兼容历史数据结构。
   */
  pasted: PastedContents

  /**
   * 历史记录创建时间。
   *
   * 单位是 epoch 毫秒。
   */
  ts: number
}

/**
 * 生成某个项目目录下的历史文件绝对路径。
 *
 * @param cwd - 项目工作目录。
 * @returns `.tegent/history.jsonl` 的绝对路径。
 */
function historyPath(cwd: string): string {
  return path.join(cwd, HISTORY_FILE) // 把项目目录和相对历史文件路径拼起来。
}

/**
 * 读取最近的输入历史记录。
 *
 * @param cwd - 项目工作目录，默认使用当前进程工作目录。
 * @returns 最多 `HISTORY_MAX` 条历史记录，按从旧到新的顺序返回。
 *
 * 返回旧到新的顺序，是为了调用方可以把新提交直接 `push` 到数组尾部，
 * 并用 `arr[arr.length - 1 - i]` 从尾部向前浏览历史。
 * 这和 `ChatInputInk` 里的 `historyRef` 内存形状一致。
 */
export async function loadInputHistory(cwd: string = process.cwd()): Promise<InputHistoryEntry[]> {
  let raw: string // 保存从历史文件读出的原始文本。
  try {
    raw = await fs.readFile(historyPath(cwd), 'utf-8') // 读取整个历史文件。
  } catch {
    // 首次运行时文件不存在，这是正常情况，直接返回空历史。
    // 其它读取错误也按空历史处理。
    // 输入历史是非关键体验，不能因为它阻塞启动。
    return []
  }
  // 每次 append 都会以 `\n` 结尾，所以文件末尾出现空行是正常的。
  // 这里也会过滤掉部分写入或手工编辑留下的空白行。
  const lines = raw.split('\n').filter((l) => l.length > 0)
  const tail = lines.length > HISTORY_MAX ? lines.slice(lines.length - HISTORY_MAX) : lines // 只保留最后 HISTORY_MAX 行。
  const out: InputHistoryEntry[] = [] // 收集成功解析的历史条目。
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as Partial<InputHistoryEntry> // 把 jsonl 的单行解析成部分历史对象。
      if (typeof parsed.text !== 'string' || !parsed.text) continue // 没有有效 text 的记录直接跳过。
      out.push({
        text: parsed.text, // 保存历史文本。
        pasted: (parsed.pasted as PastedContents | undefined) ?? {}, // pasted 缺失时用空对象兜底。
        ts: typeof parsed.ts === 'number' ? parsed.ts : 0, // ts 缺失或类型不对时用 0 兜底。
      })
    } catch {
      // 单行损坏时跳过这一行。
      // 损坏原因可能是写入中崩溃、手工编辑或旧版本格式异常。
      // 丢一条历史比阻塞启动更好。
    }
  }
  return out // 返回成功解析出的历史记录。
}

/**
 * 追加一条输入历史记录。
 *
 * @param entry - 要写入的历史记录。
 * @param cwd - 项目工作目录，默认使用当前进程工作目录。
 * @returns 写入完成后 resolve；写入失败也会吞掉错误并正常 resolve。
 *
 * 这是 fire-and-forget 设计：
 * 函数返回 Promise，方便测试等待它完成；
 * 业务调用方可以忽略这个 Promise。
 * 输入历史只是体验增强，不是核心数据。
 * 磁盘偶发错误时，丢失一条历史比在用户输入时弹出错误更合理。
 */
export async function appendInputHistory(entry: InputHistoryEntry, cwd: string = process.cwd()): Promise<void> {
  const file = historyPath(cwd) // 计算历史文件路径。
  const line = JSON.stringify(entry) + '\n' // 把历史记录序列化成 jsonl 的一行。
  try {
    await fs.mkdir(path.dirname(file), { recursive: true }) // 确保 `.tegent` 目录存在。
    await fs.appendFile(file, line, { encoding: 'utf-8' }) // 以追加方式写入一行历史。
  } catch {
    // best-effort：历史写入失败不影响主流程。
  }
}
