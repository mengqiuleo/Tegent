export type { ShellType } from './shell-provider.js'


export function splitShellCommands(cmd: string): string[] {
  const parts: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let braceDepth = 0

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    const next = cmd[i + 1]

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += ch
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += ch
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '{') {
        braceDepth++
        current += ch
      } else if (ch === '}' && braceDepth > 0) {
        braceDepth--
        current += ch
      } else if (braceDepth > 0) {
        current += ch
      } else if (ch === '|' && next === '|') {
        parts.push(current)
        current = ''
        i++ // skip next |
      } else if (ch === '&' && next === '&') {
        parts.push(current)
        current = ''
        i++ // skip next &
      } else if (ch === '|') {
        parts.push(current)
        current = ''
      } else if (ch === ';') {
        parts.push(current)
        current = ''
      } else {
        current += ch
      }
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)

  return parts.map((p) => p.trim()).filter(Boolean)
}

const READ_ONLY_COMMANDS = [
  'cd',
  'ls',
  'dir',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'echo',
  'which',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'env',
  'printenv',
  'find',
  'tree',
  'sort',
  'uniq',
  'grep',
  'cut',
  'nl',
  'basename',
  'dirname',
  'realpath',
  'Get-ChildItem',
  'Get-Location',
  'Set-Location',
  'Push-Location',
  'Pop-Location',
  'Get-Content',
  'Get-Item',
  'Get-ItemProperty',
  'Get-Date',
  'Get-Process',
  'Get-Service',
  'Get-Command',
  'Get-Help',
  'Get-Member',
  'Get-Variable',
  'Get-Alias',
  'Get-PSDrive',
  'Get-Module',
  'Get-History',
  'Get-CimInstance',
  'Select-String',
  'Select-Object',
  'Sort-Object',
  'Group-Object',
  'Where-Object',
  'ForEach-Object',
  'Measure-Object',
  'Compare-Object',
  'Tee-Object',
  'Format-Table',
  'Format-List',
  'Format-Wide',
  'Format-Custom',
  'Out-String',
  'Out-Default',
  'Out-Host',
  'Write-Output',
  'Write-Host',
  'Write-Verbose',
  'Write-Debug',
  'Write-Information',
  'ConvertTo-Json',
  'ConvertFrom-Json',
  'ConvertTo-Csv',
  'ConvertFrom-Csv',
  'ConvertTo-Xml',
  'ConvertFrom-Xml',
  'ConvertTo-Html',
  'Resolve-Path',
  'Split-Path',
  'Join-Path',
  'Convert-Path',
  'Test-Path',
]


const READ_ONLY_GIT_SUBCOMMANDS = ['status', 'log', 'diff', 'branch', 'show', 'remote', 'tag', 'stash list', 'reflog']


const READ_ONLY_REGEX = new RegExp(
  `^\\s*(${READ_ONLY_COMMANDS.join('|')}|git\\s+(${READ_ONLY_GIT_SUBCOMMANDS.join('|')}))\\b`,
  'i',
)

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // ── Filesystem destruction ──
  /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive)/,
  /\brm\s+-rf\b/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b(chmod|chown)\s+.*\//,
  />\s*\/dev\/sd/,
  /\bformat\b/,
  /\bRemove-Item\s+.*-Recurse/i,
  /\bRemove-Item\s+.*-Force/i,
  /\bdel\s+\/[sS]/,
  /\brmdir\s+\/[sS]/,

  // ── Git destructive operations ──
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+checkout\s+--\s*\./,
  /\bgit\s+rebase\b/,
  /\bgit\s+filter-branch\b/,
  /\bgit\s+reflog\s+expire\b/,
  /\bgit\s+gc\s+--prune\b/,

  // ── Remote code execution / download-and-exec ──
  /\bcurl\s.*\|\s*(ba)?sh\b/,
  /\bwget\s.*\|\s*(ba)?sh\b/,
  /\bcurl\s.*\|\s*python/,
  /\bwget\s.*\|\s*python/,

  // ── System control ──
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+[06]\b/,
  /\bsystemctl\s+(stop|disable|mask|halt|poweroff)\b/,
  /\bkillall\b/,
  /\bpkill\s+-9\b/,
  /\bStop-Computer\b/i,
  /\bRestart-Computer\b/i,

  // ── Database destruction ──
  /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDELETE\s+FROM\s+\S+\s*;?\s*$/im,

  // ── Container / infra destruction ──
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/,
  /\bkubectl\s+delete\b/,

  // ── Environment pollution ──
  /\bnpm\s+publish\b/,
  /\bpnpm\s+publish\b/,
  /\byarn\s+publish\b/,

  // ── Disk / partition ──
  /\bfdisk\b/,
  /\bparted\b/,
]


const READ_ONLY_CMDLET_SET = new Set(READ_ONLY_COMMANDS.filter((c) => c.includes('-')).map((c) => c.toLowerCase()))


const PS_CONTROL_FLOW_RE = /^\s*(?:if|elseif|else|for|foreach|while|switch|try|catch|finally|do)\b/i


const PS_CALL_OP_RE = /&\s*["'$./\\]/
const PS_DOT_SOURCING_RE = /(?:^|[\s;{(])\.\s+\S/


const VERB_NOUN_FIND_RE = /\b[A-Za-z]+(?:-[A-Za-z0-9]+)+\b/g
const VERB_NOUN_STRICT_RE = /^[A-Z][a-z]+(?:-[A-Z][A-Za-z0-9]*)+$/


function isReadOnlyControlFlow(cmd: string): boolean {
  if (!PS_CONTROL_FLOW_RE.test(cmd)) return false
  if (PS_CALL_OP_RE.test(cmd)) return false
  if (PS_DOT_SOURCING_RE.test(cmd)) return false

  let found = 0
  for (const match of cmd.matchAll(VERB_NOUN_FIND_RE)) {
    const name = match[0]
    if (!VERB_NOUN_STRICT_RE.test(name)) continue
    found++
    if (!READ_ONLY_CMDLET_SET.has(name.toLowerCase())) return false
  }
  return found > 0
}


export function isReadOnly(cmd: string): boolean {
  const c = cmd.trim()
  if (READ_ONLY_REGEX.test(c)) return true
  return isReadOnlyControlFlow(c)
}


export function isDestructive(cmd: string): boolean {
  const c = cmd.trim()
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(c))
}
