// 这里刻意完全绕开 Ink：不挂载 TUI 组件，不把 stdin 切到 raw mode，
// 也不等待 React reconciler 处理输入事件。之前如果复用 Ink 路径，
// print 模式无法稳定自动退出，因为 usePromptInput 会引用 raw mode stdin，
// 导致事件循环一直存活，直到用户按键或调整终端大小后，排队的 unmount 才会执行。
// 因此 print 模式独立成这条代码路径，避免这些交互式 UI 的生命周期问题。
import { agentLoop, hydrateLoopState, saveSession } from '@tegent/core' // 引入 agent 主循环、会话状态恢复和会话保存工具。
import type { AgentCallbacks, AgentOptions, LanguageModel, LoadedSession } from '@tegent/core' // 引入 print 模式运行所需的核心类型。

/**
 * 运行非交互式 print 模式，并返回适合进程退出使用的退出码。
 *
 * 该模式直接把模型文本增量写到 stdout，不挂载 Ink UI；遇到需要用户交互的场景时，
 * 会通过 stderr 给出说明并返回拒绝或空回答。它也支持从 `--continue` / `--resume`
 * 加载已有会话状态，确保 print 模式和交互模式使用同一套会话语义。
 *
 * @param model - 已经从 provider 注册表中解析出的语言模型实例。
 * @param options - agentLoop 的运行选项，包括权限模式、模型 id、插件上下文等。
 * @param prompt - 本次非交互式提交的用户提示词。
 * @param initialSession - 可选的已加载历史会话，用于支持 `--continue` 和 `--resume`。
 * @returns 进程退出码；`0` 表示成功，`1` 表示运行中出现错误或致命异常。
 */
