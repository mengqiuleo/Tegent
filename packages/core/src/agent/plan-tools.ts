import type { AgentCallbacks, AgentOptions, TodoItem } from '../types/index.js'
import type { LoopState } from './loop-state.js'
import { clearProgressReporter } from '../tools/progress.js'
import { makePlanFilePath, readPlan, writePlan } from './plan-storage.js'
import { toolErrorString, toolResultMessage } from './messages.js'
import { extractText } from '../utils/message-helpers.js'

function lastUserMessageText(messages: LoopState['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') {
      return extractText(m.content)
    }
  }
  return ''
}

function pushToolResult(
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError = false,
): void {
  state.messages.push(toolResultMessage(toolCallId, toolName, output))
  clearProgressReporter(toolCallId)
  callbacks.onToolResult(toolCallId, output, isError)
}

export async function handleAskUser(
  input: Record<string, unknown>,
  toolCallId: string,
  state: LoopState,
  callbacks: AgentCallbacks,
): Promise<void> {
  const question = input.question as string
  const choices = input.options as Array<{ label: string; description: string }> | undefined
  const answer = await callbacks.onAskUser(question, choices)
  pushToolResult(state, callbacks, toolCallId, 'askUser', `User answered: ${answer}`)
}

export async function handleEnterPlanMode(
  input: Record<string, unknown>,
  toolCallId: string,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
): Promise<void> {
  if (state.permissionMode === 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'enterPlanMode',
      'Already in plan mode. Continue the conversation; call exitPlanMode when the plan is ready.',
    )
    return
  }

  const decision = await callbacks.onAskPermission({ toolCallId, toolName: 'enterPlanMode', input })
  if (options.abortSignal?.aborted) {
    pushToolResult(state, callbacks, toolCallId, 'enterPlanMode', '[Tool execution interrupted by user]', true)
    return
  }

  if (decision === 'no') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'enterPlanMode',
      'User declined to enter plan mode. Continue in default mode.',
      true,
    )
    return
  }

  state.permissionMode = 'plan'
  state.systemPromptCache = null
  state.expectCacheMiss = true

  if (!state.currentPlanPath) {
    const topic = (input.topic as string | undefined)?.trim()
    const fallbackText = lastUserMessageText(state.messages)
    const explicitSlug = topic && topic.length > 0 ? topic : state.taskSlug || undefined
    state.currentPlanPath = makePlanFilePath(fallbackText, { slug: (explicitSlug || '') })
  }

  callbacks.onPlanModeChange('plan')
  pushToolResult(
    state,
    callbacks,
    toolCallId,
    'enterPlanMode',
    [
      'Entered plan mode.',
      '',
      `Plan file path for this session: ${state.currentPlanPath}`,
      'Use writeFile/edit on the plan file to build the plan.',
      'askUser is for clarifying details while planning.',
      'Call exitPlanMode when the plan is ready for approval.',
    ].join('\n'),
  )
}

export async function handleExitPlanMode(
  input: Record<string, unknown>,
  toolCallId: string,
  state: LoopState,
  callbacks: AgentCallbacks,
): Promise<void> {
  if (state.permissionMode !== 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'exitPlanMode',
      toolErrorString('not in plan mode. exitPlanMode is only valid when the session is in plan mode.'),
      true,
    )
    return
  }

  const planPath =
    state.currentPlanPath ?? makePlanFilePath(lastUserMessageText(state.messages), { slug: (state.taskSlug || '') })
  state.currentPlanPath = planPath

  const planOverride = (input.plan as string | undefined)?.trim()
  let planBody = planOverride ?? ''
  if (!planBody) planBody = (await readPlan(planPath)).trim()

  if (!planBody) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'exitPlanMode',
      toolErrorString(`the plan file at ${planPath} is empty. Write the plan first, then call exitPlanMode again.`),
      true,
    )
    return
  }

  if (planOverride) {
    try {
      await writePlan(planPath, planBody)
    } catch {
      // The approval dialog still uses the in-memory body.
    }
  }

  const approved = await callbacks.onPlanApprovalRequest(planBody)
  if (approved) {
    state.permissionMode = 'acceptEdits'
    state.systemPromptCache = null
    state.expectCacheMiss = true
    state.currentPlanPath = null
    callbacks.onPlanModeChange('acceptEdits')
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'exitPlanMode',
      [
        'Plan approved by user. Plan mode has been exited.',
        'Write tools are now auto-approved.',
      ].join('\n'),
    )
    state.messages.push({
      role: 'user',
      content: 'You have exited plan mode. You can now make edits, run tools, and take actions.',
    })
    return
  }

  pushToolResult(
    state,
    callbacks,
    toolCallId,
    'exitPlanMode',
    [
      'Plan rejected by user. You are still in plan mode.',
      'Read the user feedback, revise the plan, and call exitPlanMode again.',
    ].join('\n'),
    true,
  )
}


export async function handleTodoWrite(
  input: Record<string, unknown>,
  toolCallId: string,
  state: LoopState,
  callbacks: AgentCallbacks,
): Promise<void> {
  type RawTodo = { content?: string; activeForm?: string; status?: TodoItem['status'] }
  const raw = (input.todos as RawTodo[] | undefined) ?? []
  const normalized: TodoItem[] = []

  for (const t of raw) {
    const content = (t.content ?? '').trim()
    const activeForm = (t.activeForm ?? '').trim()
    if (!content && !activeForm) continue
    normalized.push({
      content: content || activeForm,
      activeForm: activeForm || content,
      status: t.status ?? 'pending',
    })
  }

  const allDone = normalized.length > 0 && normalized.every((t) => t.status === 'completed')
  state.todos = allDone ? [] : normalized
  callbacks.onTodosUpdate(state.todos)

  const dropped = raw.length - normalized.length
  const droppedNote =
    dropped > 0
      ? ` ${dropped} entr${dropped === 1 ? 'y was' : 'ies were'} dropped because they had neither content nor activeForm - please include both fields next time so the user sees clean labels.`
      : ''
  const VERIFY_RE = /\b(verif|test|check|lint|build|typecheck|tsc)\b/i
  const needsVerifyNudge =
    allDone &&
    normalized.length >= 3 &&
    !normalized.some((t) => VERIFY_RE.test(t.content) || VERIFY_RE.test(t.activeForm))
  const verifyNote = needsVerifyNudge
    ? ' Before wrapping up, verify your work - run tests, lint, or type-check as appropriate for this project.'
    : ''

  pushToolResult(
    state,
    callbacks,
    toolCallId,
    'todoWrite',
    allDone
      ? `All todos completed. Checklist cleared.${verifyNote}${droppedNote}`
      : `Todo list updated. Keep the checklist current - mark items completed immediately when finished, and ensure exactly one item is in_progress.${droppedNote}`,
  )
}