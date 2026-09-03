import { config as loadEnv } from 'dotenv'

import { createModelRegistry, resolveModelId } from '../../core/src/index.js'

import { buildRunArtifact, writeRunArtifacts } from './artifacts.js'
import { defaultFixturesDir, defaultResultsDir, loadEvalTasks, repoRoot, selectEvalTasks } from './tasks.js'
import { TegentCodingAgentHarness } from './tegent-harness.js'
import type { EvalResult, EvalTask, RunOptions } from './types.js'

loadEnv({ path: `${repoRoot}/.env` })

function parseArgs(argv: string[]): RunOptions {
  const options: RunOptions = { maxTurns: 20, keepWorkspaces: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--model') options.modelId = argv[++i]
    else if (arg === '--task') options.taskId = argv[++i]
    else if (arg === '--max-turns') options.maxTurns = Number(argv[++i])
    else if (arg === '--keep') options.keepWorkspaces = true
    else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: pnpm eval -- [options]',
          '',
          'Options:',
          '  --model <provider:model>  Model to evaluate; defaults to Tegent config',
          '  --task <id>              Run one task instead of the full set',
          '  --max-turns <n>          Maximum turns per task (default: 20)',
          '  --keep                   Keep temporary workspaces for debugging',
        ].join('\n'),
      )
      process.exit(0)
    }
  }

  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) {
    throw new Error('--max-turns must be a positive integer')
  }
  return options
}

function printResult(result: EvalResult): void {
  const status = result.success ? 'PASS' : 'FAIL'
  console.log(`${status} ${result.id} | ${result.turnCount} turns | ${result.toolCalls} tools | ${(result.durationMs / 1000).toFixed(1)}s`)
  for (const check of result.checks) console.log(`  ${check.passed ? 'ok' : '!!'} ${check.message}`)
  for (const error of result.errors) console.log(`  error: ${error}`)
  if (result.workspacePath) console.log(`  workspace: ${result.workspacePath}`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const requestedModelId = resolveModelId(options.modelId)
  if (!requestedModelId) {
    throw new Error('No model configured. Set a provider API key in .env or pass --model provider:model.')
  }

  const selectedTasks = selectEvalTasks(await loadEvalTasks(), options.taskId)

  const registry = createModelRegistry()
  const model = registry.languageModel(requestedModelId as `${string}:${string}`)
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const harness = new TegentCodingAgentHarness({
    modelId: requestedModelId,
    model,
    maxTurns: options.maxTurns,
    keepWorkspaces: options.keepWorkspaces,
    runId,
    fixturesDir: defaultFixturesDir,
  })
  const results: EvalResult[] = []

  console.log(`Running ${selectedTasks.length} eval task(s) with ${requestedModelId}`)
  for (const task of selectedTasks) {
    const result = await harness.run(task)
    results.push(result)
    printResult(result)
  }

  const artifact = buildRunArtifact({
    runId,
    modelId: requestedModelId,
    createdAt: new Date().toISOString(),
    results,
  })
  const writtenArtifacts = await writeRunArtifacts(defaultResultsDir, artifact)

  const passed = results.filter((result) => result.success).length
  console.log(`\nSummary: ${passed}/${results.length} passed`)
  console.log(`Results: ${writtenArtifacts.jsonPath}`)
  console.log(`Markdown: ${writtenArtifacts.summaryPath}`)
  if (passed !== results.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
