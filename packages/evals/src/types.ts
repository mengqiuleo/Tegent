/**
 * types.ts — 整个 eval 包的「数据结构定义」文件。
 *
 * 这里只定义 TypeScript 类型，不包含任何运行逻辑。
 * 其他文件（harness、checks、summary 等）都从这里导入类型，
 * 所以读懂这个文件是理解整个评测框架的第一步。
 *
 * 核心概念：
 * - EvalTask：一条评测任务（用户给 agent 出的"考题"）
 * - Check：任务的一道"验收标准"（判卷规则）
 * - EvalTrace：agent 运行过程的记录（说了什么、调了哪些工具、报了什么错）
 * - EvalResult：一条任务跑完后的完整成绩单
 */

import type { TokenUsage } from '../../core/src/index.js'

/**
 * Check — 单条验收规则（判卷标准）。
 * 一个任务可以配多条 check，全部通过才算成功。
 * 使用 TypeScript 的「可辨识联合类型」：靠 type 字段区分是哪种检查。
 */
export type Check =
  /** 最终回答的文本里必须包含 values 中的所有关键词（不区分大小写） */
  | { type: 'answerContains'; values: string[] }
  /** 工作区里 path 指向的文件内容必须和 content 完全一致 */
  | { type: 'fileEquals'; path: string; content: string }
  /** 工作区里 path 指向的 JSON 文件中，pathExpr（如 "a.b.c"）指向的值必须等于 value */
  | { type: 'jsonPathEquals'; path: string; pathExpr: string; value: unknown }
  /** 在工作区里执行一条 shell 命令，退出码为 0 才算通过；timeoutMs 可选，默认 30 秒 */
  | { type: 'command'; command: string; timeoutMs?: number }
  /** agent 只允许改动 paths 列出的文件，改了别的文件就算失败（考察"越权修改"） */
  | { type: 'onlyFiles'; paths: string[] }

/**
 * EvalTask — 一条评测任务，来自 tasks.jsonl 中的一行 JSON。
 * fixture / files 用来在任务开始前搭建一个初始工作区（考场的"桌面上摆好东西"）。
 */
export type EvalTask = {
  /** 任务唯一 ID，可用 `--task <id>` 单独跑这一条 */
  id: string
  /** 人类可读的任务名，显示在报告里 */
  name: string
  /** 给 agent 的自然语言指令（考题本身） */
  prompt: string
  /** 可选：fixtures/ 目录下的子目录名，任务开始前整个拷贝到工作区 */
  fixture?: string
  /** 可选：内联文件映射 { 相对路径: 文件内容 }，直接写进工作区 */
  files?: Record<string, string>
  /** 该任务的验收标准列表，全部通过才算 PASS */
  checks: Check[]
  /** 可选标签，用于分组/过滤 */
  tags?: string[]
}

/**
 * ToolTrace — agent 调用一次工具的记录（工具 = 读写文件、执行命令等能力）。
 */
export type ToolTrace = {
  /** 这次工具调用的唯一 ID（由模型生成，用于把调用和结果配对） */
  id: string
  /** 工具名，例如 read_file / run_command */
  name: string
  /** 调用参数（模型生成的输入） */
  input: Record<string, unknown>
  /** 工具执行结果文本（只保留前 2000 字符） */
  result?: string
  /** 这次工具调用是否报错 */
  isError?: boolean
}

/**
 * EvalTrace — 一次 agent 运行的完整过程记录，用于事后审计和验收。
 * 例如 answerContains 检查的就是这里的 text。
 */
export type EvalTrace = {
  /** agent 输出的所有文本（只保留最后 2 万字符，防止内存爆炸） */
  text: string
  /** 按时间顺序记录的每一次工具调用 */
  tools: ToolTrace[]
  /** 运行期间收集到的错误消息 */
  errors: string[]
  /** token 用量统计（输入/输出/缓存等），来自 core 包 */
  usage?: TokenUsage
}

/**
 * CheckResult — 一条 Check 的判定结果。
 */
export type CheckResult = {
  /** 对应哪种检查类型 */
  type: Check['type']
  /** 这条检查是否通过 */
  passed: boolean
  /** 人类可读的说明：通过原因或失败原因（报告中展示） */
  message: string
}

/**
 * EvalResult — 一条任务跑完后的完整成绩单，会写进 results/*.json。
 */
export type EvalResult = {
  id: string
  name: string
  /** 本次评测使用的模型 ID（如 provider:model 格式） */
  modelId: string
  /** 是否成功：所有 check 都通过 且 运行过程中没有错误 */
  success: boolean
  /** 任务耗时（毫秒） */
  durationMs: number
  /** agent 对话轮数（一轮 = 一次模型请求 + 可能的工具调用） */
  turnCount: number
  /** 相比初始工作区，agent 改动了哪些文件 */
  changedFiles: string[]
  /** 每条验收标准的判定结果 */
  checks: CheckResult[]
  /** 工具调用总次数 */
  toolCalls: number
  /** token 用量 */
  usage?: TokenUsage
  /** 运行期间的错误列表 */
  errors: string[]
  /** agent 的最终回答文本 */
  finalText: string
  /** 完整运行轨迹（文本、工具调用、错误） */
  trace: EvalTrace
  /** 仅当 --keep 保留工作区时才有值：临时工作区的路径，方便人工检查 */
  workspacePath?: string
}

/**
 * RunOptions — CLI 命令行选项（run.ts 解析命令行参数后的结构）。
 */
export type RunOptions = {
  /** 指定评测模型，格式 provider:model；不传则用 .env 里的默认配置 */
  modelId?: string
  /** 只跑指定 ID 的任务；不传则跑全部 */
  taskId?: string
  /** 每个任务最多允许 agent 跑多少轮（防止死循环烧钱） */
  maxTurns: number
  /** 任务结束后是否保留临时工作区（调试用） */
  keepWorkspaces: boolean
}
