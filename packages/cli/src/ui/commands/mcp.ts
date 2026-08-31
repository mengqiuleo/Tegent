// 支持的子命令：list / tools / refresh / add / add-json / remove。
// 其中 add / remove 使用 --scope=user|project；
// --scope project 会自动信任（trust）该项目，下次启动不再弹确认框。
import {
  detectScope,
  getMcpConfigPath,
  getPluginMcpServersFromDisk, 
  loadMergedConfigsFromDisk,
  parseAdd,
  parseAddJson,
  parseRemove, 
  readServerConfig,
  removeServerFromConfig,
  serverExists,
  trustProject, 
  writeServerToConfig,
} from '@tegent/core'
import type { AgentOptions } from '@tegent/core'


export interface McpCommandDeps {
  /** Agent 运行时选项（内含 mcpRegistry、pluginRegistry 等） */
  options: AgentOptions
  /** 向 UI 输出一条命令消息：text 是用户输入的原始命令，content 是展示内容 */
  addCommandMessage: (text: string, content: string) => void
  /** 向 UI 输出命令执行结果（与普通消息的展示形态不同） */
  addCommandResult: (content: string) => void
  /** 弹出选项式提问并等待用户选择，返回选中的 label；noOther=true 时不允许自由输入 */
  askQuestion: (
    question: string,
    options: { label: string; description: string }[],
    opts?: { noOther?: boolean },
  ) => Promise<string>
  /** 使系统提示词缓存失效（工具面变化后必须调用，否则下一轮仍命中旧缓存） */
  invalidateSystemPromptCache: () => void
}

