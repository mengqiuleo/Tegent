import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'

import { getRipgrepPath } from './utils.js'
import { reportProgress } from './progress.js'

const execFileAsync = promisify(execFile)

/**  返回给模型的文件条数上限：超出的部分截断掉，并在尾部提示模型换更精确的模式。配合 mtime 降序排序，被留下的是最近改动的文件。 */
const MAX_GLOB_RESULTS = 200

/**  execFile 的 stdout 缓冲上限。Node 默认只有 1 MB，大仓库 `rg --files` 的完整输出轻松超过它，超了会直接抛错，所以放大到 20 MB */
const RG_MAX_BUFFER = 20 * 1024 * 1024


/** 按文件名模式匹配文件路径 */
export const glob = tool({
  description:
    `Find files matching a glob pattern. Returns absolute file paths sorted by modification time, most recent first. ` +
    `Results are capped at ${MAX_GLOB_RESULTS} files — use a more specific pattern if truncated.`,
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")'),
    cwd: z.string().optional().describe('Directory to search in (defaults to working directory)'),
  }),
  execute: async ({ pattern, cwd }, { toolCallId }) => {
    try {
      const searchDir = cwd ?? process.cwd()
      reportProgress(toolCallId, `Matching ${pattern}`)
      const isCatchAll = /^(\*\*\/?\*?|\*)$/.test(pattern.trim())
      const args = ['--files', '--sortr=modified', '--hidden', '--glob', '!.git']
      if (!isCatchAll) {
        args.push('--glob', pattern)
      }
      const { stdout } = await execFileAsync(getRipgrepPath(), args, {
        cwd: searchDir,
        maxBuffer: RG_MAX_BUFFER,
        timeout: 30000,
      })
      const out = stdout.trim()
      if (!out) return 'No files found matching the pattern.'
      const relatives = out.split('\n')
      const absolutes = relatives.map((p) => (path.isAbsolute(p) ? p : path.join(searchDir, p)))
      const truncated = absolutes.length > MAX_GLOB_RESULTS
      const result = absolutes.slice(0, MAX_GLOB_RESULTS).join('\n')
      if (truncated) {
        return `${result}\n\n... [${absolutes.length - MAX_GLOB_RESULTS} more files not shown — ${absolutes.length} total matches, capped at ${MAX_GLOB_RESULTS}. Use a more specific pattern to narrow results.]`
      }
      return result
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
        return 'No files found matching the pattern.'
      }
      return formatToolError('searching files', err)
    }
  },
})
