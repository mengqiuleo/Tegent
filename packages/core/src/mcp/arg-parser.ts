// slash command 只会给我们一整段原始字符串（也就是 `/mcp <sub>` 后面的部分），这里要把它转换成结构化的 McpServerConfig。
// 我们支持的引号规则：
//   - 双引号和单引号会保留其中的空白；
//   - 反斜杠只转义空白、引号字符和反斜杠自身：
//     `\ ` 表示字面空格，`\"` 表示字面双引号，`\\` 表示字面反斜杠；
//     其他字符前面的反斜杠会原样保留。
//     这一点对 Windows 很重要，因为用户常会贴出 `D:\res\tegent-cli\tmp`
//     这类路径；如果按完整 POSIX 规则吃掉反斜杠，就会悄悄把路径改坏。
//   - 其他情况下一律按空白切 token

import type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig } from './types.js'

export type ConfigScope = 'user' | 'project'

export interface AddCommand {
  kind: 'add'
  name: string
  scope: ConfigScope
  config: McpServerConfig
}

export interface AddJsonCommand {
  kind: 'add-json'
  name: string
  scope: ConfigScope
  config: McpServerConfig
}

export interface RemoveCommand {
  kind: 'remove'
  name: string
  /** 用户没有传 `--scope` 时为 undefined，由调用方自动检测。 */
  scope?: ConfigScope
}

export type ParsedCommand = AddCommand | AddJsonCommand | RemoveCommand

export type ParseResult<T extends ParsedCommand = ParsedCommand> =
  | { ok: true; command: T }
  | { ok: false; error: string }

/**
 * 允许出现在 `mcpServers.<name>` 里的名称。
 *
 * 这里比运行时 name-mangling 的清洗规则更严格，因为“配置入口”本身
 * 就是拒绝奇怪名字的更好位置。比起用户输入 `my server!` 后，
 * 保存时被悄悄改成 `my_server___xxx`，直接告诉用户“不合法”更清楚。
 * 长度 32 也给 `{server}__{tool}` 形式留出了充足空间，避免碰到
 * 模型侧 64 字符工具名上限。
 */
const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/

// ── 顶层入口 ────────────────────────────────────────────────────────────

/**
 * 解析 `/mcp add [...flags] <name> <command-or-url> [args...]`。
 *
 * 输入里有两类东西：
 *   - flag（选项）：以 `-` 开头的参数，描述“怎么配置/存到哪”，
 *     如 --scope、--env、--header、--timeout、--http。只能出现在 name 之前。
 *   - 位置参数：按出现顺序解释，共三种角色：
 *       name    = 服务器名，写入配置后成为 mcpServers.<name> 的键，与进程启动无关；
 *       command = stdio 模式下要启动的程序（如 npx）；HTTP 模式下这个位置是 url；
 *       args    = command 后面的所有 token，原样作为程序的命令行参数。
 *
 * 两种用法，对应 MCP 的两种传输方式：
 *
 *   stdio（本地子进程，默认）：
 *     /mcp add [--scope ...] [--env K=V]... [--timeout N] <name> <command> [args...]
 *     例：/mcp add fs npx -y @modelcontextprotocol/server-filesystem /tmp
 *       → name='fs', command='npx', args=['-y','@modelcontextprotocol/server-filesystem','/tmp']
 *       → 运行效果等价于在终端执行 `npx -y @modelcontextprotocol/server-filesystem /tmp`
 *
 *   HTTP（远程服务）：
 *     /mcp add --http [--scope ...] [--header "K: V"]... [--timeout N] <name> <url>
 *     例：/mcp add --http api https://example.com/mcp
 *
 * @param rawArg `add` 子命令后面的原始参数串。
 * @returns 解析成功则返回 add 命令；失败则返回错误消息。
 */
