/**
 * vitest-harness.ts — 把 Tegent 评测接入「vitest-evals」生态的适配层。
 *
 * vitest-evals 是一个基于 Vitest 的评测库：它定义了统一的 Harness 接口
 * （run 一条输入 → 返回标准化的 output/events/usage/traces），
 * 并提供 reporter、报告服务器（`pnpm eval:report`）等基础设施。
 *
 * 本文件做的事就是"格式转换"：
 *   EvalTask ──TegentCodingAgentHarness──▶ EvalResult ──各种 toXxx()──▶ vitest-evals 格式
 *
 * 对外暴露：
 * - createTegentVitestHarness()：创建符合 vitest-evals Harness 接口的装具
 * - hasConfiguredEvalModel()：判断是否配置了可用模型（没配则跳过评测）
 */

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

// 加载仓库根目录的 .env（拿到各模型的 API key 等配置）
loadEnv({ path: path.join(repoRoot, '.env') })

/**
 * vitest-evals 要求 output 是可 JSON 序列化的格式（JsonValue），
 * 所以这里定义了一份与 EvalResult 等价、但"无 class/无 unknown"的输出类型：
 * usage 和 trace.tools.input 等字段都展开成纯 JSON 结构。
 */
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

/** createTegentVitestHarness 的可选配置；不传的项用默认值或环境变量 */
export type TegentVitestHarnessOptions = {
  modelId?: string
  model?: LanguageModel
  maxTurns?: number
  keepWorkspaces?: boolean
  runId?: string
  fixturesDir?: string
  /** 可选注入，透传给 TegentCodingAgentHarness（单测用） */
  runAgent?: RunAgent
  persistSession?: PersistSession
}

/** 把任意对象转成 vitest-evals 的 JsonValue 记录；转不成对象（数组/标量）就返回 undefined */
function toJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> | undefined {
  const json = toJsonValue(value)
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined
  return json as Record<string, JsonValue>
}

/**
 * 拆分 "provider:model" 格式的模型 ID。
 * 注意 model 部分可能含冒号（如 ollama:llama3:8b），所以只按第一个冒号切。
 */
function splitModelId(modelId: string): { provider: string; model: string } {
  const [provider, ...modelParts] = modelId.split(':')
  return { provider: provider ?? 'unknown', model: modelParts.join(':') || modelId }
}

/**
 * 把 core 包的 TokenUsage 转成 vitest-evals 的 UsageSummary 格式
 * （provider/model 拆开，缓存类字段挪进 metadata）。
 */
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

/** 把内部 EvalResult 转成 vitest-evals 要求的 TegentEvalOutput（主要是类型层面的展开） */
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

/**
 * 把录制到的轨迹还原成 vitest-evals 的「对话事件流」TranscriptEvent，
 * 报告页面会按这个顺序回放整个交互过程：
 *
 *   用户消息(任务 prompt) → [工具调用, 工具结果] x N → 助手最终回答
 */
function traceToEvents(task: EvalTask, trace: EvalTrace, output: TegentEvalOutput): TranscriptEvent[] {
  // 第一条事件永远是用户的任务指令
  const events: TranscriptEvent[] = [{ type: 'message', role: 'user', content: task.prompt }]

  // 每次工具调用产生两条事件：tool_call（请求）+ tool_result（结果）
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
      // 出错的调用：内容放 error.message；正常的调用：放结果文本
      content: tool.isError ? undefined : tool.result,
      error: tool.isError ? { message: tool.result ?? 'tool failed' } : undefined,
    })
  }

  // 最后是助手的最终回答；如果没产出文本，退而展示整个 output 的 JSON
  events.push({ type: 'message', role: 'assistant', content: output.finalText || toJsonValue(output) })
  return events
}

/**
 * 决定本次评测用哪个模型：
 * 优先级：显式传入的 modelId > 环境变量 TEGENT_EVAL_MODEL > .env 里的默认配置。
 * 同样允许注入现成的 model 实例（单测用），否则从模型注册表创建。
 */
function resolveHarnessModel(options: TegentVitestHarnessOptions): { modelId: string; model: LanguageModel } {
  const modelId = resolveModelId(options.modelId ?? process.env.TEGENT_EVAL_MODEL)
  if (!modelId) throw new Error('No model configured. Set a provider API key in .env or pass --model provider:model.')

  if (options.model) return { modelId, model: options.model }
  const registry = createModelRegistry()
  return { modelId, model: registry.languageModel(modelId as `${string}:${string}`) }
}

/**
 * 是否配置了可用于评测的模型。
 * evals/coding.eval.ts 用它决定 skipIf：没配模型时跳过评测而不是报错失败
 * （比如 CI 上没配 API key 时，测试显示 skipped 而不是 red）。
 */
export function hasConfiguredEvalModel(modelId = process.env.TEGENT_EVAL_MODEL): boolean {
  return Boolean(resolveModelId(modelId))
}

/**
 * 创建 vitest-evals 格式的 Tegent 评测装具。
 *
 * run() 是核心：接收一条 EvalTask，内部委托给 TegentCodingAgentHarness，
 * 再把 EvalResult 翻译成 vitest-evals 需要的各个字段：
 * - output：结构化结果（coding.eval.ts 里的断言就用它）
 * - events：对话回放事件流
 * - usage：token 用量（provider/model 维度）
 * - timings：耗时
 * - artifacts：附加产物（失败的 check、工作区路径、最终回答）
 * - traces：OTel 风格的 span 树（一个 agentLoop 大 span + 每个工具一个小 span），
 *   gen_ai.* 属性遵循 OpenTelemetry 生成式 AI 约定，便于接入观测平台
 * - errors：运行错误列表
 */
export function createTegentVitestHarness(options: TegentVitestHarnessOptions = {}): Harness<EvalTask, TegentEvalOutput> {
  return createHarness<EvalTask, TegentEvalOutput>({
    name: 'tegent-coding-agent',
    run: async ({ input, setArtifact }) => {
      const startedAt = new Date()
      // 配置兜底顺序：options > 环境变量 > 默认值
      const maxTurns = options.maxTurns ?? Number(process.env.TEGENT_EVAL_MAX_TURNS ?? 20)
      const keepWorkspaces = options.keepWorkspaces ?? process.env.TEGENT_EVAL_KEEP_WORKSPACES === '1'
      const { modelId, model } = resolveHarnessModel(options)
      const harness = new TegentCodingAgentHarness({
        modelId,
        model,
        maxTurns,
        keepWorkspaces,
        // runId 兜底：当前时间戳（如 20260904T101530）
        runId: options.runId ?? new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14),
        fixturesDir: options.fixturesDir ?? defaultFixturesDir,
        runAgent: options.runAgent,
        persistSession: options.persistSession,
      })
      // 真正干活的地方：跑一条任务
      const result = await harness.run(input)
      const output = toOutput(result)
      // 预先筛出失败的 check，artifacts 和后续断言都会用
      const failedChecks = output.checks.filter((check) => !check.passed)

      // setArtifact 把附加数据挂到报告上，报告页可展开查看
      setArtifact('task', { id: input.id, name: input.name, tags: input.tags ?? [] })
      setArtifact('checks', output.checks)
      setArtifact('changedFiles', output.changedFiles)
      if (output.workspacePath) setArtifact('workspacePath', output.workspacePath)

      return {
        output,
        events: traceToEvents(input, result.trace, output),
        usage: toUsageSummary(modelId, result.usage, result.toolCalls), // token 统计
        timings: { totalMs: result.durationMs },
        artifacts: { // 附加数据
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
              // 顶层 span：整个 agent 主循环
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
              // 每次工具调用一个子 span
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
