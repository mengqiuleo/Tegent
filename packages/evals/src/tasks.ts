import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { EvalTask } from './types.js'

export const evalSrcDir = path.dirname(fileURLToPath(import.meta.url))
export const evalPackageDir = path.resolve(evalSrcDir, '..')
export const repoRoot = path.resolve(evalPackageDir, '../..')
export const defaultTasksPath = path.join(evalPackageDir, 'tasks.jsonl')
export const defaultResultsDir = path.join(evalPackageDir, 'results')
export const defaultFixturesDir = path.join(evalPackageDir, 'fixtures')

export async function loadEvalTasks(tasksPath = defaultTasksPath): Promise<EvalTask[]> {
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

export function selectEvalTasks(tasks: EvalTask[], taskId?: string): EvalTask[] {
  if (!taskId) return tasks
  const selected = tasks.filter((task) => task.id === taskId)
  if (selected.length === 0) throw new Error(`Unknown eval task: ${taskId}`)
  return selected
}
