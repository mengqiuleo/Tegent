import type { LoopState } from './loop-state.js'

export async function appendHeader(_state: LoopState, _modelId: string, _taskText: string): Promise<void> {}

export async function appendUsage(_state: LoopState, _modelId: string): Promise<void> {}

export async function flushPendingMessages(state: LoopState): Promise<void> {
  state.persistedMessageCount = state.messages.length
}
