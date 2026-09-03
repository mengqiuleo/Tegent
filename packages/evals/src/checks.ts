/**
 * checks.ts — 「判卷」模块：任务跑完后，逐条执行 Check 验收标准。
 *
 * 支持 5 种检查（与 types.ts 里的 Check 联合类型一一对应）：
 * - answerContains  最终回答必须包含指定关键词
 * - fileEquals      指定文件内容必须与期望完全一致
 * - jsonPathEquals  JSON 文件中某个字段的值必须等于期望值
 * - command         在工作区里跑一条 shell 命令，退出码 0 才通过（如跑测试）
 * - onlyFiles       只允许改动白名单里的文件（防越权）
 *
 * 每条检查都会产出一个 CheckResult { type, passed, message }。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { Check, CheckResult, EvalTask, EvalTrace } from './types.js'
import type { FileSnapshot } from './workspace.js'
import { changedFiles } from './workspace.js'

/** 一次 shell 命令的执行结果 */
type CommandResult = {
  /** 进程退出码；null 表示进程被信号杀死等未正常退出的情况 */
  exitCode: number | null
  stdout: string
  stderr: string
  /** 是否因超时被强杀 */
  timedOut: boolean
}

/**
 * 读取工作区里某个 JSON 文件，并按 `a.b.c` 这种点分路径取出嵌套值。
 * 路径中途遇到非对象（如穿过字符串/数字）就返回 undefined。
 * 例：pathExpr = "scripts.test" 对应 JSON 的 obj.scripts.test
 */
async function readJsonPath(
  workspace: string,
  check: Extract<Check, { type: 'jsonPathEquals' }>,
): Promise<unknown> {
  const raw = await fs.readFile(path.join(workspace, check.path), 'utf8')
  let current: unknown = JSON.parse(raw)
  for (const part of check.pathExpr.split('.')) {
    // 当前值不是对象（或是 null）就无法继续往下取了
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * 把新输出追加到已有文本上，但只保留最后 2 万字符（有界缓冲）。
 * 防止某条命令疯狂输出（如死循环打印）把内存撑爆。
 */
function appendBounded(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-20_000)
}

/**
 * 在指定目录（cwd）下用 shell 执行一条命令，带超时保护。
 *
 * 实现要点：
 * - spawn(..., { shell: true }) 让命令串交给系统 shell 解释，
 *   所以任务里可以写 `node verify.mjs && echo ok` 这类复合命令。
 * - 超时后 child.kill() 杀掉进程；'close' 事件再统一收尾。
 * - settled 标志保证 Promise 只 resolve 一次（error 和 close 可能都触发）。
 *
 * @returns 命令的退出码和（截断后的）stdout/stderr
 */
function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    // 统一收尾函数：只生效一次
    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    // 超时计时器：到点标记超时并杀进程（结果由 close 事件收尾）
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    // 持续收集输出（有界，见 appendBounded）
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk)
    })
    // 进程根本没启动起来（如命令不存在）—— 视为失败，退出码记 1
    child.on('error', (error) => {
      finish({ exitCode: 1, stdout, stderr: appendBounded(stderr, error.message), timedOut })
    })
    // 进程结束（无论正常/被杀）—— exitCode 为 null 表示被信号杀死
    child.on('close', (exitCode) => {
      finish({ exitCode, stdout, stderr, timedOut })
    })
  })
}

/**
 * 判卷主函数：按顺序执行任务声明的所有 check，返回判定结果列表。
 *
 * @param workspace 任务的工作区路径（fileEquals/command 等需要读里面的文件）
 * @param task      任务定义（提供 checks 列表）
 * @param trace     agent 运行轨迹（answerContains 要检查其中的最终文本）
 * @param before    任务开始前的工作区快照
 * @param after     任务结束后（已应用 agent 改动）的工作区快照
 *
 * 注意：单条检查抛异常（如文件不存在）不会中断整个判卷，
 * 而是记为一条 failed 的 CheckResult。
 */
export async function runChecks(
  workspace: string,
  task: EvalTask,
  trace: EvalTrace,
  before: FileSnapshot,
  after: FileSnapshot,
): Promise<CheckResult[]> {
  // 先算出 agent 实际改动了哪些文件，onlyFiles 检查会用到
  const changed = changedFiles(before, after)
  const results: CheckResult[] = []

  for (const check of task.checks) {
    try {
      if (check.type === 'answerContains') {
        // 大小写不敏感地检查最终回答是否包含所有关键词
        const answer = trace.text.toLowerCase()
        const missing = check.values.filter((value) => !answer.includes(value.toLowerCase()))
        results.push({
          type: check.type,
          passed: missing.length === 0,
          message: missing.length === 0 ? 'final answer contains all expected values' : `missing: ${missing.join(', ')}`,
        })
      } else if (check.type === 'fileEquals') {
        // 整文件精确比对
        const actual = await fs.readFile(path.join(workspace, check.path), 'utf8')
        results.push({
          type: check.type,
          passed: actual === check.content,
          message: actual === check.content ? `${check.path} matches expected content` : `${check.path} content differs`,
        })
      } else if (check.type === 'jsonPathEquals') {
        // 按 JSONPath 取值比对（用 JSON.stringify 做深比较）
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
        // 在工作区里执行命令；退出码 0 且没超时才算通过
        const result = await runCommand(check.command, workspace, check.timeoutMs ?? 30_000)
        const passed = result.exitCode === 0 && !result.timedOut
        // 失败时把命令输出（前 240 字符）带进 message，方便排查
        const output = `${result.stdout}${result.stderr}`.trim().slice(0, 240)
        results.push({
          type: check.type,
          passed,
          message: passed
            ? `${check.command} exited with 0`
            : `${check.command} failed${result.timedOut ? ' after timeout' : ''}${output ? `: ${output}` : ''}`,
        })
      } else if (check.type === 'onlyFiles') {
        // 改动白名单：改动文件集合必须是允许列表的子集
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
      // 检查本身出错（如 fileEquals 的文件不存在）→ 该条记为失败，继续判下一条
      results.push({ type: check.type, passed: false, message: String(error) })
    }
  }

  return results
}
