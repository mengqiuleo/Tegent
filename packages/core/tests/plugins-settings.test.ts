// Tests for plugins/settings.ts（作用域路径、禁用状态读写、跨作用域并集）。
//
// settings 的真实路径是 ~/.tegent/settings.json 和 <cwd>/.tegent/settings.local.json，
// 测试不能碰这两个真实位置：用 getter 式 mock 把 USER_TEGENT_DIR 指到每个用例的
// 临时目录，project 作用域则用 process.cwd 的 spy 换成另一个临时目录。
// 和 skills-settings.test.ts 共用同一套手法。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const settingsPaths = vi.hoisted(() => ({ userDir: '', projectDir: '' }))

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/constants.js')>()
  return {
    ...actual,
    // 用 getter 而不是固定值：mkdtemp 在 beforeEach 里才执行，模块加载时路径还没定。
    get USER_TEGENT_DIR() {
      return settingsPaths.userDir
    },
  }
})

// mock 生效后再导入被测模块，保证它拿到的是 mock 后的 constants 绑定。
const { getScopedDisabledPlugins, loadDisabledPluginsSet, pluginSettingsPath, setPluginDisabled } =
  await import('../src/plugins/settings.js')

/** 直接读某个作用域 settings 文件的原始 JSON，用于断言磁盘上的真实内容。 */
function readRaw(scope: 'user' | 'project'): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(pluginSettingsPath(scope), 'utf-8')) as Record<string, unknown>
}

/** 往某个作用域的 settings 文件写入任意 JSON（会覆盖整个文件）。 */
function writeRaw(scope: 'user' | 'project', data: Record<string, unknown>): void {
  const file = pluginSettingsPath(scope)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
}

beforeEach(() => {
  settingsPaths.userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-plugins-set-user-'))
  settingsPaths.projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-plugins-set-proj-'))
  vi.spyOn(process, 'cwd').mockReturnValue(settingsPaths.projectDir)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(settingsPaths.userDir, { recursive: true, force: true })
  fs.rmSync(settingsPaths.projectDir, { recursive: true, force: true })
})

describe('pluginSettingsPath', () => {
  it('maps scopes to the user and project settings files', () => {
    // 和 skill 设置共用同一对文件：插件状态和技能状态写在同一个 settings 里。
    expect(pluginSettingsPath('user')).toBe(path.join(settingsPaths.userDir, 'settings.json'))
    expect(pluginSettingsPath('project')).toBe(
      path.join(settingsPaths.projectDir, '.tegent', 'settings.local.json'),
    )
  })
})

describe('setPluginDisabled / getScopedDisabledPlugins', () => {
  it('disables and re-enables within one scope, reporting noop for repeated calls', async () => {
    await expect(setPluginDisabled('demo@acme', 'user', true)).resolves.toBe('changed')
    await expect(setPluginDisabled('demo@acme', 'user', true)).resolves.toBe('noop')
    await expect(getScopedDisabledPlugins('user')).resolves.toEqual(['demo@acme'])

    await expect(setPluginDisabled('demo@acme', 'user', false)).resolves.toBe('changed')
    await expect(setPluginDisabled('demo@acme', 'user', false)).resolves.toBe('noop')
    await expect(getScopedDisabledPlugins('user')).resolves.toEqual([])
  })

  it('keeps unrelated fields and drops the disabledPlugins key when the list empties', async () => {
    // settings.json 里已经有 skill 设置和用户配置，插件写入必须原样保留。
    writeRaw('user', { model: 'zhipu:glm-4.7', disabledSkills: ['old'], disabledPlugins: ['stale'] })

    await setPluginDisabled('demo', 'user', true)
    // 排序写入，保证文件内容稳定；无关字段（含 disabledSkills）原样保留。
    expect(readRaw('user')).toEqual({
      model: 'zhipu:glm-4.7',
      disabledSkills: ['old'],
      disabledPlugins: ['demo', 'stale'],
    })

    await setPluginDisabled('demo', 'user', false)
    await setPluginDisabled('stale', 'user', false)
    // 列表清空后整个字段移除，settings 文件保持简洁。
    expect(readRaw('user')).toEqual({ model: 'zhipu:glm-4.7', disabledSkills: ['old'] })
  })
})

describe('loadDisabledPluginsSet', () => {
  it('merges user and project disabled lists into one set', async () => {
    await setPluginDisabled('shared', 'user', true)
    await setPluginDisabled('from-project', 'user', true)
    await setPluginDisabled('shared', 'project', true)
    await setPluginDisabled('project-only', 'project', true)

    const disabled = await loadDisabledPluginsSet()

    // 并集规则：任意作用域禁用即禁用。
    expect([...disabled].sort()).toEqual(['from-project', 'project-only', 'shared'])
  })

  it('returns an empty set when no settings files exist', async () => {
    await expect(loadDisabledPluginsSet()).resolves.toEqual(new Set())
  })

  it('tolerates corrupted settings files and non-string entries without throwing', async () => {
    fs.mkdirSync(path.dirname(pluginSettingsPath('user')), { recursive: true })
    fs.writeFileSync(pluginSettingsPath('user'), '{ not valid json !!', 'utf-8')
    fs.mkdirSync(path.dirname(pluginSettingsPath('project')), { recursive: true })
    // 数组结构 + 混入非字符串项：结构不对按空配置处理，字符串项之外的脏数据被清洗。
    fs.writeFileSync(pluginSettingsPath('project'), '{"disabledPlugins":["ok",42,null]}', 'utf-8')

    // 坏配置不阻塞启动；只有合法字符串 id 进入结果集合。
    await expect(loadDisabledPluginsSet()).resolves.toEqual(new Set(['ok']))
  })
})
