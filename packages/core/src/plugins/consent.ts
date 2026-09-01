import fs from 'node:fs/promises'
import path from 'node:path'

import { parseHookConfig } from '../hooks/config-schema.js'
import type { HookEventName } from '../hooks/types.js'
import { parseServersBlock } from '../mcp/config-schema.js'
import { extractMcpServersBlock } from './integration.js'
import type { PluginManifest, PluginSource } from './types.js'

export interface ConsentPreview {
  pluginId: string
  version: string
  description?: string
  source: PluginSource
  marketplace: string
  /** 安装来源 marketplace 条目标记为 `verified` 时为 true。 */
  verified: boolean
  /** marketplace 名称命中 `RESERVED_MARKETPLACE_NAMES` 中的保留名称时为 true。 */
  fromReservedMarketplace: boolean
  /** 插件注册的 hook 事件名列表；空数组表示没有 hook。 */
  hookEvents: HookEventName[]
  /**
   * 以内联形式贡献的 MCP server 名称。
   *
   * path 形式在授权阶段不一定展开，因为那需要额外读取文件；此时只通过布尔标记
   * 提醒用户插件确实带有 MCP server。
   */
  inlineMcpServerNames: string[]
  hasSkillsDir: boolean
  hasAgentsDir: boolean
  hasCommandsDir: boolean
  /**
   * manifest 以文件路径形式声明 `mcpServers` 时为 true。
   *
   * 授权时我们可能还不知道具体 server 名称，但可以明确警告用户：这个插件确实
   * 会带来 MCP server 能力。
   */
  hasPathMcpServers: boolean
  /** hooks 以路径形式声明而不是内联声明时为 true。 */
  hasPathHooks: boolean
  author?: string
  license?: string
  homepage?: string
}

/**
 * 插件根目录的文件系统探测信息。
 *
 * 这些信息是只看 manifest 看不到的内容，由 {@link probePluginRoot} 填充，并传给
 * {@link buildConsentPreview}。这样安装时的 “Will contribute” 文案才能包含
 * 自动发现的贡献项，例如 Claude Code 插件常把 `.mcp.json` 放在 plugin.json
 * 旁边，而不是在 manifest 里声明 `mcpServers`。
 */
export interface RootProbe {
  hasSkillsDir: boolean
  hasAgentsDir: boolean
  hasCommandsDir: boolean
  /**
   * 从根目录 `.mcp.json` / `mcp.json` 解析出的 server 名称。
   *
   * flat 和 wrapped 两种形状都接受，具体见 {@link extractMcpServersBlock}。
   * 没有文件或文件解析失败时为空数组。
   */
  rootMcpServerNames: string[]
  /**
   * 根目录存在 mcp 文件时为 true，即使暂时解析不出名称。
   *
   * 这样 consent UI 仍能警告“此插件贡献 MCP servers”，避免因为名字未知而漏报。
   */
  hasRootMcpFile: boolean
  /** 从根目录 `hooks/hooks.json` 中解析出的 hook 事件名。 */
  rootHookEvents: HookEventName[]
  /** 只要 `hooks/hooks.json` 存在就为 true，不受解析结果影响。 */
  hasRootHooksFile: boolean
}

export interface BuildPreviewInput {
  pluginId: string
  manifest: PluginManifest
  source: PluginSource
  marketplace: string
  verified?: boolean
  fromReservedMarketplace?: boolean
  /**
   * 可选的插件根目录探测结果。
   *
   * 没有它时，授权预览只能展示 manifest 显式声明的内容，会漏掉 Claude Code
   * 约定式插件放在 `plugin.json` 旁边的常规文件或目录贡献。
   */
  rootProbe?: RootProbe
}

/**
 * 探测插件根目录中符合约定的贡献文件和目录。
 *
 * loader 的 `resolveContributions` 运行时会识别 `skills/`、`.mcp.json` 等
 * 约定位置，因此 consent UI 也必须提前知道这些内容，避免 “Will contribute”
 * 预览低估插件能力。这个函数可以安全地对任意目录调用：每个探测都是 best-effort
 * stat / read，文件缺失或不可读都会被当作“不存在”处理。
 *
 * @param rootDir 插件根目录。
 * @returns 根目录中可被约定发现的贡献项摘要。
 */
