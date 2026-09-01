// 本文件负责校验 ~/.tegent/config.json 以及项目级 .tegent/config.json 中的 `mcpServers` 字段。
// 同一个模式同时覆盖 stdio 和 streamable HTTP 两种服务器；
// 通过字段是否存在来区分传输类型：有 `command` 表示 stdio，
// 有 `url` 表示 HTTP。既没有这两个字段，或者两个字段同时存在，
// 都会在启动 mcpServer 之前被拒绝。
import { z } from 'zod'

import type { McpServerConfig } from './types.js'

/**
 * 同时描述两种传输方式的宽松基础模式。
 *
 * `command` 和 `url` 的存在性是传输类型判别条件。这里使用
 * `superRefine`，而不是使用 `z.union`：当两个字段都不存在时，
 * union 只会告诉用户“输入无效”，却无法明确指出必须二选一。
 * 先用一个扁平模式收集字段类型，再在 `superRefine` 中执行跨字段
 * 约束，可以为每一种配置错误提供更容易理解的消息。
 */
const serverSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    const hasCommand = typeof v.command === 'string'
    const hasUrl = typeof v.url === 'string'
    if (hasCommand && hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mcpServers entry has both `command` and `url` — set only one',
      })
    }
    if (!hasCommand && !hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mcpServers entry must set either `command` (stdio) or `url` (http)',
      })
    }
    // 跨字段校验：禁止在 stdio 配置中使用 HTTP 专属字段，
    // 也禁止在 HTTP 配置中使用 stdio 专属字段。
    // 虽然运行时可能会忽略多余字段，但在这里报错可以尽早发现拼写错误。
    if (hasCommand && typeof v.headers !== 'undefined') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`headers` is only valid for HTTP servers' })
    }
    if (hasUrl && (v.args || v.env || v.cwd)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`args`/`env`/`cwd` are only valid for stdio servers' })
    }
  })

/** `mcpServers` 的完整对象模式：键是 mcpServer 名称，值是 mcpServer 配置。 */
export const mcpServersSchema = z.record(z.string().min(1), serverSchema)

/**
 * 校验单个 mcpServer 配置。
 *
 * @param name 配置项名称，用于把错误定位到 `mcpServers.<name>`。
 * @param raw 尚未信任的原始配置对象。
 * @returns 通过校验后的 MCP 配置。
 * @throws {Error} 配置不符合模式时抛出带服务器名称上下文的错误。
 */
export function parseServerConfig(name: string, raw: unknown): McpServerConfig {
  const result = serverSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => i.message).join('; ')
    throw new Error(`mcpServers.${name}: ${issues}`)
  }
  return result.data as McpServerConfig
}

/**
 * 校验完整的 `mcpServers` 配置块。
 *
 * 该函数采用“尽可能加载”的策略：通过校验的条目进入 `servers`，
 * 失败条目进入 `errors`。这样单个 mcpServer 配置写错时，其他 mcpServer 仍然
 * 可以继续连接，而不是让整个 CLI 启动失败。
 *
 * @param raw 配置文件中读取出的任意值, raw 是从 json 文件中读出来的 对象。
 * @returns 成功解析的 mcpServer 映射，以及每个失败条目的名称和错误消息。
 */
export function parseServersBlock(raw: unknown): {
  servers: Record<string, McpServerConfig>
  errors: Array<{ name: string; message: string }>
} {
  const servers: Record<string, McpServerConfig> = {}
  const errors: Array<{ name: string; message: string }> = []

  if (raw === undefined || raw === null) return { servers, errors }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ name: '(root)', message: 'mcpServers must be an object' })
    return { servers, errors }
  }

  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    try {
      servers[name] = parseServerConfig(name, entry)
    } catch (err) {
      errors.push({ name, message: err instanceof Error ? err.message : String(err) })
    }
  }

  return { servers, errors }
}
