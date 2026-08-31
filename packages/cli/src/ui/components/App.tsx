import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from 'ink'

import {
  MODEL_ALIASES,
  PROVIDER_MODELS,
  createModelRegistry,
  estimateTokenCount,
  expandCommandBody,
  getAutoMemory,
  getAvailableProviders,
  getContextWindow,
  listSessions,
  loadSession,
  pickLatestSession,
  resolveModelId,
  saveUserConfig,
  wrapActivatedSkill,
} from '@tegent/core'
import type {
  AgentOptions,
  KnowledgeFact,
  LanguageModel,
  SkillDefinition,
  TokenUsage,
} from '@tegent/core'

import { createDoctorCommandHandler } from '../commands/doctor.js'
import { createMcpCommandHandler } from '../commands/mcp.js'
import { createPluginCommandHandler } from '../commands/plugin.js'
import { createSkillCommandHandler } from '../commands/skill.js'
import { useAgent } from '../hooks/use-agent.js'
import { parseBooleanArg } from '../utils.js'
import { getHeaderRowCount } from './AppHeader.js'
import { ChatInput } from './ChatInputInk.js'
import { INIT_PROMPT, REVIEW_PROMPT, SLASH_COMMANDS } from './constants.js'
import { buildHelpText, compactionHintForResume, formatRelativeTime, formatUsageReport } from '../utils/toolkit.js'

interface AppProps {
  model: LanguageModel
  options: AgentOptions
  onCleanupReady?: (fn: () => Promise<void>) => void
  onSessionInfoReady?: (getter: () => { sessionId: string; taskSlug: string; messageCount: number } | null) => void
}