export async function probePluginRoot(rootDir: string): Promise<RootProbe> {
  const [hasSkillsDir, hasAgentsDir, hasCommandsDir] = await Promise.all([
    isDir(path.join(rootDir, 'skills')),
    isDir(path.join(rootDir, 'agents')),
    isDir(path.join(rootDir, 'commands')),
  ])

  let rootMcpServerNames: string[] = []
  let hasRootMcpFile = false
  for (const conv of ['.mcp.json', 'mcp.json']) {
    const p = path.join(rootDir, conv)
    if (!(await isFile(p))) continue
    hasRootMcpFile = true
    try {
      const raw = await fs.readFile(p, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      const block = extractMcpServersBlock(parsed)
      const { servers } = parseServersBlock(block)
      rootMcpServerNames = Object.keys(servers)
    } catch {

    }
    break
  }

  let rootHookEvents: HookEventName[] = []
  let hasRootHooksFile = false
  const hooksPath = path.join(rootDir, 'hooks', 'hooks.json')
  if (await isFile(hooksPath)) {
    hasRootHooksFile = true
    try {
      const raw = await fs.readFile(hooksPath, 'utf-8')
      const parsed = JSON.parse(raw)
      const cfg = parseHookConfig(parsed, rootDir)
      rootHookEvents = Object.keys(cfg) as HookEventName[]
    } catch {

    }
  }

  return {
    hasSkillsDir,
    hasAgentsDir,
    hasCommandsDir,
    rootMcpServerNames,
    hasRootMcpFile,
    rootHookEvents,
    hasRootHooksFile,
  }
}

/**
 * 判断路径是否是目录。
 *
 * @param p 待检查路径。
 * @returns 存在且是目录时为 true，否则为 false。
 */
async function isDir(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

/**
 * 判断路径是否是普通文件。
 *
 * @param p 待检查路径。
 * @returns 存在且是文件时为 true，否则为 false。
 */
async function isFile(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isFile()
  } catch {
    return false
  }
}

/**
 * 基于已经解析过的 manifest 构建安装授权预览。
 *
 * hook 和 mcp 字段只有在内联形状下才会被展开读取名称；路径形状会转换成
 * `has*` 布尔值，让 consent UI 即使暂时不知道具体名称，也能警告用户“插件贡献
 * MCP servers / hooks”。
 *
 * 当 `input.rootProbe` 存在时，函数还会合并根目录约定式贡献，例如未在 manifest
 * 声明的 `.mcp.json`、`hooks/hooks.json`、`skills/` 等。loader 运行时会识别
 * 这些内容，所以授权预览也要提前反映它们。
 *
 * @param input 生成授权预览所需的 manifest、来源、marketplace 和根目录探测结果。
 * @returns 可交给 UI 展示的安装授权预览。
 */
export function buildConsentPreview(input: BuildPreviewInput): ConsentPreview {
  const m = input.manifest
  const probe = input.rootProbe

  let hookEvents: HookEventName[] = []
  let hasPathHooks = false
  if (m.hooks !== undefined) {
    if (typeof m.hooks === 'string') {
      hasPathHooks = true
    } else {
      try {
        const cfg = parseHookConfig(m.hooks, input.pluginId)
        hookEvents = Object.keys(cfg) as HookEventName[]
      } catch {

      }
    }
  } else if (probe?.hasRootHooksFile) {
    hookEvents = probe.rootHookEvents
    hasPathHooks = true
  }

  let inlineMcpServerNames: string[] = []
  let hasPathMcpServers = false
  if (m.mcpServers !== undefined) {
    if (typeof m.mcpServers === 'string') {
      hasPathMcpServers = true
    } else {
      const { servers } = parseServersBlock(m.mcpServers)
      inlineMcpServerNames = Object.keys(servers)
    }
  } else if (probe?.hasRootMcpFile) {
    // 插件根目录按约定发现的 `.mcp.json`，安全影响面等同于 manifest
    // 声明的 path 形式。能解析出名称就展示名称，否则至少标记文件存在。
    inlineMcpServerNames = probe.rootMcpServerNames
    hasPathMcpServers = true
  }

  return {
    pluginId: input.pluginId,
    version: m.version,
    description: m.description,
    source: input.source,
    marketplace: input.marketplace,
    verified: input.verified ?? false,
    fromReservedMarketplace: input.fromReservedMarketplace ?? false,
    hookEvents,
    inlineMcpServerNames,
    hasSkillsDir: !!m.skills || !!probe?.hasSkillsDir,
    hasAgentsDir: !!m.agents || !!probe?.hasAgentsDir,
    hasCommandsDir: !!m.commands || !!probe?.hasCommandsDir,
    hasPathMcpServers,
    hasPathHooks,
    author: m.author?.name,
    license: m.license,
    homepage: m.homepage,
  }
}
