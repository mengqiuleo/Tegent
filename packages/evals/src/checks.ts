import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { Check, CheckResult, EvalTask, EvalTrace } from './types.js'
import type { FileSnapshot } from './workspace.js'
import { changedFiles } from './workspace.js'

type CommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
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

function appendBounded(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-20_000)
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk)
    })
    child.on('error', (error) => {
      finish({ exitCode: 1, stdout, stderr: appendBounded(stderr, error.message), timedOut })
    })
    child.on('close', (exitCode) => {
      finish({ exitCode, stdout, stderr, timedOut })
    })
  })
}

export async function runChecks(
  workspace: string,
  task: EvalTask,
  trace: EvalTrace,
  before: FileSnapshot,
  after: FileSnapshot,
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
        const result = await runCommand(check.command, workspace, check.timeoutMs ?? 30_000)
        const passed = result.exitCode === 0 && !result.timedOut
        const output = `${result.stdout}${result.stderr}`.trim().slice(0, 240)
        results.push({
          type: check.type,
          passed,
          message: passed
            ? `${check.command} exited with 0`
            : `${check.command} failed${result.timedOut ? ' after timeout' : ''}${output ? `: ${output}` : ''}`,
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