export function parseAdd(rawArg: string): ParseResult<AddCommand> {
  // 第 0 步：把原始字符串切成 token 数组（引号内的空白不会被切开）。
  // 例：'--env K=V fs npx -y @pkg/foo' → ['--env','K=V','fs','npx','-y','@pkg/foo']
  const tokRes = tokenize(rawArg)
  if (!tokRes.ok) return tokRes
  const tokens = tokRes.tokens

  // 第一轮：先把前面的 flag 解析出来。
  // 遇到第一个非 flag token 就停下，它会变成服务器名；
  // `--` 会硬停止 flag 解析，然后被丢掉，后面的内容全部按位置参数处理。
  // 必须在 name 处停下的原因：`npx -y ...` 里的 `-y` 是给 npx 的参数，
  // 不是我们的 flag；提前停才能让它原样进入 args。
  let isHttp = false // 走哪种传输：true=HTTP 远程服务器；false=stdio 本地子进程（默认）
  let scope: ConfigScope = 'user' // 配置写到哪里：'user'=用户级全局配置，'project'=当前项目配置
  let timeout: number | undefined // --timeout 传入的超时毫秒数；没传就保持 undefined，不写进 config
  const envEntries: Array<[string, string]> = [] // 收集所有 --env K=V，最后合成 config.env（仅 stdio 合法）
  const headerEntries: Array<[string, string]> = [] // 收集所有 --header "K: V"，最后合成 config.headers（仅 HTTP 合法）

  let i = 0 // 游标：当前读到的 token 下标；循环结束时正好指向第一个位置参数（name）
  let sawDoubleDash = false // 是否遇到过 `--`（仅作记录，下面用 void 显式忽略）
  while (i < tokens.length) {
    const t = tokens[i]!
    if (!t.startsWith('-')) break // 第一个位置参数
    if (t === '--') {
      sawDoubleDash = true
      i++
      break
    }
    if (t === '--http' || t === '--transport') {
      // `--http` 是我们的简写；`--transport <name>` 是 Claude/Gemini 的语法。
      // 这里只接受 http；设计上刻意不支持 sse，MCP 规范也已在 2025-03
      // 弃用 SSE。
      if (t === '--transport') {
        const next = tokens[i + 1]
        if (next !== 'http') {
          return err(
            `--transport only supports "http" (got ${next ?? '(missing)'}); use --http directly or omit for stdio`,
          )
        }
        i += 2
      } else {
        i++
      }
      isHttp = true
      continue
    }
    if (t === '--scope') {
      const v = tokens[i + 1]
      if (v !== 'user' && v !== 'project') {
        return err(`--scope requires "user" or "project" (got ${v ?? '(missing)'})`)
      }
      scope = v
      i += 2
      continue
    }
    if (t === '--env') {
      const v = tokens[i + 1]
      if (typeof v !== 'string') return err('--env requires a KEY=VALUE argument')
      const eq = v.indexOf('=')
      if (eq <= 0) return err(`--env expects KEY=VALUE (got ${v})`)
      envEntries.push([v.slice(0, eq), v.slice(eq + 1)])
      i += 2
      continue
    }
    if (t === '--header') {
      const v = tokens[i + 1]
      if (typeof v !== 'string') return err('--header requires a "Key: value" argument')
      // Header 格式按 "Key: Value"解析。
      const colon = v.indexOf(':')
      if (colon <= 0) return err(`--header expects "Key: Value" (got ${v})`)
      headerEntries.push([v.slice(0, colon).trim(), v.slice(colon + 1).trim()])
      i += 2
      continue
    }
    if (t === '--timeout') {
      const v = tokens[i + 1]
      if (typeof v !== 'string') return err('--timeout requires a number (ms)')
      const n = Number(v)
      if (!Number.isInteger(n) || n <= 0) return err(`--timeout requires a positive integer (got ${v})`)
      timeout = n
      i += 2
      continue
    }
    return err(`Unknown flag: ${t}`)
  }

  // 位置参数处理。
  // 经过可选的 `--` 之后，剩下的就是 name + command/url + 其余参数。
  // stdio：tokens[i] 是 name，tokens[i+1] 是 command，tokens[i+2..] 是 args。
  // HTTP：tokens[i] 是 name，tokens[i+1] 是 url，后面不允许再有内容。
  //
  // 有些用户会带着 Claude Code 的肌肉记忆写成 `add <name> -- <cmd>`，
  // 也就是把分隔符放在 name 后面。上面的 flag 循环已经会在第一个非 flag
  // 处停下，所以这里如果看到 `--`，就把它当成纯装饰直接丢掉。
  // 第二轮：flag 之后的剩余 token，按“位置”而不是“名字”解释：
  //   positional[0] = name，positional[1] = command（stdio）或 url（http），positional[2..] = args
  let positional = tokens.slice(i)
  if (positional[1] === '--') {
    positional = [positional[0]!, ...positional.slice(2)]
  }
  if (positional.length < 2) {
    return err(
      isHttp
        ? 'Usage: /mcp add --http [--scope user|project] [--header "K: V"]... [--timeout N] <name> <url>'
        : 'Usage: /mcp add [--scope user|project] [--env K=V]... [--timeout N] <name> <command> [args...]',
    )
  }
  // name：服务器名。它只是配置里的一个“键”，不参与进程启动；
  // 写入配置后就是 mcpServers.<name>，用户以后通过它引用这台服务器。
  const name = positional[0]!
  if (!NAME_RE.test(name)) {
    return err(`Invalid server name "${name}". Must match ${NAME_RE.source}.`)
  }

  // 加了 --http 时，第二个位置参数是 url 而不是 command，后面不许再有任何参数，解析后直接 return
  if (isHttp) {
    if (positional.length > 2) {
      return err('HTTP servers take only <name> <url> — no extra positional args')
    }
    if (envEntries.length > 0) return err('--env is only valid for stdio servers')
    const url = positional[1]! // 远程 MCP 服务器的 http(s) 地址；HTTP 模式下没有 command/args
    if (!isValidUrl(url)) return err(`Invalid URL: ${url}`)
    // HTTP 服务器的最终配置：一个 URL + 可选的请求头/超时。
    const config: McpHttpServerConfig = {
      url,
      ...(headerEntries.length > 0 ? { headers: Object.fromEntries(headerEntries) } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    }
    return ok({ kind: 'add', name, scope, config })
  }

  // stdio 分支。`--` 允许出现，但不是必须。
  // 有人会写 `/mcp add fs npx -y @pkg/foo /tmp`，也有人会写
  // `/mcp add fs -- npx -y ...`，这两种写法在这里会被解析成同一结果，
  // 因为上面已经把 `--` 去掉了。
  void sawDoubleDash
  if (headerEntries.length > 0) return err('--header is only valid for HTTP servers (--http)')
  // command：实际要启动的可执行程序，如 'npx' / 'node' / 'python'。
  // args：它后面的所有 token，原样作为程序的命令行参数。
  // 例：`add fs npx -y @pkg/foo /tmp`
  //   → command = 'npx'，args = ['-y', '@pkg/foo', '/tmp']
  //   → 运行效果等价于 spawn('npx', ['-y', '@pkg/foo', '/tmp'])
  const command = positional[1]!
  const args = positional.slice(2)
  // stdio 服务器的最终配置：子进程启动后通过 stdin/stdout 与我们通信。
  const config: McpStdioServerConfig = {
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(envEntries.length > 0 ? { env: Object.fromEntries(envEntries) } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  }
  return ok({ kind: 'add', name, scope, config })
}

/**
 * 解析 `/mcp add-json [--scope ...] <name> '<json>'`。
 *
 * JSON 内容只要符合 schema 就行；loader 侧会做同样的校验，
 * 所以这里直接复用相同的验证逻辑，能保证“通过 CLI 写入”和
 * “手工编辑文件”两种路径报出一致的错误。
 */
export function parseAddJson(rawArg: string): ParseResult<AddJsonCommand> {
  // add-json 的特殊点在于：JSON 字面量最好原样保留，
  // 不要再丢给 shell tokenizer，否则嵌套引号很容易被弄坏。
  // 所以策略是：先只对前缀里的 flag + name 做 tokenize，
  // 然后把后面的 JSON 作为原样后缀拿出来。

  const trimmed = rawArg.trim()
  if (!trimmed) {
    return err("Usage: /mcp add-json [--scope user|project] <name> '<json>'")
  }

  // 一直扫 token，直到 flags/name 处理完或者遇到以 `{` 开头的 token。
  // JSON 可能是以单引号包着输入到 slash command 的；那样 tokenizer
  // 会把引号去掉，我们拿到的是干净的对象字符串。没加引号时，
  // JSON 本来也不该包含复杂空白结构，一个 token 通常也够用。
  const tokRes = tokenize(trimmed)
  if (!tokRes.ok) return tokRes
  const tokens = tokRes.tokens

  let scope: ConfigScope = 'user'
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === '--scope') {
      const v = tokens[i + 1]
      if (v !== 'user' && v !== 'project') {
        return err(`--scope requires "user" or "project" (got ${v ?? '(missing)'})`)
      }
      scope = v
      i += 2
      continue
    }
    if (!t.startsWith('-')) break
    return err(`Unknown flag for add-json: ${t}`)
  }

  if (i >= tokens.length) {
    return err("Usage: /mcp add-json [--scope user|project] <name> '<json>'")
  }
  const name = tokens[i]!
  if (!NAME_RE.test(name)) {
    return err(`Invalid server name "${name}". Must match ${NAME_RE.source}.`)
  }
  i++

  // 如果用户没给 JSON 加引号，它可能会被拆成多个 token。
  // 这里用单个空格把剩余部分拼回去；JSON 解析对 token 间空白是宽容的，
  // 实际上可以正常 round-trip。
  if (i >= tokens.length) {
    return err(`Missing JSON body for "${name}". Wrap it in single quotes: '{...}'`)
  }
  const jsonBlob = tokens.slice(i).join(' ').trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonBlob)
  } catch (e) {
    return err(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 这里使用和 loader 相同的 zod schema 语义，但为了避免在这里引入
  // writer 层而形成循环依赖，只返回“需要后续校验”的已解析对象，
  // 由调用方再去真正验证。config-writer.ts 在写入前会做这一步。
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err('JSON body must be an object')
  }
  return ok({ kind: 'add-json', name, scope, config: parsed as McpServerConfig })
}