export function createMcpCommandHandler(deps: McpCommandDeps) {
  const { options, addCommandMessage, addCommandResult, askQuestion, invalidateSystemPromptCache } = deps

  /** /mcp add —— 把新 server 写入用户级（默认）或项目级配置。
   *
   *  添加后【不会】自动连接：会话中途改变工具面会使系统提示词内容变化，
   *  下一轮请求必然 prompt-cache miss（OpenAI 兼容供应商的前缀缓存）。
   *  因此只提示用户在准备好时执行 /mcp refresh 或重启 —— 与设计文档中
   *  "显式刷新"的理念保持一致。
   *
   *  --scope project 还会自动信任该项目：用户亲手执行命令本身就是
   *  授权信号，没必要下次启动再让他们确认一次信任对话框。而克隆仓库
   *  的协作者仍会正常走信任确认流程。 */
  async function handleMcpAdd(text: string, subArgRaw: string): Promise<void> {
    // 解析子命令参数（server 名字、scope、配置体）
    const res = parseAdd(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name, scope, config } = res.command

    // 在目标 scope 内做重名检查。这里刻意用 serverExists 而不是
    // detectScope：跨 scope 同名是允许的（user 级和 project 级可以
    // 合法重名 —— 比如个人版与团队共享版并存），只有同一 scope 内
    // 的冲突才会阻止本次添加。
    if (await serverExists(name, scope, process.cwd())) {
      // 重名时读出现有配置并格式化展示，方便用户对照
      const existing = await readServerConfig(name, scope, process.cwd())
      const summary =
        existing && typeof existing === 'object'
          ? JSON.stringify(existing, null, 2) 
              .split('\n') // 按行拆开
              .map((l) => '  ' + l) // 每行补两个空格缩进
              .join('\n')
          : '(unreadable)' // 配置读不出来（类型异常等）时的兜底文案
      addCommandMessage(
        text,
        [
          `Server "${name}" already exists in ${scope} scope:`,
          summary,
          '',
          `Run /mcp remove --scope ${scope} ${name} first, or pick a different name.`,
        ].join('\n'),
      )
      return
    }

    // 重名检查通过，真正写入配置文件
    let written: { path: string }
    try {
      written = await writeServerToConfig(name, config, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to add "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    let autoTrusted = false
    if (scope === 'project') {
      try {
        await trustProject(process.cwd())
        autoTrusted = true
      } catch {

      }
    }

    const transport = 'url' in config ? 'http' : 'stdio'
    const lines = [`Added MCP server "${name}" (${transport}) to ${written.path}.`]
    if (autoTrusted) {
      lines.push('Auto-trusted this project for future launches.')
    }
    if (scope === 'project') {
      lines.push('Tip: commit `.tegent/config.json` to share with collaborators.')
    }
    lines.push('Run /mcp refresh to load it now, or restart tegent.')
    addCommandMessage(text, lines.join('\n'))
  }

  /** /mcp add-json —— 与 /mcp add 相同，但配置体是一个原始 JSON 对象。
   *  （嵌套 env、多个 header、自定义 cwd 等）。 */
  async function handleMcpAddJson(text: string, subArgRaw: string): Promise<void> {
    const res = parseAddJson(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name, scope, config } = res.command

    // 同一 scope 内重名检查（逻辑与 add 一致）
    if (await serverExists(name, scope, process.cwd())) {
      addCommandMessage(
        text,
        `Server "${name}" already exists in ${scope} scope. Run /mcp remove --scope ${scope} ${name} first.`,
      )
      return
    }

    let written: { path: string }
    try {
      written = await writeServerToConfig(name, config, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to add "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    let autoTrusted = false
    if (scope === 'project') {
      try {
        await trustProject(process.cwd())
        autoTrusted = true
      } catch {

      }
    }

    const lines = [`Added MCP server "${name}" to ${written.path}.`]
    if (autoTrusted) lines.push('Auto-trusted this project for future launches.')
    if (scope === 'project') lines.push('Tip: commit `.tegent/config.json` to share with collaborators.')
    lines.push('Run /mcp refresh to load it now, or restart tegent.')
    addCommandMessage(text, lines.join('\n'))
  }

  /** /mcp remove —— 从 config.json 删除一个 server。做任何破坏性操作前先弹 y/N 确认。 */
  async function handleMcpRemove(text: string, subArgRaw: string): Promise<void> {
    const res = parseRemove(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name } = res.command 
    let scope = res.command.scope

    if (!scope) {
      // 未指定 scope：自动探测。名字同时存在于两个 scope 时（both）
      // 强制用户显式指定 --scope，避免静默删错一边。
      const detected = await detectScope(name, process.cwd())
      switch (detected.kind) {
        case 'not-found':
          // 两个 scope 都没有：无事可做
          addCommandMessage(text, `Server "${name}" is not in user or project config — nothing to remove.`)
          return
        case 'both':
          // 两边都有：必须让用户二选一
          addCommandMessage(text, `Server "${name}" exists at both scopes. Specify --scope user or --scope project.`)
          return
        case 'user':
        case 'project':
          // 只有一边有：直接采用探测结果
          scope = detected.kind
          break
      }
    } else {
      // 显式指定了 scope：先确认条目确实存在，再去打扰用户弹确认框
      if (!(await serverExists(name, scope, process.cwd()))) {
        addCommandMessage(
          text,
          `Server "${name}" is not in ${scope} scope (${getMcpConfigPath(scope, process.cwd())}) — nothing to remove.`,
        )
        return
      }
    }

    // 删除前确认：Remove / Cancel 二选一，不允许自由输入
    const confirmAnswer = await askQuestion(
      `Remove MCP server "${name}" from ${scope} scope?\n  (${getMcpConfigPath(scope, process.cwd())})`,
      [
        { label: 'Remove', description: 'Delete this server entry. Current session unchanged.' },
        { label: 'Cancel', description: 'Keep the config as-is.' },
      ],
      { noOther: true },
    )
    if (confirmAnswer !== 'Remove') {
      addCommandMessage(text, `Cancelled — "${name}" not removed.`) // 用户取消
      return
    }

    // 确认后执行删除
    let result: { path: string; removed: boolean }
    try {
      result = await removeServerFromConfig(name, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to remove "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!result.removed) {
      addCommandMessage(text, `Server "${name}" was already gone from ${scope} scope.`)
      return
    }

    // 删除成功：告知路径，并说明当前会话不受影响
    addCommandMessage(
      text,
      [
        `Removed "${name}" from ${scope} scope (${result.path}).`,
        'Current session unchanged — the running server (if any) keeps working until tegent exits.',
      ].join('\n'),
    )
  }

  // /mcp 主入口：解析子命令，分发给对应的处理函数
  async function handleMcp(text: string, arg: string): Promise<void> {
    const argTrimmed = arg.trim()
    const sub = (argTrimmed.split(/\s+/)[0] ?? '').toLowerCase()
    const subArg = argTrimmed.slice(sub.length).trim() // 其余部分作为该子命令的参数
    const registry = options.mcpRegistry 

    switch (sub) {
      // 无参数或 list：列出所有 server 及其连接状态
      case '':
      case 'list': {
        const statuses = registry?.serverStatus() ?? [] // 各 server 的状态快照
        if (statuses.length === 0) {
          addCommandMessage(text, 'No MCP servers configured. Add `mcpServers` to ~/.tegent/config.json then restart.')
          return
        }
        const lines = ['MCP servers:']
        const namePad = Math.max(...statuses.map((s) => s.name.length), 8) + 2
        for (const s of statuses) {
          let badge = '' // 每个 server 的状态徽标文案
          switch (s.status.kind) {
            case 'connected':
              // 已连接：展示工具数与资源数（注意单复数处理）
              badge = `connected — ${s.status.toolCount} tool${s.status.toolCount === 1 ? '' : 's'}, ${s.status.resourceCount} resource${s.status.resourceCount === 1 ? '' : 's'}`
              break
            case 'disabled':
              badge = 'disabled' // 已禁用
              break
            case 'connecting':
              badge = 'connecting…' // 连接中
              break
            case 'failed':
              badge = `failed — ${s.status.error}` // 连接失败：附上错误信息
              break
          }
          lines.push(`  ${s.name.padEnd(namePad)} ${badge}`)
        }
        addCommandMessage(text, lines.join('\n'))
        return
      }
      // tools：列出工具。可带 server 名做过滤（/mcp tools <server>）
      case 'tools': {
        const all = registry?.list() ?? []
        const filtered = subArg ? all.filter((t) => t.serverName === subArg) : all // 有参数则只保留该 server 的工具
        if (filtered.length === 0) {
          addCommandMessage(text, subArg ? `No tools on server "${subArg}".` : 'No MCP tools available.')
          return
        }
        const lines = [subArg ? `MCP tools on ${subArg}:` : 'All MCP tools:']
        for (const t of filtered) {
          const desc = t.description ? ` — ${t.description.slice(0, 160).replace(/\s+/g, ' ').trim()}` : ''
          lines.push(`  ${t.callableName}${desc}`)
        }
        addCommandMessage(text, lines.join('\n'))
        return
      }
      // refresh：重读配置并重连所有 server
      case 'refresh': {
        if (!registry) {
          addCommandMessage(text, 'No MCP registry to refresh.')
          return
        }
        addCommandMessage(text, 'Re-reading MCP config and reconnecting servers...')
        try {
          const extraServers = options.pluginRegistry ? await getPluginMcpServersFromDisk(process.cwd()) : undefined
          const { configs, configErrors, projectSkipped } = await loadMergedConfigsFromDisk({
            cwd: process.cwd(),
            askUser: (q, opts) => askQuestion(q, opts, { noOther: true }), // 信任确认走 UI 提问
            extraServers, // 插件贡献的 server 一并合并
          })
          const summary = await registry.restartAll(configs) // 按新配置重连全部 server
          invalidateSystemPromptCache() // 工具面变了，系统提示词缓存必须失效

          // 汇总本次刷新的变更明细
          const parts: string[] = []
          if (summary.added.length) parts.push(`added: ${summary.added.join(', ')}`) // 新增的 server
          if (summary.removed.length) parts.push(`removed: ${summary.removed.join(', ')}`) // 移除的 server
          if (summary.changed.length) parts.push(`changed: ${summary.changed.join(', ')}`) // 配置变化后重连的 server
          if (summary.unchanged.length) parts.push(`reconnected: ${summary.unchanged.join(', ')}`) // 未变化也重连的 server
          if (parts.length === 0) parts.push('no servers configured') // 一个 server 都没配
          const lines = [`Reloaded MCP — ${parts.join('; ')}.`]
          lines.push(`Note: next message rebuilds the system prompt, so prompt-cache will miss once.`) // 提醒：缓存会 miss 一次
          if (projectSkipped) lines.push('Project-level MCP servers were skipped (not trusted).') // 项目级配置因未信任被跳过
          for (const e of configErrors) lines.push(`Config error in ${e.name}: ${e.message}`) // 逐条列出配置错误
          addCommandResult(lines.join('\n'))
        } catch (err) {
          addCommandResult(`✗ Refresh failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }

      case 'add':
        await handleMcpAdd(text, subArg)
        return


      case 'add-json':
        await handleMcpAddJson(text, subArg)
        return

      case 'remove':
      case 'rm':
        await handleMcpRemove(text, subArg)
        return

      default: {
        addCommandMessage(
          text,
          `Unknown subcommand: /mcp ${sub}. Available: list, tools, add, add-json, remove, refresh.`,
        )
        return
      }
    }
  }

  return { handleMcp }
}
