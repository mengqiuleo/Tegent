// AutoMemory 用来保存“模型从对话中提取出来、未来还可能有用”的事实。
// 它以 key 为主键做增删改查，写入 markdown 文件，启动时加载，过期后自动淘汰。
// 当前有两份实例：
//   1. 用户级记忆：放在 ~/.tegent/memory/auto.md，跨项目共享；
//   2. 项目级记忆：放在当前项目 .tegent/memory/auto.md，只服务当前仓库。
//
// 文件格式刻意保持简单：每条事实是一行 `- [日期] key: fact`。
// 这样它既方便人读，也方便 parseMemoryFile 用正则稳定解析。
import fs from 'node:fs/promises'
import path from 'node:path'

import type { KnowledgeCategory, KnowledgeFact } from '../types/index.js'
import { USER_TEGENT_DIR, TEGENT_DIR } from '../utils.js'

// 从自动记忆文件注入 prompt 时，最多读取这么多行，避免记忆文件过大挤爆上下文。
const MAX_LOAD_LINES = 200

/** 合法记忆分类白名单，需要和 types/index.ts 里的 `KnowledgeCategory` 保持同步。
 *
 * 写入时和解析时都会拒绝白名单之外的分类。这样旧版本在没有 schema 约束时写入的
 * 分类（例如 `context`、`tech-stack`、`commands` 等）不会在后续 session 中
 * 悄悄继续存在并被重新序列化。
 */
const VALID_CATEGORIES: ReadonlySet<KnowledgeCategory> = new Set(['user', 'feedback', 'project', 'reference'])

// 运行时类型守卫：把普通字符串判断成合法的 KnowledgeCategory。
function isValidCategory(c: string): c is KnowledgeCategory {
  // Set.has 只会返回 boolean；这里用 as KnowledgeCategory 是为了让 TypeScript 接受类型收窄。
  return VALID_CATEGORIES.has(c as KnowledgeCategory)
}

/**
 * 把换行和连续空白折叠成单个空格，并去掉首尾空白。
 *
 * AutoMemory 的持久化格式要求“一条事实占一行”。即使调用方传入多行内容，
 * 这里也会把它压成单行，避免破坏 markdown 行格式。对空字符串也会稳定返回 ''，
 * 调用方不需要额外做空值处理。
 */
function sanitizeLine(s: string): string {
  // \s+ 会匹配空格、换行、tab 等连续空白；统一替换成单个空格，最后再 trim。
  return s.replace(/\s+/g, ' ').trim()
}

class AutoMemory {
  // 当前实例在内存里维护的所有事实；load() 会从磁盘填充它，add/delete 会修改它。
  private facts: KnowledgeFact[] = []

  // 当前 AutoMemory 对应的 markdown 文件路径；用户级和项目级实例会指向不同文件。
  private filePath: string

  /** 串行保存队列，用来避免多个 add/delete 同时写同一个文件。 */
  private saveQueue: Promise<void> = Promise.resolve()

  // 构造时只绑定文件路径；真正读磁盘发生在 load()，这样创建实例本身很轻。
  constructor(filePath: string) {
    // 把传入路径存下来，后续 load/save 都会用同一个路径。
    this.filePath = filePath
  }

  /** 从 markdown 文件加载记忆。文件不存在、格式异常或读取失败时，降级为空记忆。 */
  async load(): Promise<void> {
    try {
      // 尝试读取整个 auto.md；文件格式很小，所以一次性读完比流式读取更简单。
      const content = await fs.readFile(this.filePath, 'utf-8')

      // 把 markdown 文本解析成结构化数组，后续查找、更新、删除都基于这个数组。
      this.facts = parseMemoryFile(content)
    } catch {
      // 自动记忆是可选增强：文件不存在、权限问题、解析前读取失败，都不应该阻塞 agent 启动。
      this.facts = []
    }
  }

