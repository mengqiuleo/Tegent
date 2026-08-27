// 组件挂载时会从 cwd 开始做 BFS 遍历，生成扁平的 `{ relPath, isDirectory }` 列表。
// 补全菜单的 fuzzy ranker 会消费这份列表。
// 扫描时按优先级从高到低应用三层过滤：
//
// 1. 硬黑名单：node_modules、.git、dist、.next、.tegent、out、build、coverage 等。
//    这些目录几乎每个项目都会忽略。
//    提前过滤可以避免在解析 .gitignore 之前，条目预算就被 vendor 或构建产物耗尽。
// 2. 简化版 .gitignore：只读取顶层文件，只支持裸名称和 `*.suffix` 模式。
//    其它复杂规则会静默跳过。
//    这是一个 UI 便利功能，所以暂时不引入 `ignore` npm 依赖。
//    需要完整 git 语义的复杂仓库，仍然可以依赖硬黑名单兜底。
// 3. 跳过 symlink：避免循环遍历，同时不需要额外维护 visited-set。
//
// 扫描有 5000 条目和 200ms 的软上限，防止巨型 monorepo 在启动时冻结 UI。
// 触顶时会返回已经扫描到的内容。
// 因为 BFS 会先扫描浅层目录，用户看到的建议也更接近他们实际可能输入的路径。
import fs from 'node:fs/promises' // 导入 promise 版 fs，用于异步读取目录和 .gitignore。
import path from 'node:path' // 导入路径工具，用于拼接跨平台路径。

import { useEffect, useState } from 'react' // 导入 React hook，用于挂载扫描和保存状态。

import type { FileEntry } from '../file-completion.js' // 导入补全菜单消费的文件条目类型。

/**
 * 永远跳过的目录或文件名集合。
 *
 * 这些名称会在任何深度匹配，避免索引常见依赖、构建产物和缓存目录。
 */
const HARD_BLACKLIST: ReadonlySet<string> = new Set([
  'node_modules', // 依赖目录通常极大，且不适合作为 @ mention 候选。
  '.git', // git 内部目录不应进入 UI 补全。
  'dist', // 常见构建输出目录。
  '.next', // Next.js 构建缓存目录。
  '.tegent', // 本项目本地状态目录。
  'out', // 常见输出目录。
  'build', // 常见构建输出目录。
  'coverage', // 测试覆盖率输出目录。
  '.turbo', // Turborepo 缓存目录。
  '.cache', // 通用缓存目录。
])

const DEFAULT_MAX_ENTRIES = 5000 // 默认最多收集 5000 个条目，防止大型仓库耗尽启动预算。
const DEFAULT_MAX_MS = 200 // 默认最多扫描 200ms，避免阻塞 UI 启动。

/**
 * 简化版 ignore 规则。
 *
 * 只覆盖 UI 补全需要的常见场景，不追求完整 gitignore 语义。
 */
interface SimpleIgnore {
  /**
   * 在树的任意深度都能匹配的裸名称。
   *
   * 例如 `node_modules`、`dist`。
   */
  names: Set<string>

  /**
   * 已转为小写且包含点号的后缀。
   *
   * 例如 `.log`、`.tsbuildinfo`。
   */
  suffixes: Set<string>
}

const EMPTY_IGNORE: SimpleIgnore = { names: new Set(), suffixes: new Set() } // 没有 .gitignore 时使用的空规则对象。

/**
 * 解析语义刻意简化的 `.gitignore` 内容。
 *
 * @param content - `.gitignore` 文件内容。
 * @returns 可被扫描器快速匹配的简化 ignore 规则。
 *
 * 解析规则：
 *
 * - 跳过空行、注释行 `#` 和取反规则 `!…`。
 * - `*.ext` 转成后缀 `.ext`。
 * - `name`、`/name`、`name/` 转成裸名称，任意深度都匹配。
 * - 中间包含 `/`、`**`、`?` 或 `[` 的复杂模式会被丢弃。
 *
 * 这样能覆盖硬黑名单漏掉的大多数常见规则，例如 `*.log`、`coverage`、`.DS_Store`、
 * `*.tsbuildinfo`，同时避免为 UI 细节引入完整 ignore 依赖。
 */
