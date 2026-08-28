// 当模型用同一个工具、同一组参数反复调用时，这里负责识别并阻断。
// 这种情况通常发生在上一次调用失败后，模型没有改变策略而是原样重试。
// Windows 上尤其常见：shell 命令因为引号错误失败，模型随后连续重试完全相同的命令，
// 每次失败都会把一大段错误栈塞进上下文。
//
// 两阶段策略：
//   1. 软阻断：达到默认阈值 3 次时，注入一个合成 tool_result，告诉模型不要再原样重试。
//      下一轮模型看到这个结果后通常会换方法。
//   2. 硬阻断：达到默认阈值 5 次时，中断本轮并询问用户。
//      如果软提醒都没用，继续追加上下文只会浪费窗口。
//
// 检测方式：对 `{toolName, stableInputJson}` 做 SHA256。
// stable stringify 会排序对象 key，所以 `{a:1,b:2}` 和 `{b:2,a:1}` 会得到同一个 hash。
//
// 调参说明：
// 这里没有采用“连续 3 次完全相同”的简单判断，因为模型可能在两次相同命令之间插入一次读文件。
// 我们扫描最近 N 次同名工具调用，只要其中 K 次 hash 相同，就认为是循环。
import crypto from 'node:crypto'

import type { LoopState } from './loop-state.js'
import { toolResultMessage } from './messages.js'

// 中文导读：
// 这个文件是“重复工具调用熔断器”。模型有时会用完全相同参数反复调用失败工具，
// 尤其是 Windows shell 引号错误时会把上下文刷满。这里通过稳定 hash 识别重复调用：
// 先软阻断并把提醒作为 tool_result 喂回模型；重复更多次时硬阻断并询问用户。

// 滚动窗口内同一调用达到这个次数，就触发软阻断。
export const SOFT_LOOP_THRESHOLD = 3

// 滚动窗口内同一调用达到这个次数，就触发硬阻断。
export const HARD_LOOP_THRESHOLD = 5

// 每次检测时向后扫描的工具调用窗口大小。
export const LOOP_WINDOW_SIZE = 8 // 设置最多保留多少条历史。

/** 稳定 JSON 序列化：递归排序对象 key，让语义相同但 key 顺序不同的输入得到同一字符串。 */
function stableStringify(value: unknown): string {
  // JSON.stringify 会保留对象插入顺序；这里排序 key，避免同一对象不同顺序算成不同调用。
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}'
}

/** 为一次工具调用生成重复检测 hash。
 *  截断到 16 个十六进制字符；在 8 条窗口里比较时，碰撞概率极低。 */
export function hashToolCall(toolName: string, input: unknown): string {
  // 工具名和参数之间用 NUL 分隔，避免字符串拼接边界歧义。
  const payload = toolName + '\x00' + stableStringify(input)
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

/** 所有检查结果都带上预计算 hash，后续 recordToolCall 可以复用，避免重复 hash。 */
interface LoopCheckBase {
  hash: string
}

export type LoopCheck =
  // 没检测到循环：正常派发工具。
  | (LoopCheckBase & { kind: 'ok' })
  // 达到软阻断阈值：注入合成 tool-result，并跳过本轮真实工具执行。
  // toolCallId 是当前调用的 id，让合成结果看起来就是它的返回值。
  | (LoopCheckBase & { kind: 'soft-block'; toolCallId: string; message: string })
  // 达到硬阻断阈值：中止本轮并询问用户。
  | (LoopCheckBase & { kind: 'hard-block'; toolName: string; message: string })

/**
 * 检查即将到来的工具调用是否和最近调用重复，并告诉调用方该怎么处理。
 * 这个函数不修改 state；调用方只有在决定记录时才通过 recordToolCall 提交 hash。
 * 返回值里的 hash 应继续传给 recordToolCall，避免对同一输入再算一次 SHA256。
 *
 * 只统计 hash 相同且 toolName 相同的调用。不同工具就算参数看起来一样，也不会触发 guard。
 */
export function checkForLoop(state: LoopState, toolName: string, input: unknown, toolCallId: string): LoopCheck {
  const hash = hashToolCall(toolName, input)
  const window = state.recentToolCalls.slice(-LOOP_WINDOW_SIZE)

  // 只统计同名工具且 hash 相同的历史调用；不同工具即便参数相似也不是同一个循环。
  let priorMatches = 0
  for (const entry of window) {
    if (entry.toolName === toolName && entry.hash === hash) priorMatches++
  }

  // 当前这次调用是把计数推过阈值的那一次，所以判断时用“历史匹配数 + 1”。

  if (priorMatches + 1 >= HARD_LOOP_THRESHOLD) {
    return {
      kind: 'hard-block',
      hash,
      toolName,
      message: `Tool ${toolName} has been called with identical arguments ${priorMatches + 1} times in a row. The model is looping; aborting this turn.`,
    }
  }

  if (priorMatches + 1 >= SOFT_LOOP_THRESHOLD) {
    return {
      kind: 'soft-block',
      hash,
      toolCallId,
      message:
        `This exact ${toolName} call (same arguments) has already been attempted ${priorMatches + 1} times this session with the same result. ` +
        'DO NOT retry it. Change your approach — alter the arguments meaningfully, try a different tool, or ask the user what to do instead.',
    }
  }

  return { kind: 'ok', hash }
}

/** 记录最近的工具调用 
 * 把一次工具调用提交到滚动窗口。
 *  窗口有上限，避免长会话无限增长。优先传入 checkForLoop 返回的 hash；
 *  只有在检查路径之外调用时才省略 hash。 */
export function recordToolCall(state: LoopState, toolName: string, input: unknown, hash?: string): void {
  const h = hash ?? hashToolCall(toolName, input)
  state.recentToolCalls.push({ toolName, hash: h })
  // 保留 2 倍窗口长度，让 checkForLoop 在活跃比较窗口之外还有一点历史。
  // 以后调整 LOOP_WINDOW_SIZE 时，也不会改变持久化 footprint 太多。
  const cap = LOOP_WINDOW_SIZE * 2 // 设置最多保留多少条历史。
  if (state.recentToolCalls.length > cap) {
    state.recentToolCalls.splice(0, state.recentToolCalls.length - cap) // 如果历史太长，就从数组开头删掉旧记录，只保留最新的 16 条。
  }
}

/** 构造一个合成 tool-result，告诉模型本次调用被 loop guard 阻断。
 *  模型会像看到真实工具结果一样看到它，通常下一轮会调整策略。 */
export function syntheticLoopBlockResult(toolName: string, toolCallId: string, message: string) {
  // 构造成标准 tool-result，保证下一次发给 provider 的工具调用配对仍然合法。
  return toolResultMessage(toolCallId, toolName, `[loop-guard] ${message}`)
}
