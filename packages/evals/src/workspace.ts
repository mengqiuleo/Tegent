import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { EvalTask } from './types.js'

export type FileSnapshot = Map<string, string>

export async function createEvalWorkspace(
  task: EvalTask,
  runId: string,
  fixturesDir: string,
): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `tegent-eval-${runId}-${task.id}-`))

  if (task.fixture) {
    await fs.cp(path.join(fixturesDir, task.fixture), workspace, { recursive: true })
  }

  for (const [relativePath, content] of Object.entries(task.files ?? {})) {
    const absolutePath = path.resolve(workspace, relativePath)
    if (!absolutePath.startsWith(`${workspace}${path.sep}`)) {
      throw new Error(`Task ${task.id} writes outside the eval workspace: ${relativePath}`)
    }
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, content, 'utf8')
  }

  return workspace
}

export async function listFiles(root: string): Promise<FileSnapshot> {
  const files: FileSnapshot = new Map()

  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.tegent') continue
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolutePath)
      else if (entry.isFile()) {
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/')
        const content = await fs.readFile(absolutePath)
        files.set(relativePath, crypto.createHash('sha256').update(content).digest('hex'))
      }
    }
  }

  await visit(root)
  return files
}

export function changedFiles(before: FileSnapshot, after: FileSnapshot): string[] {
  const allPaths = new Set([...before.keys(), ...after.keys()])
  return [...allPaths].filter((filePath) => before.get(filePath) !== after.get(filePath)).sort()
}
