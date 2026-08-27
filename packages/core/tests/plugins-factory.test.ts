// Tests for createPluginRegistry / reloadPluginRegistry（工厂函数的组装逻辑：
// loader 扫描结果 + settings 禁用集合如何汇进同一个注册表，以及原地刷新的 diff）。
//
// 用和 plugins-settings.test.ts 相同的 getter 式 mock 隔离真实目录：
// USER_TEGENT_DIR 指到临时目录（settings 和插件缓存都在它下面），cwd 指到另一个临时目录。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dirOverrides = vi.hoisted(() => ({ userDir: '', projectDir: '' }))

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/constants.js')>()
  return {
    ...actual,
    // 用 getter 而不是固定值：mkdtemp 在 beforeEach 里才执行，模块加载时路径还没定。
    get USER_TEGENT_DIR() {
      return dirOverrides.userDir
    },
  }
})

// mock 生效后再导入被测模块，保证它拿到的是 mock 后的 constants 绑定。
const { createPluginRegistry, reloadPluginRegistry } = await import('../src/plugins/registry.js')
const { setPluginDisabled } = await import('../src/plugins/settings.js')

/** 在用户缓存目录（<userDir>/plugins/cache/<name>）下写入一个插件清单。 */
function writeCachedPlugin(name: string, version: string): string {
  const pluginDir = path.join(dirOverrides.userDir, 'plugins', 'cache', name, '.tegent-plugin')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify({ name, version }),
    'utf-8',
  )
  return pluginDir
}

beforeEach(() => {
  dirOverrides.userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-plugins-fact-user-'))
  dirOverrides.projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-plugins-fact-proj-'))
  vi.spyOn(process, 'cwd').mockReturnValue(dirOverrides.projectDir)
})

afterEach(() => {
  // 先取出被 spy 的临时 cwd 再恢复 spy：恢复后 process.cwd() 是真实工作目录。
  const dirs = [dirOverrides.userDir, dirOverrides.projectDir]
  vi.restoreAllMocks()
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('createPluginRegistry', () => {
  it('assembles the registry from the loader result and the disabled set', async () => {
    writeCachedPlugin('demo', '1.0.0')
    writeCachedPlugin('muted', '1.0.0')
    await setPluginDisabled('muted', 'user', true) // settings 里禁用 muted。

    const registry = await createPluginRegistry()

    // 工厂 = loadPlugins + loadDisabledPluginsSet + 构造：禁用项进 listAll 不进 list。
    expect(registry.names()).toEqual(['demo'])
    expect(registry.listAll().map((p) => p.id).sort()).toEqual(['demo', 'muted'])
  })

  it('returns an empty-but-usable registry when nothing is installed', async () => {
    const registry = await createPluginRegistry()
    expect(registry.list()).toEqual([])
  })
})

describe('reloadPluginRegistry', () => {
  it('diffs disk state against the in-memory registry in place', async () => {
    writeCachedPlugin('demo', '1.0.0')
    const registry = await createPluginRegistry()
    const before = registry

    // 磁盘变化：demo 升级、新增 extra、settings 新禁用 demo。
    writeCachedPlugin('demo', '2.0.0')
    writeCachedPlugin('extra', '1.0.0')
    await setPluginDisabled('demo', 'user', true)

    const summary = await reloadPluginRegistry(registry)

    expect(summary).toMatchObject({ added: ['extra'], removed: [], changed: ['demo'], unchanged: [] })
    // 原地刷新：对象身份不变，内容已是最新。
    expect(registry).toBe(before)
    expect(registry.getEntry('demo')?.version).toBe('2.0.0')
    expect(registry.getEntry('demo')?.disabled).toBe(true)
    expect(registry.names()).toEqual(['extra']) // demo 被禁用后从可见集合消失。
  })
})