export async function runPrintMode( // 导出非交互式模式 runner，供 CLI 主入口调用。
  model: LanguageModel, // 当前调用要使用的语言模型对象。
  options: AgentOptions, // 当前 agentLoop 的配置选项。
  prompt: string, // 用户输入或 stdin 合并后的提示词。
  initialSession?: LoadedSession | null, // 可选的历史会话；没有恢复会话时为空。
): Promise<number> { // 函数异步返回退出码。
  // Ctrl+C 时中止当前 agentLoop，让长时间运行的 -p 调用可以被用户打断。
  const controller = new AbortController() // 创建 AbortController，用于向 agentLoop 传递中止信号。
  const onSigint = () => controller.abort() // 定义 SIGINT 处理函数，把 Ctrl+C 转换成 abort。
  process.on('SIGINT', onSigint) // 注册 SIGINT 监听器，确保运行期间可中断。

  let sawError = false // 记录回调过程中是否收到非致命错误，用于最终决定退出码。

  const callbacks: AgentCallbacks = { // 定义 agentLoop 在 print 模式下使用的一组回调。
    onTextDelta: (delta) => { // 收到模型文本增量时调用。
      if (delta) process.stdout.write(delta) // 如果有实际文本，就原样写入 stdout。
    }, // 结束文本增量回调。
    onToolCall: () => {}, // print 模式不展示工具调用开始事件，因此这里静默忽略。
    onToolProgress: () => {}, // print 模式没有进度 UI，因此工具进度静默忽略。
    onToolResult: () => {}, // print 模式不额外渲染工具结果，由模型最终文本负责表达。
    onAskPermission: async (toolCall) => { // 工具执行需要权限确认时调用。
      // 非交互模式无法弹出确认提示，因此默认拒绝，让模型根据拒绝结果自行调整。
      // 如果用户希望 -p 模式自动允许写操作，应显式传入 -t / --trust。
      process.stderr.write(`\n[permission denied: ${toolCall.toolName} — pass --trust to auto-approve in -p mode]\n`) // 向 stderr 说明权限被拒绝及解决方式。
      return 'no' // 返回拒绝，阻止该工具调用继续执行。
    }, // 结束权限请求回调。
    onAskUser: async (question) => { // 模型或工具需要向用户追问时调用。
      process.stderr.write(`\n[cannot ask question in -p mode: ${question}]\n`) // 向 stderr 说明非交互模式无法追问。
      return '' // 返回空字符串，表示没有用户补充输入。
    }, // 结束用户追问回调。
    onPlanApprovalRequest: async () => { // plan 模式请求用户批准进入编辑阶段时调用。
      // 非交互模式无法展示批准对话框，因此默认拒绝批准。
      // 这样模型会留在 plan 模式并输出最终计划，而不是假装用户已经批准。
      process.stderr.write(`\n[plan approval not available in -p mode — pass --plan + interactive session]\n`) // 向 stderr 说明 print 模式不能批准计划。
      return false // 返回 false，表示计划未获批准。
    }, // 结束计划批准回调。
    onPlanModeChange: () => { // plan 模式状态变化时调用。
      // print 模式没有 UI 需要刷新；模式变化已经写入 LoopState，
      // 对这种短生命周期运行来说，LoopState 才是真正需要更新的状态来源。
    }, // 结束 plan 模式变化回调。
    onTodosUpdate: () => { // 待办事项状态变化时调用。
      // print 模式没有实时待办面板；todos 仍存在于 LoopState 中，
      // 只是当前终端输出不负责渲染它们，因此这里保持静默。
    }, // 结束待办更新回调。
    onShellOutput: () => {}, // print 模式不单独展示 shell 输出事件。
    onUsageUpdate: () => {}, // print 模式不实时展示 token 用量变化。
    onContextCompressed: () => {}, // print 模式不额外提示上下文压缩事件。
    onError: (err) => { // agentLoop 报告可恢复或非致命错误时调用。
      sawError = true // 标记发生过错误，最终退出码会变成 1。
      process.stderr.write(`\n[error] ${err.message}\n`) // 将错误消息写入 stderr。
    }, // 结束错误回调。
  } // 结束 callbacks 定义。

  try { // 进入主运行逻辑，并统一捕获致命异常。
    // 在 print 模式中支持 --continue / --resume：从已加载会话恢复 LoopState。
    // 如果不做这一步，main() 虽然已经读取了之前的 jsonl，会话主循环却会从空状态开始，
    // 等于静默丢掉用户的恢复请求。交互式 Ink 路径通过 useAgent 调用 hydrateLoopState，
    // print 模式这里补上同样的连接。
    const existingState = initialSession // 根据是否传入历史会话决定是否恢复已有 LoopState。
      ? hydrateLoopState(initialSession, options.permissionMode ?? 'default') // 有历史会话时，把 jsonl 内容恢复成 agentLoop 可继续使用的状态。
      : undefined // 没有历史会话时传 undefined，让 agentLoop 创建新会话状态。
    const { state } = await agentLoop( // 运行 agent 主循环，并取回最终 LoopState。
      prompt, // 传入本次用户提示词。
      model, // 传入已经解析好的语言模型实例。
      { ...options, abortSignal: controller.signal }, // 透传选项，并额外加入 Ctrl+C 可触发的 abortSignal。
      callbacks, // 传入 print 模式专用回调集合。
      existingState, // 传入可选的历史状态，支持继续会话。
    ) // 结束 agentLoop 调用。

    // stdout 是 TTY 时补一个换行，让 shell prompt 出现在新行。
    // 如果 stdout 被管道消费，就保留模型输出原样，避免改变脚本调用者拿到的数据。
    if (process.stdout.isTTY) process.stdout.write('\n') // 仅交互终端下补尾随换行。

    // 等待会话保存完成：print 模式生命周期很短，保存完成前进程就可能退出。
    // 如果这里 fire-and-forget，process.exit 可能抢在 jsonl flush 前发生，
    // 导致最后一轮消息丢失。这里多等几十毫秒，比脚本调用者或 e2e 测试读到残缺转录更可取。
    // 交互式 Ink 路径可以继续 fire-and-forget，因为它通过 React unmount 退出，而不是立刻 process.exit。
    await saveSession(state, model).catch(() => undefined) // 尝试保存会话；保存失败不影响 print 模式退出。

    return sawError ? 1 : 0 // 如果运行期间出现过错误则返回 1，否则返回 0。
  } catch (err) { // 捕获 agentLoop 或周边逻辑抛出的致命异常。
    process.stderr.write(`\n[fatal] ${err instanceof Error ? err.message : String(err)}\n`) // 将致命错误格式化写入 stderr。
    return 1 // 致命异常统一返回失败退出码。
  } finally { // 无论成功、失败还是抛错，都执行清理逻辑。
    process.off('SIGINT', onSigint) // 移除 SIGINT 监听器，避免泄漏到后续流程。
  } // 结束 finally 清理。
} // 结束 runPrintMode。
