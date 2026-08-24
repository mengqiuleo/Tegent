import fs from 'node:fs/promises'
import path from 'node:path'

import type { LanguageModel } from 'ai'

import type { LoopState } from './loop-state.js'
import { isToolErrorString, toolErrorFromUnknown, toolErrorString, toolResultMessage } from './messages.js'
import { runShellCommand, truncateToolResult } from './tools.js'
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

async function executeWriteTool(toolName: string, input: Record<string, unknown>): Promise<string> {
  if (toolName === 'writeFile') {
    const filePath = input.filePath as string
    const content = input.content as string
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
    return `File written: ${filePath}`
  }

  if (toolName === 'edit') {
    const filePath = input.filePath as string
    const oldString = input.oldString as string
    const newString = input.newString as string
    const replaceAll = Boolean(input.replaceAll)
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
    if (tc.toolName === 'writeFile' || tc.toolName === 'edit') {
      const output = await executeWriteTool(tc.toolName, tc.input)
      const isError = isToolErrorString(output)
      if (!isError) state.filesModified.add(tc.input.filePath as string)
      pushToolResult(state, callbacks, tc.toolCallId, tc.toolName, truncateToolResult(output), isError)
      return
    }

    if (tc.toolName === 'shell') {
      const command = tc.input.command as string
      const timeout = (tc.input.timeout as number | undefined) ?? 30_000
      callbacks.onToolProgress(tc.toolCallId, `Running ${command}`)
      const result = await runShellCommand(command, timeout)
      callbacks.onShellOutput(result.output)
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
