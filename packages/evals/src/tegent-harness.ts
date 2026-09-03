/**
 * tegent-harness.ts — 评测核心「测试装具（harness）」。
 *
 * 一条任务的完整生命周期都在 TegentCodingAgentHarness.run() 里：
 *
 *   建临时工作区 → 拍"前"快照 → 切到该目录跑 agent（用回调记录轨迹）
 *   → 拍"后"快照 → 判卷(runChecks) → 汇总 EvalResult → 清理工作区
 *
 * agent 本体来自 @tegent/core 的 agentLoop；本文件通过 AgentCallbacks
 * 把 agent 运行过程中发生的一切"录制"到 EvalTrace 里。
 *
 * runAgent / persistSession 做成可注入的依赖：测试时可以传假的实现，
 * 不需要真的调模型就能测 harness 自身的逻辑。
 */

import fs from 'node:fs/promises'

import { agentLoop, saveSession } from '../../core/src/index.js'
import type { AgentCallbacks, LanguageModel } from '../../core/src/index.js'

import { runChecks } from './checks.js'
import type { EvalResult, EvalTask, EvalTrace, ToolTrace } from './types.js'
import { changedFiles, createEvalWorkspace, listFiles } from './workspace.js'

/** runAgent 的返回值：agent 结束后的内部状态和对话轮数 */
export type AgentRunResult = {
  state: unknown
  turnCount: number
}

/**
 * 「跑一次 agent」的函数签名（可注入）。
 * 默认实现是下面的 defaultRunAgent；单测可替换为假实现。
 */
export type RunAgent = (args: {
  task: EvalTask
  modelId: string
  model: LanguageModel
  maxTurns: number
  callbacks: AgentCallbacks
}) => Promise<AgentRunResult>

/** 「保存 agent 会话」的函数签名（可注入），默认实现是 defaultPersistSession */
export type PersistSession = (state: unknown, model: LanguageModel) => Promise<void>

/** 创建 harness 时需要的全部配置 */
export type TegentHarnessOptions = {
  modelId: string
  model: LanguageModel
  /** 每个任务最多跑多少轮 */
  maxTurns: number
  /** 是否保留临时工作区（调试用） */
  keepWorkspaces: boolean
  /** 本次运行的 ID（用于工作区目录命名和报告） */
  runId: string
  /** fixtures 目录路径 */
  fixturesDir: string
  /** 可选注入：自定义跑 agent 的方式 */
  runAgent?: RunAgent
  /** 可选注入：自定义保存会话的方式 */
  persistSession?: PersistSession
}

/** 新建一条空轨迹 */
function createTrace(): EvalTrace {
  return { text: '', tools: [], errors: [] }
}

/**
 * 把 AgentCallbacks（agent 的各类事件钩子）转成"录制器"：
 * agent 每发生一件事，就写进 trace。
 */
function createCallbacks(trace: EvalTrace): AgentCallbacks {
  // 记录最近一次工具调用，用于 onToolResult 兜底配对
  let currentTool: ToolTrace | undefined

  return {
    // 模型输出的一段文本 —— 累加进 trace.text，只留最后 2 万字符（有界）
    onTextDelta: (text) => {
      trace.text = `${trace.text}${text}`.slice(-20_000)
    },
    // agent 发起一次工具调用 —— 新建一条 ToolTrace 记录
    onToolCall: (id, name, input) => {
      currentTool = { id, name, input }
      trace.tools.push(currentTool)
    },
    // 工具执行中的增量输出 —— 评测不关心，丢弃
    onToolProgress: () => undefined,
    // 工具执行完毕 —— 按工具调用 ID 找到对应记录，补上结果和错误标记；
    // 倒序查找是因为同名工具可能被并发/多次调用，取最近的一条更稳；
    // result 只保留前 2000 字符，避免 trace 过大
    onToolResult: (id, result, isError) => {
      const tool = [...trace.tools].reverse().find((entry) => entry.id === id) ?? currentTool
      if (tool) {
        tool.result = result.slice(0, 2_000)
        tool.isError = isError
      }
    },
    // ===== 以下是"人机交互"类回调。评测是无人值守的，全部自动应答：=====
    // 请求权限（如执行命令前）→ 一律允许（eval 沙盒里放行，考察 agent 真实能力）
    onAskPermission: async () => 'yes',
    // 向用户提问 → 直接选第一个选项
    onAskUser: async (_question, options) => options[0]?.label ?? '',
    // 请求批准计划 → 自动同意
    onPlanApprovalRequest: async () => true,
    // 计划模式切换 / todo 更新 / shell 实时输出 / 上下文压缩通知 —— 评测不关心
    onPlanModeChange: () => undefined,
    onTodosUpdate: () => undefined,
    onShellOutput: () => undefined,
    // token 用量更新 —— 覆盖式记录最新值
    onUsageUpdate: (usage) => {
      trace.usage = { ...usage }
    },
    onContextCompressed: () => undefined,
    // agent 内部报错 —— 收集到 trace.errors，会导致任务判为失败
    onError: (error) => {
      trace.errors.push(error.message)
    },
  }
}

