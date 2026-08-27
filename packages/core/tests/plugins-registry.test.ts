// Tests for plugins/registry.ts（构造覆盖、命令式 register/unregister、
// reload diff、disabled 过滤）。全部是纯逻辑，不落盘。
import { describe, expect, it } from 'vitest'

import { PluginRegistry } from '../src/plugins/registry.js'
import type { PluginDefinition } from '../src/plugins/types.js'

/** 生成一个最小的插件定义；dir 只是字符串，注册表不做任何文件系统操作。 */
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

describe('PluginRegistry', () => {
  it('lets later definitions override same-id earlier ones', () => {
    const registry = new PluginRegistry([
      makePlugin({ id: 'shared', version: '1.0.0', source: 'user' }),
      makePlugin({ id: 'shared', version: '2.0.0', source: 'project' }),
    ])

    // loadPlugins 按用户级 → 项目级顺序返回，后者覆盖前者。
    expect(registry.get('shared')?.version).toBe('2.0.0')
    expect(registry.list()).toHaveLength(1)
  })

  it('registers and unregisters plugins imperatively', () => {
    const registry = new PluginRegistry([])
    expect(registry.list()).toEqual([])

    registry.register(makePlugin({ id: 'late' }))
    expect(registry.names()).toEqual(['late'])

    expect(registry.unregister('late')).toBe(true)
    expect(registry.unregister('late')).toBe(false) // 第二次移除：id 已不存在。
    expect(registry.names()).toEqual([])
  })

  it('applies the disabled set passed at construction', () => {
    const registry = new PluginRegistry(
      [makePlugin({ id: 'on' }), makePlugin({ id: 'off' })],
      new Set(['off']),
    )

    expect(registry.get('off')).toBeUndefined()
    expect(registry.names()).toEqual(['on'])
    expect(registry.list().map((p) => p.id)).toEqual(['on'])

    // /plugin list 需要看见禁用项，走 listAll/getEntry。
    const entry = registry.getEntry('off')
    expect(entry?.disabled).toBe(true)
    expect(registry.listAll().map((p) => p.id).sort()).toEqual(['off', 'on'])
  })

  it('computes disabled state for plugins registered after construction', () => {
    const registry = new PluginRegistry([], new Set(['muted']))
    registry.register(makePlugin({ id: 'muted' }))
    registry.register(makePlugin({ id: 'loud' }))

    // register() 参考构造时传入的禁用集合，而不是一律视为启用。
    expect(registry.get('muted')).toBeUndefined()
    expect(registry.names()).toEqual(['loud'])
  })

  it('classifies reload diffs into added/removed/changed/unchanged', () => {
    const registry = new PluginRegistry([makePlugin({ id: 'kept' }), makePlugin({ id: 'gone' })])

    const summary = registry.reload([makePlugin({ id: 'kept' })], new Set())

    expect(summary).toMatchObject({ added: [], removed: ['gone'], changed: [], unchanged: ['kept'] })
    expect(registry.get('gone')).toBeUndefined()
  })

  it('marks version and disabled-state flips as changes', () => {
    const registry = new PluginRegistry([makePlugin({ id: 'a' }), makePlugin({ id: 'b' })])

    const summary = registry.reload(
      [
        makePlugin({ id: 'a', version: '1.1.0' }),
        makePlugin({ id: 'b' }), // 版本一致，但下面被禁用了
      ],
      new Set(['b']),
    )

    expect(summary.changed.sort()).toEqual(['a', 'b'])
    expect(summary.unchanged).toEqual([])
    // 禁用状态在 reload 后立即反映到 agent 可见集合。
    expect(registry.names()).toEqual(['a'])
  })

  it('replaces the disabled set on reload so register() follows the fresh settings', () => {
    const registry = new PluginRegistry([], new Set(['old-muted']))
    registry.reload([], new Set(['new-muted']))
    registry.register(makePlugin({ id: 'new-muted' }))

    // reload 后 register() 应参考新集合，而不是构造时的旧集合。
    expect(registry.get('new-muted')).toBeUndefined()
  })

  it('keeps the registry object identity stable across reload', () => {
    const registry = new PluginRegistry([makePlugin({ id: 'a' })])
    const before = registry
    registry.reload([makePlugin({ id: 'b' })], new Set())
    expect(registry).toBe(before) // 缓存了注册表引用的调用方无需重新取引用。
    expect(registry.names()).toEqual(['b'])
  })
})