  /** 添加或更新一条记忆。
   *  同一个 category + 同一个 key 会被视为同一条事实，并用新内容替换旧内容。
   *  未知 category 会被直接拒绝，避免污染记忆文件。 */
  add(newFact: KnowledgeFact): void {
    // 首先校验分类，避免非法分类进入内存并在下一次保存时落盘。
    if (!isValidCategory(newFact.category)) {
      // 纵深防御：工具 schema 理论上应该已经拦住非法分类；
      // 如果有调用方绕过 schema，宁可丢弃这次写入，也不要把脏数据写进文件。
      return
    }

    // 清理 key 和 fact，避免内嵌换行破坏“一条事实一行”的 markdown 格式。
    const fact: KnowledgeFact = {
      // 保留调用方传来的 date/category 等字段，只覆盖下面需要清理的文本字段。
      ...newFact,

      // key 会出现在 `key: fact` 的冒号前；必须保持单行，便于后续正则解析。
      key: sanitizeLine(newFact.key),

      // fact 是真正的记忆内容；同样压成单行，避免一条事实拆成多行。
      fact: sanitizeLine(newFact.fact),
    }

    // 查找是否已有同分类、同 key 的事实；这就是“更新”而不是“追加”的判定条件。
    const conflictIndex = this.facts.findIndex(
      // category 区分用户反馈、项目事实等不同命名空间；key 是同一命名空间下的唯一标识。
      (existing) => existing.category === fact.category && existing.key === fact.key,
    )

    // 找到已有事实时，用新事实替换旧事实。
    if (conflictIndex >= 0) {
      this.facts[conflictIndex] = fact
    } else {
      // 没有冲突时，把它作为一条新记忆追加到数组末尾。
      this.facts.push(fact)
    }

    // 内存已变更，异步排队写回磁盘；这里不 await，是为了不阻塞调用方主流程。
    this.enqueueSave()
  }

  /** 按 key 删除记忆；传入 category 时只删除该分类下的同名 key。 */
  delete(key: string, category?: string): void {
    // filter 会保留“不应该删除”的事实；匹配 key 且 category 符合条件的事实会被过滤掉。
    this.facts = this.facts.filter((f) => !(f.key === key && (!category || f.category === category)))

    // 删除后同样排队保存，把内存状态同步回 markdown 文件。
    this.enqueueSave()
  }

  /** 按 key 查找记忆；传入 category 时只在该分类中查找。 */
  find(key: string, category?: string): KnowledgeFact | undefined {
    // find 返回第一条匹配的事实；如果没有匹配项，TypeScript 类型里会体现为 undefined。
    return this.facts.find((f) => f.key === key && (!category || f.category === category))
  }

  /** 淘汰超过 maxAgeDays 天的旧记忆。
   *  默认保留 90 天，避免自动记忆无限膨胀，也减少过期偏好继续影响模型的概率。 */
  evict(maxAgeDays: number = 90): void {
    // cutoff 是“最早允许保留的时间戳”；比它更早的记忆会被淘汰。
    const cutoff = Date.now() - maxAgeDays * 86400_000

    // 记录过滤前数量，用来判断是否真的发生了删除。
    const before = this.facts.length

    // KnowledgeFact.date 是 YYYY-MM-DD 字符串；转成时间戳后和 cutoff 比较。
    this.facts = this.facts.filter((f) => new Date(f.date).getTime() > cutoff)

    // 只有确实删掉了旧记忆才保存，避免无意义写文件。
    if (this.facts.length < before) this.save()
  }

  /** 获取当前内存中的所有记忆。返回浅拷贝，避免外部直接修改内部数组。 */
  getAll(): KnowledgeFact[] {
    // 用展开语法复制数组本身；外部 push/splice 不会影响 this.facts。
    return [...this.facts]
  }

  /** 获取可注入 system prompt 的 markdown 内容。
   *  只保留前 MAX_LOAD_LINES 行，防止自动记忆文件过大时挤占过多上下文窗口。 */
  getPromptContent(): string {
    // 先复用 serialize() 得到和文件保存一致的 markdown 表示。
    const content = this.serialize()

    // 按行切开，后面才能做行数截断。
    const lines = content.split('\n')

    // 如果超过最大行数，只取前面部分，并明确告诉模型这段内容被截断过。
    if (lines.length > MAX_LOAD_LINES) {
      return lines.slice(0, MAX_LOAD_LINES).join('\n') + '\n... (truncated)'
    }

    // 没超过限制时，直接返回完整内容。
    return content
  }