/**
 * 解析 `/mcp remove [--scope ...] <name>`。
 */
export function parseRemove(rawArg: string): ParseResult<RemoveCommand> {
  const tokRes = tokenize(rawArg)
  if (!tokRes.ok) return tokRes
  const tokens = tokRes.tokens
  if (tokens.length === 0) {
    return err('Usage: /mcp remove [--scope user|project] <name>')
  }

  let scope: ConfigScope | undefined
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === '--scope') {
      const v = tokens[i + 1]
      if (v !== 'user' && v !== 'project') {
        return err(`--scope requires "user" or "project" (got ${v ?? '(missing)'})`)
      }
      scope = v
      i += 2
      continue
    }
    if (!t.startsWith('-')) break
    return err(`Unknown flag for remove: ${t}`)
  }

  if (i >= tokens.length) {
    return err('Usage: /mcp remove [--scope user|project] <name>')
  }
  if (i + 1 < tokens.length) {
    return err(`/mcp remove takes exactly one name (got extra: ${tokens.slice(i + 1).join(' ')})`)
  }
  const name = tokens[i]!
  if (!NAME_RE.test(name)) {
    return err(`Invalid server name "${name}". Must match ${NAME_RE.source}.`)
  }
  return ok({ kind: 'remove', name, scope })
}



