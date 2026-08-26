// Tests for agent/plan-tools.ts (handleEnterPlanMode / handleExitPlanMode)
import { beforeEach, describe, expect, it, vi } from 'vitest'

import os from 'node:os'
import path from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import { handleEnterPlanMode, handleExitPlanMode } from '../src/agent/plan-tools.js'
import type { AgentCallbacks, AgentOptions } from '../src/types/index.js'

// plan-storage 的真实实现把计划写到 <cwd>/.tegent/plans，路径里还带时间戳。
// 这里替换成内存实现：测试不落盘、路径可预测，slugify 仍用真实逻辑。
const planStore = vi.hoisted(() => ({ files: new Map<string, string>(), seq: 0 }))

vi.mock('../src/agent/plan-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/plan-storage.js')>()
  return {
    ...actual,
    makePlanFilePath: (taskText: string, opts?: { slug?: string }) => {
      const slug = opts?.slug ?? actual.slugify(taskText)
      const stamp = String(++planStore.seq).padStart(4, '0')
      return path.join(os.tmpdir(), 'tegent-plan-tests', `${slug ? `${slug}-` : ''}${stamp}.md`)
    },
    readPlan: async (planPath: string) => planStore.files.get(planPath) ?? '',
    writePlan: async (planPath: string, body: string) => {
      planStore.files.set(planPath, body)
      return planPath
    },
  }
})

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

function makeOptions(overrides: Partial<AgentOptions> = {}): AgentOptions {
  return {
    modelId: 'test:model',
    trustMode: false,
    ...overrides,
  }
}

function lastToolResult(callbacks: AgentCallbacks): { toolCallId: string; output: string; isError: boolean } {
  const calls = vi.mocked(callbacks.onToolResult).mock.calls
  const last = calls[calls.length - 1]
  if (!last) throw new Error('expected onToolResult to have been called')
  return { toolCallId: last[0], output: last[1], isError: last[2] ?? false }
}

beforeEach(() => {
  planStore.files.clear()
  planStore.seq = 0
})

describe('handleEnterPlanMode', () => {
  it('flips permissionMode and clears the system prompt cache when approved', async () => {
    const state = createLoopState('default')
    state.systemPromptCache = 'cached'
    const callbacks = makeCallbacks()

    await handleEnterPlanMode({ topic: 'Refactor Auth' }, 'tc1', state, makeOptions(), callbacks)

    expect(state.permissionMode).toBe('plan')
    expect(state.systemPromptCache).toBeNull()
    expect(state.expectCacheMiss).toBe(true)
    expect(state.currentPlanPath).toContain('Refactor Auth')
    expect(callbacks.onPlanModeChange).toHaveBeenCalledWith('plan')
    const result = lastToolResult(callbacks)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Entered plan mode')
    expect(result.output).toContain(state.currentPlanPath ?? '')
  })

  it('falls back to taskSlug for the plan file name when no topic is given', async () => {
    const state = createLoopState('default')
    state.taskSlug = 'legacy-slug'
    const callbacks = makeCallbacks()

    await handleEnterPlanMode({}, 'tc1', state, makeOptions(), callbacks)

    expect(state.currentPlanPath).toContain('legacy-slug')
  })

  it('keeps the already-assigned plan path instead of deriving a new one', async () => {
    const state = createLoopState('default')
    state.currentPlanPath = path.join(os.tmpdir(), 'tegent-plan-tests', 'existing.md')
    const callbacks = makeCallbacks()

    await handleEnterPlanMode({ topic: 'Other Topic' }, 'tc1', state, makeOptions(), callbacks)

    expect(state.currentPlanPath).toBe(path.join(os.tmpdir(), 'tegent-plan-tests', 'existing.md'))
    expect(planStore.seq).toBe(0)
  })

  it('returns a no-op result when already in plan mode', async () => {
    const state = createLoopState('plan')
    const callbacks = makeCallbacks()

    await handleEnterPlanMode({}, 'tc1', state, makeOptions(), callbacks)

    expect(callbacks.onAskPermission).not.toHaveBeenCalled()
    expect(state.permissionMode).toBe('plan')
    const result = lastToolResult(callbacks)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Already in plan mode')
  })

  it('declines cleanly when the user rejects the permission prompt', async () => {
    const state = createLoopState('default')
    const callbacks = makeCallbacks({ onAskPermission: vi.fn().mockResolvedValue('no') })

    await handleEnterPlanMode({}, 'tc1', state, makeOptions(), callbacks)

    expect(state.permissionMode).toBe('default')
    expect(state.currentPlanPath).toBeNull()
    expect(callbacks.onPlanModeChange).not.toHaveBeenCalled()
    const result = lastToolResult(callbacks)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('User declined')
  })

  it('reports interruption when the abort signal fires after permission resolves', async () => {
    const state = createLoopState('default')
    const ac = new AbortController()
    const callbacks = makeCallbacks({
      onAskPermission: vi.fn().mockImplementation(async () => {
        ac.abort()
        return 'yes'
      }),
    })

    await handleEnterPlanMode({}, 'tc1', state, makeOptions({ abortSignal: ac.signal }), callbacks)

    expect(state.permissionMode).toBe('default')
    const result = lastToolResult(callbacks)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('interrupted')
  })
})

