import { Chalk } from 'chalk'

import { VERSION } from '../../version.js'

const c = new Chalk({ level: 3 })


const LOGO_COLOR = '#89b4fa'


const LOGO_WIDE = `
  ████████╗███████╗ ██████╗ ███████╗███╗   ██╗████████╗
  ╚══██╔══╝██╔════╝██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
     ██║   █████╗  ██║  ███╗█████╗  ██╔██╗ ██║   ██║   
     ██║   ██╔══╝  ██║   ██║██╔══╝  ██║╚██╗██║   ██║   
     ██║   ███████╗╚██████╔╝███████╗██║ ╚████║   ██║   
     ╚═╝   ╚══════╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   `

const LOGO_COMPACT_ALT = `
  ╔═══╗ ╔═══╗ ╔═══╗ ╔═══╗ ╔═══╗ ╔═══╗
  ║ T ║ ║ E ║ ║ G ║ ║ E ║ ║ N ║ ║ T ║
  ╚═══╝ ╚═══╝ ╚═══╝ ╚═══╝ ╚═══╝ ╚═══╝`


const LOGO_TINY = '  TEGENT'

export function getHeaderRowCount(modelId: string): number {
  return renderHeader(modelId).split('\n').length - 1 
}


export function renderHeader(modelId: string): string {
  const cols = process.stdout.columns ?? 80

  let logo: string
  if (cols >= 52) {
    logo = LOGO_WIDE
  } else if (cols >= 30) {
    logo = LOGO_COMPACT_ALT
  } else {
    logo = LOGO_TINY
  }

  const [provider, ...modelParts] = modelId.split(':')
  const modelName = modelParts.join(':') || modelId

  const isMac = process.platform === 'darwin'
  const abortKey = isMac ? '⌃C' : 'Ctrl+C'
  const newlineHint = isMac ? '⌥⏎ or \\⏎ for newline' : 'Alt+Enter or \\+Enter for newline'

  const lines = [
    c.hex(LOGO_COLOR).bold(logo),
    ` ${c.dim(`v${VERSION}`)} ${c.dim('│')} ${c.hex(LOGO_COLOR)(provider)} ${c.dim('/')} ${c.hex(LOGO_COLOR).bold(modelName)}`,
    ` ${c.dim(`Type /help for commands, ${abortKey} to abort, ${newlineHint}`)}`,
    '',
  ]

  return lines.join('\n') + '\n'
}


export function printHeader(modelId: string): void {
  const rows = process.stdout.rows ?? 25
  if (process.stdout.isTTY && rows > 1) {
    process.stdout.write('\n'.repeat(rows - 1) + '\x1b[H')
  }
  process.stdout.write(renderHeader(modelId))
}
