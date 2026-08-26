// Tests for skills/loader.ts（目录扫描、frontmatter 解析、配套文件列表、插件 extras 合并）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadSkills } from '../src/skills/loader.js'

// 每个用例的技能根目录都会被登记，afterEach 统一清理临时目录。
const roots: string[] = []

/** 创建一个空的技能根目录，并把它设为 XC_SKILLS_DIR 覆盖路径。 */
async function makeSkillRoot(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-skills-loader-'))
  roots.push(root)
  process.env.XC_SKILLS_DIR = root
  return root
}

/**
 * 在根目录下写一个技能目录。
 *
 * @param root 技能根目录。
 * @param dir 技能子目录名（可以和 frontmatter 里的 name 不同，注册表以 frontmatter 为准）。
 * @param skillMd SKILL.md 的完整内容。
 */
async function writeSkill(root: string, dir: string, skillMd: string): Promise<void> {
  const skillDir = path.join(root, dir)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd, 'utf-8')
}

/** 生成一段最小的合法 frontmatter + 正文。 */
function skillMd(name: string, description: string, body = 'Do the thing.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

beforeEach(() => {
  // 默认给一个空的覆盖目录：即使某个用例忘了建 fixture，loadSkills 也不会
  // 意外扫到开发机真实的 ~/.tegent/skills 或仓库里的 .tegent/skills。
  void makeSkillRoot()
})

afterEach(() => {
  delete process.env.XC_SKILLS_DIR
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('loadSkills', () => {
  it('loads skills from the XC_SKILLS_DIR override as project source', async () => {
    const root = process.env.XC_SKILLS_DIR!
    await writeSkill(root, 'alpha', skillMd('alpha', 'First skill'))
    await writeSkill(root, 'random-dir-name', skillMd('beta', 'Second skill'))

    const skills = await loadSkills()

    // 注册表以 frontmatter 的 name 为准，目录名不参与命名。
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'beta'])
    expect(skills[0]).toMatchObject({ source: 'project', description: 'First skill' })
    // 正文去掉首尾空白后保存。
    expect(skills[0]!.content).toBe('Do the thing.')
    // dir 指向包含 SKILL.md 的目录，激活时模型用它解析相对路径。
    expect(skills[0]!.dir).toBe(path.join(root, 'alpha'))
  })

  it('folds indented frontmatter continuation lines and strips surrounding quotes', async () => {
    const root = process.env.XC_SKILLS_DIR!
    await writeSkill(
      root,
      'folded',
      '---\nname: folded\ndescription: "A long description\n  continued on the next line"\n---\n\nBody.\n',
    )

    const skills = await loadSkills()

    // 缩进续行折叠成一行，最外层成对引号去掉。
    expect(skills[0]?.description).toBe('A long description continued on the next line')
  })

  it('skips entries without SKILL.md or with invalid frontmatter', async () => {
    const root = process.env.XC_SKILLS_DIR!
    // 没有 SKILL.md 的目录：直接跳过。
    fs.mkdirSync(path.join(root, 'no-skill-file'), { recursive: true })
    fs.writeFileSync(path.join(root, 'no-skill-file', 'README.md'), 'not a skill', 'utf-8')
    // 没有 frontmatter。
    await writeSkill(root, 'no-frontmatter', 'Just some prose.\n')
    // frontmatter 缺少必填的 description。
    await writeSkill(root, 'missing-description', '---\nname: missing-description\n---\n\nBody.\n')
    // frontmatter 缺少必填的 name。
    await writeSkill(root, 'missing-name', '---\ndescription: no name here\n---\n\nBody.\n')
    // 合法技能作对照，证明扫描本身仍在工作。
    await writeSkill(root, 'valid', skillMd('valid', 'Valid skill'))

    // 跳过时会打警告，测试里静音并断言确实报告过。
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const skills = await loadSkills()

    expect(skills.map((s) => s.name)).toEqual(['valid'])
    // 4 个坏目录里只有 3 个会打 error（no-skill-file 只是不含 SKILL.md，静默跳过）。
    expect(errorSpy).toHaveBeenCalledTimes(3)
  })

  it('lists bundled files excluding SKILL.md, hidden entries and heavy dirs, sorted with / separators', async () => {
    const root = process.env.XC_SKILLS_DIR!
    await writeSkill(root, 'bundled', skillMd('bundled', 'Skill with resources'))
    const skillDir = path.join(root, 'bundled')
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'scripts', 'run.sh'), 'echo ok', 'utf-8')
    fs.writeFileSync(path.join(skillDir, 'references', 'api.md'), '# API', 'utf-8')
    fs.writeFileSync(path.join(skillDir, '.hidden.txt'), 'hidden at root', 'utf-8')
    fs.writeFileSync(path.join(skillDir, 'references', '.hidden.md'), 'hidden in subdir', 'utf-8')
    fs.mkdirSync(path.join(skillDir, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'node_modules', 'dep.js'), 'heavy', 'utf-8')

    const skills = await loadSkills()

    // SKILL.md、隐藏文件、重目录都被排除；路径按字母序、分隔符统一为 /。
    expect(skills[0]?.files).toEqual(['references/api.md', 'scripts/run.sh'])
  })

  it('caps the bundled file list at 50 entries', async () => {
    const root = process.env.XC_SKILLS_DIR!
    await writeSkill(root, 'many-files', skillMd('many-files', 'Skill with many files'))
    const skillDir = path.join(root, 'many-files')
    for (let i = 1; i <= 55; i++) {
      fs.writeFileSync(path.join(skillDir, `file-${String(i).padStart(2, '0')}.txt`), `${i}`, 'utf-8')
    }

    const skills = await loadSkills()

    // 加载阶段就截断到上限；「已截断」的提示由激活时的 formatter 负责。
    expect(skills[0]?.files).toHaveLength(50)
  })

  it('merges plugin extra dirs after the override dir with pluginId and user source', async () => {
    const root = process.env.XC_SKILLS_DIR!
    await writeSkill(root, 'local', skillMd('local', 'Local skill'))

    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tegent-skills-plugin-'))
    roots.push(pluginDir)
    await writeSkill(pluginDir, 'plugin-skill', skillMd('plugin-skill', 'From a plugin'))

    const skills = await loadSkills({ extraDirs: [{ dir: pluginDir, pluginId: 'demo@marketplace' }] })

    // 覆盖目录（项目级）在前，插件技能在后：同名时项目级胜出。
    expect(skills.map((s) => s.name)).toEqual(['local', 'plugin-skill'])
    expect(skills[1]).toMatchObject({ source: 'user', pluginId: 'demo@marketplace' })
  })
})
