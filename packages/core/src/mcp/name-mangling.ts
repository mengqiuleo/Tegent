// 对模型暴露 MCP 工具时使用带命名空间的名称，避免与内置工具
// （readFile、shell 等）冲突，也让模型能直接看出工具来自哪个服务器：
//
//     <server>__<tool>
//
// 服务器名和工具名都会清洗：`[A-Za-z0-9_]` 之外的连续字符替换成 `_`。
// 使用双下划线作为分隔符，是为了让原始工具名中的单下划线
// （例如 `read_file`、`list_issues`）保持可辨识。
//
// 不增加统一的 `mcp__` 前缀。虽然 Claude Code 使用
// `mcp__<server>__<tool>`，但它会为每个工具额外消耗 token，而描述中
// 已经足够表达工具来源。工具是否为 MCP 工具由 registry 查找决定，
// 不依赖名称前缀。
//
// 模型侧工具名限制为 64 个字符。过长名称会被截断，并追加 6 位内容
// 哈希，避免两个相似长名称被截断成同一个名字。
//
// 不同服务器暴露同名工具时，会给后加入的名称追加服务器名哈希后缀，
// 以消除冲突。
import { createHash } from 'node:crypto'

export const MCP_MAX_NAME_LEN = 64

function sanitize(part: string): string {
  // 将一段连续的非法字符替换成一个 `_`，并去掉首尾下划线，
  // 避免生成 `_server__tool_` 这样的名称。
  const cleaned = part.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  // 清洗后为空（例如名称全部由中文组成）时退回哈希，
  // 以便仍然得到稳定且合法的标识符。
  if (cleaned === '') {
    return shortHash(part, 6)
  }
  return cleaned
}

function shortHash(input: string, len: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len)
}

/**
 * 为一个 MCP 工具生成模型侧可调用的名称。
 *
 * @param serverName MCP 服务器原始名称。
 * @param rawToolName MCP 服务器返回的原始工具名称。
 * @param existing 当前 registry 中已经占用的名称集合。
 * @returns 清洗、限长并确保不与 `existing` 冲突的工具名称。
 *
 * 如果发生冲突，会追加服务器名称哈希，而不是工具名称哈希。
 * 这是有意为之：工具名承载模型需要理解的语义，服务器名才是用户
 * 可以用来区分来源的部分。
 */
export function buildCallableName(serverName: string, rawToolName: string, existing: ReadonlySet<string>): string {
  const s = sanitize(serverName)
  const t = sanitize(rawToolName)

  let name = `${s}__${t}`

  // 名称过长时截断，但保留内容哈希，避免不同原名被截断成同一个名称。
  if (name.length > MCP_MAX_NAME_LEN) {
    const hash = shortHash(`${serverName}::${rawToolName}`, 6)
    const room = MCP_MAX_NAME_LEN - 1 /* underscore */ - hash.length
    name = `${(s + '__' + t).slice(0, room)}_${hash}`
  }

  // 发生冲突时追加 4 位服务器名称哈希。
  // 如果在极端情况下仍冲突，就逐步增加哈希长度，直到名称唯一，
  // 同时始终受 MCP_MAX_NAME_LEN 限制。
  if (existing.has(name)) {
    for (let extra = 4; extra <= 12; extra++) {
      const suffix = '_' + shortHash(serverName, extra)
      const candidate =
        name.length + suffix.length <= MCP_MAX_NAME_LEN
          ? name + suffix
          : name.slice(0, MCP_MAX_NAME_LEN - suffix.length) + suffix
      if (!existing.has(candidate)) {
        return candidate
      }
    }
    // 理论上不应到达这里；最后追加包含当前时间的哈希作为兜底。
    return name.slice(0, MCP_MAX_NAME_LEN - 9) + '_' + shortHash(name + Date.now(), 8)
  }

  return name
}
