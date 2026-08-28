// 实际的目录遍历委托给 ripgrep（`rg --files --glob ...`），而不是用
// Node 的 glob 库。三个原因：
//   1. ripgrep 本来就是 `grep` 工具的依赖 —— 复用它让跨工具的依赖
//      体积保持最小。
//   2. ripgrep 走巨型目录树很快（Rust + 并行目录遍历），且默认遵守
//      .gitignore。
//   3. ripgrep 的 `--sortr=modified` 给出确定的"最近修改在前"排序 ——
//      结果被截断时模型最需要的就是这个：最相关的文件留在上限之内。
//
// 这也让 glob 的实际行为与它的 description 文案对齐了 —— 之前的文案
// 承诺按 mtime 排序，实际跑出来的却是库默认排序（globby 的字母序）。
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'
import { getRipgrepPath } from './utils.js'

const execFileAsync = promisify(execFile)

// 返回给模型的文件条数上限：超出的部分截断掉，并在尾部提示模型
// 换更精确的模式。配合 mtime 降序排序，被留下的是最近改动的文件。
const MAX_GLOB_RESULTS = 200

// execFile 的 stdout 缓冲上限。Node 默认只有 1 MB，大仓库 `rg --files`
// 的完整输出轻松超过它，超了会直接抛错，所以放大到 20 MB。
const RG_MAX_BUFFER = 20 * 1024 * 1024

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
      // cwd 缺省时用 CLI 进程的当前工作目录（通常就是仓库根）。
      const searchDir = cwd ?? process.cwd()
      reportProgress(toolCallId, `Matching ${pattern}`)
      // ripgrep 参数：
      //   --files          — 列出文件，而不是搜索文件内容
      //   --sortr=modified — 按 mtime 排序，最近修改在前
      //   --hidden         — 连点开头的文件也算上（.eslintrc / .prettierrc）
      //   --glob '!.git'   — 显式排除 git 元数据目录。.gitignore 通常
      //                      【不】会列 .git/（git 自己内部管理它），所以
      //                      没有这个参数的话，`--hidden` 会大摇大摆走进
      //                      .git/objects，翻出几千个内部哈希对象文件。
      //   --glob <pattern> — 用户给的 glob 过滤器（相对搜索目录）
      //
      // 有一类模式要特殊处理，因为它和 ripgrep 白名单式的 --glob 语义
      // 合不来：
      //
      //   • 万能模式（"**/*"、"**"、"*"）会被整个丢弃不传：
      //     `--glob "**/*"` 会被 ripgrep 解读成显式白名单、进而覆盖
      //     .gitignore，结果里就会混进 node_modules / dist 等 ——
      //     通常是几万个纯噪声文件。干脆不传用户的 --glob，让
      //     ripgrep 默认的文件遍历生效（那套默认是遵守 .gitignore 的）。
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
      // rg 输出的是相对搜索目录的路径；拼回绝对路径再给模型
      //（模型拿着绝对路径才能直接喂给 readFile 等工具）。
      const relatives = out.split('\n')
      const absolutes = relatives.map((p) => (path.isAbsolute(p) ? p : path.join(searchDir, p)))
      const truncated = absolutes.length > MAX_GLOB_RESULTS
      const result = absolutes.slice(0, MAX_GLOB_RESULTS).join('\n')
      if (truncated) {
        return `${result}\n\n... [${absolutes.length - MAX_GLOB_RESULTS} more files not shown — ${absolutes.length} total matches, capped at ${MAX_GLOB_RESULTS}. Use a more specific pattern to narrow results.]`
      }
      return result
    } catch (err) {
      // ripgrep 没有匹配到文件时会以退出码 1 结束 —— 把它呈现为空结果
      // 而不是报错，让模型把"没有匹配"当成正常结局，而不是一个需要
      // 重试的工具失败。
      if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
        return 'No files found matching the pattern.'
      }
      return formatToolError('searching files', err)
    }
  },
})
