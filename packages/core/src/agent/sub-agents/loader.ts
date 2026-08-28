// 扫描以下位置的 *.md 文件，加载带 YAML frontmatter 的用户自定义子代理：
//   - ~/.tegent/agents/*.md
//   - <repo-root>/.tegent/agents/*.md
//
// 坏文件只会被跳过并向 stderr 打 warning。
// 一个写坏的 agent 文件绝不能让整个 CLI 崩掉。
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { USER_TEGENT_DIR, TEGENT_DIR } from '../../utils.js'
import type { SubAgentDefinition } from './types.js'

// frontmatter 的 schema。这里先做结构校验，再把 markdown body 作为 prompt 合并进定义。
const frontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  shellRestrictions: z.array(z.string()).optional(),
})

/** 最小 YAML frontmatter parser。
 *
 * 只支持我们需要的子集：
 * - string scalar
 * - number scalar
 * - inline/flow array，例如 `[readFile, grep]`
 *
 * 没有引入 gray-matter 依赖，是为了保持安装体积和依赖面更小。
 * 这不是完整 YAML parser；如果未来需要 block array、多行复杂对象等语法，
 * 再考虑引入标准 parser。 */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]!
  const body = match[2]!
  const data: Record<string, unknown> = {}

  // 折叠 YAML continuation line：
  // 缩进的非空行会拼到上一行后面，中间加一个空格。
  // 这覆盖 agent frontmatter 中常见的长 description 写法。
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
    let value: string | number | string[] = trimmed.slice(colonIdx + 1).trim()

    // inline array: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1)
      data[key] = inner
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
      continue
    }

    // 去掉成对引号。
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    // number scalar。
    if (/^\d+$/.test(value)) {
      data[key] = parseInt(value, 10)
      continue
    }

    data[key] = value
  }

  return { data, body }
}

async function loadAgentsFromDir(
  dir: string,
  source: SubAgentDefinition['source'],
  pluginId?: string,
): Promise<SubAgentDefinition[]> {
  const agents: SubAgentDefinition[] = []

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    // 目录不存在或不可读时视为空目录。自定义 agent 是可选能力，不能阻断启动。
    return agents
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const filePath = path.join(dir, entry)

    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = parseFrontmatter(raw)
      if (!parsed) {
        console.error(`[sub-agents] Skipping ${filePath}: no valid YAML frontmatter`)
        continue
      }

      const result = frontmatterSchema.safeParse(parsed.data)
      if (!result.success) {
        console.error(
          `[sub-agents] Skipping ${filePath}: invalid frontmatter — ${result.error.issues.map((i) => i.message).join(', ')}`,
        )
        continue
      }

      const fm = result.data
      agents.push({
        name: fm.name,
        description: fm.description,
        prompt: parsed.body.trim(),
        tools: fm.tools,
        disallowedTools: fm.disallowedTools,
        model: fm.model,
        maxTurns: fm.maxTurns ?? 30,
        shellRestrictions: fm.shellRestrictions,
        source,
        ...(pluginId ? { pluginId } : {}),
      })
    } catch (err) {
      console.error(`[sub-agents] Skipping ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return agents
}

export interface LoadCustomAgentsOptions {
  /** 额外要扫描的子代理目录，以及拥有这些目录的插件 id。
   *  插件贡献如何转换成这个形状，见 packages/core/src/plugins/integration.ts。 */
  extraDirs?: ReadonlyArray<{ dir: string; pluginId: string }>
}

/** 从用户级目录、项目级目录，以及插件贡献目录加载自定义子代理。
 *
 * 测试时可以用环境变量 `XC_AGENTS_DIR` 覆盖内置路径；
 * 覆盖只影响用户/项目默认目录，插件 extraDirs 仍会照常加载。 */
export async function loadCustomAgents(opts: LoadCustomAgentsOptions = {}): Promise<SubAgentDefinition[]> {
  const override = process.env.XC_AGENTS_DIR
  if (override) {
    const overrideAgents = await loadAgentsFromDir(override, 'project')
    return [...overrideAgents, ...(await loadAgentsFromExtras(opts.extraDirs))]
  }

  const userDir = path.join(USER_TEGENT_DIR, 'agents')
  const projectDir = path.join(process.cwd(), TEGENT_DIR, 'agents')

  const userAgents = await loadAgentsFromDir(userDir, 'user')
  const pluginAgents = await loadAgentsFromExtras(opts.extraDirs)
  const projectAgents = await loadAgentsFromDir(projectDir, 'project')

  // 加载顺序：user -> plugin -> project。
  // SubAgentRegistry 内部用 Map.set 保存，同名会被后面的覆盖，
  // 所以最终优先级与 skills 一致：project 覆盖 plugin，plugin 覆盖 user。
  return [...userAgents, ...pluginAgents, ...projectAgents]
}

async function loadAgentsFromExtras(extras: LoadCustomAgentsOptions['extraDirs']): Promise<SubAgentDefinition[]> {
  if (!extras || extras.length === 0) return []
  const out: SubAgentDefinition[] = []
  for (const { dir, pluginId } of extras) {
    // 插件贡献目前归入 user source：它不是项目内定义，也不是内置定义。
    // pluginId 会额外保留，供展示、刷新和归属追踪使用。
    out.push(...(await loadAgentsFromDir(dir, 'user', pluginId)))
  }
  return out
}
