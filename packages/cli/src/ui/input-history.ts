// 这个文件负责支持 Up/Down 调出历史输入。
// 历史记录持久化到 `.tegent/history.jsonl`。
// 文件里每一行是一个 JSON 对象，只追加写入，不在写入时重写整个文件。
// 历史文件放在项目本地，这样两个无关项目不会共享同一份输入历史。
// 这和项目里的 `.tegent/sessions/`、`.tegent/plans/`、`.tegent/memory/` 约定一致。

// 这里选择更简单的每项目一个文件：
// 1. 不需要处理全局文件的跨进程 flush 队列和 lockfile。
// 2. 历史记录和其它 `.tegent/` 内容一样，是 gitignored、项目内聚、可随项目丢弃的状态。
//
// 加载时会读取整个历史文件，然后只保留最后 `HISTORY_MAX` 条。

import fs from 'node:fs/promises'
import path from 'node:path'

const HISTORY_FILE = '.tegent/history.jsonl'

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
   */
  text: string

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
  return path.join(cwd, HISTORY_FILE)
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
    return []
  }

  const lines = raw.split('\n').filter((l) => l.length > 0)
  const tail = lines.length > HISTORY_MAX ? lines.slice(lines.length - HISTORY_MAX) : lines // 只保留最后 HISTORY_MAX 行。
  const out: InputHistoryEntry[] = []
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as Partial<InputHistoryEntry> 
      if (typeof parsed.text !== 'string' || !parsed.text) continue
      out.push({
        text: parsed.text, // 保存历史文本。
        ts: typeof parsed.ts === 'number' ? parsed.ts : 0, 
      })
    } catch {

    }
  }
  return out 
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
  const file = historyPath(cwd)
  const line = JSON.stringify(entry) + '\n' 
  try {
    await fs.mkdir(path.dirname(file), { recursive: true }) 
    await fs.appendFile(file, line, { encoding: 'utf-8' })
  } catch {

  }
}
