// Ink 应用的挂载入口：把模型、agent 选项和初始提示词交给根组件 App。
import { render } from 'ink'

import type { AgentOptions, LanguageModel } from '@tegent/core'

import { App } from './ui/components/App.js'
import { printHeader } from './ui/components/AppHeader.js'
import type { CliSession } from './ui/slash-commands.js'

// App 组件通过 onCleanupReady 注册的清理函数（保存会话）。
// Ctrl+C 双击退出时 App 来不及自己清理，index.ts 在 Ink 卸载后调用它兜底。
let registeredCleanup: (() => Promise<void>) | null = null

export function getCleanupFn(): (() => Promise<void>) | null {
  return registeredCleanup
}

/**
 * 挂载 Ink TUI，返回一个在应用退出（Ink 卸载）时 resolve 的 Promise。
 *
 * @param model 已解析好的语言模型实例。
 * @param options agent 选项（模型 id、权限模式、轮数上限等）。
 * @param session 会话注册表容器（skill / plugin / MCP），供斜杠命令原地更新。
 * @param initialPrompt 命令行位置参数拼出的初始提示词；没有则进入空输入状态。
 */
export function startApp(
  model: LanguageModel,
  options: AgentOptions,
  session: CliSession,
  initialPrompt?: string,
) {
  printHeader(options.modelId)

  const { waitUntilExit } = render(
    <App
      model={model}
      options={options}
      session={session}
      initialPrompt={initialPrompt}
      onCleanupReady={(fn) => {
        registeredCleanup = fn
      }}
    />,
    // Ctrl+C 不走 Ink 默认的“直接退出”，App 要先做双击判定和 turn 取消。
    { exitOnCtrlC: false },
  )
  return waitUntilExit
}