  /** 序列化成 markdown 格式。
   *  先按 category 分组，再输出为二级标题 + 三级分类标题 + 列表项，便于人类查看和编辑。 */
  private serialize(): string {
    // 没有任何记忆时返回空字符串；调用方会据此跳过 prompt section。
    if (this.facts.length === 0) return ''

    // Map 用来按 category 聚合事实，保持输出结构清晰。
    const categories = new Map<string, KnowledgeFact[]>()

    // 遍历当前所有事实，把它们放入对应分类的数组里。
    for (const fact of this.facts) {
      // 如果这个分类已经有数组就复用；否则先创建一个空数组。
      const list = categories.get(fact.category) ?? []

      // 把当前事实加入该分类。
      list.push(fact)

      // 写回 Map；新建数组时需要这一步，复用数组时这一步也保持逻辑一致。
      categories.set(fact.category, list)
    }

    // markdown 输出从固定标题开始，空字符串表示标题后留一行空行。
    const sections: string[] = ['## Auto Memory', '']

    // 按 Map 的插入顺序输出每个分类。
    for (const [category, facts] of categories) {
      // 分类标题，例如 `### user`、`### project`。
      sections.push(`### ${category}`)

      // 输出该分类下的每条事实。
      for (const f of facts) {
        // 单条事实格式固定为 `- [日期] key: fact`，parseMemoryFile 会依赖这个格式读回来。
        sections.push(`- [${f.date}] ${f.key}: ${f.fact}`)
      }

      // 每个分类后空一行，让 markdown 更好读。
      sections.push('')
    }

    // 用换行把所有 markdown 行拼成最终文本。
    return sections.join('\n')
  }

  /**
   * 将保存操作放入队列，让并发 add/delete 触发的写文件动作串行执行。
   * 每次保存都会等待前一次保存完成，避免后写入的旧内容覆盖先写入的新内容。
   */
  private enqueueSave(): void {
    // 把新的 save 接到上一次 save 后面；这样同时触发的保存也会排队执行。
    this.saveQueue = this.saveQueue.then(() => this.save())
  }

  /** 把当前内存中的记忆写回文件。写入失败时静默忽略，不能因为记忆失败导致 agent 崩溃。 */
  private async save(): Promise<void> {
    try {
      // 确保 memory 目录存在；recursive 让多级目录不存在时也能一次性创建。
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })

      // 把当前 facts 序列化后的 markdown 写入 auto.md，覆盖旧内容。
      await fs.writeFile(this.filePath, this.serialize(), 'utf-8')
    } catch {
      // 静默失败：自动记忆是增强功能，写失败不应该中断 agent 主流程。
    }
  }
}

/** 把 markdown 记忆文件解析回结构化事实数组。
 *
 * 未知 category 下的条目会被丢弃。这样旧版本写入的遗留分类
 * （例如 `context`、`tech-stack`、`commands` 等）会在下次保存时自然消失，
 * 不会继续被重新序列化进新文件。
 */
