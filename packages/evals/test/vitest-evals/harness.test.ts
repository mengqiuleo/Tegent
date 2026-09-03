import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { LanguageModel } from '../../../core/src/index.js'
import { TegentCodingAgentHarness, type RunAgent } from '../../src/tegent-harness.js'
import type { EvalTask } from '../../src/types.js'

const tempRoots: string[] = []

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('TegentCodingAgentHarness', () => {
  it('runs a task with an injected agent runner and grades the resulting workspace', async () => {
    const fixturesDir = await makeTempRoot('tegent-harness-fixtures-')
    const runAgent: RunAgent = async ({ callbacks }) => {
      callbacks.onTextDelta('Created the expected notes file.')
      callbacks.onToolCall('tool-1', 'write_file', { path: 'notes.txt' })
      await fs.writeFile(path.join(process.cwd(), 'notes.txt'), 'Eval task completed.\n', 'utf8')
      callbacks.onToolResult('tool-1', 'ok', false)
      return { state: { session: 'fake' }, turnCount: 2 }
    }
    let persisted = false
    const harness = new TegentCodingAgentHarness({
      modelId: 'fake:model',
      model: {} as LanguageModel,
      maxTurns: 5,
      keepWorkspaces: false,
      runId: 'run123',
      fixturesDir,
      runAgent,
      persistSession: async () => {
        persisted = true
      },
    })
    const task: EvalTask = {
      id: 'create-file',
      name: 'Create file',
      prompt: 'Create notes.txt',
      checks: [
        { type: 'fileEquals', path: 'notes.txt', content: 'Eval task completed.\n' },
        { type: 'onlyFiles', paths: ['notes.txt'] },
      ],
    }

    const result = await harness.run(task)

    expect(result.success).toBe(true)
    expect(result.turnCount).toBe(2)
    expect(result.toolCalls).toBe(1)
    expect(result.changedFiles).toEqual(['notes.txt'])
    expect(result.workspacePath).toBeUndefined()
    expect(persisted).toBe(true)
  })

  it('keeps the workspace path for debugging when requested', async () => {
    const fixturesDir = await makeTempRoot('tegent-harness-fixtures-')
    const harness = new TegentCodingAgentHarness({
      modelId: 'fake:model',
      model: {} as LanguageModel,
      maxTurns: 5,
      keepWorkspaces: true,
      runId: 'run123',
      fixturesDir,
      runAgent: async () => {
        await fs.writeFile(path.join(process.cwd(), 'debug.txt'), 'kept\n', 'utf8')
        return { state: {}, turnCount: 1 }
      },
      persistSession: async () => undefined,
    })

    const result = await harness.run({
      id: 'keep-workspace',
      name: 'Keep workspace',
      prompt: 'Create debug.txt',
      checks: [{ type: 'fileEquals', path: 'debug.txt', content: 'kept\n' }],
    })

    expect(result.success).toBe(true)
    expect(result.workspacePath).toBeTruthy()
    if (result.workspacePath) {
      tempRoots.push(result.workspacePath)
      await expect(fs.readFile(path.join(result.workspacePath, 'debug.txt'), 'utf8')).resolves.toBe('kept\n')
    }
  })
})
