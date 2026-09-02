import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { config as loadEnv } from 'dotenv'

import { agentLoop, createModelRegistry, resolveModelId, saveSession } from '../src/index.js'
import type { AgentCallbacks, LanguageModel, TokenUsage } from '../src/index.js'
import { getShellProvider } from '../src/tools/shell-provider.js'

type Check =
  | { type: 'answerContains'; values: string[] }
  | { type: 'fileEquals'; path: string; content: string }
  | { type: 'jsonPathEquals'; path: string; pathExpr: string; value: unknown }
  | { type: 'command'; command: string; timeoutMs?: number }
  | { type: 'onlyFiles'; paths: string[] }

type EvalTask = {
  id: string
  name: string
  prompt: string
  fixture?: string
  files?: Record<string, string>
  checks: Check[]
}

type ToolTrace = {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
}

type EvalTrace = {
  text: string
  tools: ToolTrace[]
  errors: string[]
  usage?: TokenUsage
}

type CheckResult = {
  type: Check['type']
  passed: boolean
  message: string
}

type EvalResult = {
  id: string
  name: string
  modelId: string
  success: boolean
  durationMs: number
  turnCount: number
  changedFiles: string[]
  checks: CheckResult[]
  toolCalls: number
  usage?: TokenUsage
  errors: string[]
  finalText: string
  workspacePath?: string
}

type RunOptions = {
  modelId?: string
  taskId?: string
  maxTurns: number
  keepWorkspaces: boolean
}

const evalDir = path.dirname(fileURLToPath(import.meta.url))
const tasksPath = path.join(evalDir, 'tasks.jsonl')
const resultsDir = path.join(evalDir, 'results')
const fixturesDir = path.join(evalDir, 'fixtures')

loadEnv({ path: path.resolve(evalDir, '../../../.env') })

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

async function loadTasks(): Promise<EvalTask[]> {
  const raw = await fs.readFile(tasksPath, 'utf8')
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as EvalTask
      } catch (error) {
        throw new Error(`Invalid task JSON on line ${index + 1}: ${String(error)}`)
      }
    })
}

async function createWorkspace(task: EvalTask, runId: string): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `tegent-eval-${runId}-${task.id}-`))
  if (task.fixture) {
    await fs.cp(path.join(fixturesDir, task.fixture), workspace, { recursive: true })
  }
  for (const [relativePath, content] of Object.entries(task.files ?? {})) {
    const absolutePath = path.join(workspace, relativePath)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, content, 'utf8')
  }
  return workspace
}

async function listFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()

  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.tegent') continue
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolutePath)
      else if (entry.isFile()) {
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/')
        const content = await fs.readFile(absolutePath)
        files.set(relativePath, crypto.createHash('sha256').update(content).digest('hex'))
      }
    }
  }

  await visit(root)
  return files
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const allPaths = new Set([...before.keys(), ...after.keys()])
  return [...allPaths].filter((filePath) => before.get(filePath) !== after.get(filePath)).sort()
}