function ok<T extends ParsedCommand>(command: T): ParseResult<T> {
  return { ok: true, command }
}
function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message }
}

/**
 * 一个最小化的 POSIX 风格 tokenizer。
 *
 * 支持 `"` / `'` 引号，以及对任意单字符的反斜杠转义。
 * 输出会去掉引号，转义则去掉反斜杠。返回带标签的结果，
 * 这样调用方可以把“引号没闭合”作为普通错误消息展示，而不需要抛异常。
 */
export function tokenize(input: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const tokens: string[] = []
  let i = 0
  const n = input.length

  while (i < n) {
    // 跳过 token 之间的空白。
    while (i < n && /\s/.test(input[i]!)) i++
    if (i >= n) break

    let token = ''
    let quote: '"' | "'" | null = null
    let inToken = true

    while (i < n && inToken) {
      const c = input[i]!
      if (quote) {
        if (c === '\\' && quote === '"' && i + 1 < n) {
          // 双引号内部允许用反斜杠转义 " 和 \。
          const next = input[i + 1]!
          if (next === '"' || next === '\\') {
            token += next
            i += 2
            continue
          }
          // 其他字符前的反斜杠保留字面值，符合 POSIX 的习惯。
          token += c
          i++
          continue
        }
        if (c === quote) {
          quote = null
          i++
          continue
        }
        token += c
        i++
        continue
      }
      // 未加引号的普通状态。
      if (c === '"' || c === "'") {
        quote = c
        i++
        continue
      }
      if (c === '\\' && i + 1 < n) {
        // 这里只转义空白、引号和反斜杠本身。
        // 其他字符前的反斜杠必须原样保留，这样 Windows 路径
        // 例如 `D:\res\tegent-cli\tmp` 才不会被悄悄改坏；
        // 吃掉这些反斜杠会把错误延迟到 MCP 服务器访问目录时才暴露。
        const next = input[i + 1]!
        if (next === ' ' || next === '\t' || next === '"' || next === "'" || next === '\\') {
          token += next
          i += 2
          continue
        }
        // 反斜杠后面跟其他字符时，两个字符都保留为字面值。
        token += c
        i++
        continue
      }
      if (/\s/.test(c)) {
        inToken = false
        break
      }
      token += c
      i++
    }
    if (quote) {
      return { ok: false, error: `Unclosed ${quote} quote` }
    }
    tokens.push(token)
  }
  return { ok: true, tokens }
}

/**
 * 判断字符串是否为合法 HTTP(S) URL。
 *
 * @param s 待检查字符串。
 * @returns 仅接受 http: 和 https:。
 */
function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
