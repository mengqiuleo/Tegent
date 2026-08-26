// Tests for skills/registry.ts（注册表过滤、reload diff、激活格式化）
// 以及 tools/activate-skill.ts（activateSkill 工具行为）。全部是纯逻辑，不落盘。
import { describe, expect, it } from 'vitest'

import {
  SkillRegistry,
  formatSkillActivationBody,
  wrapActivatedSkill,
} from '../src/skills/registry.js'
import type { SkillDefinition } from '../src/skills/registry.js'
import { createActivateSkillTool } from '../src/tools/activate-skill.js'

/** 生成一个最小的技能定义；dir 只是字符串，激活格式化不做任何文件系统操作。 */
function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'demo',
    description: 'demo skill',
    content: 'Do the demo thing.',
    source: 'user',
    dir: '/skills/demo',
    files: [],
    ...overrides,
  }
}

describe('SkillRegistry', () => {
  it('lets later definitions override same-name earlier ones', () => {
    const registry = new SkillRegistry([
      makeSkill({ name: 'shared', content: 'user version', source: 'user' }),
      makeSkill({ name: 'shared', content: 'project version', source: 'project' }),
    ])

    // loadSkills 按用户级 → 插件级 → 项目级顺序返回，后者覆盖前者。
    expect(registry.get('shared')?.content).toBe('project version')
    expect(registry.list()).toHaveLength(1)
  })

  it('hides disabled skills from get/list/names but keeps them in listAll/getEntry', () => {
    const registry = new SkillRegistry(
      [makeSkill({ name: 'on' }), makeSkill({ name: 'off' })],
      new Set(['off']),
    )

    expect(registry.get('off')).toBeUndefined()
    expect(registry.names()).toEqual(['on'])
    expect(registry.list().map((s) => s.name)).toEqual(['on'])

    // /skill list 和 enable/disable handler 需要看见禁用项，走 listAll/getEntry。
    const entry = registry.getEntry('off')
    expect(entry?.disabled).toBe(true)
    expect(registry.listAll().map((s) => s.name).sort()).toEqual(['off', 'on'])
  })

  it('classifies reload diffs into added/removed/changed/unchanged', () => {
    const registry = new SkillRegistry([makeSkill({ name: 'kept' }), makeSkill({ name: 'gone' })])

    const summary = registry.reload([makeSkill({ name: 'kept' })], new Set())

    expect(summary).toMatchObject({ added: [], removed: ['gone'], changed: [], unchanged: ['kept'] })
    expect(registry.get('gone')).toBeUndefined()
  })

  it('marks content and disabled-state flips as changes', () => {
    const registry = new SkillRegistry([makeSkill({ name: 'a' }), makeSkill({ name: 'b' })])

    const summary = registry.reload(
      [
        makeSkill({ name: 'a', content: 'rewritten' }),
        makeSkill({ name: 'b' }), // 描述/内容一致，但下面被禁用了
      ],
      new Set(['b']),
    )

    expect(summary.changed.sort()).toEqual(['a', 'b'])
    expect(summary.unchanged).toEqual([])
    // 禁用状态在 reload 后立即反映到 agent 可见集合。
    expect(registry.names()).toEqual(['a'])
  })

  it('reports newly added skills in the reload summary', () => {
    const registry = new SkillRegistry([makeSkill({ name: 'old' })])

    const summary = registry.reload(
      [makeSkill({ name: 'old' }), makeSkill({ name: 'fresh', source: 'project' })],
      new Set(),
    )

    expect(summary.added).toEqual(['fresh'])
    expect(registry.names().sort()).toEqual(['fresh', 'old'])
  })
})

describe('formatSkillActivationBody / wrapActivatedSkill', () => {
  it('wraps content in the activated_skill shell with base dir and path hint', () => {
    const skill = makeSkill({
      content: '\n  Trimmed body line.\n\n',
      dir: '/skills/demo',
      files: ['references/api.md', 'scripts/run.sh'],
    })

    const wrapped = wrapActivatedSkill(skill)

    // 两条激活路径（模型自主调用 / 用户敲 slash）共享同一份字节流。
    expect(wrapped).toBe(`<activated_skill name="demo">
Trimmed body line.

Base directory for this skill: /skills/demo
Relative paths in this skill (e.g., scripts/foo.sh, references/api.md) are resolved against the base directory above.

Files in this skill directory:
- references/api.md
- scripts/run.sh
</activated_skill>`)
  })

  it('omits the file list section when the skill has no bundled files', () => {
    const body = formatSkillActivationBody(makeSkill({ files: [] }))

    expect(body).not.toContain('Files in this skill directory')
    expect(body).toContain('Base directory for this skill:')
  })

  it('truncates the rendered file list at 50 with a remainder marker', () => {
    const files = Array.from({ length: 55 }, (_, i) => `file-${String(i + 1).padStart(2, '0')}.txt`)
    const body = formatSkillActivationBody(makeSkill({ files }))

    expect(body).toContain('- file-50.txt')
    expect(body).not.toContain('- file-51.txt')
    expect(body).toContain('... and 5 more file(s) not shown')
  })
})

describe('createActivateSkillTool', () => {
  it('returns the wrapped skill XML for a known name', async () => {
    const registry = new SkillRegistry([makeSkill({ name: 'demo', content: 'Do the demo thing.' })])
    const tool = createActivateSkillTool(registry)

    await expect(tool.execute({ name: 'demo' }, {} as never)).resolves.toBe(wrapActivatedSkill(
      makeSkill({ name: 'demo', content: 'Do the demo thing.' }),
    ))
  })

  it('returns a not-found hint listing available skills for unknown names', async () => {
    const registry = new SkillRegistry([makeSkill({ name: 'alpha' }), makeSkill({ name: 'beta' })])
    const tool = createActivateSkillTool(registry)

    await expect(tool.execute({ name: 'nope' }, {} as never)).resolves.toBe(
      'Skill "nope" not found. Available: alpha, beta',
    )
  })

  it('reports that no skills are loaded when the registry is empty or fully disabled', async () => {
    const registry = new SkillRegistry([makeSkill({ name: 'hidden' })], new Set(['hidden']))
    const tool = createActivateSkillTool(registry)

    await expect(tool.execute({ name: 'hidden' }, {} as never)).resolves.toBe(
      'Skill "hidden" not found. No skills are currently loaded.',
    )
  })

  it('embeds the enabled skill names in the tool description', () => {
    const registry = new SkillRegistry([
      makeSkill({ name: 'alpha' }),
      makeSkill({ name: 'beta' }),
      makeSkill({ name: 'off' }),
    ], new Set(['off']))
    const tool = createActivateSkillTool(registry)

    // loop 靠工具描述把 skill 路由信息带给模型，所以名单必须是最新的启用集合。
    expect(tool.description).toContain('alpha')
    expect(tool.description).toContain('beta')
    expect(tool.description).not.toContain('off')
  })
})
