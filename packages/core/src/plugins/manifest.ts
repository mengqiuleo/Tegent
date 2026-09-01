import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { GEMINI_MANIFEST_REL, MANIFEST_CANDIDATES } from './paths.js'
import type { ManifestFormat, PluginManifest } from './types.js'


const authorSchema = z.union([
  z.string(),
  z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    url: z.string().optional(),
  }),
])

const userConfigItemSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean']),
  sensitive: z.boolean().optional(),
  prompt: z.string().optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().optional(),
})

/**
 * 某些贡献字段既可以是相对路径字符串，也可以是内联对象。
 *
 * Claude Code 的 `mcpServers` 和 `hooks` 就是这种形状。这里不校验内联对象
 * 的具体 schema，因为 MCP 和 hooks 子系统已经各自拥有更权威的 schema。
 */
const pathOrInline = z.union([z.string().min(1), z.record(z.string(), z.unknown())])

/**
 * 插件名称正则。
 *
 * 规则：只能包含小写字母、数字和短横线，并且必须以字母或数字开头。这个约束
 * 同时兼容 Claude Code / Codex / Gemini，也能保证名称作为 Windows 路径片段
 * 时足够安全。
 */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const manifestSchema = z.object({
  schemaVersion: z.string().optional(),
  name: z
    .string()
    .min(1)
    .regex(NAME_RE, 'name must be lowercase letters, digits, and dashes only (e.g. "linear-issues")'),
  version: z.string().min(1).optional(),
  description: z.string().optional(),
  author: authorSchema.optional(),
  keywords: z.array(z.string()).optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),

  skills: z.string().min(1).optional(),
  agents: z.string().min(1).optional(),
  commands: z.string().min(1).optional(),
  mcpServers: pathOrInline.optional(),
  hooks: pathOrInline.optional(),

  userConfig: z.array(userConfigItemSchema).optional(),
  dependencies: z.array(z.string().min(1)).optional(),
  engines: z.object({ 'tegent': z.string().optional() }).optional(),
})


export interface ManifestDiscovery {
  /** 实际命中的 manifest 文件绝对路径。 */
  manifestPath: string
  format: ManifestFormat
}

/**
 * 在插件根目录下探测 manifest 文件。
 *
 * 函数会按 `MANIFEST_CANDIDATES` 的顺序返回最高优先级命中项。如果只发现
 * Gemini manifest，则返回 `format: 'gemini'`；installer 会借此给出“暂不支持
 * Gemini 扩展”的友好错误，而不是误报“找不到 manifest”。
 *
 * @param rootDir 插件根目录。
 * @returns 命中的 manifest 信息；没有任何 manifest 时返回 `null`。
 */
export async function discoverManifest(rootDir: string): Promise<ManifestDiscovery | null> {
  for (const candidate of MANIFEST_CANDIDATES) {
    const full = path.join(rootDir, candidate.rel)
    if (await fileExists(full)) {
      return { manifestPath: full, format: candidate.format }
    }
  }
  const gemini = path.join(rootDir, GEMINI_MANIFEST_REL)
  if (await fileExists(gemini)) {
    return { manifestPath: gemini, format: 'gemini' }
  }
  return null
}


export class ManifestParseError extends Error {
  constructor(
    message: string,
    public readonly manifestPath: string,
  ) {
    super(message)
    this.name = 'ManifestParseError'
  }
}

/**
 * 读取、解析并校验一个 manifest JSON 文件。
 *
 * 当 `schemaVersion` 缺失时会补成 `"1"`，这是当前隐式默认值；多数现存
 * Claude Code 插件并不会显式写这个字段。失败时抛出 `ManifestParseError`，
 * 错误里带有 manifest 路径，方便 loader 收集成 `/plugin doctor` 条目，而不是
 * 因单个坏插件中断整个启动流程。
 *
 * @param manifestPath manifest 文件的绝对路径。
 * @returns 标准化后的插件 manifest。
 * @throws ManifestParseError 读取、JSON 解析或 schema 校验失败时抛出。
 */
export async function parseManifest(manifestPath: string): Promise<PluginManifest> {
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf-8')
  } catch (err) {
    throw new ManifestParseError(
      `failed to read manifest: ${err instanceof Error ? err.message : String(err)}`,
      manifestPath,
    )
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new ManifestParseError(
      `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      manifestPath,
    )
  }

  const result = manifestSchema.safeParse(json)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new ManifestParseError(`invalid manifest — ${issues}`, manifestPath)
  }

  const data = result.data
  return {
    ...data,
    schemaVersion: data.schemaVersion ?? '1',
    version: data.version ?? '0.0.0',
    author: typeof data.author === 'string' ? { name: data.author } : data.author,
  }
}


/**
 * 判断指定路径是否存在且当前进程可访问。
 *
 * @param p 待检测文件路径。
 * @returns 可访问时为 `true`，不存在或不可访问时为 `false`。
 */
async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