export function parseSimpleGitignore(content: string): SimpleIgnore {
  const names = new Set<string>() // 收集裸名称匹配规则。
  const suffixes = new Set<string>() // 收集后缀匹配规则。
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim() // 去掉首尾空白，统一后续匹配。
    if (!line || line.startsWith('#') || line.startsWith('!')) continue // 空行、注释和取反规则都不支持，直接跳过。
    if (line.startsWith('*.') && !line.slice(2).match(/[\\/*?[\]]/)) {
      suffixes.add(line.slice(1).toLowerCase()) // `*.log` 保存为 `.log`，并统一小写。
      continue // 后缀规则处理完后进入下一行。
    }
    const stripped = line.replace(/^\/+/, '').replace(/\/+$/, '') // 去掉开头和结尾的斜杠，得到裸名称候选。
    if (!stripped) continue // 去掉斜杠后为空的规则没有意义。
    if (/[*?[\]/]/.test(stripped)) continue // 复杂通配符或中间路径规则不在简化语义中支持。
    names.add(stripped) // 保存裸名称规则，后续任意深度匹配。
  }
  return { names, suffixes } // 返回扫描器可直接使用的规则集合。
}

/**
 * 从工作区根目录读取并解析顶层 `.gitignore`。
 *
 * @param rootDir - 工作区根目录。
 * @returns 解析后的简化 ignore 规则；读取失败时返回空规则。
 */
async function loadIgnore(rootDir: string): Promise<SimpleIgnore> {
  try {
    const content = await fs.readFile(path.join(rootDir, '.gitignore'), 'utf-8') // 尝试读取根目录下的 .gitignore。
    return parseSimpleGitignore(content) // 读取成功后解析为简化规则。
  } catch {
    return EMPTY_IGNORE // 文件不存在或不可读时，使用空规则兜底。
  }
}

/**
 * 工作区文件扫描选项。
 */
export interface ScanOptions {
  /**
   * 要扫描的根目录。
   */
  rootDir: string

  /**
   * 可选的取消信号。
   */
  signal?: AbortSignal

  /**
   * 最多返回的条目数。
   */
  maxEntries?: number

  /**
   * 最长扫描时间，单位毫秒。
   */
  maxMs?: number

  /**
   * 覆盖默认 gitignore 规则。
   *
   * 这是测试注入点。
   * 生产路径始终读取 `<rootDir>/.gitignore`。
   */
  ignore?: SimpleIgnore
}

/**
 * 对工作区根目录执行 BFS 扫描，并应用三层过滤规则。
 *
 * @param opts - 扫描配置。
 * @returns 可供 @ mention 补全菜单使用的文件条目列表。
 *
 * 即使在 Windows 上，返回的 `relPath` 也统一使用 POSIX 风格的正斜杠。
 * 这样能匹配菜单展示和用户输入。
 * 后端的 file-ingest.ts 会同时兼容两种路径分隔符。
 */
export async function scanWorkspaceFiles(opts: ScanOptions): Promise<FileEntry[]> {
  const { rootDir, signal, maxEntries = DEFAULT_MAX_ENTRIES, maxMs = DEFAULT_MAX_MS } = opts // 解构扫描选项并填入默认软上限。
  const ignore = opts.ignore ?? (await loadIgnore(rootDir)) // 优先使用注入规则，否则读取根目录 .gitignore。
  const start = Date.now() // 记录扫描开始时间，用于 maxMs 软上限。
  const result: FileEntry[] = [] // 收集扫描得到的文件和目录条目。
  const queue: string[] = [''] // BFS 队列保存相对 POSIX 路径；空字符串表示根目录。

  /**
   * 判断文件名是否匹配简化 ignore 后缀规则。
   *
   * @param name - 文件名。
   * @returns 命中后缀规则时返回 `true`。
   */
  const matchesSuffix = (name: string): boolean => {
    if (ignore.suffixes.size === 0) return false // 没有后缀规则时快速返回。
    const lower = name.toLowerCase() // 后缀匹配统一小写，避免大小写差异。
    for (const suf of ignore.suffixes) {
      if (lower.endsWith(suf)) return true // 命中任一后缀即认为应忽略。
    }
    return false // 所有后缀都未命中。
  }

  while (queue.length > 0) {
    if (signal?.aborted) break // 外部取消时提前结束扫描。
    if (Date.now() - start > maxMs) break // 超过时间预算时返回已扫描结果。
    if (result.length >= maxEntries) break // 达到条目数量上限时停止。

    const relDir = queue.shift()! // 取出 BFS 队列中的下一个相对目录。
    const absDir = relDir === '' ? rootDir : path.join(rootDir, relDir) // 根目录直接使用 rootDir，其它目录拼出绝对路径。

    let dirents // 保存 fs.readdir 返回的目录项。
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true }) // 异步读取目录，并请求 Dirent 类型信息。
    } catch {
      continue // 权限错误、目录消失等情况直接跳过该目录。
    }

    for (const dirent of dirents) {
      const name = dirent.name // 读取当前目录项名称。
      if (HARD_BLACKLIST.has(name)) continue // 硬黑名单优先级最高，命中就跳过。
      if (ignore.names.has(name)) continue // 命中简化 gitignore 裸名称规则时跳过。
      if (dirent.isSymbolicLink()) continue // 跳过 symlink，避免循环遍历。

      const isDir = dirent.isDirectory() // 判断当前条目是否是目录。
      const isFile = dirent.isFile() // 判断当前条目是否是普通文件。
      if (!isDir && !isFile) continue // 非目录也非普通文件的条目不进入补全。
      if (isFile && matchesSuffix(name)) continue // 普通文件命中忽略后缀时跳过。

      const relPath = relDir ? `${relDir}/${name}` : name // 拼出 POSIX 风格相对路径。
      result.push({ relPath, isDirectory: isDir }) // 把条目加入补全索引。
      if (isDir) queue.push(relPath) // 目录需要继续 BFS 扫描子项。
      if (result.length >= maxEntries) break // 内层循环也检查数量上限，避免超出太多。
    }
  }

  return result // 返回已扫描到的条目，可能因为软上限而不是完整工作区。
}

/**
 * 文件补全 hook 的返回值。
 */
export interface UseFileCompletionResult {
  /**
   * 当前可用于补全的文件和目录条目。
   */
  entries: readonly FileEntry[]

  /**
   * 是否仍在扫描工作区。
   */
  loading: boolean
}

/**
 * 扫描一次当前工作目录，并暴露补全条目和加载状态。
 *
 * @returns 文件补全状态。
 *
 * `process.cwd()` 只在扫描启动时读取一次，之后不会重新检查。
 * shell 工具内部即使执行 chdir，也不会影响补全菜单的根目录。
 */
export function useFileCompletion(): UseFileCompletionResult {
  const [entries, setEntries] = useState<readonly FileEntry[]>([]) // 保存扫描得到的补全条目。
  const [loading, setLoading] = useState(true) // 保存扫描是否仍在进行。

  useEffect(() => {
    let cancelled = false // 标记组件是否已经卸载或 effect 是否已清理。
    const ac = new AbortController() // 创建取消控制器，供扫描函数尽早停止。
    scanWorkspaceFiles({ rootDir: process.cwd(), signal: ac.signal })
      .then((result) => {
        if (cancelled) return // 清理后不再写入 React 状态。
        setEntries(result) // 保存扫描结果。
        setLoading(false) // 扫描成功后关闭 loading。
      })
      .catch(() => {
        if (cancelled) return // 清理后不再写入 React 状态。
        setLoading(false) // 扫描失败时也结束 loading，补全列表保持为空。
      })
    return () => {
      cancelled = true // 标记后续异步回调不应再 setState。
      ac.abort() // 通知扫描循环尽快停止。
    }
  }, [])

  return { entries, loading } // 返回补全条目和加载状态。
}
