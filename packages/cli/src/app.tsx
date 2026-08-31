import { render } from 'ink'

import type { AgentOptions, LanguageModel } from '@tegent/core'

import { App } from './ui/components/App.js'
import { printHeader } from './ui/components/AppHeader.js'

let registeredCleanup: (() => Promise<void>) | null = null

export function getCleanupFn(): (() => Promise<void>) | null {
  return registeredCleanup
}

export interface SessionExitInfo {
  sessionId: string
  taskSlug: string
  messageCount: number
}
let registeredSessionInfoGetter: (() => SessionExitInfo | null) | null = null
export function getSessionExitInfo(): SessionExitInfo | null {
  return registeredSessionInfoGetter ? registeredSessionInfoGetter() : null
}

export function startApp(model: LanguageModel, options: AgentOptions) {
  printHeader(options.modelId)

  const { waitUntilExit } = render(
    <App
      model={model}
      options={options}
      onCleanupReady={(fn) => {
        registeredCleanup = fn
      }}
      onSessionInfoReady={(getter) => {
        registeredSessionInfoGetter = getter
      }}
    />,
    { exitOnCtrlC: false },
  )
  return waitUntilExit
}
