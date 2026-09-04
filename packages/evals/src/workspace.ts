/**
 * workspace.ts — 评测「临时工作区」管理模块。
 *
 * 每条评测任务都在一个独立的临时目录里运行（沙盒隔离）：
 * 1. createEvalWorkspace()：搭考场 —— 建临时目录，铺入 fixture 素材和内联文件。
 * 2. listFiles()：拍快照 —— 递归记录目录下所有文件的 SHA-256 哈希。
 * 3. changedFiles()：对比前后两次快照，算出 agent 改动了哪些文件。
 *
 * 这样 agent 无论怎么折腾，都不会污染真实项目；同时能精确检测它的改动范围。
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { EvalTask } from './types.js'

/**
 * 文件快照：Map<相对路径(用 / 分隔), 文件内容的 SHA-256 哈希>。
 * 存哈希而不是内容，可以节省内存（不需要 diff 内容本身，只需知道变没变）。
 */
export type FileSnapshot = Map<string, string>

/**
 * 为一条任务创建临时工作区（即 agent 的"考场"）。
 *
 * 步骤：
 * 1. mkdtemp 在系统临时目录（如 /tmp）下创建唯一目录，
 *    前缀形如 `tegent-eval-<runId>-<taskId>-`，一眼能看出是哪次运行哪个任务。
 * 2. 若任务声明了 fixture（fixtures/ 下的子目录名），把整个目录递归拷贝进来。
 * 3. 再把任务声明的内联文件 files 逐个写入（可覆盖 fixture 里的同名文件）。
 *
 * @returns 工作区的绝对路径
 */
export async function createEvalWorkspace(
  task: EvalTask,
  runId: string,
  fixturesDir: string,
): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `tegent-eval-${runId}-${task.id}-`))

  if (task.fixture) {
    // 递归拷贝 fixture 目录的全部内容到工作区
    await fs.cp(path.join(fixturesDir, task.fixture), workspace, { recursive: true })
  }

  for (const [relativePath, content] of Object.entries(task.files ?? {})) {
    // resolve 得到绝对路径，再检查它确实还在 workspace 目录内 ——
    // 防止任务定义里出现 `../../.env` 之类的路径把文件写到工作区外面（路径穿越攻击）
    const absolutePath = path.resolve(workspace, relativePath)
    if (!absolutePath.startsWith(`${workspace}${path.sep}`)) {
      throw new Error(`Task ${task.id} writes outside the eval workspace: ${relativePath}`)
    }
    // 先确保父目录存在（files 里可以写 "src/deep/nested/file.txt" 这类多级路径）
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, content, 'utf8')
  }

  return workspace
}

/**
 * 递归遍历目录，给所有文件拍一张"快照"（相对路径 -> 内容哈希）。
 * 跳过 .tegent 目录（那是 agent 自己的会话/状态数据，不算 agent 对代码的改动）。
 */
export async function listFiles(root: string): Promise<FileSnapshot> {
  const files: FileSnapshot = new Map()

  // 内部递归函数：逐个处理目录项，是目录就继续往下钻
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      // 忽略 agent 的内部状态目录
      if (entry.name === '.tegent') continue
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolutePath)
      else if (entry.isFile()) {
        // 统一转成 / 分隔的相对路径，保证 Windows/Linux 下路径一致
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/')
        // 用 SHA-256 哈希代表文件内容
        const content = await fs.readFile(absolutePath)
        files.set(relativePath, crypto.createHash('sha256').update(content).digest('hex'))
      }
    }
  }

  await visit(root)
  return files
}

/**
 * 对比任务开始前（before）和结束后（after）的两张快照，
 * 返回所有发生变化的文件路径（新增/修改/删除都算"变化"），按字母序排序。
 *
 * 判定逻辑：某文件在两张快照中的哈希不同（或只在其中一张出现）即为变化。
 * 该结果用于 onlyFiles 检查和报告里的 changedFiles 字段。
 */
export function changedFiles(before: FileSnapshot, after: FileSnapshot): string[] {
  // 合并两张快照的所有路径，保证任一边独有的文件也会被检查到
  const allPaths = new Set([...before.keys(), ...after.keys()])
  return [...allPaths].filter((filePath) => before.get(filePath) !== after.get(filePath)).sort()
}
