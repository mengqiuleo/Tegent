// Tests for skills/settings.ts（作用域路径、禁用状态读写、跨作用域并集）。
//
// settings 的真实路径是 ~/.tegent/settings.json 和 <cwd>/.tegent/settings.local.json，
// 测试不能碰这两个真实位置：用 getter 式 mock 把 USER_TEGENT_DIR 指到每个用例的
// 临时目录，project 作用域则用 process.cwd 的 spy 换成另一个临时目录。
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
const { getScopedDisabledSkills, loadDisabledSkillsSet, setSkillDisabled, skillSettingsPath } =
  await import('../src/skills/settings.js')

/** 直接读某个作用域 settings 文件的原始 JSON，用于断言磁盘上的真实内容。 */
function readRaw(scope: 'user' | 'project'): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(skillSettingsPath(scope), 'utf-8')) as Record<string, unknown>
}

/** 往某个作用域的 settings 文件写入任意 JSON（会覆盖整个文件）。 */
function writeRaw(scope: 'user' | 'project', data: Record<string, unknown>): void {
  const file = skillSettingsPath(scope)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
}

beforeEach(() => {
  settingsPaths.userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-skills-set-user-'))
  settingsPaths.projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-skills-set-proj-'))
  vi.spyOn(process, 'cwd').mockReturnValue(settingsPaths.projectDir)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(settingsPaths.userDir, { recursive: true, force: true })
  fs.rmSync(settingsPaths.projectDir, { recursive: true, force: true })
})

describe('skillSettingsPath', () => {
  it('maps scopes to the user and project settings files', () => {
    expect(skillSettingsPath('user')).toBe(path.join(settingsPaths.userDir, 'settings.json'))
    expect(skillSettingsPath('project')).toBe(
      path.join(settingsPaths.projectDir, '.tegent', 'settings.local.json'),
    )
  })
})

describe('setSkillDisabled / getScopedDisabledSkills', () => {
  it('disables and re-enables within one scope, reporting noop for repeated calls', async () => {
    await expect(setSkillDisabled('demo', 'user', true)).resolves.toBe('changed')
    await expect(setSkillDisabled('demo', 'user', true)).resolves.toBe('noop')
    await expect(getScopedDisabledSkills('user')).resolves.toEqual(['demo'])

    await expect(setSkillDisabled('demo', 'user', false)).resolves.toBe('changed')
    await expect(setSkillDisabled('demo', 'user', false)).resolves.toBe('noop')
    await expect(getScopedDisabledSkills('user')).resolves.toEqual([])
  })

  it('keeps unrelated fields and drops the disabledSkills key when the list empties', async () => {
    writeRaw('user', { model: 'zhipu:glm-4.7', disabledSkills: ['old'] })

    await setSkillDisabled('demo', 'user', true)
    // 排序写入，保证文件内容稳定；无关字段原样保留。
    expect(readRaw('user')).toEqual({ model: 'zhipu:glm-4.7', disabledSkills: ['demo', 'old'] })

    await setSkillDisabled('demo', 'user', false)
    await setSkillDisabled('old', 'user', false)
    // 列表清空后整个字段移除，settings 文件保持简洁。
    expect(readRaw('user')).toEqual({ model: 'zhipu:glm-4.7' })
  })
})

describe('loadDisabledSkillsSet', () => {
  it('merges user and project disabled lists into one set', async () => {
    await setSkillDisabled('shared', 'user', true)
    await setSkillDisabled('from-project', 'user', true)
    await setSkillDisabled('shared', 'project', true)
    await setSkillDisabled('project-only', 'project', true)

    const disabled = await loadDisabledSkillsSet()

    // 并集规则：任意作用域禁用即禁用。
    expect([...disabled].sort()).toEqual(['from-project', 'project-only', 'shared'])
  })

  it('returns an empty set when no settings files exist', async () => {
    await expect(loadDisabledSkillsSet()).resolves.toEqual(new Set())
  })

  it('tolerates corrupted settings files without throwing', async () => {
    fs.mkdirSync(path.dirname(skillSettingsPath('user')), { recursive: true })
    fs.writeFileSync(skillSettingsPath('user'), '{ not valid json !!', 'utf-8')
    fs.mkdirSync(path.dirname(skillSettingsPath('project')), { recursive: true })
    fs.writeFileSync(skillSettingsPath('project'), '[]', 'utf-8')

    // 坏配置不阻塞启动：JSON 语法错误和非对象结构都按空配置处理。
    await expect(loadDisabledSkillsSet()).resolves.toEqual(new Set())
  })
})