async function readJsonPath(
  workspace: string,
  check: Extract<Check, { type: 'jsonPathEquals' }>,
): Promise<unknown> {
  const raw = await fs.readFile(path.join(workspace, check.path), 'utf8')
  let current: unknown = JSON.parse(raw)
  for (const part of check.pathExpr.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

async function runChecks(
  workspace: string,
  task: EvalTask,
  trace: EvalTrace,
  before: Map<string, string>,
  after: Map<string, string>,
): Promise<CheckResult[]> {
  const changed = changedFiles(before, after)
  const results: CheckResult[] = []

  for (const check of task.checks) {
    try {
      if (check.type === 'answerContains') {
        const answer = trace.text.toLowerCase()
        const missing = check.values.filter((value) => !answer.includes(value.toLowerCase()))
        results.push({
          type: check.type,
          passed: missing.length === 0,
          message: missing.length === 0 ? 'final answer contains all expected values' : `missing: ${missing.join(', ')}`,
        })
      } else if (check.type === 'fileEquals') {
        const actual = await fs.readFile(path.join(workspace, check.path), 'utf8')
        results.push({
          type: check.type,
          passed: actual === check.content,
          message: actual === check.content ? `${check.path} matches expected content` : `${check.path} content differs`,
        })
      } else if (check.type === 'jsonPathEquals') {
        const actual = await readJsonPath(workspace, check)
        const passed = JSON.stringify(actual) === JSON.stringify(check.value)
        results.push({
          type: check.type,
          passed,
          message: passed
            ? `${check.path}.${check.pathExpr} matches expected value`
            : `${check.path}.${check.pathExpr} was ${JSON.stringify(actual)}`,
        })
      } else if (check.type === 'command') {
        const shell = getShellProvider()
        const result = await shell.spawn(check.command, {
          cwd: workspace,
          timeout: check.timeoutMs ?? 30_000,
        })
        const passed = result.exitCode === 0
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 240)
        results.push({
          type: check.type,
          passed,
          message: passed ? `${check.command} exited with 0` : `${check.command} failed${output ? `: ${output}` : ''}`,
        })
      } else if (check.type === 'onlyFiles') {
        const allowed = new Set(check.paths)
        const unexpected = changed.filter((filePath) => !allowed.has(filePath))
        results.push({
          type: check.type,
          passed: unexpected.length === 0,
          message: unexpected.length === 0
            ? 'changed files are within the allowed list'
            : `unexpected changes: ${unexpected.join(', ')}`,
        })
      }
    } catch (error) {
      results.push({ type: check.type, passed: false, message: String(error) })
    }
  }

  return results
}

function createTrace(): EvalTrace {
  return { text: '', tools: [], errors: [] }
}

function createCallbacks(trace: EvalTrace): AgentCallbacks {
  let currentTool: ToolTrace | undefined

  return {
    onTextDelta: (text) => {
      trace.text = `${trace.text}${text}`.slice(-20_000)
    },
    onToolCall: (id, name, input) => {
      currentTool = { id, name, input }
      trace.tools.push(currentTool)
    },
    onToolProgress: () => undefined,
    onToolResult: (id, result, isError) => {
      const tool = [...trace.tools].reverse().find((entry) => entry.id === id) ?? currentTool
      if (tool) {
        tool.result = result.slice(0, 2_000)
        tool.isError = isError
      }
    },
    onAskPermission: async () => 'yes',
    onAskUser: async (_question, options) => options[0]?.label ?? '',
    onPlanApprovalRequest: async () => true,
    onPlanModeChange: () => undefined,
    onTodosUpdate: () => undefined,
    onShellOutput: () => undefined,
    onUsageUpdate: (usage) => {
      trace.usage = { ...usage }
    },
    onContextCompressed: () => undefined,
    onError: (error) => {
      trace.errors.push(error.message)
    },
  }
}

async function runTask(
  task: EvalTask,
  modelId: string,
  model: LanguageModel,
  options: RunOptions,
  runId: string,
): Promise<EvalResult> {
  const workspace = await createWorkspace(task, runId)
  const before = await listFiles(workspace)
  const trace = createTrace()
  const originalCwd = process.cwd()
  const startedAt = Date.now()
  let turnCount = 0

  try {
    process.chdir(workspace)
    const result = await agentLoop(
      task.prompt,
      model,
      { modelId, trustMode: false, maxTurns: options.maxTurns },
      createCallbacks(trace),
    )
    turnCount = result.turnCount
    await saveSession(result.state, model)
  } catch (error) {
    trace.errors.push(error instanceof Error ? error.message : String(error))
  } finally {
    process.chdir(originalCwd)
  }

  const after = await listFiles(workspace)
  const changed = changedFiles(before, after)
  const checks = await runChecks(workspace, task, trace, before, after)
  const result: EvalResult = {
    id: task.id,
    name: task.name,
    modelId,
    success: checks.every((check) => check.passed) && trace.errors.length === 0,
    durationMs: Date.now() - startedAt,
    turnCount,
    changedFiles: changed,
    checks,
    toolCalls: trace.tools.length,
    ...(trace.usage ? { usage: trace.usage } : {}),
    errors: trace.errors,
    finalText: trace.text,
    ...(options.keepWorkspaces ? { workspacePath: workspace } : {}),
  }

  if (!options.keepWorkspaces) await fs.rm(workspace, { recursive: true, force: true })
  return result
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

  const tasks = await loadTasks()
  const selectedTasks = options.taskId ? tasks.filter((task) => task.id === options.taskId) : tasks
  if (selectedTasks.length === 0) throw new Error(`Unknown eval task: ${options.taskId}`)

  const registry = createModelRegistry()
  const model = registry.languageModel(requestedModelId as `${string}:${string}`)
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const results: EvalResult[] = []

  console.log(`Running ${selectedTasks.length} eval task(s) with ${requestedModelId}`)
  for (const task of selectedTasks) {
    const result = await runTask(task, requestedModelId, model, options, runId)
    results.push(result)
    printResult(result)
  }

  await fs.mkdir(resultsDir, { recursive: true })
  const resultPath = path.join(resultsDir, `${runId}.json`)
  await fs.writeFile(resultPath, JSON.stringify({ modelId: requestedModelId, results }, null, 2) + '\n', 'utf8')

  const passed = results.filter((result) => result.success).length
  console.log(`\nSummary: ${passed}/${results.length} passed`)
  console.log(`Results: ${resultPath}`)
  if (passed !== results.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