describe('handleExitPlanMode', () => {
  it('rejects the call when not currently in plan mode', async () => {
    const state = createLoopState('default')
    const callbacks = makeCallbacks()

    await handleExitPlanMode({ plan: 'something' }, 'tc1', state, callbacks)

    expect(callbacks.onPlanApprovalRequest).not.toHaveBeenCalled()
    const result = lastToolResult(callbacks)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not in plan mode')
  })

  it('errors when the plan body is empty and remembers the derived path', async () => {
    const state = createLoopState('plan')
    const callbacks = makeCallbacks()

    await handleExitPlanMode({}, 'tc1', state, callbacks)

    const result = lastToolResult(callbacks)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('is empty')
    expect(state.permissionMode).toBe('plan')
    // 没有预设路径时会先派生一个并记到 state 上，方便下次重试。
    expect(state.currentPlanPath).toBeTruthy()
  })

  it('switches to acceptEdits and emits a plan-approved result on user approval', async () => {
    const state = createLoopState('plan')
    state.systemPromptCache = 'cached'
    const planPath = path.join(os.tmpdir(), 'tegent-plan-tests', 'approve.md')
    state.currentPlanPath = planPath
    const callbacks = makeCallbacks()

    await handleExitPlanMode({ plan: 'My plan body' }, 'tc1', state, callbacks)

    expect(state.permissionMode).toBe('acceptEdits')
    expect(state.systemPromptCache).toBeNull()
    expect(state.currentPlanPath).toBeNull()
    expect(callbacks.onPlanModeChange).toHaveBeenCalledWith('acceptEdits')
    expect(callbacks.onPlanApprovalRequest).toHaveBeenCalledWith('My plan body')
    const result = lastToolResult(callbacks)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Plan approved')

    // 传入的 plan 覆盖内容会被持久化到计划文件。
    expect(planStore.files.get(planPath)).toBe('My plan body')

    // 追加一条 user 消息，让模型知道门禁已放开。
    const lastMsg = state.messages[state.messages.length - 1]
    expect(lastMsg?.role).toBe('user')
  })

  it('approves the plan already written to the plan file when no override is passed', async () => {
    const state = createLoopState('plan')
    const planPath = path.join(os.tmpdir(), 'tegent-plan-tests', 'from-disk.md')
    state.currentPlanPath = planPath
    planStore.files.set(planPath, '# Plan from disk')
    const callbacks = makeCallbacks()

    await handleExitPlanMode({}, 'tc1', state, callbacks)

    expect(callbacks.onPlanApprovalRequest).toHaveBeenCalledWith('# Plan from disk')
    expect(state.permissionMode).toBe('acceptEdits')
  })

  it('stays in plan mode and pushes an errored result when the user rejects', async () => {
    const state = createLoopState('plan')
    const planPath = path.join(os.tmpdir(), 'tegent-plan-tests', 'rejected.md')
    state.currentPlanPath = planPath
    const callbacks = makeCallbacks({ onPlanApprovalRequest: vi.fn().mockResolvedValue(false) })

    await handleExitPlanMode({ plan: 'rejected plan' }, 'tc1', state, callbacks)

    expect(state.permissionMode).toBe('plan')
    expect(state.currentPlanPath).toBe(planPath)
    const result = lastToolResult(callbacks)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Plan rejected')
    // 被拒绝后不追加“已退出计划模式”的 user 消息。
    const lastMsg = state.messages[state.messages.length - 1]
    expect(lastMsg?.role).toBe('tool')
  })
})