export function App({
  model,
  options,
  onCleanupReady,
  onSessionInfoReady,
}: AppProps) {
  const { exit } = useApp()
  const {
    state,
    submit,
    resolvePermission, // 解析队首权限请求
    resolveQuestion, // 解析当前 pendingQuestion
    abort,
    cleanup, // 保存会话并退出
    clear,
    compact,
    resume,
    rewind,
    getCheckpoints,
    getSessionInfo,
    switchModel,
    setThinking,
    getThinking,
    invalidateSystemPromptCache, // 清掉 system prompt cache
    addInfoMessage,
    addUserMessage,
    echoCommand, // 追加命令回显
    addCommandMessage, // 追加命令消息
    addCommandResult, // 追加命令结果
    askQuestion, // 弹出选择器问题
    setPermissionMode,
  } = useAgent(model, options)

  // 每次 `/skill refresh` 原地修改注册表时递增。
  // 注册表对象本身的引用在 refresh 前后保持不变，reload() 只是重写内部 map。
  // 因此 React 需要一个显式依赖，才能知道可见 skill 列表已经变化；
  // 否则下面 memo 出来的 skillCommands 会一直停留在旧快照。
  const [skillRegistryVersion, setSkillRegistryVersion] = useState(0)

  // 从 options.skillRegistry 派生出的 skill 命令列表。
  // 当 /skill refresh 推高版本号后重新计算，让 Tab 补全和 /help 无需重启即可看到新 skill。
  const skillCommands = useMemo(
    () => (options.skillRegistry ? options.skillRegistry.list() : []),
    [skillRegistryVersion],
  )

  // 基于文件的 slash commands，包括用户、项目和插件提供的 markdown 命令文件。
  // 它和 skills 共用同一个版本计数；/plugin refresh 重载两个注册表后也会触发刷新。
  const fileCommands = useMemo(
    () => (options.commandRegistry ? options.commandRegistry.list() : []),
    [skillRegistryVersion],
  )

  // 合并后的命令列表：内置命令 + 已加载 skill + 文件型命令，主要提供给 Tab 补全。
  const allCommands = useMemo(
    () => [
      ...SLASH_COMMANDS,
      ...skillCommands.map((s) => ({ name: `/${s.name}`, description: s.description })),
      ...fileCommands.map((c) => ({ name: `/${c.name}`, description: c.description ?? '' })),
    ],
    [skillCommands, fileCommands],
  )

  /**
   * 等待注入的 skill。
   *
   * 当用户只输入 `/skillname` 且没有追加具体问题时设置它。这样不会因为单独的
   * skill XML 立即触发一次 AI 回复；skill 内容会被前置到下一条非 slash command
   * 用户消息中。执行 `/clear` 或成功消费后会清空。
   */
  const pendingSkillRef = useRef<SkillDefinition | null>(null)

  // 输入框下方的临时单行提示，渲染在 ChatInput footer 区域，
  // 和 plan mode / accept edits 等状态提示共享位置。
  // 目前只用于 “Press Ctrl+C again to exit” 双击退出提醒。
  // 这里刻意保持为单一窄槽位，方便未来其他短提示复用；位置对齐 Claude Code 的 PromptInputFooter。
  const [notice, setNotice] = useState<string | null>(null)
  // 最近一次 Ctrl+C 的时间戳。
  // 如果下一次 Ctrl+C 落在 arm window 内，就真正退出；
  // 如果已经超时，则只是重新布防，并在必要时取消当前运行中的 turn。
  // 行为对齐 Claude Code 的 `useExitOnCtrlCD` 两秒窗口。
  const ctrlCArmedAtRef = useRef(0)
  const ctrlCArmWindowMs = 2000
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!notice) return
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), ctrlCArmWindowMs)
    return () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = null
      }
    }
  }, [notice])

  /**
   * 处理 Ctrl+C：双击退出，单击取消当前 turn 并展示退出提示。
   *
   * 空闲 + 第一次按下：显示 “Press Ctrl+C again to exit”，开启 2 秒窗口。
   * 空闲 + 第二次按下：退出。
   * 加载中 + 第一次按下：中断当前 turn，显示提示，开启 2 秒窗口。
   * 加载中 + 第二次按下：退出。
   *
   * arm window 会自动过期，上面的 effect 会负责清除 notice。
   */
  const handleCtrlC = useCallback(() => {
    const now = Date.now()
    const armed = now - ctrlCArmedAtRef.current < ctrlCArmWindowMs
    if (armed) {
      // 在窗口期内第二次按下，说明用户确认要退出。
      // exit 会触发 Ink 卸载，并经由 onCleanupReady 走 gracefulShutdown。
      exit()
      return
    }
    ctrlCArmedAtRef.current = now
    if (state.isLoading) {
      abort()
    }
    setNotice('Press Ctrl+C again to exit')
  }, [exit, abort, state.isLoading])

  useEffect(() => {
    onCleanupReady?.(cleanup)
  }, [cleanup])


  useEffect(() => {
    onSessionInfoReady?.(getSessionInfo)
  }, [getSessionInfo])

  /**
   * 执行 `/resume`：列出当前项目所有历史会话，并让用户选择一个恢复。
   *
   * 复用 askQuestion 选择器，也就是 `/model` 和 askUser tool 使用的同一个对话框，
   * 因此天然获得一致的键盘导航、Other 自由输入逃生口和 Esc 取消行为。
   *
   * 选择器标签格式是：`[短 prompt] <相对时间> · N msgs`。
   * 每个选项的 description 会带上绝对文件路径，方便用户确认自己选择的是哪个会话。
   * 用户选中后，调用 `loadSession` 完整读取文件，再交给 `useAgent.resume`
   * 热替换 agent 状态。这里包成 useCallback，是为了给挂载 effect 稳定引用，
   * 避免 react-hooks lint 对组件体后方函数声明的闭包新鲜度发出警告。
   */
  const handleResume = useCallback(async () => {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      addInfoMessage(
        '**No past sessions found in this project.** Sessions are saved automatically — start working and one will appear here next time.',
      )
      return
    }
    const choices = sessions.slice(0, 30).map((s) => {
      const preview = (s.firstPrompt || '(empty)').slice(0, 60).replace(/\s+/g, ' ').trim()
      const ago = formatRelativeTime(s.mtime)
      const totalTokens = s.tokenUsage ? s.tokenUsage.totalTokens.toLocaleString('en-US') : '—'
      return {
        label: `${preview}  ·  ${ago}`,
        description: `${s.modelId}  ·  ${totalTokens} tokens  ·  ${s.sessionId}`,
        filePath: s.filePath,
      }
    })
    const answer = await askQuestion(
      `Pick a session to resume (${sessions.length} total in this project):`,
      choices.map((c) => ({ label: c.label, description: c.description })),
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      // 用户在 Other 里输入了自由文本时，这里按取消处理。
      // 不对 session id 做模糊匹配；当前支持的选择方式就是 picker。
      addInfoMessage('Resume cancelled.')
      return
    }
    const loaded = await loadSession(picked.filePath)
    if (!loaded) {
      addInfoMessage(`Failed to load session at ${picked.filePath}. The file may be corrupted.`)
      return
    }
    resume(loaded)
    const hint =
      compactionHintForResume(
        loaded.tokenUsage.inputTokens || null,
        estimateTokenCount(loaded.messages),
        loaded.modelId,
      ) ?? ''
    addInfoMessage(
      `**Resumed session:** ${loaded.firstPrompt.slice(0, 80) || '(no first prompt)'}\n\nContinuing from ${loaded.messages.length} message${loaded.messages.length === 1 ? '' : 's'}.${hint}`,
    )
  }, [addInfoMessage, askQuestion, resume])

  /**
   * 执行 `/rewind` 的选择器和回滚逻辑。
   *
   * 带参数时，直接跳到命名 checkpoint，支持完整 id 或 sha1 风格前缀。
   * 不带参数时，按新到旧列出当前会话的所有 checkpoint，并用触发 checkpoint
   * 的用户 prompt 作为预览。如果还没有任何 checkpoint，例如第一轮用户消息尚未落地，
   * 选择器会安静地提示并返回。
   */
  const handleRewind = useCallback(
    async (arg: string) => {
      const checkpoints = getCheckpoints()
      if (checkpoints.length === 0) {
        addInfoMessage(
          '**No rewind points yet.** A checkpoint is taken at the start of every user message — type something first, then `/rewind` will offer it.',
        )
        return
      }

      // 直接参数路径：先做精确 ckptId 匹配，再做前缀匹配。
      // 不做模糊匹配，因为歧义前缀可能静默回滚到错误位置。
      let pickedId: string | null = null
      if (arg) {
        const exact = checkpoints.find((c) => c.ckptId === arg)
        if (exact) pickedId = exact.ckptId
        else {
          const prefixed = checkpoints.filter((c) => c.ckptId.startsWith(arg))
          if (prefixed.length === 1) pickedId = prefixed[0]!.ckptId
          else if (prefixed.length > 1) {
            addInfoMessage(
              `Ambiguous checkpoint prefix \`${arg}\` (${prefixed.length} matches). Run \`/rewind\` and pick.`,
            )
            return
          } else {
            addInfoMessage(`No checkpoint matches \`${arg}\`. Run \`/rewind\` and pick.`)
            return
          }
        }
      }

      if (!pickedId) {
        // 新的 checkpoint 放在前面，符合用户“退一步/两步”的直觉。
        // 最近的决策点应该出现在列表顶部。
        const ordered = [...checkpoints].reverse()
        const choices = ordered.slice(0, 30).map((c) => {
          const preview = (c.userPrompt || '(empty prompt)').slice(0, 60).replace(/\s+/g, ' ').trim()
          const ago = formatRelativeTime(new Date(c.ts).getTime())
          return {
            label: `${preview}  ·  ${ago}`,
            description: `${c.ckptId}  ·  message #${c.messageCount}`,
            ckptId: c.ckptId,
          }
        })
        const answer = await askQuestion(
          `Pick a checkpoint to rewind to (${ordered.length} total in this session):`,
          choices.map((c) => ({ label: c.label, description: c.description })),
        )
        const picked = choices.find((c) => c.label === answer)
        if (!picked) {
          addInfoMessage('Rewind cancelled.')
          return
        }
        pickedId = picked.ckptId
      }

      const result = await rewind(pickedId)
      if (!result.ok) {
        addInfoMessage(`**Rewind failed:** ${result.reason}`)
        return
      }
      addInfoMessage(
        `**Rewound to:** ${result.preview || '(empty prompt)'}\n\nFiles and conversation restored. Continue from here.`,
      )
    },
    [addInfoMessage, askQuestion, getCheckpoints, rewind],
  )

  /**
   * 处理用户提交的输入，包括 slash command 和普通消息。
   *
   * slash command 在这里被分发到对应 handler；普通消息会直接提交给 agent。
   * 如果之前用户只激活了某个 skill 而没有给具体任务，这里会把 pending skill
   * 包装后注入到下一条普通消息前面。
   *
   * @param text - 用户从输入框提交的原始文本。
   */
  async function handleSubmit(text: string) {
    // slash command 路径：以 `/` 开头的输入不会直接作为普通用户消息提交。
    if (text.startsWith('/')) {
      const parts = text.slice(1).trim().split(/\s+/)
      const command = parts[0].toLowerCase()
      const arg = parts.slice(1).join(' ')

      switch (command) {
        case 'help':
          echoCommand(text)
          addInfoMessage(buildHelpText(skillCommands, fileCommands))
          return

        case 'model':
          handleModelSwitch(text, arg)
          return

        case 'thinking':
          handleThinkingToggle(text, arg)
          return

        case 'plan':
          handlePlanToggle(text, arg)
          return

        case 'clear':
          pendingSkillRef.current = null
          clear()
          return

        case 'compact':
          echoCommand(text)
          await handleCompact()
          return

        case 'resume':
          echoCommand(text)
          await handleResume()
          return

        case 'rewind':
          echoCommand(text)
          await handleRewind(arg)
          return

        case 'init':
          echoCommand(text)
          await submit(INIT_PROMPT, { silent: true })
          return

        case 'review':
          echoCommand(text)
          await submit(REVIEW_PROMPT(arg), { silent: true })
          return

        case 'usage':
          echoCommand(text)
          await handleUsage()
          return

        case 'usage-history':
          echoCommand(text)
          await handleUsageHistory()
          return

        case 'memory':
          echoCommand(text)
          handleMemory()
          return

        case 'skill':
          await handleSkill(text, arg)
          return

        case 'mcp':
          await handleMcp(text, arg)
          return

        case 'plugin':
          await handlePlugin(text, arg)
          return

        case 'doctor':
          handleDoctor(text)
          return

        case 'exit':
          await cleanup()
          exit()
          return

        default: {
          const skill = options.skillRegistry?.get(command)
          if (skill) {
            if (arg) {
              // skill 后面紧跟具体请求：先 echo 命令，再把 skill 内容和用户请求一起提交。
              // 这样模型会把 skill persona 应用到用户的具体问题上。
              // submit 设置 silent，由 echoCommand 提供可见的命令回显。
              // wrapActivatedSkill 会构造和 activateSkill 工具相同的 <activated_skill> 包裹，
              // 包含正文、base directory 和文件列表，保证用户手动触发与工具触发在模型看来字节一致。
              echoCommand(text)
              await submit(`${wrapActivatedSkill(skill)}\n\n${arg}`, {
                silent: true,
              })
            } else {
              // 暂时没有后续请求：保存完整 SkillDefinition。
              // 等用户下一条真实消息到达时，再用相同 wrapper 重新格式化并注入。
              // addCommandMessage 负责这里的命令回显。
              pendingSkillRef.current = skill
              addCommandMessage(text, `Skill **${skill.name}** loaded. Type your request.`)
            }
            return
          }

          // 再检查插件贡献的 slash commands。
          // 已安装插件中的 `commands/<name>.md` 会映射成 `/<name>`；
          // 命令正文会在替换 $ARGUMENTS / ${CLAUDE_PLUGIN_ROOT} 后作为模型 prompt 提交。
          const cmd = options.commandRegistry?.get(command)
          if (cmd) {
            echoCommand(text)
            const expanded = expandCommandBody(cmd, arg)
            await submit(expanded, { silent: true })
            return
          }
          addCommandMessage(text, `Unknown command: /${command}. Type /help for available commands.`)
          return
        }
      }
    }

    // 普通消息路径：如果存在等待注入的 skill，就把 skill 上下文前置到用户消息前面并清空。
    const pendingSkill = pendingSkillRef.current
    if (pendingSkill) {
      pendingSkillRef.current = null
      await submit(`${wrapActivatedSkill(pendingSkill)}\n\n${text}`, { silent: true })
      return
    }
    await submit(text)
  }

  /**
   * 根据模型 id 查找面向用户展示的模型标签。
   *
   * @param modelId - 完整模型 id，例如 `anthropic:claude-sonnet-4-6`。
   * @returns 模型选择器里的友好标签；找不到时回退为原始 id。
   */
  function renderModelLabel(modelId: string): string {
    for (const models of Object.values(PROVIDER_MODELS)) {
      for (const m of models) if (m.id === modelId) return m.label
    }
    return modelId
  }

  /**
   * 提交一次模型切换。
   *
   * 会重新创建 provider 注册表，确保新 provider 的环境变量 API key 被读取；
   * 然后切换运行中的 language model 引用、持久化到用户配置，并输出确认消息。
   *
   * @param commandText - 用户输入的原始命令文本，用于回显。
   * @param newModelId - 要切换到的新模型 id。
   */
  function commitModelChange(commandText: string, newModelId: string) {
    try {
      const registry = createModelRegistry()
      const newModel = registry.languageModel(newModelId as `${string}:${string}`)
      switchModel(newModelId, newModel)
      saveUserConfig({ model: newModelId })
      addCommandMessage(commandText, `Set model to ${renderModelLabel(newModelId)}`)
    } catch (err) {
      addCommandMessage(commandText, `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 处理 `/model` 命令。
   *
   * 带参数时走脚本友好的直接路径，支持别名或完整 model id；
   * 不带参数时打开交互式模型选择器，只展示当前已配置 API key 的 provider 下的模型。
   *
   * @param commandText - 用户输入的原始命令文本。
   * @param arg - `/model` 后面的参数。
   */
  async function handleModelSwitch(commandText: string, arg: string) {
    // 带显式参数时，保留原本适合脚本调用的路径：参数可以是别名，也可以是完整 id。
    if (arg) {
      const newModelId = resolveModelId(arg)
      if (!newModelId) {
        addCommandMessage(commandText, `Could not resolve model: ${arg}`)
        return
      }
      commitModelChange(commandText, newModelId)
      return
    }

    // 不带参数时打开交互式选择器。
    // 只列出 provider 已配置 API key 的模型，确保列表里的选择都能实际使用。
    const providers = new Set(getAvailableProviders())
    const choices: { id: string; label: string; description: string }[] = []
    for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
      if (!providers.has(provider)) continue
      for (const m of models) {
        const marker = m.id === state.modelId ? `● ` : '  '
        choices.push({ id: m.id, label: `${marker}${m.label}`, description: `${m.id} — ${m.description}` })
      }
    }

    if (choices.length === 0) {
      addCommandMessage(
        commandText,
        'No models available — set an API key (e.g. `ANTHROPIC_API_KEY`, `ALIBABA_API_KEY`) and restart.',
      )
      return
    }

    // askQuestion resolve 的是用户选中项的 label，而不是 model id。
    // SelectOptions 面向可读选项设计，所以这里需要通过刚才 push 的 label 反查 id。
    const answer = await askQuestion(
      `Current: ${state.modelId}\nPick a model (● = current):`,
      choices.map((c) => ({ label: c.label, description: c.description })),
      { noOther: true },
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      // 空 answer 表示用户按 Esc 关闭了对话框。
      // 静默取消即可，不要把空字符串丢给 resolveModelId，
      // 否则会出现空 model id 的“无法解析模型”提示。
      if (!answer) {
        addCommandMessage(commandText, `Cancelled — model stays **${renderModelLabel(state.modelId)}**.`)
        return
      }
      // 用户选择 Other 或输入了自由文本时，把它当成模型 id / 别名处理。
      // 这样高级用户仍然可以跳到选择器没有列出的冷门模型。
      const resolved = resolveModelId(answer)
      if (!resolved) {
        addCommandMessage(commandText, `Could not resolve model: ${answer}`)
        return
      }
      commitModelChange(commandText, resolved)
      return
    }
    if (picked.id === state.modelId) {
      addCommandMessage(commandText, `Already on ${renderModelLabel(picked.id)} — no change.`)
      return
    }
    commitModelChange(commandText, picked.id)
  }

  /**
   * 提交 extended thinking 模式变更。
   *
   * 会更新运行时 ref，让下一轮 agent turn 使用新值；同时写入磁盘配置，
   * 并输出一条 Claude 风格的命令结果消息。
   *
   * @param commandText - 用户输入的原始命令文本。
   * @param next - 下一步是否启用 extended thinking。
   */
  function commitThinkingChange(commandText: string, next: boolean) {
    setThinking(next)
    saveUserConfig({ thinking: next })
    addCommandMessage(commandText, `Extended thinking → **${next ? 'on' : 'off'}**. Takes effect on the next message.`)
  }

  /**
   * 处理 `/thinking`：切换 extended thinking 开关。
   *
   * 不带参数时打开交互式选择器，体验和 `/model` 一致：当前状态用 `●` 标记，
   * 用户可用方向键和 Enter 选择。取消或选择当前状态都不会产生变化。
   *
   * `on` / `off` 以及 `true` / `false` / `enable` / `disable` 等别名
   * 会走直接切换路径，适合脚本和肌肉记忆。其他参数会被拒绝并给出提示。
   *
   * 该开关对所有 provider 使用统一语义，具体实现见 providers/thinking.ts：
   * ON 会启用各 provider 支持的最大 reasoning；
   * OFF 会请求最小或禁用 reasoning。Gemini 2.5 Pro 不能完全关闭，
   * 因此会被限制到它的 128 token 最小值。
   *
   * 选择会持久化到 ~/.tegent/config.json。agent loop 每轮都会通过 useAgent
   * 里的 thinkingRef 读取它，因此切换后的下一条消息立即生效；
   * 这不同于 `/model`，不需要重建模型实例。
   *
   * @param commandText - 用户输入的原始命令文本。
   * @param arg - `/thinking` 后面的参数。
   */
  async function handleThinkingToggle(commandText: string, arg: string) {
    const current = getThinking()
    const trimmed = arg.trim().toLowerCase()

    // 直接切换路径：用户显式输入 on/off 或别名。
    if (trimmed) {
      const next = parseBooleanArg(trimmed)
      if (next === null) {
        addCommandMessage(
          commandText,
          `Unknown value: \`${arg}\`. Use \`/thinking\`, \`/thinking on\`, or \`/thinking off\`.`,
        )
        return
      }

      if (next === current) {
        addCommandMessage(commandText, `Extended thinking is already **${next ? 'on' : 'off'}** — no change.`)
        return
      }

      commitThinkingChange(commandText, next)
      return
    }

    // 不带参数时打开交互式选择器。
    // 始终展示 On 和 Off 两个选项，让用户看到完整状态空间；
    // 当前选项用 `● ` 标记，和 `/model` 的渲染保持一致。
    const onMarker = current ? `● ` : '  '
    const offMarker = current ? '  ' : `● `
    const choices = [
      {
        label: `${onMarker}On`,
        description: 'Opt every supported provider into max reasoning. Slower, costs more, better on hard problems.',
      },
      {
        label: `${offMarker}Off`,
        description: 'Each provider runs its non-thinking default. Faster, cheaper, sufficient for most chat.',
      },
    ]
    const answer = await askQuestion(
      `Extended thinking is currently **${current ? 'on' : 'off'}**. Pick a mode (● = current):`,
      choices,
      { noOther: true },
    )
    const wantOn = answer === choices[0].label
    const wantOff = answer === choices[1].label
    if (!wantOn && !wantOff) {
      // 用户在选择器里输入了自由文本时，仍然识别标准别名；
      // 如果无法识别，就按取消处理，通常说明用户只是想退出选择器。
      const free = (answer ?? '').trim().toLowerCase()
      if (free === 'on' || free === 'true' || free === '1' || free === 'enable' || free === 'enabled') {
        if (current) {
          addCommandMessage(commandText, 'Extended thinking is already **on** — no change.')
          return
        }
        commitThinkingChange(commandText, true)
        return
      }
      if (free === 'off' || free === 'false' || free === '0' || free === 'disable' || free === 'disabled') {
        if (!current) {
          addCommandMessage(commandText, 'Extended thinking is already **off** — no change.')
          return
        }
        commitThinkingChange(commandText, false)
        return
      }
      addCommandMessage(commandText, `Cancelled — extended thinking stays **${current ? 'on' : 'off'}**.`)
      return
    }
    const next = wantOn
    if (next === current) {
      addCommandMessage(commandText, `Already **${next ? 'on' : 'off'}** — no change.`)
      return
    }
    commitThinkingChange(commandText, next)
  }

  /**
   * 处理 `/plan`：切换 plan 模式。
   *
   * 这里不做选择器，因为 `/plan` 本身就是用户明确请求进入或退出 plan 模式。
   * `/plan` 会在 plan 与默认模式之间切换；`/plan on` 和 `/plan off`
   * 是幂等 setter，方便脚本化流程。确认输出对齐 Claude Code 的单行格式。
   *
   * @param commandText - 用户输入的原始命令文本。
   * @param arg - `/plan` 后面的参数。
   */
  function handlePlanToggle(commandText: string, arg: string) {
    const current = state.permissionMode === 'plan'
    const trimmed = arg.trim().toLowerCase()

    let next: boolean
    if (!trimmed) {
      next = !current
    } else {
      const parsed = parseBooleanArg(trimmed)
      if (parsed === null) {
        addCommandMessage(commandText, `Unknown value: \`${arg}\`. Use \`/plan\`, \`/plan on\`, or \`/plan off\`.`)
        return
      }
      next = parsed
    }

    if (next === current) {
      addCommandMessage(commandText, `Plan mode is already **${current ? 'on' : 'off'}** — no change.`)
      return
    }

    // /plan 直接在 plan 和 default 之间切换。
    // 这里通过 setPermissionMode 更新 loopState，并复用现有 onPlanModeChange
    // 回调路径完成 React state 和 UI 同步。
    setPermissionMode(next ? 'plan' : 'default')
    addCommandMessage(commandText, next ? 'Enabled plan mode' : 'Disabled plan mode')
  }

  /**
   * 执行 `/compact`：手动压缩当前上下文。
   *
   * @returns 无显式返回值；结果会写入命令结果消息。
   */
  async function handleCompact() {
    const result = await compact()
    if (!result) {
      addCommandResult('Nothing to compress — conversation is too short.')
      return
    }
    const beforeK = Math.round(result.beforeTokens / 1000)
    const afterK = Math.round(result.afterTokens / 1000)
    addCommandResult(`Context compressed: ~${beforeK}k → ~${afterK}k tokens.`)
  }

  /**
   * 执行 `/usage`：展示当前会话或最近会话快照的 token 用量。
   *
   * 当前会话还没有任何用量时，会尝试回退到最近一次已保存会话的 tokenUsage，
   * 让用户刚启动时也能看到上一段工作的用量概览。
   *
   * @returns 无显式返回值；报告会写入滚动消息区。
   */
  async function handleUsage() {
    let usage: TokenUsage = state.usage
    let modelId = state.modelId
    let source: 'live' | 'snapshot' = 'live'
    let sessionName: string | undefined
    const info = getSessionInfo()
    if (info?.firstPrompt) {
      sessionName = info.firstPrompt
    }
    if (usage.totalTokens === 0) {
      const latest = await pickLatestSession()
      if (latest && latest.tokenUsage) {
        usage = latest.tokenUsage
        modelId = latest.modelId
        source = 'snapshot'
        sessionName = latest.firstPrompt.slice(0, 80) || undefined
      }
    }
    addInfoMessage(formatUsageReport(usage, modelId, source, sessionName))
  }

  /**
   * 执行 `/usage-history`：用交互式选择器查看历史会话用量。
   *
   * 用户先从会话列表中选一个会话，再查看该会话的 usage 报告；
   * 每次查看后可以回到列表继续选择，或按 Esc 退出。
   *
   * @returns 无显式返回值；报告会写入滚动消息区。
   */
  async function handleUsageHistory() {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      addInfoMessage('**Usage history** — no past sessions found in this project.')
      return
    }

    const fmt = (n: number) => n.toLocaleString('en-US')
    const choices = sessions.map((s) => {
      const preview = (s.firstPrompt || '(empty)').slice(0, 50).replace(/\s+/g, ' ').trim()
      const ago = formatRelativeTime(s.mtime)
      const total = s.tokenUsage ? fmt(s.tokenUsage.totalTokens) : '—'
      return {
        label: `${preview}  ·  ${ago}`,
        description: `${s.modelId}  ·  ${total} tokens`,
        session: s,
      }
    })

    const BACK_LABEL = '← Back to list'
    const tick = () => new Promise<void>((r) => setTimeout(r, 50))

    while (true) {
      const answer = await askQuestion(
        `**Usage history** — ${sessions.length} session${sessions.length === 1 ? '' : 's'}. Pick one to view details:`,
        choices.map((c) => ({ label: c.label, description: c.description })),
        { noOther: true },
      )

      const picked = choices.find((c) => c.label === answer)
      if (!picked) break

      const s = picked.session
      const usage = s.tokenUsage
      if (!usage) {
        addInfoMessage(
          `**${(s.firstPrompt || '(empty)').slice(0, 60)}**\n\nNo usage data recorded (interrupted before first turn).`,
        )
      } else {
        addInfoMessage(formatUsageReport(usage, s.modelId, 'history', s.firstPrompt.slice(0, 80) || undefined))
      }

      await tick()

      const back = await askQuestion(
        'Press Enter to return, or Esc to exit.',
        [{ label: BACK_LABEL, description: 'Go back to the session list.' }],
        { noOther: true },
      )

      if (!back) break
    }
  }

  /**
   * 把 auto-memory fact 列表格式化成滚动消息区可展示的 markdown。
   *
   * @param scope - memory 范围，项目级或用户级。
   * @param facts - 要展示的 memory facts。
   * @returns 格式化后的 markdown 文本。
   */
  function formatMemoryList(scope: 'project' | 'user', facts: KnowledgeFact[]): string {
    if (facts.length === 0) {
      return `**Auto memory (${scope})** — empty.`
    }
    const byCategory = new Map<string, KnowledgeFact[]>()
    for (const f of facts) {
      const list = byCategory.get(f.category) ?? []
      list.push(f)
      byCategory.set(f.category, list)
    }
    const lines: string[] = [`**Auto memory (${scope})** — ${facts.length} fact${facts.length === 1 ? '' : 's'}.`, '']
    for (const [category, items] of byCategory) {
      lines.push(`### ${category}`)
      for (const f of items) {
        lines.push(`- \`${f.key}\` — ${f.fact} _(${f.date})_`)
      }
      lines.push('')
    }
    return lines.join('\n').trimEnd()
  }

  /**
   * 执行 `/memory`：展示项目级和用户级 auto-memory 条目。
   *
   * memory extractor 会在后台写底层文件；如果用户想删除或编辑条目，
   * 需要直接打开对应的 `auto.md`。
   */
  function handleMemory() {
    const sections: string[] = []
    sections.push(formatMemoryList('project', getAutoMemory('project').getAll()))
    sections.push('')
    sections.push(formatMemoryList('user', getAutoMemory('user').getAll()))
    addInfoMessage(sections.join('\n'))
  }

  // skill、plugin、mcp 的 slash-command handler 位于 ../commands/{skill,plugin,mcp}.ts。
  // 每个工厂函数都会闭包捕获 App 当前 render 的依赖，并返回上方 dispatcher 调用的 handler。
  // 这种每次 render 重新创建的身份行为，和它们以前写成组件内联函数声明时保持一致。
  const { handleSkill } = createSkillCommandHandler({
    options,
    addCommandMessage,
    invalidateSystemPromptCache,
    pendingSkillRef,
    bumpSkillRegistryVersion: () => setSkillRegistryVersion((v) => v + 1),
  })

  const { handlePlugin } = createPluginCommandHandler({
    options,
    addCommandMessage,
    askQuestion,
    invalidateSystemPromptCache,
    bumpSkillRegistryVersion: () => setSkillRegistryVersion((v) => v + 1),
  })

  const { handleMcp } = createMcpCommandHandler({
    options,
    addCommandMessage,
    addCommandResult,
    askQuestion,
    invalidateSystemPromptCache,
  })

  const handleDoctor = createDoctorCommandHandler({
    options,
    modelId: state.modelId,
    addInfoMessage,
    echoCommand,
  })

  // 渲染架构
  //
  // `ChatInput` 拥有初始 header 下面的整个终端区域：
  //   - 滚动历史消息通过直接写 stdout 提交；
  //   - spinner、输入框、分隔线、补全、错误、Permission 对话框、
  //     SelectOptions 对话框都渲染到同一个 cell 级 diff buffer 中。
  //
  // Ink 的动态区域必须始终为空，也就是不向 Ink 自己的子树里渲染任何可见内容。
  // 如果 Ink 往那里写内容，它内部使用的 `\x1b7` / `\x1b8` 会破坏我们的光标锚点，
  // 留下清不掉的旧帧。早期版本曾把 SelectOptions 作为直接 Ink 子组件，
  // 但当对话框高度超过 ChatInput 时，终端自动滚动会在对话框关闭后
  // 在 scrollback 中留下永久空行；所以它现在也被移入 ChatInput 的 cell buffer。
  const permissionRequest = state.permissionQueue[0]
  const selectActive = !!state.pendingQuestion

  return (
    <ChatInput
      messages={state.messages}
      // initialContentRows={getHeaderRowCount(state.modelId)}
      onSubmit={handleSubmit}
      onInterrupt={handleCtrlC}
      onEscapeCancel={abort}
      permissionMode={state.permissionMode}
      isLoading={state.isLoading}
      notice={notice}
      // 选择器对话框打开时，隐藏 spinner 的 “Thinking” 行，但保留 ChatInput 本体。
      // 现在对话框渲染在 ChatInput 的 cell buffer 里面，而不是 Ink 顶层子树里。
      //
      // Permission 对话框不能隐藏 spinner：active-tool 列表渲染在 ChatInput 的
      // `if (spinner)` 分支里。如果把 spinner 置空，Running 指示也会一起消失，
      // 用户会看到一个像卡住一样、没有可见权限提示的屏幕。
      spinner={
        state.isLoading && !selectActive
          ? {
              // 当一串可折叠 read 工具正在执行时，单个工具的实时指示会被抑制，
              // 否则每次快速读取都会闪一下“出现 → 消失”。但如果只显示通用
              // “Thinking...”，多秒读取链又会看起来像卡住。
              // `bufferingReads` 会在连续 read 之间 50-200ms 的间隙里保持粘性；
              // 没有它的话，标签会在每个工具之间反复 Reading/Thinking/Reading 闪烁。
              // 该状态由 useAgent 在 tool-call、text-delta、loop-end、abort 时更新。
              label: state.compressionLabel
                ? `Compressing — ${state.compressionLabel}`
                : state.bufferingReads
                  ? 'Reading'
                  : 'Thinking',
              mode: state.activeToolCalls.length > 0 ? 'tool-use' : 'requesting',
            }
          : null
      }
      contextUsage={
        // footer 上的上下文用量指示，例如 `6.6k / 200k · 3%`。
        // 它使用最近一次 API 响应里的快照，而不是累计会话计数。
        // 累计值会在每一轮重复计入消息历史；即便输入命中缓存，
        // 也仍会体现在 `inputTokens` 中，导致数字远大于实际账单意义上的用量。
        // 第一轮完成前没有快照，因此隐藏该指示。
        state.usage.currentContextTokens > 0
          ? { used: state.usage.currentContextTokens, window: getContextWindow(state.modelId) }
          : null
      }
      activeToolCalls={state.activeToolCalls}
      todos={state.todos}
      errorMessage={state.error}
      permission={
        permissionRequest
          ? {
              toolName: permissionRequest.toolName,
              input: permissionRequest.input,
              mcp: permissionRequest.mcp,
              onResolve: resolvePermission,
            }
          : null
      }
      selectRequest={
        state.pendingQuestion
          ? {
              question: state.pendingQuestion.question,
              options: state.pendingQuestion.options,
              onResolve: resolveQuestion,
              dismissible: state.pendingQuestion.dismissible,
              layout: state.pendingQuestion.layout,
            }
          : null
      }
      commands={allCommands}
    />
  )
}
