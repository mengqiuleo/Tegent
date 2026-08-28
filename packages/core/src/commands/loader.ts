// 这个模块会扫描用户、项目和插件贡献的 `commands/` 目录，把每个 `*.md`
// 文件解析成可注册到 CommandRegistry 的 CommandDefinition。
// 整体结构刻意和 sub-agents 加载器保持一致：使用同一类最小 YAML
// frontmatter 解析策略，也遵循“单个坏文件只记录并跳过，绝不拖垮启动”的容错方式。
import fs from 'node:fs/promises'
import path from 'node:path'

import { TEGENT_DIR, userTeCodeDir } from '../utils.js'
import type { CommandDefinition } from './types.js'

/**
 * 解析 markdown 文件开头的最小 YAML frontmatter。
 *
 * 这里只支持 skills / sub-agents 加载器同款的 YAML 子集：键值对里的值都按
 * 字符串标量处理，不引入 gray-matter 之类的额外依赖。命令文件真正需要的字段
 * 目前只有 `description`，但真实 Claude Code command 文件里常见多行
 * `allowed-tools`，因此会把缩进续行折叠到上一行，保证解析器不会因为我们暂时
 * 忽略的字段而报错。
 *
 * @param raw - markdown 文件的完整原始文本。
 * @returns 解析成功时返回 frontmatter 数据和正文；没有合法 frontmatter 时返回 null。
 */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]!
  const body = match[2]!
  const data: Record<string, unknown> = {}

  const folded: string[] = []
  for (const line of yamlBlock.split(/\r?\n/)) {
    // YAML 的缩进续行会被合并到上一条键值行，兼容 `allowed-tools` 的多行写法。
    if (/^\s/.test(line) && line.trim() && folded.length > 0) {
      folded[folded.length - 1] += ' ' + line.trim()
    } else {
      folded.push(line)
    }
  }

  for (const line of folded) {
    const trimmed = line.trim()
    // 空行和注释行不参与数据构造；格式不完整的行也按宽松模式跳过。
    if (!trimmed || trimmed.startsWith('#')) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx < 1) continue
    const key = trimmed.slice(0, colonIdx).trim()
    let value: string = trimmed.slice(colonIdx + 1).trim()
    // 去掉一层简单引号，保留内部内容；复杂 YAML 类型不在这个轻量解析器的范围内。
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }

  return { data, body }
}

/**
 * 从单个目录加载 markdown command 文件。
 *
 * 目录不存在或不可读时返回空数组，方便上层无条件扫描用户、项目和插件路径。
 * 单个文件解析失败只影响该文件本身，错误会写到 stderr，其他命令继续加载。
 *
 * @param dir - 要扫描的 command 目录。
 * @param source - 命令来源标签，写入 CommandDefinition 供后续 UI 和优先级判断使用。
 * @param pluginId - 插件来源命令所属插件 id；用户/项目命令不传。
 * @param pluginRoot - 插件根目录；用于命令正文里的 `${CLAUDE_PLUGIN_ROOT}` 替换。
 * @returns 当前目录中成功加载出的 CommandDefinition 列表。
 */
async function loadCommandsFromDir(
  dir: string,
  source: CommandDefinition['source'],
  pluginId?: string,
  pluginRoot?: string,
): Promise<CommandDefinition[]> {
  const out: CommandDefinition[] = []
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return out
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const filePath = path.join(dir, entry)
    const name = entry.slice(0, -3) // 去掉 `.md` 后缀，文件名就是 slash command 名称。

    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = parseFrontmatter(raw)
      // 没有 frontmatter 的命令文件仍然有效：整个文件都会作为 prompt 正文。
      // 真实 Claude Code command 通常都有 frontmatter，但这里保持宽松，方便用户手写。
      const description = parsed?.data.description as string | undefined
      const body = (parsed ? parsed.body : raw).trim()

      const cmd: CommandDefinition = {
        name,
        description,
        body,
        source,
      }
      // pluginId / pluginRoot 只对插件命令有意义。
      // 用户和项目命令没有插件上下文；expandCommandBody 会把 `${CLAUDE_PLUGIN_ROOT}`
      // 替换成空字符串，因此这是一个安全的无操作。
      if (pluginId) cmd.pluginId = pluginId
      if (pluginRoot) cmd.pluginRoot = pluginRoot
      out.push(cmd)
    } catch (err) {
      console.error(`[commands] Skipping ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}

export interface LoadCommandsOptions {
  /**
   * 插件贡献的 command 目录列表。
   *
   * 每一项都携带所属插件 id 和插件根目录。数组顺序会决定注册表插入顺序；
   * 同名冲突时 CommandRegistry 采用后写覆盖。
   */
  extraDirs?: ReadonlyArray<{ dir: string; pluginId: string; pluginRoot: string }>
}

/**
 * 加载所有文件型 slash commands。
 *
 * 扫描来源包括用户级 `~/.tegent/commands/*.md`、插件传入的 `extraDirs`，
 * 以及项目级 `<cwd>/.tegent/commands/*.md`。合并顺序是 user → plugin → project，
 * 配合 CommandRegistry 的“同名后写覆盖”，最终优先级就是
 * **project > plugin > user**，与 skills 和 sub-agents 的规则一致。
 *
 * `userTeCodeDir()` 必须在加载时调用，因为测试会通过 `X_CODE_HOME` 重定向
 * 用户级目录；如果提前缓存路径，测试隔离会失效。
 *
 * @param opts - 可选的插件 command 目录集合。
 * @returns 按优先级插入顺序排列的 CommandDefinition 列表。
 */
export async function loadPluginCommands(opts: LoadCommandsOptions = {}): Promise<CommandDefinition[]> {
  const userDir = path.join(userTeCodeDir(), 'commands')
  const projectDir = path.join(process.cwd(), TEGENT_DIR, 'commands')

  // 先加载用户级命令，作为最低优先级的基础层。
  const userCmds = await loadCommandsFromDir(userDir, 'user')
  const pluginCmds: CommandDefinition[] = []
  for (const { dir, pluginId, pluginRoot } of opts.extraDirs ?? []) {
    // 插件命令夹在用户和项目之间：可覆盖用户命令，但仍会被项目命令覆盖。
    pluginCmds.push(...(await loadCommandsFromDir(dir, 'plugin', pluginId, pluginRoot)))
  }
  // 项目级命令最后加载，允许当前仓库精确覆盖用户或插件提供的同名命令。
  const projectCmds = await loadCommandsFromDir(projectDir, 'project')

  return [...userCmds, ...pluginCmds, ...projectCmds]
}
