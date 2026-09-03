/**
 * tasks.ts — 评测任务的「加载与选择」模块。
 *
 * 职责：
 * 1. 定义整个包共用的路径常量（源码目录、包目录、仓库根目录、
 *    tasks.jsonl / results / fixtures 的默认位置）。
 * 2. loadEvalTasks()：从 tasks.jsonl 逐行读取并解析出 EvalTask 列表。
 * 3. selectEvalTasks()：支持用 --task <id> 只挑选某一条任务。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { EvalTask } from './types.js'

// ---- 路径常量（其他文件都从这里取路径，避免各处硬编码） ----

// 本文件（编译后）所在的目录，即 packages/evals/src
export const evalSrcDir = path.dirname(fileURLToPath(import.meta.url))
// eval 包根目录，即 packages/evals
export const evalPackageDir = path.resolve(evalSrcDir, '..')
// 整个仓库根目录（packages/evals 往上两级），用于找 .env 等文件
export const repoRoot = path.resolve(evalPackageDir, '../..')
// 默认任务清单文件：packages/evals/tasks.jsonl（每行一个 JSON 任务）
export const defaultTasksPath = path.join(evalPackageDir, 'tasks.jsonl')
// 默认结果输出目录：packages/evals/results（存放 .json / .md 报告）
export const defaultResultsDir = path.join(evalPackageDir, 'results')
// 默认夹具目录：packages/evals/fixtures（任务的初始工作区素材）
export const defaultFixturesDir = path.join(evalPackageDir, 'fixtures')

/**
 * 读取任务清单 tasks.jsonl 并解析为 EvalTask 数组。
 *
 * JSONL 格式 = 每行一个独立的 JSON 对象（相比一个大 JSON 数组，
 * 更方便追加任务、看 git diff）。
 *
 * @param tasksPath 任务文件路径，默认用 defaultTasksPath
 * @throws 某一行不是合法 JSON 时，抛出带行号的错误，方便定位
 */
export async function loadEvalTasks(tasksPath = defaultTasksPath): Promise<EvalTask[]> {
  const raw = await fs.readFile(tasksPath, 'utf8')
  return raw
    .split(/\r?\n/)
    // 跳过空行（包括文件末尾的换行产生的空行）
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as EvalTask
      } catch (error) {
        // 报错时带上行号（index 从 0 开始，所以 +1）
        throw new Error(`Invalid task JSON on line ${index + 1}: ${String(error)}`)
      }
    })
}

/**
 * 按 ID 挑选任务：传了 taskId 就只返回那一条，否则原样返回全部。
 *
 * @throws 传了 taskId 但找不到对应任务时报错（通常是 ID 打错了）
 */
export function selectEvalTasks(tasks: EvalTask[], taskId?: string): EvalTask[] {
  if (!taskId) return tasks
  const selected = tasks.filter((task) => task.id === taskId)
  if (selected.length === 0) throw new Error(`Unknown eval task: ${taskId}`)
  return selected
}