function parseMemoryFile(content: string): KnowledgeFact[] {
  // 解析结果会逐条 push 到 facts，最后返回给 AutoMemory.load()。
  const facts: KnowledgeFact[] = []

  // 当前正在解析哪个 `### category` 小节；只有合法分类下的列表项才会被接受。
  let currentCategory = ''

  // markdown 文件按行解析，因为持久化格式约定“一条事实一行”。
  for (const line of content.split('\n')) {
    // 匹配分类标题，例如 `### user`；捕获括号里的内容就是分类名。
    const categoryMatch = line.match(/^### (.+)$/)

    // 如果这一行是分类标题，就更新 currentCategory，并跳过本行剩余解析。
    if (categoryMatch) {
      // trim 去掉标题前后多余空格，让 `### user ` 也能正常识别。
      currentCategory = categoryMatch[1]?.trim() ?? ''

      // 分类标题不是事实本身，所以继续读下一行。
      continue
    }

    // 匹配事实行，例如 `- [2026-08-13] editor: prefers Chinese comments`。
    const factMatch = line.match(/^- \[(\d{4}-\d{2}-\d{2})\] (.+?):\s*(.+)$/)

    // 只有事实行匹配成功，并且当前分类合法时，才把它加入结果。
    if (factMatch && isValidCategory(currentCategory)) {
      facts.push({
        // 正则第 1 组是日期，格式固定为 YYYY-MM-DD。
        // 捕获组在 match 成功时必然存在，`?? ''` 只是满足 noUncheckedIndexedAccess。
        date: factMatch[1] ?? '',

        // 正则第 2 组是 key；trim 防止冒号前有人手动多写了空格。
        key: factMatch[2]?.trim() ?? '',

        // 正则第 3 组是事实内容；trim 防止行尾空格进入记忆。
        fact: factMatch[3]?.trim() ?? '',

        // currentCategory 已经过 isValidCategory 收窄，TypeScript 知道它是合法分类。
        category: currentCategory,
      })
    }
  }

  // 返回解析出的所有合法事实；非法分类和不符合格式的行都会被忽略。
  return facts
}

// 单例实例
//
// 项目级 memory 按 cwd 对应的文件路径缓存。这样如果进程在运行中切换工作目录
// （例如被嵌入 daemon 或测试框架），就会拿到绑定到新项目文件的实例，而不是误用
// 旧 cwd 的 stale 实例。用户级 memory 是真正的单例，因为它的路径固定来自 USER_XCODE_DIR。

const projectMemories = new Map<string, AutoMemory>()

// 用户级记忆路径固定，所以整个进程只需要一个实例；第一次访问时懒创建。
let userMemory: AutoMemory | null = null

// 根据当前工作目录计算项目级自动记忆文件路径。
function projectMemoryPath(cwd: string): string {
  // 最终路径形如 `<cwd>/.tegent/memory/auto.md`。
  return path.join(cwd, TEGENT_DIR, 'memory', 'auto.md')
}

// 获取指定作用域的 AutoMemory 实例；调用方不需要关心文件路径和缓存细节。
export function getAutoMemory(scope: 'project' | 'user'): AutoMemory {
  // 项目级记忆跟 cwd 绑定，所以同一个进程可能缓存多个项目路径对应的实例。
  if (scope === 'project') {
    // 每次调用都用最新的 process.cwd() 算路径，支持测试或嵌入场景中切换 cwd。
    const filePath = projectMemoryPath(process.cwd())

    // 先看看这个项目路径是否已经创建过 AutoMemory。
    let mem = projectMemories.get(filePath)

    // 没创建过就新建一个，并放入 Map，后续同路径复用。
    if (!mem) {
      mem = new AutoMemory(filePath)
      projectMemories.set(filePath, mem)
    }

    // 返回绑定到当前项目路径的记忆实例。
    return mem
  }

  // 用户级记忆路径固定，第一次访问时才创建。
  if (!userMemory) {
    userMemory = new AutoMemory(path.join(USER_TEGENT_DIR, 'memory', 'auto.md'))
  }

  // 返回全局用户级记忆实例。
  return userMemory
}

/** 初始化记忆：从磁盘加载用户级和项目级记忆，并清理过期条目。 */
export async function initMemories(): Promise<void> {
  // 取当前项目对应的项目级记忆实例。
  const project = getAutoMemory('project')

  // 取用户级记忆实例。
  const user = getAutoMemory('user')

  // 并行从磁盘加载两份记忆；它们路径不同，没有必要串行等待。
  await Promise.all([project.load(), user.load()])

  // 加载后清理项目级过期记忆，默认保留 90 天。
  project.evict(90)

  // 加载后清理用户级过期记忆，默认保留 90 天。
  user.evict(90)
}

// 导出类本身，方便测试或高级调用方创建自定义路径的 AutoMemory。
export { AutoMemory }
