import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { toolCalls, type HarnessContext } from 'vitest-evals'

import type { LanguageModel } from '../../../core/src/index.js'
import type { RunAgent } from '../../src/tegent-harness.js'
import { createTegentVitestHarness } from '../../src/vitest-harness.js'

const tempRoots: string[] = []

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('createTegentVitestHarness', () => {
  it('normalizes a Tegent eval result into a vitest-evals harness run', async () => {
    const fixturesDir = await makeTempRoot('tegent-vitest-harness-fixtures-')
    const runAgent: RunAgent = async ({ callbacks }) => {
      callbacks.onTextDelta('Created notes.txt.')
      callbacks.onToolCall('call-1', 'write_file', { path: 'notes.txt' })
      await fs.writeFile(path.join(process.cwd(), 'notes.txt'), 'Eval task completed.\n', 'utf8')
      callbacks.onToolResult('call-1', 'ok', false)
      callbacks.onUsageUpdate({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        currentContextTokens: 15,
      })
      return { state: {}, turnCount: 2 }
    }
    const harness = createTegentVitestHarness({
      modelId: 'fake:model',
      model: {} as LanguageModel,
      maxTurns: 5,
      runId: 'run123',
      fixturesDir,
      runAgent,
      persistSession: async () => undefined,
    })
    const artifacts: HarnessContext['artifacts'] = {}

    const run = await harness.run(
      {
        id: 'create-file',
        name: 'Create file',
        prompt: 'Create notes.txt',
        checks: [{ type: 'fileEquals', path: 'notes.txt', content: 'Eval task completed.\n' }],
      },
      {
        artifacts,
        setArtifact: (name, value) => {
          artifacts[name] = value
        },
      },
    )

    expect(run.output.success).toBe(true)
    expect(run.session.events[0]).toMatchObject({ type: 'message', role: 'user' })
    expect(toolCalls(run)).toEqual([{ name: 'write_file', arguments: { path: 'notes.txt' }, status: 'ok', result: 'ok' }])
    expect(run.usage).toMatchObject({ provider: 'fake', model: 'model', inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    expect(artifacts.changedFiles).toEqual(['notes.txt'])
    expect(run.traces?.[0]?.spans.map((span) => span.kind)).toContain('agent')
  })
})
