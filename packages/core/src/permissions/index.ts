// 权限判断大致分成几层：
// 1. 静态规则：readFile/glob/grep 这类只读工具默认放行，writeFile/edit/shell 默认更谨慎。
// 2. shell 细分：shell 会继续拆命令，判断是否只读、危险、还是需要询问。
// 3. trustMode：全局信任模式，除了明确 deny，基本都放行。
// 4. acceptEdits：允许项目内普通文件编辑自动放行，但敏感路径仍要询问。
// 5. session-store：用户点过 “always” 后，后续匹配的调用自动放行。
// 6. 最后才弹权限询问，让用户决定 yes / always / no。
import path from 'node:path'

import { isDestructive, isReadOnly, splitShellCommands } from '../tools/shell-utils.js'
import type { PermissionLevel, PermissionMode } from '../types/index.js'
import { addSessionAllowRule, buildAllowRule, persistRule, sessionRulesMatch } from './session-store.js'

type PermissionInput = Record<string, unknown>

/**
 * shell 权限结果缓存。
 *
 * key 是完整命令字符串，value 是这条命令最终被分类成的 PermissionLevel。
 * shell 命令的只读/危险规则在进程生命周期内不会变，所以不需要 TTL。
 * 但长会话里模型可能生成很多不同命令，所以仍然设置一个最大容量，避免无限增长。
 */
const SHELL_PERMISSION_CACHE_MAX = 256
const shellPermissionCache = new Map<string, PermissionLevel>()

/**
 * 根据 shell 命令内容计算权限等级。
 *
 * 这个函数不处理缓存，只负责判断一条命令本身属于：
 * - deny：明确危险
 * - always-allow：只读安全
 * - ask：其它情况交给用户确认
 */
function evaluateShellPermission(command: string): PermissionLevel {
  // 先把复合命令拆成多个子命令，例如 `cd x && pnpm test` 会拆开判断。
  const subCommands = splitShellCommands(command)

  // 只要任意子命令危险，整条命令就直接 deny。
  if (subCommands.some(isDestructive)) return 'deny'

  // 所有子命令都是只读，整条命令才可以自动放行。
  if (subCommands.every(isReadOnly)) return 'always-allow'

  // 剩下的既不是明确危险，也不是纯只读，统一询问用户。
  return 'ask'
}

/**
 * 带缓存地解析 shell 命令权限。
 *
 * 同一条命令多次出现时，不需要重复跑拆分和规则匹配。
 */
function resolveShellPermission(input: PermissionInput): PermissionLevel {
  // shell 工具的参数里 command 才是真正的命令字符串。
  const cmd = (input.command as string) ?? ''

  // 缓存命中就直接返回。
  const cached = shellPermissionCache.get(cmd)
  if (cached) return cached

  // 缓存没命中，现场计算一次。
  const level = evaluateShellPermission(cmd)

  // 达到容量上限时，删除最早插入的那条记录。
  if (shellPermissionCache.size >= SHELL_PERMISSION_CACHE_MAX) {
    // Map 会保留插入顺序，所以 keys().next().value 就是最老的 key。
    const oldest = shellPermissionCache.keys().next().value
    if (oldest !== undefined) shellPermissionCache.delete(oldest)
  }

  // 写入缓存，供下一次同命令复用。
  shellPermissionCache.set(cmd, level)
  return level
}

/**
 * 每个工具的默认权限规则。
 *
 * value 是函数，是因为有些工具的权限取决于 input，例如 shell 要看具体命令。
 */
const rules: Record<string, (input: PermissionInput) => PermissionLevel> = {
  // 只读本地/网络检索类工具默认放行。
  readFile: () => 'always-allow',
  glob: () => 'always-allow',
  grep: () => 'always-allow',
  listDir: () => 'always-allow',
  webSearch: () => 'always-allow',
  webFetch: () => 'always-allow',
  askUser: () => 'always-allow',

  // 写文件和编辑文件默认询问用户。
  edit: () => 'ask',
  writeFile: () => 'ask',

  // shell 需要按具体命令进一步分类。
  shell: resolveShellPermission,
}

/**
 * 获取某次工具调用的默认权限等级。
 *
 * 未知工具保守处理，默认 ask。
 */
export function getPermissionLevel(toolName: string, input: PermissionInput): PermissionLevel {
  // 先查工具名对应的规则函数。
  const rule = rules[toolName]

  // 没配置规则的工具默认询问用户。
  if (!rule) return 'ask'

  // 调用规则函数得到权限等级。
  return rule(input)
}

