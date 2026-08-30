// 支持在 MCP 服务器配置的任意字符串字段中使用两种形式：
//   ${VAR}             — 展开变量；变量未设置时抛错；
//   ${VAR:-fallback}   — 变量未设置或为空时使用字面量 fallback。
//
// 故意不支持完整 Shell 展开：不处理没有花括号的 `$VAR`、命令替换，也不处理嵌套 `${${A}}`。

/**
 * 当 `${VAR}` 引用无法解析时抛出的错误。
 *
 * loader 会捕获此错误并把对应服务器标记为 `failed`，这样其他 MCP
 * 服务器仍然可以继续启动。
 */
export class EnvExpansionError extends Error {
  constructor(public varName: string) {
    super(`Required environment variable not set: ${varName}`)
    this.name = 'EnvExpansionError'
  }
}

const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/**
 * 展开单个字符串中的所有 `${VAR}` 引用。
 *
 * 将 变量值 替换为环境变量映射中对应的值；如果变量未设置且没有 fallback，则抛出 `EnvExpansionError`。
 *
 * @param input 要展开的原始字符串。
 * @param env 用于查找变量的环境映射，默认使用当前进程环境。
 * @returns 展开后的字符串。
 * @throws {EnvExpansionError} 必需变量缺失且没有 fallback 时抛出。
 * @example "env": {
      "GITHUB_TOKEN": "${GITHUB_TOKEN}",
      "NODE_OPTIONS": "--require ./evil.js"
    } 转换后能够拿到 process.env.GITHUB_TOKEN
 */
export function expandEnvString(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(REF_RE, (match, name: string, fallback?: string) => {
    const v = env[name]
    if (v !== undefined && v !== '') return v
    if (fallback !== undefined) return fallback
    throw new EnvExpansionError(name)
  })
}

/**
 * 递归遍历配置值并展开其中的字符串。
 *
 * 数组和普通对象会继续递归；数字、布尔值和 `null` 原样保留。
 * 返回值是深拷贝，不会修改输入对象，因为输入可能直接来自缓存的
 * 配置解析结果，修改它会污染后续刷新流程。
 *
 * @param value 任意配置值。
 * @param env 用于变量查找的环境映射。
 * @returns 与输入结构相同、但字符串已展开的深拷贝。
 * @throws {EnvExpansionError} 任意嵌套字符串中的必需变量缺失时抛出。
 */
export function expandEnvDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') {
    return expandEnvString(value, env) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnvDeep(v, env)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvDeep(v, env)
    }
    return out as unknown as T
  }
  return value
}
