// Tests for plugins/integration.ts（pluginSkillDirs 纯换算 + 与 loadSkills 的端到端契约：
// 插件 skills/ 目录经 extraDirs 并入后，SkillDefinition.pluginId 保留插件来源）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadSkills } from '../src/skills/loader.js'
import { pluginSkillDirs } from '../src/plugins/integration.js'
import type { PluginDefinition } from '../src/plugins/types.js'

/** 生成一个最小的插件定义；测试只关心 dir 和 id。 */
function makePlugin(overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id: 'demo',
    name: 'demo',
    version: '1.0.0',
    source: 'user',
    dir: '/plugins/cache/demo',
    manifestPath: '/plugins/cache/demo/.tegent-plugin/plugin.json',
    ...overrides,
  }
}

// 端到端用例的临时目录登记，afterEach 统一清理。
const roots: string[] = []

beforeEach(() => {
  // 端到端用例借助 XC_SKILLS_DIR 把内置技能目录指到空的临时目录，
  // 避免扫到开发机真实的技能；插件贡献内容走 extraDirs 照常加载。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-plugins-integration-'))
  roots.push(root)
  process.env.XC_SKILLS_DIR = root
})

afterEach(() => {
  delete process.env.XC_SKILLS_DIR
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('pluginSkillDirs', () => {
  it('maps each plugin to its skills dir carrying the plugin id', () => {
    const dirs = pluginSkillDirs([
      makePlugin({ id: 'demo', dir: path.join('/plugins', 'cache', 'demo') }),
      makePlugin({ id: 'paid@acme', name: 'paid', dir: path.join('/plugins', 'cache', 'paid') }),
    ])

    expect(dirs).toEqual([
      { dir: path.join('/plugins', 'cache', 'demo', 'skills'), pluginId: 'demo' },
      { dir: path.join('/plugins', 'cache', 'paid', 'skills'), pluginId: 'paid@acme' },
    ])
  })

  it('returns an empty list for an empty plugin list', () => {
    expect(pluginSkillDirs([])).toEqual([])
  })
})

describe('pluginSkillDirs + loadSkills', () => {
  it('merges plugin skills into loadSkills output with pluginId provenance', async () => {
    // 在临时目录里搭一个最小插件：skills/hello/SKILL.md。
    const pluginRoot = path.dirname(process.env.XC_SKILLS_DIR!)
    const pluginDir = path.join(pluginRoot, 'demo-plugin')
    const skillDir = path.join(pluginDir, 'skills', 'hello')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: hello\ndescription: greets from a plugin\n---\n\nSay hello.',
      'utf-8',
    )

    const skills = await loadSkills({ extraDirs: pluginSkillDirs([makePlugin({ id: 'demo', dir: pluginDir })]) })

    // 插件 skill 正常加载，source 落在 user，真实来源由 pluginId 表达。
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: 'hello',
      description: 'greets from a plugin',
      pluginId: 'demo',
      source: 'user',
    })
  })

  it('tolerates plugins without a skills dir (missing dir loads nothing)', async () => {
    // 插件目录存在但没有 skills/ 子目录：loadSkillsFromDir 的 readdir fail-soft，
    // extraDirs 里多一个不存在的路径不影响其余技能加载，也不抛错。
    const pluginDir = path.join(path.dirname(process.env.XC_SKILLS_DIR!), 'bare-plugin')
    fs.mkdirSync(pluginDir, { recursive: true })

    const skills = await loadSkills({ extraDirs: pluginSkillDirs([makePlugin({ id: 'bare', dir: pluginDir })]) })

    expect(skills).toEqual([])
  })
})
