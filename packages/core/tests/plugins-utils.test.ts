// Tests for plugins/utils.ts（id 拼拆、名字校验、路径计算）。
//
// pluginCacheDir/projectPluginsDir 依赖 USER_TEGENT_DIR 常量和 process.cwd，
// 用和 skills-settings.test.ts 相同的 getter 式 mock 指到临时目录，避免碰真实位置。
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
const {
  formatPluginId,
  isValidPluginName,
  parsePluginId,
  pluginCacheDir,
  pluginManifestPath,
  projectPluginsDir,
} = await import('../src/plugins/utils.js')

beforeEach(() => {
  dirOverrides.userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-plugins-utils-user-'))
  dirOverrides.projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-plugins-utils-proj-'))
  vi.spyOn(process, 'cwd').mockReturnValue(dirOverrides.projectDir)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dirOverrides.userDir, { recursive: true, force: true })
  fs.rmSync(dirOverrides.projectDir, { recursive: true, force: true })
})

describe('plugin dirs', () => {
  it('maps the user cache dir and the project plugins dir', () => {
    expect(pluginCacheDir()).toBe(path.join(dirOverrides.userDir, 'plugins', 'cache'))
    expect(projectPluginsDir()).toBe(path.join(dirOverrides.projectDir, '.tegent', 'plugins'))
  })

  it('builds the manifest path under .tegent-plugin', () => {
    expect(pluginManifestPath(path.join(dirOverrides.userDir, 'plugins', 'cache', 'demo'))).toBe(
      path.join(
        dirOverrides.userDir,
        'plugins',
        'cache',
        'demo',
        '.tegent-plugin',
        'plugin.json',
      ),
    )
  })
})

describe('formatPluginId / parsePluginId', () => {
  it('formats bare names and marketplace-qualified ids', () => {
    expect(formatPluginId('demo')).toBe('demo')
    expect(formatPluginId('demo', 'acme')).toBe('demo@acme')
  })

  it('parses ids with and without a marketplace part', () => {
    expect(parsePluginId('demo')).toEqual({ name: 'demo' })
    expect(parsePluginId('demo@acme')).toEqual({ name: 'demo', marketplace: 'acme' })
  })

  it('round-trips through format then parse', () => {
    const id = formatPluginId('demo', 'acme')
    expect(parsePluginId(id)).toEqual({ name: 'demo', marketplace: 'acme' })
  })

  it('splits on the last @ when the marketplace itself contains one', () => {
    // 插件名不允许 @（见 isValidPluginId），所以多余的 @ 只可能来自 marketplace 侧。
    expect(parsePluginId('demo@acme@mirror')).toEqual({ name: 'demo', marketplace: 'acme@mirror' })
  })
})

describe('isValidPluginName', () => {
  it('accepts npm-style names', () => {
    expect(isValidPluginName('demo')).toBe(true)
    expect(isValidPluginName('my-plugin')).toBe(true)
    expect(isValidPluginName('plugin.v2')).toBe(true)
    expect(isValidPluginName('a'.repeat(214))).toBe(true)
  })

  it('rejects empty, oversized, scoped, uppercase and path-like names', () => {
    expect(isValidPluginName('')).toBe(false)
    expect(isValidPluginName('a'.repeat(215))).toBe(false) // 超过 npm 长度上限。
    expect(isValidPluginName('@scope/demo')).toBe(false) // 不支持 scoped 名，@ 不是合法字符。
    expect(isValidPluginName('Demo')).toBe(false) // 大写会导致大小写不敏感文件系统上目录名碰撞。
    expect(isValidPluginName('../escape')).toBe(false) // 拒绝路径穿越形态的名字。
    expect(isValidPluginName('.hidden')).toBe(false) // 首字符必须是字母或数字。
  })
})