/** 默认的"跑 agent"实现：调用 core 包的 agentLoop 主循环 */
const defaultRunAgent: RunAgent = async ({ task, modelId, model, maxTurns, callbacks }) => {
  const result = await agentLoop(task.prompt, model, { modelId, trustMode: false, maxTurns }, callbacks)
  return { state: result.state, turnCount: result.turnCount }
}

/** 默认的"存会话"实现：把 agent 最终状态保存成 Tegent 会话（可在 CLI 里回看） */
const defaultPersistSession: PersistSession = async (state, model) => {
  await saveSession(state as Parameters<typeof saveSession>[0], model)
}

/**
 * TegentCodingAgentHarness — 单模型、单配置的评测装具。
 * 持有模型/轮数等配置，run(task) 跑一条任务并返回 EvalResult。
 */
export class TegentCodingAgentHarness {
  constructor(private readonly options: TegentHarnessOptions) {}

  /**
   * 跑一条评测任务的完整流程（见文件头注释的流水线）。
   *
   * 关键点：
   * - process.chdir(workspace)：把当前工作目录切到临时工作区，
   *   agent 的相对路径读写就都落在这个沙盒里；
   *   finally 里切回原目录，保证后续任务不受影响。
   * - 即使 agent 抛异常也不中断流程：错误记进 trace.errors，
   *   照常判卷、产出结果（一个"失败但完整"的成绩单）。
   */
  async run(task: EvalTask): Promise<EvalResult> {
    const workspace = await createEvalWorkspace(task, this.options.runId, this.options.fixturesDir)
    const before = await listFiles(workspace) // agent 动手前的快照
    const trace = createTrace()
    const originalCwd = process.cwd()
    const startedAt = Date.now()
    let turnCount = 0

    try {
      process.chdir(workspace)
      // 没有注入就用默认实现（真的跑 agentLoop）
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
      // agent 崩了也记录下来，后面照常判卷
      trace.errors.push(error instanceof Error ? error.message : String(error))
    } finally {
      // 无论成败都切回原目录
      process.chdir(originalCwd)
    }

    const after = await listFiles(workspace) // agent 动手后的快照
    const checks = await runChecks(workspace, task, trace, before, after)
    const changed = changedFiles(before, after)
    const result: EvalResult = {
      id: task.id,
      name: task.name,
      modelId: this.options.modelId,
      // 成功条件很严格：所有 check 通过 且 运行零错误
      success: checks.every((check) => check.passed) && trace.errors.length === 0,
      durationMs: Date.now() - startedAt,
      turnCount,
      changedFiles: changed,
      checks,
      toolCalls: trace.tools.length,
      // 条件展开：没有 usage 数据时干脆不写这个字段
      ...(trace.usage ? { usage: trace.usage } : {}),
      errors: trace.errors,
      finalText: trace.text,
      trace,
      // 只有 --keep 时才保留工作区路径（否则目录马上被删，路径无意义）
      ...(this.options.keepWorkspaces ? { workspacePath: workspace } : {}),
    }

    // 默认删掉临时工作区；--keep 时保留供人工检查
    if (!this.options.keepWorkspaces) await fs.rm(workspace, { recursive: true, force: true })
    return result
  }
}
