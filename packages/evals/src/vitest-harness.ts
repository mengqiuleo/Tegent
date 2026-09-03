import path from 'node:path'

import { config as loadEnv } from 'dotenv'
import {
  createHarness,
  toJsonValue,
  type Harness,
  type JsonValue,
  type TranscriptEvent,
  type UsageSummary,
} from 'vitest-evals'

import { createModelRegistry, resolveModelId, type LanguageModel, type TokenUsage } from '../../core/src/index.js'

import { defaultFixturesDir, repoRoot } from './tasks.js'
import { TegentCodingAgentHarness, type PersistSession, type RunAgent } from './tegent-harness.js'
import type { CheckResult, EvalResult, EvalTask, EvalTrace } from './types.js'

loadEnv({ path: path.join(repoRoot, '.env') })

export type TegentEvalOutput = {
  id: string
  name: string
  success: boolean
  durationMs: number
  turnCount: number
  changedFiles: string[]
  checks: CheckResult[]
  toolCalls: number
  errors: string[]
  finalText: string
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    currentContextTokens: number
  }
  workspacePath?: string
  trace: {
    text: string
    tools: Array<{
      id: string
      name: string
      input?: Record<string, JsonValue>
      result?: string
      isError?: boolean
    }>
    errors: string[]
  }
}

export type TegentVitestHarnessOptions = {
  modelId?: string
  model?: LanguageModel
  maxTurns?: number
  keepWorkspaces?: boolean
  runId?: string
  fixturesDir?: string
  runAgent?: RunAgent
  persistSession?: PersistSession
}

function toJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> | undefined {
  const json = toJsonValue(value)
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined
  return json as Record<string, JsonValue>
}

function splitModelId(modelId: string): { provider: string; model: string } {
  const [provider, ...modelParts] = modelId.split(':')
  return { provider: provider ?? 'unknown', model: modelParts.join(':') || modelId }
}

function toUsageSummary(modelId: string, usage: TokenUsage | undefined, toolCalls: number): UsageSummary {
  const parsed = splitModelId(modelId)
  return {
    provider: parsed.provider,
    model: parsed.model,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    toolCalls,
    metadata: usage
      ? {
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          currentContextTokens: usage.currentContextTokens,
        }
      : undefined,
  }
}

function toOutput(result: EvalResult): TegentEvalOutput {
  return {
    id: result.id,
    name: result.name,
    success: result.success,
    durationMs: result.durationMs,
    turnCount: result.turnCount,
    changedFiles: result.changedFiles,
    checks: result.checks,
    toolCalls: result.toolCalls,
    errors: result.errors,
    finalText: result.finalText,
    usage: result.usage
      ? {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheCreationTokens: result.usage.cacheCreationTokens,
          currentContextTokens: result.usage.currentContextTokens,
        }
      : undefined,
    workspacePath: result.workspacePath,
    trace: {
      text: result.trace.text,
      tools: result.trace.tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        input: toJsonRecord(tool.input),
        result: tool.result,
        isError: tool.isError,
      })),
      errors: result.trace.errors,
    },
  }
}

function traceToEvents(task: EvalTask, trace: EvalTrace, output: TegentEvalOutput): TranscriptEvent[] {
  const events: TranscriptEvent[] = [{ type: 'message', role: 'user', content: task.prompt }]

  for (const tool of trace.tools) {
    events.push({
      type: 'tool_call',
      id: tool.id,
      name: tool.name,
      arguments: toJsonRecord(tool.input),
    })
    events.push({
      type: 'tool_result',
      toolCallId: tool.id,
      name: tool.name,
      content: tool.isError ? undefined : tool.result,
      error: tool.isError ? { message: tool.result ?? 'tool failed' } : undefined,
    })
  }

  events.push({ type: 'message', role: 'assistant', content: output.finalText || toJsonValue(output) })
  return events
}

function resolveHarnessModel(options: TegentVitestHarnessOptions): { modelId: string; model: LanguageModel } {
  const modelId = resolveModelId(options.modelId ?? process.env.TEGENT_EVAL_MODEL)
  if (!modelId) throw new Error('No model configured. Set a provider API key in .env or pass --model provider:model.')

  if (options.model) return { modelId, model: options.model }
  const registry = createModelRegistry()
  return { modelId, model: registry.languageModel(modelId as `${string}:${string}`) }
}

export function hasConfiguredEvalModel(modelId = process.env.TEGENT_EVAL_MODEL): boolean {
  return Boolean(resolveModelId(modelId))
}

export function createTegentVitestHarness(options: TegentVitestHarnessOptions = {}): Harness<EvalTask, TegentEvalOutput> {
  return createHarness<EvalTask, TegentEvalOutput>({
    name: 'tegent-coding-agent',
    run: async ({ input, setArtifact }) => {
      const startedAt = new Date()
      const maxTurns = options.maxTurns ?? Number(process.env.TEGENT_EVAL_MAX_TURNS ?? 20)
      const keepWorkspaces = options.keepWorkspaces ?? process.env.TEGENT_EVAL_KEEP_WORKSPACES === '1'
      const { modelId, model } = resolveHarnessModel(options)
      const harness = new TegentCodingAgentHarness({
        modelId,
        model,
        maxTurns,
        keepWorkspaces,
        runId: options.runId ?? new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14),
        fixturesDir: options.fixturesDir ?? defaultFixturesDir,
        runAgent: options.runAgent,
        persistSession: options.persistSession,
      })
      const result = await harness.run(input)
      const output = toOutput(result)
      const failedChecks = output.checks.filter((check) => !check.passed)

      setArtifact('task', { id: input.id, name: input.name, tags: input.tags ?? [] })
      setArtifact('checks', output.checks)
      setArtifact('changedFiles', output.changedFiles)
      if (output.workspacePath) setArtifact('workspacePath', output.workspacePath)

      return {
        output,
        events: traceToEvents(input, result.trace, output),
        usage: toUsageSummary(modelId, result.usage, result.toolCalls),
        timings: { totalMs: result.durationMs },
        artifacts: {
          failedChecks,
          workspacePath: output.workspacePath,
          finalText: output.finalText,
        },
        traces: [
          {
            name: 'tegent eval task',
            startedAt: startedAt.toISOString(),
            durationMs: result.durationMs,
            metadata: { taskId: input.id, modelId },
            spans: [
              {
                name: 'agentLoop',
                kind: 'agent',
                durationMs: result.durationMs,
                status: result.success ? 'ok' : 'error',
                attributes: {
                  'gen_ai.operation.name': 'invoke_agent',
                  'gen_ai.request.model': modelId,
                  'tegent.eval.task_id': input.id,
                  'tegent.eval.turn_count': result.turnCount,
                },
              },
              ...result.trace.tools.map((tool) => ({
                name: tool.name,
                kind: 'tool' as const,
                status: tool.isError ? ('error' as const) : ('ok' as const),
                attributes: {
                  'gen_ai.operation.name': 'execute_tool',
                  'gen_ai.tool.call.id': tool.id,
                  'gen_ai.tool.name': tool.name,
                  'gen_ai.tool.call.arguments': toJsonValue(tool.input),
                },
              })),
            ],
          },
        ],
        errors: result.errors.map((message) => ({ message })),
      }
    },
  })
}
