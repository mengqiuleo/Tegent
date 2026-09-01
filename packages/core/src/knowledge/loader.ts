// 这个文件负责把“用户偏好、项目说明、自动记忆、本地私有偏好”等知识来源
// 组合成一段 system prompt 里的上下文。它不是随便拼接文件，而是按层级加载：
// 同一类项目文件内部按“仓库根目录 -> 当前子目录”的顺序排列；不同来源则按下面顺序拼接：
//
//   1. 用户级 AGENTS.md（~/.tegent/）- 不存在时只读兼容 CLAUDE.md
//   2. 用户级自动记忆（~/.tegent/memory/auto.md）- 每轮结束后由 AI 提取写入
//   3. 项目 AGENTS.md 链 - 每个目录不存在 AGENTS.md 时只读兼容 CLAUDE.md
//   4. 项目级自动记忆（.tegent/memory/auto.md）- 每轮结束后由 AI 提取写入
//   5. 项目根目录 AGENTS.local.md - 个人本地偏好，gitignored，不进仓库
//
// 越靠后的 section 通常对模型越“近”，也更容易覆盖前面的共享规则：
// 例如 monorepo 子包里的 AGENTS.md 会比仓库根目录的 AGENTS.md 更具体；
// AGENTS.local.md 又比团队共享文件更贴近当前开发者的私人偏好。
//
// 文件名策略是“读取时兼容，写入时统一”：
// 在每个目录先找 `AGENTS.md`（这是本项目约定，也是 `/init` 会创建的文件），
// 只有找不到时才回退读取 `CLAUDE.md`，方便从 Claude Code 迁移过来的用户继续使用
// 既有文件而不必改名。如果同一目录两个文件都存在，`AGENTS.md` 明确胜出，
// `CLAUDE.md` 会被忽略。后续所有写入类工具（例如 `/init`）都应该写 AGENTS.md。
import path from 'node:path'

import { USER_TEGENT_DIR, fileExists, readFileSafe } from '../utils.js'
import { getAutoMemory } from './auto-memory.js'

const USER_DIR = USER_TEGENT_DIR

/** 每个目录中会识别的知识文件名，按数组顺序尝试。
 *  第一个找到的文件会成为该目录的知识来源，后面的候选会跳过。
 *  AGENTS.md 是主约定；CLAUDE.md 只是为了兼容旧项目的只读回退。 */
const KNOWLEDGE_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const

/** 读取 `dir` 目录下存在的 AGENTS.md 或 CLAUDE.md，并优先选择前者。
 *  如果两个文件都不存在，返回 null。 */
async function readKnowledgeFile(dir: string): Promise<{ fileName: string; content: string } | null> {
  for (const fileName of KNOWLEDGE_FILENAMES) {
    const content = await readFileSafe(path.join(dir, fileName))
    if (content) return { fileName, content }
  }
  return null
}

/**
 * 从 `startDir` 开始一路向上查找，每个目录最多收集一个知识文件。
 *
 * 这符合 Codex 的项目知识约定：仓库根目录的 AGENTS.md 作用于整个项目；
 * monorepo 中更深层的包级 AGENTS.md 可以追加更具体的上下文，从而覆盖共享规则。
 * 向上查找会在第一个包含 `.git` 的目录停止（包含该目录本身），如果一直找不到，
 * 则最多走到文件系统根目录。
 *
 * 返回值按“根目录 -> 当前目录”的顺序排列，这样越深、越具体的文件会被拼在后面。
 * 每个目录最多贡献一条：有 AGENTS.md 就用它；否则有 CLAUDE.md 就用它；都没有就跳过。
 */
async function collectProjectKnowledgeChain(
  startDir: string,
): Promise<Array<{ dir: string; fileName: string; content: string }>> {
  const dirs: string[] = []

  // 把传入的目录转成绝对路径，避免调用方传入相对路径时，后续 path.dirname 判断出错。
  let dir = path.resolve(startDir)

  // 记录当前磁盘/分区的根目录，例如 macOS/Linux 上通常是 `/`，Windows 上可能是 `C:\`。
  const fsRoot = path.parse(dir).root

  // 这一段循环负责“从当前目录一路向上走”，例如：
  // `/repo/packages/core/src` -> `/repo/packages/core` -> `/repo/packages` -> `/repo`
  while (true) {
    dirs.push(dir)
    if (await fileExists(path.join(dir, '.git'))) break
    if (dir === fsRoot) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const entries: Array<{ dir: string; fileName: string; content: string }> = []

  // dirs 的收集顺序是“当前目录 -> 父目录 -> 仓库根目录”。
  // 但 system prompt 需要“根目录 -> 当前目录”，让越靠后的、更具体的规则更容易覆盖前面的规则。
  for (const d of dirs.reverse()) {
    const found = await readKnowledgeFile(d)
    if (found) entries.push({ dir: d, fileName: found.fileName, content: found.content })
  }

  return entries
}

/** 构建最终注入 system prompt 的完整知识上下文。 */
export async function buildKnowledgeContext(options?: { sessionContext?: string }): Promise<string> {
  // sections 是最终 prompt 的各个小块；最后会用空行拼成一整段 Project Knowledge。
  const sections: string[] = []

  // 用户级、人工编写的偏好：优先读取 AGENTS.md；如果没有，则兼容读取 CLAUDE.md。
  // 这样已经有 `~/.tegent/CLAUDE.md` 的用户，或从 Claude Code home 拷贝配置过来的用户，
  // 不需要手动改名也能继续生效。
  const userKnowledge = await readKnowledgeFile(USER_DIR)

  if (userKnowledge) {
    sections.push(`### User Preferences (~/.tegent/${userKnowledge.fileName})\n${userKnowledge.content}`)
  }

  const userMemory = getAutoMemory('user')
  const userMemoryContent = userMemory.getPromptContent()

  if (userMemoryContent) {
    sections.push('### User Auto Memory\n' + userMemoryContent)
  }

  const cwd = process.cwd()
  const projectKnowledge = await collectProjectKnowledgeChain(cwd)

  for (const entry of projectKnowledge) {
    const relPath = path.relative(cwd, entry.dir) || '.'
    sections.push(`### Project ${entry.fileName} (${relPath})\n${entry.content}`)
  }

  const projectMemory = getAutoMemory('project')
  const projectMemoryContent = projectMemory.getPromptContent()

  if (projectMemoryContent) {
    sections.push('### Project Auto Memory\n' + projectMemoryContent)
  }

  // AGENTS.local.md 是当前开发者的本地私有偏好，通常 gitignored，不会提交给团队。
  const localPrefs = await readFileSafe(path.join(cwd, 'AGENTS.local.md'))

  if (localPrefs) {
    sections.push('### Local Preferences (AGENTS.local.md)\n' + localPrefs)
  }

  if (options?.sessionContext) {
    sections.push(options.sessionContext)
  }

  if (sections.length === 0) return ''

  return '## Project Knowledge\n\n' + sections.join('\n\n')
}
