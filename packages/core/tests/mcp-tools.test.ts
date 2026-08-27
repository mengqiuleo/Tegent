import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool as MCPToolDef } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'

import { wrapMcpTool } from '../src/mcp/mcpTool.js'
import { ToolRegistry } from '../src/types/index.js'
import type { Tool } from '../src/mcp/type.js'

// wrapMcpTool 只在 execute 里才真正用到 client（发起 tools/call），
// 测名称/描述/截断这些纯映射逻辑时给个空壳即可。
function fakeClient(callTool?: () => unknown): Client {
  return { callTool } as unknown as Client
}

function makeLocalTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'mcp__test__echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: {}, required: [] },
    isReadOnly: true,
    execute: async () => ({ content: 'ok', isError: false }),
    ...overrides,
  }
}

describe('wrapMcpTool', () => {
  it('给工具名加 mcp__<server>__ 前缀，防止和内置工具或其它 Server 撞名', () => {
    const tool = wrapMcpTool('github', fakeClient(), { name: 'create_issue' } as MCPToolDef)
    expect(tool.name).toBe('mcp__github__create_issue')
  })

  it('超长描述截断到上限并加截断标记，防止 Server 文档撑爆上下文', () => {
    const tool = wrapMcpTool('s', fakeClient(), {
      name: 't',
      description: 'x'.repeat(3000),
    } as MCPToolDef)
    expect(tool.description.length).toBeLessThanOrEqual(2048 + '… [truncated]'.length)
    expect(tool.description.endsWith('… [truncated]')).toBe(true)
  })

  it('readOnlyHint 只是 Server 的自述：未声明时按可能有副作用处理', () => {
    expect(wrapMcpTool('s', fakeClient(), { name: 'a' } as MCPToolDef).isReadOnly).toBe(false)
    expect(
      wrapMcpTool('s', fakeClient(), { name: 'a', annotations: { readOnlyHint: true } } as MCPToolDef).isReadOnly,
    ).toBe(true)
  })

  it('execute 把 text 块拼成正文，非 text 块转成占位说明而不是静默丢弃', async () => {
    const client = fakeClient(() => ({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/png' },
      ],
    }))
    const tool = wrapMcpTool('s', client, { name: 't' } as MCPToolDef)
    const result = await tool.execute({}, process.cwd())
    expect(result.content).toBe('hello\n[non-text content: image/png]')
    expect(result.isError).toBe(false)
  })

  it('协议层异常也翻成 ToolResult，让结果回路照常走', async () => {
    const client = fakeClient(() => Promise.reject(new Error('boom')))
    const tool = wrapMcpTool('s', client, { name: 't' } as MCPToolDef)
    const result = await tool.execute({}, process.cwd())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('boom')
  })
})

describe('ToolRegistry', () => {
  it('同名工具重复注册直接抛错', () => {
    const registry = new ToolRegistry()
    registry.register(makeLocalTool())
    expect(() => registry.register(makeLocalTool())).toThrow('already registered')
  })

  it('toToolSet 以工具名为 key，且不生成 execute（手动执行才能过权限闸门）', () => {
    const registry = new ToolRegistry()
    registry.register(makeLocalTool())
    registry.register(makeLocalTool({ name: 'mcp__test__write', description: 'w', isReadOnly: false }))

    const set = registry.toToolSet()
    expect(Object.keys(set).sort()).toEqual(['mcp__test__echo', 'mcp__test__write'])
    for (const key of Object.keys(set)) {
      const entry = set[key] as { description?: string; execute?: unknown }
      expect(typeof entry.description).toBe('string')
      expect(entry.execute).toBeUndefined()
    }
  })

  it('空注册表转出空 ToolSet', () => {
    expect(new ToolRegistry().toToolSet()).toEqual({})
  })
})
