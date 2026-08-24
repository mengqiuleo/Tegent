import type { LanguageModel } from 'ai'

import type { LoopState } from './loop-state.js'

export async function runMemoryExtractor(_options: {
  parentState: LoopState
  parentModel: LanguageModel
  abortSignal?: AbortSignal | undefined
  onWrite?: ((notice: string) => void) | undefined
}): Promise<void> {}
