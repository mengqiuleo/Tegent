import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { LanguageModel } from 'ai'

import type { LoopState } from './loop-state.js'
import { isToolErrorString, toolErrorFromUnknown, toolErrorString, toolResultMessage } from './messages.js'
import { truncateToolResult } from './tools.js'
import { clearProgressReporter, reportProgress } from './tools/progress.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'

type ToolCall = {
  toolName: string
  toolCallId: string
  input: Record<string, unknown>
}

function pushToolResult(
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError = false,
): void {
  state.messages.push(toolResultMessage(toolCallId, toolName, output))
  clearProgressReporter(toolCallId)
  callbacks.onToolResult(toolCallId, output, isError)
}

function collectFulfilledToolCallIds(state: LoopState): Set<string> {
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part.type === 'tool-result' && part.toolCallId) ids.add(part.toolCallId)
    }
  }
  return ids
}

function countOccurrences(content: string, search: string): number {
  let count = 0
  let pos = 0
  while ((pos = content.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

async function runShellCommand(
  command: string,
  timeout = 30_000,
  callbacks?: Pick<AgentCallbacks, 'onShellOutput'>,
  toolCallId?: string,
  signal?: AbortSignal,
): Promise<{ output: string; isError: boolean }> {
  return await new Promise((resolve) => {
    const proc = spawn(command, {
      shell: true,
      cwd: process.cwd(),
      env: process.env,
      signal,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout>

    const finish = (output: string, isError: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ output: truncateToolResult(output), isError })
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      callbacks?.onShellOutput(text)
      if (toolCallId) reportProgress(toolCallId, text.trim().split(/\r?\n/).at(-1) ?? 'Running command...')
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      callbacks?.onShellOutput(text)
      if (toolCallId) reportProgress(toolCallId, text.trim().split(/\r?\n/).at(-1) ?? 'Running command...')
    })

    timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeout)

    proc.on('error', (err) => finish(err.message || 'Command failed', true))

    proc.on('close', (code) => {
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim()
      if (timedOut) {
        finish(`${combined}\nCommand timed out after ${timeout}ms`.trim(), true)
        return
      }
      if (code !== 0) {
        finish(combined ? `${combined}\nExit code ${code}` : `Exit code ${code}`, true)
        return
      }
      finish(combined || 'Done', false)
    })
  })
}

async function executeWriteTool(toolName: string, input: Record<string, unknown>, toolCallId: string): Promise<string> {
  if (toolName === 'writeFile') {
    const filePath = input.filePath as string
    const content = input.content as string
    reportProgress(toolCallId, `Writing ${filePath}`)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
    return `File written: ${filePath}`
  }

  if (toolName === 'edit') {
    const filePath = input.filePath as string
    const oldString = input.oldString as string
    const newString = input.newString as string
    const replaceAll = Boolean(input.replaceAll)
    reportProgress(toolCallId, `Editing ${filePath}`)
    const content = await fs.readFile(filePath, 'utf-8')

    if (!replaceAll) {
      const count = countOccurrences(content, oldString)
      if (count === 0) return toolErrorString(`oldString not found in ${filePath}`)
      if (count > 1) return toolErrorString(`oldString is not unique in ${filePath}`)
    }

    const next = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)
    await fs.writeFile(filePath, next, 'utf-8')
    return `File edited: ${filePath}`
  }

  return toolErrorString(`No manual executor for ${toolName}`)
}

async function executeBypassTool(
  tc: ToolCall,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
): Promise<boolean> {
  if (tc.toolName === 'askUser') {
    const question = tc.input.question as string
    const choices = tc.input.options as Array<{ label: string; description: string }> | undefined
    const answer = await callbacks.onAskUser(question, choices)
    pushToolResult(state, callbacks, tc.toolCallId, tc.toolName, `User answered: ${answer}`)
    return true
  }

  if (tc.toolName === 'todoWrite') {
    state.todos = (tc.input.todos as typeof state.todos | undefined) ?? []
    pushToolResult(state, callbacks, tc.toolCallId, tc.toolName, `Todo list updated: ${state.todos.length} items`)
    return true
  }

  if (tc.toolName === 'enterPlanMode') {
    state.permissionMode = 'plan'
    pushToolResult(state, callbacks, tc.toolCallId, tc.toolName, 'Entered plan mode.')
    return true
  }

  if (tc.toolName === 'exitPlanMode') {
    state.permissionMode = 'default'
    pushToolResult(state, callbacks, tc.toolCallId, tc.toolName, 'Exited plan mode.')
    return true
  }

  return false
}

async function askPermission(
  tc: ToolCall,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
): Promise<boolean> {
  if (options.trustMode) return true
  if ((tc.toolName === 'writeFile' || tc.toolName === 'edit') && state.permissionMode === 'acceptEdits') return true
  if (tc.toolName !== 'writeFile' && tc.toolName !== 'edit' && tc.toolName !== 'shell') return true

  const decision = await callbacks.onAskPermission(tc)
  return decision === 'yes' || decision === 'always'
}

async function handleToolCall(
  tc: ToolCall,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
): Promise<void> {
  if (!(await askPermission(tc, state, options, callbacks))) {
    pushToolResult(state, callbacks, tc.toolCallId, tc.toolName, 'Permission denied by user.')
    return
  }

  try {
    if (await executeBypassTool(tc, state, options, callbacks)) return

    if (tc.toolName === 'writeFile' || tc.toolName === 'edit') {
      const output = await executeWriteTool(tc.toolName, tc.input, tc.toolCallId)
      const isError = isToolErrorString(output)
      if (!isError) state.filesModified.add(tc.input.filePath as string)
      pushToolResult(state, callbacks, tc.toolCallId, tc.toolName, truncateToolResult(output), isError)
      return
    }

    if (tc.toolName === 'shell') {
      const command = tc.input.command as string
      const timeout = (tc.input.timeout as number | undefined) ?? 30_000
      reportProgress(tc.toolCallId, 'Running command...')
      const result = await runShellCommand(command, timeout, callbacks, tc.toolCallId, options.abortSignal)
      pushToolResult(state, callbacks, tc.toolCallId, tc.toolName, result.output, result.isError)
      return
    }
  } catch (err) {
    pushToolResult(state, callbacks, tc.toolCallId, tc.toolName, toolErrorFromUnknown(err), true)
  }
}

export async function processToolCalls(
  toolCalls: ToolCall[],
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  _model: LanguageModel,
): Promise<void> {
  const fulfilled = collectFulfilledToolCallIds(state)

  for (const tc of toolCalls) {
    if (fulfilled.has(tc.toolCallId)) continue
    await handleToolCall(tc, state, options, callbacks)
  }
}
