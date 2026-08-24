import { exec } from 'node:child_process'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

const execAsync = promisify(exec)

const MAX_TOOL_RESULT_BYTES = 24_000

/** 截断工具输出 */
export function truncateToolResult(result: string): string {
  if (Buffer.byteLength(result, 'utf-8') <= MAX_TOOL_RESULT_BYTES) return result
  return result.slice(0, MAX_TOOL_RESULT_BYTES) + '\n...[tool result truncated]'
}

export const readFile = tool({
  description:
    'Read a text file. This tool is read-only and includes execute, so the AI SDK can auto-execute it during streamText.',
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  execute: async ({ filePath, offset, limit }) => {
    const content = await fs.readFile(filePath, 'utf-8')
    const lines = content.split('\n')
    const start = Math.max((offset ?? 1) - 1, 0)
    const end = limit == null ? lines.length : start + limit
    const numbered = lines.slice(start, end).map((line, i) => `${start + i + 1}\t${line}`)
    return truncateToolResult(numbered.join('\n'))
  },
})

export const writeFile = tool({
  description: 'Write a file. No execute is provided because writes must go through permission checks.',
  inputSchema: z.object({
    filePath: z.string(),
    content: z.string(),
  }),
})

export const edit = tool({
  description: 'Replace text in a file. No execute is provided because edits must go through permission checks.',
  inputSchema: z.object({
    filePath: z.string(),
    oldString: z.string(),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
  }),
})

export const shell = tool({
  description: 'Run a shell command. No execute is provided because shell commands must go through permission checks.',
  inputSchema: z.object({
    command: z.string(),
    timeout: z.number().optional(),
  }),
})

export async function runShellCommand(
  command: string,
  timeout = 30_000,
): Promise<{ output: string; isError: boolean }> {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout })
    return { output: truncateToolResult([stdout, stderr].filter(Boolean).join('\n').trim() || 'Done'), isError: false }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim()
    return { output: truncateToolResult(output || 'Command failed'), isError: true }
  }
}

export const toolRegistry = {
  readFile,
  writeFile,
  edit,
  shell,
}
