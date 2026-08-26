// 扫描 ~/.tegent/skills/*/SKILL.md 和 <repo-root>/.tegent/skills/*/SKILL.md，
// 找出带有 YAML frontmatter 的用户自定义技能。每个技能独占一个子目录，
// 这种结构和 Gemini CLI、Opencode、Codex 等工具保持一致，后续也方便
// 在 SKILL.md 旁边放 references、scripts、assets 等配套文件。
//
// 优先级：同名技能里，项目级技能会覆盖用户级技能。
// 约束：坏文件只打印警告并跳过，单个损坏的 SKILL.md 不能导致 CLI 崩溃。
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { USER_TEGENT_DIR, TEGENT_DIR } from '../constants.js'
import type { SkillDefinition } from './registry.js'

const SKILL_FILENAME = 'SKILL.md'

/**
 * 每个技能最多列出的配套文件数量。
 *
 * 这个上限用于控制技能激活时注入给模型的资源列表大小。即使某个技能携带了大量
 * references、assets、scripts，也不会让激活载荷无限膨胀。
 *
 * 注意：当前函数只负责截断列表本身；调用侧如果需要展示“列表已截断”的提示，
 * 应基于这个上限自行追加提示文本。
 */
const MAX_LISTED_FILES = 50

/**
 * 列出技能配套文件时要跳过的目录名。
 *
 * 这些目录通常是隐藏目录、依赖目录或构建产物目录，体积大且很少包含需要注入模型的
 * 技能资源。这里按目录 basename 匹配，不是 glob 规则。
 */
const SKILL_FILE_LIST_SKIP_DIRS = new Set([
  'node_modules',
  '__pycache__',
  '.git',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
])

const frontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
})

/**
 * 遍历单个技能目录，并返回该技能自带资源文件的相对路径列表。
 *
 * 只返回非隐藏文件，并排除 SKILL.md 本身。加载阶段提前计算这份列表，是为了让
 * SkillRegistry 拿到一个可以直接注入模型的资源清单。Opencode 和 Gemini CLI
 * 通常在技能激活时做类似扫描；tegent 的注册表在会话内会被冻结，所以这里把文件
 * 列表缓存进 SkillDefinition，后续通过 `/skill refresh` 重建即可。
 *
 * @param skillDir 技能目录的绝对路径。
 * @returns 按字母序排序后的技能资源相对路径列表，路径分隔符统一为 `/`。
 */
async function listSkillFiles(skillDir: string): Promise<string[]> {
  const out: string[] = []

  async function walk(currentDir: string): Promise<void> {
    if (out.length >= MAX_LISTED_FILES) return

    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (out.length >= MAX_LISTED_FILES) return
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (SKILL_FILE_LIST_SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(currentDir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const fullPath = path.join(currentDir, entry.name)
      // 注入模型时需要跨平台稳定路径，所以把 Windows 的 `\` 统一成 `/`。
      const rel = path.relative(skillDir, fullPath).split(path.sep).join('/')
      if (rel === SKILL_FILENAME) continue
      out.push(rel)
    }
  }

  await walk(skillDir)
  return out.sort()
}

/**
 * 解析 SKILL.md 顶部的最小 YAML frontmatter。
 *
 * 这里复用子代理加载器使用的简化规则：只支持字符串标量，不引入 gray-matter 之类的
 * 额外依赖。这样可以让技能加载保持轻量，也避免 YAML 完整语法带来的复杂边界。
 *
 * @param raw SKILL.md 文件的完整原始文本。
 * @returns 解析成功时返回 frontmatter 数据和正文；没有合法 frontmatter 时返回 null。
 */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]!
  const body = match[2]!
  const data: Record<string, unknown> = {}

  // 折叠 YAML 续行：非空缩进行会拼接到上一行后面，中间用一个空格连接。
  // 这能兼容 SKILL.md 中很常见的写法：长 `description:` 用 2 个空格缩进换行。
  const foldedLines: string[] = []
  for (const line of yamlBlock.split(/\r?\n/)) {
    if (/^\s/.test(line) && line.trim() && foldedLines.length > 0) {
      foldedLines[foldedLines.length - 1] += ' ' + line.trim()
    } else {
      foldedLines.push(line)
    }
  }

  for (const line of foldedLines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx < 1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    let value: string = trimmed.slice(colonIdx + 1).trim()

    // 去掉最外层成对引号，只处理最简单的字符串场景。
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    data[key] = value
  }

  return { data, body }
}

