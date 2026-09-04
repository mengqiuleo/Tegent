import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runChecks } from '../../src/checks.js'
import type { EvalTask, EvalTrace } from '../../src/types.js'
import { listFiles } from '../../src/workspace.js'

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tegent-checks-test-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('runChecks', () => {
  it('passes deterministic answer, file, json, command, and changed-file checks', async () => {
    const workspace = await makeTempRoot()
    await fs.writeFile(path.join(workspace, 'config.json'), JSON.stringify({ enabled: false, name: 'demo' }), 'utf8')
    const before = await listFiles(workspace)

    await fs.writeFile(path.join(workspace, 'config.json'), JSON.stringify({ enabled: true, name: 'demo' }), 'utf8')
    await fs.writeFile(path.join(workspace, 'notes.txt'), 'Eval task completed.\n', 'utf8')
    const after = await listFiles(workspace)

    const task: EvalTask = {
      id: 'checks-pass',
      name: 'Checks pass',
      prompt: 'irrelevant',
      checks: [
        { type: 'answerContains', values: ['Tegent', '3'] },
        { type: 'fileEquals', path: 'notes.txt', content: 'Eval task completed.\n' },
        { type: 'jsonPathEquals', path: 'config.json', pathExpr: 'enabled', value: true },
        { type: 'command', command: 'node -e "process.exit(0)"' },
        { type: 'onlyFiles', paths: ['config.json', 'notes.txt'] },
      ],
    }
    const trace: EvalTrace = { text: 'Project Tegent has 3 enabled features.', tools: [], errors: [] }

    const results = await runChecks(workspace, task, trace, before, after)

    expect(results).toHaveLength(task.checks.length)
    expect(results.every((result) => result.passed)).toBe(true)
  })

  it('fails onlyFiles when the agent modifies an unexpected file', async () => {
    const workspace = await makeTempRoot()
    await fs.writeFile(path.join(workspace, 'public.txt'), 'before\n', 'utf8')
    const before = await listFiles(workspace)

    await fs.writeFile(path.join(workspace, 'public.txt'), 'after\n', 'utf8')
    await fs.writeFile(path.join(workspace, 'private.txt'), 'changed\n', 'utf8')
    const after = await listFiles(workspace)

    const task: EvalTask = {
      id: 'scope-fail',
      name: 'Scope fail',
      prompt: 'irrelevant',
      checks: [{ type: 'onlyFiles', paths: ['public.txt'] }],
    }

    const [result] = await runChecks(workspace, task, { text: '', tools: [], errors: [] }, before, after)

    expect(result?.passed).toBe(false)
    expect(result?.message).toContain('private.txt')
  })
})
