// Tests for plugins/loader.ts（目录扫描、清单解析、fail-soft、来源顺序）。
//
// 用真实临时目录 + 真实文件系统验证 loader 行为；扫描路径全部通过
// LoadPluginsOptions 注入，不碰 ~/.tegent 和 <cwd>/.tegent。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadPlugins } from '../src/plugins/loader.js'

let userDir: string
let projectDir: string
let cwdDir: string // 被 spy 的临时 cwd；afterEach 要在恢复 spy 之前先取出来，避免误删真实目录。

/** 在某个插件根目录下写入一个插件（清单 + 可选的其他字段）。 */
function writePlugin(
  root: string,
  name: string,
  manifest: Record<string, unknown> = { version: '1.0.0' },
): string {
  const pluginDir = path.join(root, name)
  const manifestDir = path.join(pluginDir, '.tegent-plugin')
  fs.mkdirSync(manifestDir, { recursive: true })
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    JSON.stringify({ name, ...manifest }),
    'utf-8',
  )
  return pluginDir
}

/** 直接写任意清单内容；构造“缺 name 字段”这类 helper 覆盖不了的场景。 */
function writeRawManifest(root: string, name: string, data: unknown): string {
  const pluginDir = path.join(root, name)
  const manifestDir = path.join(pluginDir, '.tegent-plugin')
  fs.mkdirSync(manifestDir, { recursive: true })
  fs.writeFileSync(path.join(manifestDir, 'plugin.json'), JSON.stringify(data), 'utf-8')
  return pluginDir
}

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-plugins-loader-user-'))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-plugins-loader-proj-'))
  // loadPlugins 默认会读 process.cwd 下的 .tegent/plugins；这里显式传入两个目录后
  // cwd 不该被读到。spy 成一个空临时目录兜底，防止误读开发机真实项目。
  cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-plugins-loader-cwd-'))
  vi.spyOn(process, 'cwd').mockReturnValue(cwdDir)
})

afterEach(() => {
  // 必须先取出被 spy 的临时 cwd 再恢复 spy：恢复后 process.cwd() 是真实工作目录。
  const dirs = [userDir, projectDir, cwdDir]
  vi.restoreAllMocks()
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('loadPlugins', () => {
  it('returns an empty list when no plugin dirs exist', async () => {
    // 目录都不存在：按“没有插件”处理，不抛错。
    await expect(
      loadPlugins({ userDir: path.join(userDir, 'missing'), projectDir: path.join(projectDir, 'missing') }),
    ).resolves.toEqual([])
  })

  it('loads manifests from the user cache dir with full metadata', async () => {
    const dir = writePlugin(userDir, 'demo', {
      version: '2.1.0',
      description: 'a demo plugin',
      author: 'tegent',
    })

    const plugins = await loadPlugins({ userDir, projectDir })

    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toEqual({
      id: 'demo', // 没有 marketplace 字段时 id 就是裸名。
      name: 'demo',
      version: '2.1.0',
      description: 'a demo plugin',
      author: 'tegent',
      source: 'user',
      dir,
      manifestPath: path.join(dir, '.tegent-plugin', 'plugin.json'),
    })
  })

  it('formats marketplace-qualified ids', async () => {
    writePlugin(userDir, 'demo', { version: '1.0.0', marketplace: 'acme' })

    const plugins = await loadPlugins({ userDir, projectDir })

    expect(plugins[0]?.id).toBe('demo@acme')
    expect(plugins[0]?.marketplace).toBe('acme')
  })

  it('loads user plugins before project plugins so the registry lets project win', async () => {
    writePlugin(userDir, 'shared', { version: '1.0.0' })
    writePlugin(userDir, 'user-only', { version: '1.0.0' })
    writePlugin(projectDir, 'shared', { version: '2.0.0' })
    writePlugin(projectDir, 'project-only', { version: '1.0.0' })

    const plugins = await loadPlugins({ userDir, projectDir })

    // 契约是“用户级整体先于项目级”（readdir 的目录内顺序没有保证，不影响正确性）：
    // PluginRegistry 按“后写覆盖”让项目级 shared 覆盖用户缓存里的版本。
    const labels = plugins.map((p) => `${p.id}@${p.source}`)
    expect(labels).toHaveLength(4)
    const lastUser = labels.map((l) => l.endsWith('@user')).lastIndexOf(true)
    const firstProject = labels.map((l) => l.endsWith('@project')).indexOf(true)
    expect(lastUser).toBeGreaterThan(-1)
    expect(firstProject).toBeGreaterThan(-1)
    expect(lastUser).toBeLessThan(firstProject)

    // 同 id 双份都在列表里，覆盖胜负由注册表决定（见 plugins-registry.test.ts）。
    expect(labels.filter((l) => l.startsWith('shared@'))).toEqual(['shared@user', 'shared@project'])
  })

  it('ignores plain files and directories without a manifest', async () => {
    fs.writeFileSync(path.join(userDir, 'README.md'), 'not a plugin', 'utf-8')
    fs.mkdirSync(path.join(userDir, 'no-manifest'), { recursive: true }) // 无清单目录：静默跳过。

    const plugins = await loadPlugins({ userDir, projectDir })

    expect(plugins).toEqual([])
  })

  it('skips broken manifests with a warning instead of throwing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // 四种坏清单：JSON 语法错误、缺 name、缺 version、非法插件名（大写）。
    const badJsonDir = path.join(userDir, 'bad-json', '.tegent-plugin')
    fs.mkdirSync(badJsonDir, { recursive: true })
    fs.writeFileSync(path.join(badJsonDir, 'plugin.json'), '{ not json !!', 'utf-8')
    writeRawManifest(userDir, 'no-name', { version: '1.0.0' })
    writeRawManifest(userDir, 'no-version', { name: 'no-version' })
    writePlugin(userDir, 'Invalid_Name', { version: '1.0.0' })

    const plugins = await loadPlugins({ userDir, projectDir })

    // 一个坏清单只影响自己：全部被跳过但绝不抛错，警告逐个打印。
    expect(plugins).toEqual([])
    expect(errSpy).toHaveBeenCalledTimes(4)
    for (const call of errSpy.mock.calls) {
      expect(String(call[0])).toMatch(/^\[plugins\] Skipping .*plugin\.json/)
    }
    errSpy.mockRestore()
  })
})