// ── 写入工具的路径安全规则 ──
// 这些路径属于敏感配置或元数据路径。
// 即使 permissionMode 是 acceptEdits，也不能自动放行这些文件的写入。
const SENSITIVE_PATH_PATTERNS = [
  /[\\/]\.bashrc$/,
  /[\\/]\.bash_profile$/,
  /[\\/]\.profile$/,
  /[\\/]\.zshrc$/,
  /[\\/]\.zprofile$/,
  /[\\/]\.gitconfig$/,
  /[\\/]\.ssh[\\/]/,
  /[\\/]\.env$/,
  /[\\/]\.git[\\/]/,
  /[\\/]\.vscode[\\/]/,
  /[\\/]\.idea[\\/]/,
]

/**
 * 判断 filePath 是否位于 projectDir 内部，或者正好等于 projectDir。
 *
 * 这里会统一 resolve、转成正斜杠、小写，避免 Windows 盘符大小写、
 * 反斜杠和尾部分隔符导致误判。
 */
export function isPathWithinProject(filePath: string, projectDir: string): boolean {
  // 把路径规整成适合字符串比较的形式。
  const normalize = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase()

  // file 是目标文件绝对路径。
  const file = normalize(filePath)

  // dir 是项目根目录绝对路径。
  const dir = normalize(projectDir)

  // 文件等于项目目录，或者以 “项目目录/” 开头，就认为在项目内。
  return file === dir || file.startsWith(dir + '/')
}

/**
 * 判断路径是否命中敏感路径规则。
 */
function isSensitivePath(filePath: string): boolean {
  // 任意一个正则匹配就算敏感。
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(filePath))
}

/**
 * 检查一次工具调用是否允许执行。
 *
 * permissionMode 的含义：
 * - default：默认模式，ask 级别工具会弹权限询问。
 * - acceptEdits：项目目录内的 writeFile/edit 自动放行，但敏感路径仍要问。
 * - plan：计划模式本身主要靠系统提示约束模型；如果模型仍调用写工具，这里照常询问。
 *
 * trustMode 是全局信任开关，优先级很高；但明确 deny 的命令仍不会放行。
 */
export async function checkPermission(
  toolCall: { toolCallId: string; toolName: string; input: PermissionInput },
  trustMode: boolean,
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: PermissionInput
  }) => Promise<'yes' | 'always' | 'no'>,
  permissionMode: PermissionMode = 'default',
  cwd?: string,
): Promise<boolean> {
  // 先得到工具的默认权限等级。
  const level = getPermissionLevel(toolCall.toolName, toolCall.input)

  // 只读工具或全局信任模式直接放行。
  if (level === 'always-allow' || trustMode) return true

  // acceptEdits 只特殊处理 writeFile/edit。
  if (permissionMode === 'acceptEdits' && (toolCall.toolName === 'writeFile' || toolCall.toolName === 'edit')) {
    // 从工具参数里取目标文件路径。
    const filePath = (toolCall.input.filePath as string) ?? ''

    // 没传 cwd 时使用当前进程目录作为项目目录。
    const projectDir = cwd ?? process.cwd()

    // 目标路径必须在项目内，且不能命中敏感路径，才自动放行。
    if (filePath && isPathWithinProject(filePath, projectDir) && !isSensitivePath(filePath)) {
      return true
    }
    // 项目外路径或敏感文件不自动放行，继续走下面的询问流程。
  }

  // 用户本会话里点过 always 的规则，如果匹配也直接放行。
  if (sessionRulesMatch(toolCall.toolName, toolCall.input)) return true

  // 走到这里说明必须问用户。
  const decision = await onAskPermission(toolCall)

  // always 表示本次允许，并且保存一条后续可复用的 allow rule。
  if (decision === 'always') {
    const result = buildAllowRule(toolCall.toolName, toolCall.input)
    if (result) {
      // 复合 shell 命令可能拆出多条规则，例如 `git commit && git push`。
      // UI 显示的 label 会提示用户保存的是多条规则，这里逐条加入 session store。
      for (const rule of result.rules) {
        // 先加入内存规则，本会话立即生效。
        addSessionAllowRule(rule)

        // 如果规则允许持久化，并且有 cwd，就写入 `.tegent/local/permissions.json`。
        if (result.persist && cwd) persistRule(cwd, rule)
      }
    }
    return true
  }

  // yes 只允许本次，不保存规则；no 表示拒绝。
  return decision === 'yes'
}

// 对外重新导出权限规则相关工具，供 CLI 或测试直接使用。
export { addSessionAllowRule, clearSessionRules, buildAllowRule } from './session-store.js'
export {
  extractCommandPrefix,
  extractCompoundPrefixes,
  extractCompoundRules,
  suggestRuleLabel,
} from './session-store.js'
export { loadPersistedRules, persistRule } from './session-store.js'
