// Tests for agent/plan-tools.ts (handleAskUser)
import { describe, expect, it, vi } from 'vitest'

import { createLoopState } from '../src/agent/loop-state.js'
import { handleAskUser } from '../src/agent/plan-tools.js'
import type { AgentCallbacks } from '../src/types/index.js'

function makeCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolCall: vi.fn(),
    onToolProgress: vi.fn(),
    onToolResult: vi.fn(),
    onAskPermission: vi.fn().mockResolvedValue('yes'),
    onAskUser: vi.fn().mockResolvedValue('option1'),
    onPlanApprovalRequest: vi.fn().mockResolvedValue(true),
    onPlanModeChange: vi.fn(),
    onTodosUpdate: vi.fn(),
    onShellOutput: vi.fn(),
    onUsageUpdate: vi.fn(),
    onContextCompressed: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

type LoopState = ReturnType<typeof createLoopState>

// 取消息列表末尾的 tool-result part，断言转录里真实落下的工具结果。
function lastToolMessage(state: LoopState) {
  const last = state.messages[state.messages.length - 1]
  if (!last || last.role !== 'tool') {
    throw new Error('expected a tool message at the end of the transcript')
  }
  const parts = last.content as Array<{
    type: 'tool-result'
    toolCallId: string
    toolName: string
    output: { type: 'text'; value: string }
  }>
  const part = parts[0]
  if (!part) throw new Error('expected a tool-result part')
  return part
}

describe('handleAskUser', () => {
  it('passes the question and options to the UI and records the answer', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    const options = [
      { label: 'Postgres', description: '关系型数据库' },
      { label: 'MongoDB', description: '文档数据库' },
    ]
    await handleAskUser({ question: '用哪个数据库？', options }, 'tc-ask', state, callbacks)

    expect(callbacks.onAskUser).toHaveBeenCalledTimes(1)
    expect(callbacks.onAskUser).toHaveBeenCalledWith('用哪个数据库？', options)
    expect(callbacks.onToolResult).toHaveBeenCalledWith('tc-ask', 'User answered: option1', false)

    const part = lastToolMessage(state)
    expect(part.toolCallId).toBe('tc-ask')
    expect(part.toolName).toBe('askUser')
    expect(part.output.value).toBe('User answered: option1')
  })

  it('treats a missing options field as an open-ended question', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    await handleAskUser({ question: '想怎么做？' }, 'tc-ask', state, callbacks)

    expect(callbacks.onAskUser).toHaveBeenCalledWith('想怎么做？', undefined)
    expect(callbacks.onToolResult).toHaveBeenCalledWith('tc-ask', expect.stringContaining('User answered:'), false)
  })

  it('returns free-typed answers verbatim', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks({ onAskUser: vi.fn().mockResolvedValue('先只做只读分析') })
    await handleAskUser({ question: '这次的范围？' }, 'tc-ask', state, callbacks)

    expect(callbacks.onToolResult).toHaveBeenCalledWith('tc-ask', 'User answered: 先只做只读分析', false)
  })

  it('appends exactly one tool-result message to the transcript', async () => {
    const state = createLoopState()
    state.messages.push({ role: 'user', content: '帮我排查问题' })
    const callbacks = makeCallbacks()

    await handleAskUser({ question: '从哪开始？' }, 'tc-ask', state, callbacks)

    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]?.role).toBe('user')
    expect(state.messages[1]?.role).toBe('tool')
  })
})
