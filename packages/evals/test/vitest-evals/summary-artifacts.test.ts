import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildRunArtifact, writeRunArtifacts } from '../../src/artifacts.js'
import { renderSummaryMarkdown } from '../../src/summary.js'
import type { EvalResult } from '../../src/types.js'

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tegent-artifacts-test-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function result(overrides: Partial<EvalResult>): EvalResult {
  return {
    id: 'task-a',
    name: 'Task A',
    modelId: 'fake:model',
    success: true,
    durationMs: 1234,
    turnCount: 2,
    changedFiles: [],
    checks: [{ type: 'answerContains', passed: true, message: 'ok' }],
    toolCalls: 1,
    errors: [],
    finalText: 'done',
    trace: { text: 'done', tools: [], errors: [] },
    ...overrides,
  }
}

describe('eval summary and artifacts', () => {
  it('renders a stable markdown summary for pass and fail results', () => {
    const markdown = renderSummaryMarkdown({
      runId: 'run123',
      modelId: 'fake:model',
      createdAt: '2026-09-03T00:00:00.000Z',
      results: [
        result({ id: 'task-a', success: true }),
        result({
          id: 'task-b',
          success: false,
          checks: [{ type: 'fileEquals', passed: false, message: 'content differs' }],
          durationMs: 2400,
        }),
      ],
    })

    expect(markdown).toContain('# Tegent Eval Summary')
    expect(markdown).toContain('- Passed: 1/2')
    expect(markdown).toContain('| task-a | PASS | 1/1 | 2 | 1 | 1.2s |')
    expect(markdown).toContain('| task-b | FAIL | 0/1 | 2 | 1 | 2.4s |')
  })

  it('writes json and markdown artifacts for a run', async () => {
    const resultsDir = await makeTempRoot()
    const artifact = buildRunArtifact({
      runId: 'run123',
      modelId: 'fake:model',
      createdAt: '2026-09-03T00:00:00.000Z',
      results: [result({})],
    })

    const written = await writeRunArtifacts(resultsDir, artifact)

    await expect(fs.readFile(written.summaryPath, 'utf8')).resolves.toContain('- Passed: 1/1')
    const json = JSON.parse(await fs.readFile(written.jsonPath, 'utf8')) as { runId?: string; results?: unknown[] }
    expect(json.runId).toBe('run123')
    expect(json.results).toHaveLength(1)
  })
})
