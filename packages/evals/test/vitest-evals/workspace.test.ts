import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { changedFiles, createEvalWorkspace, listFiles } from '../../src/workspace.js'

const tempRoots: string[] = []

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('eval workspace helpers', () => {
  it('copies fixture files and overlays inline task files', async () => {
    const fixturesDir = await makeTempRoot('tegent-fixtures-test-')
    await fs.mkdir(path.join(fixturesDir, 'demo', 'src'), { recursive: true })
    await fs.writeFile(path.join(fixturesDir, 'demo', 'src', 'index.ts'), 'export const fixture = true\n', 'utf8')

    const workspace = await createEvalWorkspace(
      {
        id: 'workspace-copy',
        name: 'Workspace copy',
        prompt: 'irrelevant',
        fixture: 'demo',
        files: { 'README.md': '# Inline file\n' },
        checks: [],
      },
      'run123',
      fixturesDir,
    )
    tempRoots.push(workspace)

    await expect(fs.readFile(path.join(workspace, 'src', 'index.ts'), 'utf8')).resolves.toBe('export const fixture = true\n')
    await expect(fs.readFile(path.join(workspace, 'README.md'), 'utf8')).resolves.toBe('# Inline file\n')
  })

  it('ignores .tegent runtime files when computing snapshots', async () => {
    const workspace = await makeTempRoot('tegent-snapshot-test-')
    await fs.mkdir(path.join(workspace, '.tegent'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.tegent', 'session.jsonl'), '{}\n', 'utf8')
    await fs.writeFile(path.join(workspace, 'visible.txt'), 'tracked\n', 'utf8')

    const snapshot = await listFiles(workspace)

    expect([...snapshot.keys()]).toEqual(['visible.txt'])
  })

  it('reports created, modified, and deleted files', async () => {
    const workspace = await makeTempRoot('tegent-change-test-')
    await fs.writeFile(path.join(workspace, 'modified.txt'), 'before\n', 'utf8')
    await fs.writeFile(path.join(workspace, 'deleted.txt'), 'remove\n', 'utf8')
    const before = await listFiles(workspace)

    await fs.writeFile(path.join(workspace, 'modified.txt'), 'after\n', 'utf8')
    await fs.writeFile(path.join(workspace, 'created.txt'), 'new\n', 'utf8')
    await fs.rm(path.join(workspace, 'deleted.txt'))
    const after = await listFiles(workspace)

    expect(changedFiles(before, after)).toEqual(['created.txt', 'deleted.txt', 'modified.txt'])
  })

  it('rejects inline task files that escape the eval workspace', async () => {
    const fixturesDir = await makeTempRoot('tegent-fixtures-test-')

    await expect(
      createEvalWorkspace(
        {
          id: 'escape',
          name: 'Escape',
          prompt: 'irrelevant',
          files: { '../escape.txt': 'nope\n' },
          checks: [],
        },
        'run123',
        fixturesDir,
      ),
    ).rejects.toThrow('outside the eval workspace')
  })
})
