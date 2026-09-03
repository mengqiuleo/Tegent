import fs from 'node:fs/promises'

import { agentLoop, saveSession } from '../../core/src/index.js'
import type { AgentCallbacks, LanguageModel } from '../../core/src/index.js'

import { runChecks } from './checks.js'
import type { EvalResult, EvalTask, EvalTrace, ToolTrace } from './types.js'
import { changedFiles, createEvalWorkspace, listFiles } from './workspace.js'

export type AgentRunResult = {
  state: unknown
  turnCount: number
}

export type RunAgent = (args: {
  task: EvalTask
  modelId: string
  model: LanguageModel
  maxTurns: number
  callbacks: AgentCallbacks
}) => Promise<AgentRunResult>

export type PersistSession = (state: unknown, model: LanguageModel) => Promise<void>

export type TegentHarnessOptions = {
  modelId: string
  model: LanguageModel
  maxTurns: number
  keepWorkspaces: boolean
  runId: string
  fixturesDir: string
  runAgent?: RunAgent
  persistSession?: PersistSession
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

const defaultRunAgent: RunAgent = async ({ task, modelId, model, maxTurns, callbacks }) => {
  const result = await agentLoop(task.prompt, model, { modelId, trustMode: false, maxTurns }, callbacks)
  return { state: result.state, turnCount: result.turnCount }
}

const defaultPersistSession: PersistSession = async (state, model) => {
  await saveSession(state as Parameters<typeof saveSession>[0], model)
}

export class TegentCodingAgentHarness {
  constructor(private readonly options: TegentHarnessOptions) {}

  async run(task: EvalTask): Promise<EvalResult> {
    const workspace = await createEvalWorkspace(task, this.options.runId, this.options.fixturesDir)
    const before = await listFiles(workspace)
    const trace = createTrace()
    const originalCwd = process.cwd()
    const startedAt = Date.now()
    let turnCount = 0

    try {
      process.chdir(workspace)
      const runAgent = this.options.runAgent ?? defaultRunAgent
      const persistSession = this.options.persistSession ?? defaultPersistSession
      const result = await runAgent({
        task,
        modelId: this.options.modelId,
        model: this.options.model,
        maxTurns: this.options.maxTurns,
        callbacks: createCallbacks(trace),
      })
      turnCount = result.turnCount
      await persistSession(result.state, this.options.model)
    } catch (error) {
      trace.errors.push(error instanceof Error ? error.message : String(error))
    } finally {
      process.chdir(originalCwd)
    }

    const after = await listFiles(workspace)
    const checks = await runChecks(workspace, task, trace, before, after)
    const changed = changedFiles(before, after)
    const result: EvalResult = {
      id: task.id,
      name: task.name,
      modelId: this.options.modelId,
      success: checks.every((check) => check.passed) && trace.errors.length === 0,
      durationMs: Date.now() - startedAt,
      turnCount,
      changedFiles: changed,
      checks,
      toolCalls: trace.tools.length,
      ...(trace.usage ? { usage: trace.usage } : {}),
      errors: trace.errors,
      finalText: trace.text,
      trace,
      ...(this.options.keepWorkspaces ? { workspacePath: workspace } : {}),
    }

    if (!this.options.keepWorkspaces) await fs.rm(workspace, { recursive: true, force: true })
    return result
  }
}