/**
 * 从指定目录加载全部技能。
 *
 * 目录结构要求是 `dir/<skill-name>/SKILL.md`。单个技能解析失败时只跳过该技能，
 * 不会中断其他技能加载，这样一个坏文件不会拖垮整个 CLI。
 *
 * @param dir 要扫描的技能根目录。
 * @param source 技能来源，用于 UI 展示和后续优先级判断。
 * @param pluginId 插件贡献技能时携带的插件 ID；普通用户/项目技能没有该值。
 * @returns 从该目录成功加载出来的技能定义列表。
 */
async function loadSkillsFromDir(
  dir: string,
  source: SkillDefinition['source'],
  pluginId?: string,
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return skills
  }

  for (const entry of entries) {
    const skillDir = path.join(dir, entry)
    const skillFile = path.join(skillDir, SKILL_FILENAME)

    try {
      await fs.access(skillFile)
    } catch {
      continue
    }

    try {
      const raw = await fs.readFile(skillFile, 'utf-8')
      const parsed = parseFrontmatter(raw)
      if (!parsed) {
        console.error(`[skills] Skipping ${skillFile}: no valid YAML frontmatter`)
        continue
      }

      const result = frontmatterSchema.safeParse(parsed.data)
      if (!result.success) {
        console.error(
          `[skills] Skipping ${skillFile}: invalid frontmatter — ${result.error.issues.map((i) => i.message).join(', ')}`,
        )
        continue
      }

      const files = await listSkillFiles(skillDir)

      skills.push({
        name: result.data.name,
        description: result.data.description,
        content: parsed.body.trim(),
        source,
        dir: skillDir,
        files,
        ...(pluginId ? { pluginId } : {}),
      })
    } catch (err) {
      console.error(`[skills] Skipping ${skillFile}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return skills
}

export interface LoadSkillsOptions {
  /**
   * 除内置用户级和项目级路径外，需要额外扫描的技能目录。
   *
   * 插件系统会通过这里把插件贡献的 `skills/` 目录合并进同一个注册表，相关入口见
   * packages/core/src/plugins/integration.ts。
   *
   * 顺序很重要：同名技能由后扫描者覆盖。插件技能会早于项目技能扫描，所以项目作者
   * 可以用项目级技能覆盖插件提供的同名技能。
   */
  extraDirs?: ReadonlyArray<{ dir: string; pluginId: string }>
}

/**
 * 加载当前会话可用的全部技能。
 *
 * 默认会按“用户级技能 → 插件技能 → 项目级技能”的顺序加载，最终注册表里同名技能由
 * 后面的来源覆盖。测试环境可以通过 `XC_SKILLS_DIR` 覆盖内置路径；额外目录仍然会被
 * 加载，以便测试插件技能的合并逻辑。
 *
 * @param opts 技能加载选项，主要用于传入插件贡献的额外技能目录。
 * @returns 当前进程工作目录下可用的技能定义列表。
 */
export async function loadSkills(opts: LoadSkillsOptions = {}): Promise<SkillDefinition[]> {
  const override = process.env.XC_SKILLS_DIR
  if (override) {
    // 测试专用覆盖路径：把 override 当作项目级技能目录，仍然追加 extras。
    const overrideSkills = await loadSkillsFromDir(override, 'project')
    return [...overrideSkills, ...(await loadFromExtras(opts.extraDirs))]
  }

  const userDir = path.join(USER_TEGENT_DIR, 'skills')
  const projectDir = path.join(process.cwd(), TEGENT_DIR, 'skills')

  const userSkills = await loadSkillsFromDir(userDir, 'user')
  const pluginSkills = await loadFromExtras(opts.extraDirs)
  const projectSkills = await loadSkillsFromDir(projectDir, 'project')

  // 合并顺序：注册表采用“后者覆盖前者”。因此最终优先级是项目级 > 插件级 > 用户级。
  // 这和对用户说明的规则一致：项目级技能永远可以覆盖插件提供的同名技能。
  return [...userSkills, ...pluginSkills, ...projectSkills]
}

/**
 * 加载插件系统传入的额外技能目录。
 *
 * 插件技能物理上位于用户目录下的插件缓存中，但仍通过 pluginId 保留真实来源，
 * 这样 UI 和调试信息可以区分普通用户技能与插件贡献技能。
 *
 * @param extras 插件贡献的额外技能目录列表。
 * @returns 从这些额外目录中加载出的技能定义列表。
 */
async function loadFromExtras(extras: LoadSkillsOptions['extraDirs']): Promise<SkillDefinition[]> {
  if (!extras || extras.length === 0) return []
  const out: SkillDefinition[] = []
  for (const { dir, pluginId } of extras) {
    // 插件技能实际位于 ~/.tegent/plugins/cache/... 这样的用户级缓存目录。
    // 因为它不是项目私有资源，所以 source 使用最接近的 'user'；真实插件来源由 pluginId 表达。
    out.push(...(await loadSkillsFromDir(dir, 'user', pluginId)))
  }
  return out
}
