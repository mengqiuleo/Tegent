import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { defaultResultsDir, evalPackageDir } from './tasks.js'

type VitestEvalCliOptions = {
  modelId?: string
  taskId?: string
  maxTurns?: number
  keepWorkspaces: boolean
  info: boolean
  passthrough: string[]
}

function printHelp(): void {
  console.log(
    [
      'Usage: pnpm eval -- [options] [vitest options]',
      '',
      'Options:',
      '  --model <provider:model>  Model to evaluate; defaults to Tegent config',
      '  --task <id>              Run one task instead of the full set',
      '  --max-turns <n>          Maximum turns per task (default: 20)',
      '  --keep                   Keep temporary workspaces for debugging',
      '  --info                   Print detailed vitest-evals reporter output',
      '  -h, --help               Show this help',
      '',
      'Examples:',
      '  pnpm eval -- --task fix-test --model deepseek:deepseek-chat',
      '  pnpm eval -- --info --task scope-control',
    ].join('\n'),
  )
}

function parseArgs(argv: string[]): VitestEvalCliOptions {
  const options: VitestEvalCliOptions = { keepWorkspaces: false, info: false, passthrough: [] }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--model') options.modelId = argv[++i]
    else if (arg === '--task') options.taskId = argv[++i]
    else if (arg === '--max-turns') options.maxTurns = Number(argv[++i])
    else if (arg === '--keep') options.keepWorkspaces = true
    else if (arg === '--info' || arg === '--verbose' || arg === '-v') options.info = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else options.passthrough.push(arg)
  }

  if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)) {
    throw new Error('--max-turns must be a positive integer')
  }
  return options
}

async function runVitest(options: VitestEvalCliOptions): Promise<number | null> {
  await fs.mkdir(defaultResultsDir, { recursive: true })
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const outputFile = path.join('results', 'vitest-results.json')
  const args = [
    'exec',
    'vitest',
    'run',
    'evals/**/*.eval.ts',
    '--reporter=vitest-evals/reporter',
    '--reporter=json',
    `--outputFile.json=${outputFile}`,
    ...options.passthrough,
  ]
  const env = {
    ...process.env,
    ...(options.modelId ? { TEGENT_EVAL_MODEL: options.modelId } : {}),
    ...(options.taskId ? { TEGENT_EVAL_TASK: options.taskId } : {}),
    ...(options.maxTurns ? { TEGENT_EVAL_MAX_TURNS: String(options.maxTurns) } : {}),
    ...(options.keepWorkspaces ? { TEGENT_EVAL_KEEP_WORKSPACES: '1' } : {}),
    ...(options.info ? { VITEST_EVALS_REPORT_LEVEL: 'info' } : {}),
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: evalPackageDir,
      env,
      stdio: 'inherit',
      windowsHide: true,
    })

    child.on('error', reject)
    child.on('close', resolve)
  })
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const exitCode = await runVitest(options)
  process.exitCode = exitCode ?? 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
