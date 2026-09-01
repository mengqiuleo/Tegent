// 子命令：list / info / install / uninstall / enable / disable /
// search / update / refresh / doctor / marketplace（后者自带
// add / remove / list / refresh / info 子命令树）。未知子命令会 打印用法提示。
import {
  addKnownMarketplace,
  clearPluginEntry,
  fetchMarketplace,
  installPlugin,
  listInstalledPlugins,
  lookupPlugin,
  readAllCachedMarketplaces,
  readKnownMarketplaces,
  refreshPluginContributions,
  removeKnownMarketplace,
  resolveContributions,
  setPluginEnabled,
  uninstallPlugin,
} from '@tegent/core'
import type { AgentOptions, PluginScope, PluginSource } from '@tegent/core'

/**
 * `/plugin` 命令处理器的依赖集合（由 App 层注入，见 createPluginCommandHandler）。
 */
export interface PluginCommandDeps {
  /** Agent 运行时选项，携带各注册表：plugin / skill / subAgent / command / mcp / hookBus */
  options: AgentOptions
  /** 把命令结果渲染到聊天界面：text 为用户原始输入，content 为 markdown 内容 */
  addCommandMessage: (text: string, content: string) => void
  /** 在最近一次命令回显下方追加紧凑的 `⎿` 结果行（异步命令的增量输出） */
  addCommandResult: (content: string) => void
  /** 向用户弹出选项式询问（`/plugin refresh` 的信任确认流程会用到） */
  askQuestion: (
    question: string,
    options: { label: string; description: string }[],
    opts?: { noOther?: boolean },
  ) => Promise<string>
  /** 使系统提示缓存失效（插件集合变更后，下一条消息需重建提示词） */
  invalidateSystemPromptCache: () => void
  /** 递增技能注册表版本号（让 /help 与 Tab 补全重新计算） */
  bumpSkillRegistryVersion: () => void
}

/**
 * 三种来源的渲染形式：
 * - local  → `local: <路径>`
 * - git    → `git: <url>`（带 ref 时追加 `#<ref>`）
 * - github → `github:<owner>/<repo>`（带 ref 时追加 `#<ref>`）
 *
 * @param s 插件来源对象；为 undefined 时返回 `(unknown)`
 * @returns 可直接展示的来源描述字符串
 */
function formatPluginSource(s: PluginSource | undefined): string {
  if (!s) return '(unknown)'
  if (s.kind === 'local') return `local: ${s.path}`
  if (s.kind === 'git') return `git: ${s.url}${s.ref ? `#${s.ref}` : ''}`
  return `github:${s.owner}/${s.repo}${s.ref ? `#${s.ref}` : ''}`
}

/**
 * 解析 `/plugin enable|disable` 的参数字符串，识别通用的
 * `--scope=user|project` / `-s=user|project` 标志（解析逻辑与
 * parseSkillScopeFlag 相同）。默认 scope = 'user'，让简短调用保持简短。
 *
 * @param arg 原始参数串，例如 `"my-plugin --scope=project"`
 * @returns `{ id, scope }`：去掉标志后剩下的插件 id，以及解析出的作用域
 */
function parsePluginScopeFlag(arg: string): { id: string; scope: PluginScope } {
  const tokens = arg.split(/\s+/).filter(Boolean)
  let scope: PluginScope = 'user'
  const remaining: string[] = []
  for (const tok of tokens) {
    const m = tok.match(/^(?:--scope|-s)(?:=(.+))?$/)
    if (m) {
      const value = m[1]?.toLowerCase()
      if (value === 'user' || value === 'project') scope = value
      continue
    }
    remaining.push(tok)
  }
  return { id: remaining.join(' '), scope }
}

/**
 * `/plugin` 命令处理器工厂：把所有子命令需要的依赖一次性闭包进来，
 * 返回主分发函数 handlePlugin（它再按第一个词路由到各子命令处理函数）。
 *
 * @param deps 依赖集合，见 {@link PluginCommandDeps}
 * @returns `{ handlePlugin }` — `/plugin` 命令的总入口
 */
export function createPluginCommandHandler(deps: PluginCommandDeps) {
  const { options, addCommandMessage, addCommandResult, askQuestion, invalidateSystemPromptCache, bumpSkillRegistryVersion } = deps

  /**
   * `/plugin list`：列出已安装的插件。
   *
   * 输出为对齐的列表：开关徽标 `[on]/[off]` + 插件 id + 版本 + 来源市场；
   * 注册表中若有加载错误，末尾追加提示（引导去 `/plugin doctor`）。
   *
   * @param text 用户原始输入（用于消息展示）
   * @param raw 子命令之后的参数串，可能混有 'list' 本身与过滤标志
   */
  function pluginList(text: string, raw: string): void {
    const reg = options.pluginRegistry
    if (!reg) {
      addCommandMessage(text, 'Plugin system is disabled for this session.')
      return
    }
    // 可选过滤：--enabled（只看已启用）、--disabled（只看已禁用）、不带标志 = 全部。
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    let filter: 'all' | 'enabled' | 'disabled' = 'all'
    for (const t of tokens) {
      // 跳过子命令词本身（'list'），如果存在的话
      if (t === 'list') continue
      if (t === '--enabled') filter = 'enabled'
      else if (t === '--disabled') filter = 'disabled'
    }
    const all = reg.listAll()
    if (all.length === 0) {
      addCommandMessage(text, 'No plugins installed. Install one with `/plugin install <source>`.')
      return
    }
    const filtered =
      filter === 'enabled' ? all.filter((p) => p.enabled) : filter === 'disabled' ? all.filter((p) => !p.enabled) : all
    if (filtered.length === 0) {
      addCommandMessage(text, `No ${filter} plugins.`)
      return
    }
    const header =
      filter === 'all'
        ? `**Installed plugins** (${filtered.length}):`
        : `**Installed plugins** (${filter}, ${filtered.length} of ${all.length}):`
    const lines = [header]
    const namePad = Math.max(...filtered.map((p) => p.id.length), 8) + 2
    for (const p of filtered) {
      const badge = p.enabled ? '[on] ' : '[off]'
      const src = p.marketplace === 'local' ? '(local)' : `(${p.marketplace})`
      lines.push(`  ${badge} ${p.id.padEnd(namePad)} v${p.manifest.version}  ${src}`)
    }
    const errors = reg.loadErrors()
    if (errors.length > 0) {
      lines.push('', `${errors.length} load error${errors.length === 1 ? '' : 's'} — run \`/plugin doctor\`.`)
    }
    addCommandMessage(text, lines.join('\n'))
  }

  /**
   * `/plugin info <id>`：显示单个插件的详情。
   *
   * 输出分两段：manifest 元数据（版本 / 描述 / 来源 / 目录 / 作者等），
   * 以及插件的"贡献物"（它向宿主注入的 skills / agents / commands /
   * mcpServers / hooks —— 可能是目录路径，也可能是内联配置）。
   *
   * @param text 用户原始输入
   * @param raw 插件 id，格式 `name@marketplace`
   */
  async function pluginInfo(text: string, raw: string): Promise<void> {
    const id = raw.trim()
    if (!id) {
      addCommandMessage(text, 'Usage: `/plugin info <id>`  (id = `name@marketplace`)')
      return
    }
    const plugin = options.pluginRegistry?.getEntry(id)
    if (!plugin) {
      addCommandMessage(text, `No plugin \`${id}\` loaded. Check \`/plugin list\`.`)
      return
    }
    // 解析插件声明了哪些贡献物（各目录 / 内联的 MCP 与 hooks 配置）
    const c = await resolveContributions(plugin)
    const lines: string[] = [
      `**${plugin.id}** v${plugin.manifest.version}`,
      plugin.manifest.description ?? '_(no description)_',
      '',
      `- Enabled:     ${plugin.enabled ? 'yes' : 'no'}`,
      `- Source:      ${formatPluginSource(plugin.source)}`,
      `- Marketplace: ${plugin.marketplace}`,
      `- Root dir:    ${plugin.rootDir}`,
      `- Manifest:    ${plugin.manifestPath} (${plugin.manifestFormat})`,
    ]
    if (plugin.manifest.author?.name) lines.push(`- Author:      ${plugin.manifest.author.name}`)
    if (plugin.manifest.homepage) lines.push(`- Homepage:    ${plugin.manifest.homepage}`)
    if (plugin.manifest.license) lines.push(`- License:     ${plugin.manifest.license}`)

    lines.push('', '**Contributions:**')
    let any = false
    if (c.skillsDir) {
      lines.push(`- skills:     ${c.skillsDir}`)
      any = true
    }
    if (c.agentsDir) {
      lines.push(`- agents:     ${c.agentsDir}`)
      any = true
    }
    if (c.commandsDir) {
      lines.push(`- commands:   ${c.commandsDir}`)
      any = true
    }
    if (c.mcpServers) {
      lines.push(`- mcpServers: ${c.mcpServers.kind === 'inline' ? '(inline)' : c.mcpServers.path}`)
      any = true
    }
    if (c.hooks) {
      lines.push(`- hooks:      ${c.hooks.kind === 'inline' ? '(inline)' : c.hooks.path}`)
      any = true
    }
    if (!any) lines.push('- _(none)_')

    addCommandMessage(text, lines.join('\n'))
  }

  /**
   * `/plugin install <source>`：安装插件。
   *
   * 只接受一个来源参数，识别来源类型后
   * 下载 / 拷贝到缓存目录并读取 manifest。四种来源：
   * 1. `name@marketplace` — 先到已订阅市场的缓存索引里查真实来源
   * 2. `github:owner/repo[#ref]` — GitHub 仓库简写
   * 3. `https://…` / `git@…` — 任意 git URL
   * 4. `./path`、`/abs/path`、`C:\path` — 本地目录
   *
   * 注意：安装只落盘，插件的贡献物（技能 / 子代理 / 命令 / hooks）不会
   * 立即生效，需再执行 `/plugin refresh`；MCP 服务器则要单独 `/mcp refresh`。
   *
   * @param text 用户原始输入
   * @param raw 来源字符串
   */
  async function pluginInstall(text: string, raw: string): Promise<void> {
    if (!raw) {
      addCommandMessage(
        text,
        'Usage: `/plugin install <source>`\n' +
          '  Sources:\n' +
          '    `<name>@<marketplace>` — look up + install from subscribed marketplace\n' +
          '    `github:owner/repo[#ref]` — install from a GitHub repo\n' +
          '    `https://...` or `git@...` — install from any git URL\n' +
          '    `/abs/path` or `./relative/path` — install from a local directory',
      )
      return
    }

    const tokens = raw.trim().split(/\s+/)
    const source_str = tokens[0]!
    // 多余参数一律报错
    const extras = tokens.slice(1)
    if (extras.length > 0) {
      addCommandMessage(
        text,
        `Unrecognised arguments to \`/plugin install\`: ${extras.map((e) => `\`${e}\``).join(', ')}`,
      )
      return
    }
    raw = source_str

    let source: PluginSource
    let marketplace: string
    let expectedName: string | undefined

    // 识别来源类型：本地路径 / git URL / github 简写 / 市场引用（name@marketplace）。
    // 市场引用的判定必须排除前三种，避免把 URL 或路径里的 '@' 误当成市场分隔符。
    const isPath = raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(raw)
    const isGitUrl = /^https?:\/\//i.test(raw) || raw.startsWith('git@')
    const isGhShort = raw.startsWith('github:')
    const atIdx = raw.lastIndexOf('@')
    const isMarketplaceRef = atIdx > 0 && !isPath && !isGitUrl && !isGhShort

    // 市场引用：先在已订阅市场的缓存索引中查该插件，拿到真实安装来源
    if (isMarketplaceRef) {
      const name = raw.slice(0, atIdx)
      const mpName = raw.slice(atIdx + 1)
      const found = await lookupPlugin(`${name}@${mpName}`)
      if (!found) {
        addCommandMessage(
          text,
          `Plugin \`${name}\` not found in marketplace \`${mpName}\`. ` +
            `Run \`/plugin marketplace refresh ${mpName}\` or check the spelling.`,
        )
        return
      }
      source = found.entry.source
      marketplace = mpName
      expectedName = name
    } else if (isGhShort) {
      const m = raw.match(/^github:([^/]+)\/(.+?)(?:#(.+))?$/i)
      if (!m) {
        addCommandMessage(text, 'Invalid github source. Expected `github:owner/repo` or `github:owner/repo#ref`.')
        return
      }
      source = { kind: 'github', owner: m[1]!, repo: m[2]!, ref: m[3] }
      marketplace = 'local'
    } else if (isGitUrl) {
      source = { kind: 'git', url: raw }
      marketplace = 'local'
    } else if (isPath) {
      source = { kind: 'local', path: raw }
      marketplace = 'local'
    } else {
      addCommandMessage(
        text,
        `Unrecognised source: \`${raw}\`. Use \`name@marketplace\`, \`github:owner/repo\`, an https/git URL, or a path.`,
      )
      return
    }

    addCommandMessage(text, `Installing from ${formatPluginSource(source)} …`)
    try {
      const result = await installPlugin({ source, marketplace, expectedName })
      addCommandMessage(
        text,
        `Installed **${result.pluginId}** v${result.manifest.version}\n` +
          `Cache: \`${result.rootDir}\`\n` +
          `Run \`/plugin refresh\` to load this plugin's contributions now (skills / agents / commands / hooks). ` +
          `MCP servers need \`/mcp refresh\` separately.`,
      )
    } catch (err) {
      addCommandMessage(text, `Install failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * `/plugin uninstall <id>`：卸载插件。
   *
   * 做两件事：删除缓存目录中该插件的所有版本，并清掉 user / project
   * 两个作用域配置里的启停记录。插件的数据目录（用户状态）会保留，
   * 重装后可继续使用。活跃注册表里的贡献物要等 `/plugin refresh` 才移除。
   *
   * @param text 用户原始输入
   * @param raw 插件 id，格式 `name@marketplace`
   */
  async function pluginUninstall(text: string, raw: string): Promise<void> {
    const id = raw.trim()
    if (!id) {
      addCommandMessage(text, 'Usage: `/plugin uninstall <id>` (id = `name@marketplace`)')
      return
    }
    try {
      const result = await uninstallPlugin(id)
      if (!result.removedRecord && result.removedVersions.length === 0) {
        addCommandMessage(text, `No plugin \`${id}\` installed.`)
        return
      }
      // 清掉两个作用域里的启停记录；清理失败不影响卸载结果
      for (const scope of ['user', 'project'] as PluginScope[]) {
        await clearPluginEntry(id, scope).catch(() => undefined)
      }
      const verCount = result.removedVersions.length
      addCommandMessage(
        text,
        `Uninstalled **${id}** (removed ${verCount} cached version${verCount === 1 ? '' : 's'}).\n` +
          `Plugin data dir preserved — reinstall will keep user state.\n` +
          `Run \`/plugin refresh\` to drop its contributions from active registries.`,
      )
    } catch (err) {
      addCommandMessage(text, `Uninstall failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * `/plugin enable|disable <id> [--scope=user|project]`：切换插件启停。
   *
   * 只改写指定作用域配置文件里的开关，不动已加载的注册表；
   * 要让变更立即生效需执行 `/plugin refresh`。
   *
   * @param text 用户原始输入
   * @param raw 参数串（插件 id + 可选 scope 标志），由 parsePluginScopeFlag 解析
   * @param enable true 对应 enable 子命令，false 对应 disable 子命令
   */
  async function pluginToggle(text: string, raw: string, enable: boolean): Promise<void> {
    const { id, scope } = parsePluginScopeFlag(raw)
    if (!id) {
      addCommandMessage(text, `Usage: \`/plugin ${enable ? 'enable' : 'disable'} <id> [--scope=user|project]\``)
      return
    }
    try {
      const result = await setPluginEnabled(id, scope, enable)
      const verb = enable ? 'enabled' : 'disabled'
      if (result === 'noop') {
        addCommandMessage(text, `Plugin \`${id}\` already ${verb} (${scope} scope).`)
      } else {
        addCommandMessage(text, `Plugin **${id}** ${verb} in ${scope} scope. Run \`/plugin refresh\` to apply now.`)
      }
    } catch (err) {
      addCommandMessage(text, `Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * `/plugin search <keyword>`：按关键词搜索插件。
   *
   * 只查本地缓存的市场索引（不联网）：把每个条目的 名称 + 描述 + keywords
   * 拼成一句话，做小写子串匹配。缓存为空时引导用户先刷新市场索引。
   *
   * @param text 用户原始输入
   * @param raw 搜索关键词
   */
  async function pluginSearch(text: string, raw: string): Promise<void> {
    const kw = raw.trim().toLowerCase()
    if (!kw) {
      addCommandMessage(text, 'Usage: `/plugin search <keyword>`')
      return
    }
    const marketplaces = await readAllCachedMarketplaces()
    if (marketplaces.length === 0) {
      const km = await readKnownMarketplaces()
      if (km.marketplaces.length === 0) {
        addCommandMessage(
          text,
          'No subscribed marketplaces. Add one with `/plugin marketplace add <name> <source>` and `refresh` it.',
        )
      } else {
        const names = km.marketplaces.map((m) => m.name).join(', ')
        addCommandMessage(
          text,
          `No cached marketplace index. You're subscribed to ${names} but the cache is empty — run \`/plugin marketplace refresh\` to fetch.`,
        )
      }
      return
    }
    const matches: Array<{ marketplace: string; name: string; description?: string; verified?: boolean }> = []
    for (const m of marketplaces) {
      for (const entry of m.plugins) {
        // 把名称 / 描述 / 关键词拼成一个"草垛"（haystack），再做包含匹配
        const hay = [entry.name, entry.description ?? '', ...(entry.keywords ?? [])].join(' ').toLowerCase()
        if (hay.includes(kw)) {
          matches.push({
            marketplace: m.name,
            name: entry.name,
            description: entry.description,
            verified: entry.verified,
          })
        }
      }
    }
    if (matches.length === 0) {
      addCommandMessage(
        text,
        `No plugins matching \`${kw}\` in ${marketplaces.length} subscribed marketplace${marketplaces.length === 1 ? '' : 's'}. ` +
          `Run \`/plugin marketplace refresh\` to pull latest indexes.`,
      )
      return
    }
    const lines = [`Found ${matches.length} match${matches.length === 1 ? '' : 'es'}:`]
    for (const m of matches) {
      const tag = m.verified ? ' [verified]' : ''
      lines.push(`  ${m.name}@${m.marketplace}${tag}`)
      if (m.description) lines.push(`    ${m.description}`)
    }
    lines.push('', 'Install with `/plugin install <name>@<marketplace>`.')
    addCommandMessage(text, lines.join('\n'))
  }

  /**
   * `/plugin update <id>` / `/plugin update --all`：更新插件。
   *
   * "更新"即按安装记录里的原始来源重新安装一遍，再比较前后版本号：
   * 一样 → 原地重装（unchanged），不一样 → 升级（updated）。
   * `--all` 时串行更新所有已安装插件，单个失败跳过并继续。
   *
   * @param text 用户原始输入
   * @param raw 插件 id，或 `--all` / `-a`
   */
  async function pluginUpdate(text: string, raw: string): Promise<void> {
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    const all = tokens.includes('--all') || tokens.includes('-a')
    const positional = tokens.filter((t) => t !== '--all' && t !== '-a')

    if (all && positional.length > 0) {
      addCommandMessage(text, '`/plugin update`: pass either `--all` or a plugin id, not both.')
      return
    }
    if (!all && positional.length === 0) {
      addCommandMessage(
        text,
        'Usage: `/plugin update <id>` · `/plugin update --all`\n' +
          '  `<id>`: a `name@marketplace` from `/plugin list`\n' +
          '  `--all`: update every installed plugin (sequential, skip-on-error)',
      )
      return
    }

    if (all) {
      const records = await listInstalledPlugins()
      if (records.length === 0) {
        addCommandMessage(text, 'No plugins installed.')
        return
      }
      addCommandMessage(text, `Updating ${records.length} plugin${records.length === 1 ? '' : 's'} …`)
      const lines: string[] = []
      let updated = 0
      let unchanged = 0
      let failed = 0
      for (const rec of records) {
        try {
          const result = await installPlugin({
            source: rec.source,
            marketplace: rec.marketplace,
            expectedName: rec.name,
          })
          // 版本号没变 → 视为未变更（原地重装）；变了 → 记一次更新
          if (result.manifest.version === rec.version) {
            lines.push(`  ${rec.id}: reinstalled at ${rec.version}`)
            unchanged++
          } else {
            lines.push(`  ${rec.id}: ${rec.version} → ${result.manifest.version}`)
            updated++
          }
        } catch (err) {
          lines.push(`  ${rec.id}: failed — ${err instanceof Error ? err.message : String(err)}`)
          failed++
        }
      }
      lines.push('', `Summary: ${updated} updated, ${unchanged} unchanged, ${failed} failed.`)
      if (updated > 0) lines.push('Run `/plugin refresh` to load the new versions.')
      addCommandMessage(text, lines.join('\n'))
      return
    }

    const id = positional[0]!
    const records = await listInstalledPlugins()
    const rec = records.find((r) => r.id === id)
    if (!rec) {
      addCommandMessage(text, `Plugin \`${id}\` not installed.`)
      return
    }
    addCommandMessage(text, `Reinstalling **${id}** from ${formatPluginSource(rec.source)} …`)
    try {
      const result = await installPlugin({
        source: rec.source,
        marketplace: rec.marketplace,
        expectedName: rec.name,
      })
      const versionMsg =
        result.manifest.version === rec.version
          ? `Reinstalled at the same version (${rec.version}).`
          : `Updated ${rec.version} → ${result.manifest.version}.`
      addCommandMessage(text, `${versionMsg} Run \`/plugin refresh\` to load the new version.`)
    } catch (err) {
      addCommandMessage(text, `Update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * `/plugin refresh`：重新扫描并重载所有插件的贡献物。
   *
   * 核心一步是 refreshPluginContributions：把磁盘上的插件集合与各活跃
   * 注册表做增量同步 —— skills / agents / commands 进对应子注册表，
   * hooks 挂到 hook 总线，MCP 服务器按需重连（可能触发信任询问）。
   * 完成后再让系统提示缓存失效、递增技能注册表版本，最后把
   * 插件 → 子注册表 → MCP 三层变更摘要拼成报告输出。
   *
   * @param text 用户原始输入
   */
  async function pluginRefresh(text: string): Promise<void> {
    if (!options.pluginRegistry) {
      addCommandMessage(text, 'Plugin system is disabled for this session (`--no-plugins`).')
      return
    }
    let summary
    try {
      summary = await refreshPluginContributions({
        pluginRegistry: options.pluginRegistry,
        skillRegistry: options.skillRegistry,
        subAgentRegistry: options.subAgentRegistry,
        commandRegistry: options.commandRegistry,
        hookBus: options.hookBus,
        mcpRegistry: options.mcpRegistry,
        askUser: (q, opts) => askQuestion(q, opts, { noOther: true }),
        cwd: process.cwd(),
      })
    } catch (err) {
      addCommandMessage(text, `Failed to reload plugins: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // 插件集合已变化：让下一条消息重建系统提示，并让 /help、Tab 补全重算
    invalidateSystemPromptCache()
    bumpSkillRegistryVersion()

    // —— 组装报告。第一层：插件本体的增 / 删 / 改 ——
    const parts: string[] = []
    const p = summary.plugins
    if (p.added.length) parts.push(`added: ${p.added.join(', ')}`)
    if (p.removed.length) parts.push(`removed: ${p.removed.join(', ')}`)
    if (p.changed.length) parts.push(`changed: ${p.changed.join(', ')}`)
    if (parts.length === 0) parts.push(`no plugin changes (${p.unchanged.length} unchanged)`)
    const lines = [`Reloaded plugins — ${parts.join('; ')}.`]
    // 第二层：下游子注册表（skills / subAgents / commands）的联动变更数
    const subBits: string[] = []
    if (summary.skills && (summary.skills.added.length || summary.skills.removed.length))
      subBits.push(`${summary.skills.added.length + summary.skills.removed.length} skill change(s)`)
    if (summary.subAgents && (summary.subAgents.added.length || summary.subAgents.removed.length))
      subBits.push(`${summary.subAgents.added.length + summary.subAgents.removed.length} sub-agent change(s)`)
    if (summary.commands && (summary.commands.added.length || summary.commands.removed.length))
      subBits.push(`${summary.commands.added.length + summary.commands.removed.length} command change(s)`)
    if (subBits.length) lines.push(`Downstream: ${subBits.join(', ')}.`)
    // 第三层：MCP 服务器的增 / 删 / 改；无变化但有存量时显示"已重连"
    if (summary.mcp) {
      const m = summary.mcp
      const mcpBits: string[] = []
      if (m.added.length) mcpBits.push(`added: ${m.added.join(', ')}`)
      if (m.removed.length) mcpBits.push(`removed: ${m.removed.join(', ')}`)
      if (m.changed.length) mcpBits.push(`changed: ${m.changed.join(', ')}`)
      if (mcpBits.length) lines.push(`MCP — ${mcpBits.join('; ')}.`)
      else if (m.unchanged.length) lines.push(`MCP — ${m.unchanged.length} server(s) reconnected.`)
    }
    if (summary.mcpProjectSkipped) {
      lines.push('Note: project-level MCP servers were skipped (trust dialog declined).')
    }
    for (const e of summary.mcpConfigErrors ?? []) {
      lines.push(`MCP config error: ${e.name}: ${e.message}`)
    }
    lines.push('Note: next message rebuilds the system prompt, so prompt-cache will miss once.')
    addCommandMessage(text, lines.join('\n'))
  }

  /**
   * `/plugin doctor`：插件系统健康检查。
   *
   * 汇总已加载 / 启用 / 禁用的插件数量与加载错误数，逐条列出错误
   * （插件 id + manifest 路径 + 错误信息），并提示更深的诊断要去
   * debug 日志看（MCP 冲突、hook 报错、不支持的 commands 贡献等）。
   *
   * @param text 用户原始输入
   */
  function pluginDoctor(text: string): void {
    const reg = options.pluginRegistry
    if (!reg) {
      addCommandMessage(text, 'Plugin system is disabled for this session (`--no-plugins`).')
      return
    }
    const errors = reg.loadErrors()
    const all = reg.listAll()
    const lines: string[] = ['**Plugin doctor**']
    lines.push(`- Total loaded: ${all.length}`)
    lines.push(`- Enabled:      ${all.filter((p) => p.enabled).length}`)
    lines.push(`- Disabled:     ${all.filter((p) => !p.enabled).length}`)
    lines.push(`- Load errors:  ${errors.length}`)
    if (errors.length > 0) {
      lines.push('', '**Errors:**')
      for (const e of errors) {
        lines.push(`- ${e.id ?? '(unknown)'} at \`${e.path}\``)
        lines.push(`  ${e.message}`)
      }
    }
    lines.push(
      '',
      '_For deeper diagnostics (mcp collisions, hook errors, unsupported `commands` contributions), set `DEBUG_STDOUT=1` and check `~/.tegent/logs/debug.log`._',
    )
    addCommandMessage(text, lines.join('\n'))
  }

  /**
   * `/plugin marketplace ...`：市场（插件索引源）管理子命令树。
   *
   * "市场"是一个可订阅的插件索引（marketplace.json），本命令树负责：
   * - `list`（缺省）：列出已订阅的市场
   * - `add <name> <source>`：订阅新市场（只登记，索引需 refresh 拉取）
   * - `remove <name>`：退订
   * - `refresh [name]`：拉取全部 / 指定市场的索引到本地缓存
   * - `info <name>`：展示某市场的元数据与插件列表（读缓存）
   *
   * @param text 用户原始输入
   * @param arg `marketplace` 之后的参数串
   */
  async function handlePluginMarketplace(text: string, arg: string): Promise<void> {
    const parts = arg.trim().split(/\s+/)
    const sub = (parts[0] ?? '').toLowerCase()
    const rest = parts.slice(1).join(' ').trim()

    // list（缺省）：列出已订阅的市场
    if (sub === '' || sub === 'list') {
      const km = await readKnownMarketplaces()
      if (km.marketplaces.length === 0) {
        addCommandMessage(text, 'No marketplaces subscribed. Add one with `/plugin marketplace add <name> <source>`.')
        return
      }
      const lines = [`**Subscribed marketplaces** (${km.marketplaces.length}):`]
      const namePad = Math.max(...km.marketplaces.map((m) => m.name.length), 8) + 2
      for (const m of km.marketplaces) {
        const tag = m.reservedName ? ' [official]' : ''
        lines.push(`  ${m.name.padEnd(namePad)} ${m.source}${tag}`)
      }
      addCommandMessage(text, lines.join('\n'))
      return
    }

    // add <name> <source>：登记订阅；索引要再执行 refresh 才会拉取
    if (sub === 'add') {
      const argParts = rest.split(/\s+/)
      if (argParts.length < 2 || !argParts[0] || !argParts[1]) {
        addCommandMessage(
          text,
          'Usage: `/plugin marketplace add <name> <source>` (source: `github:owner/repo` or an https URL to a marketplace.json)',
        )
        return
      }
      // 第一个词作为市场名，其余词重新拼接为来源字符串
      const [name, ...sourceParts] = argParts
      const source = sourceParts.join(' ')
      try {
        await addKnownMarketplace({ name, source })
        addCommandMessage(
          text,
          `Subscribed to **${name}** (\`${source}\`). Run \`/plugin marketplace refresh ${name}\` to fetch its index.`,
        )
      } catch (err) {
        addCommandMessage(text, `Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    // remove <name>：退订市场
    if (sub === 'remove') {
      if (!rest) {
        addCommandMessage(text, 'Usage: `/plugin marketplace remove <name>`')
        return
      }
      const result = await removeKnownMarketplace(rest)
      if (result === 'noop') addCommandMessage(text, `No marketplace \`${rest}\` subscribed.`)
      else addCommandMessage(text, `Unsubscribed from **${rest}**.`)
      return
    }

    // refresh [name]：不带名字则刷新全部已订阅市场，逐个拉取索引并汇报
    if (sub === 'refresh') {
      const km = await readKnownMarketplaces()
      const targets = rest ? km.marketplaces.filter((m) => m.name === rest) : km.marketplaces
      if (targets.length === 0) {
        addCommandMessage(text, rest ? `No marketplace \`${rest}\` subscribed.` : 'No marketplaces subscribed.')
        return
      }
      // fetchMarketplace 是网络请求，可能耗时数秒。先立即回显命令并给出
      // 进行中提示，避免输入已提交、界面却无任何反馈的"空窗期"；结果在
      // 完成后经 addCommandResult 追加到同一命令块下方（与 /mcp refresh
      // 的两段式输出模式一致）。
      addCommandMessage(text, `Refreshing ${targets.length} marketplace${targets.length === 1 ? '' : 's'} …`)
      const lines: string[] = []
      for (const t of targets) {
        try {
          const m = await fetchMarketplace(t)
          lines.push(`  ✓ ${t.name} — ${m.plugins.length} plugin${m.plugins.length === 1 ? '' : 's'}`)
        } catch (err) {
          lines.push(`  ✗ ${t.name} — ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      addCommandResult(lines.join('\n'))
      return
    }

    // info <name>：展示缓存的索引详情（含插件列表）；无缓存则提示先 refresh
    if (sub === 'info') {
      if (!rest) {
        addCommandMessage(text, 'Usage: `/plugin marketplace info <name>`')
        return
      }
      const all = await readAllCachedMarketplaces()
      const m = all.find((x) => x.name === rest)
      if (!m) {
        addCommandMessage(
          text,
          `No cached index for marketplace \`${rest}\`. Run \`/plugin marketplace refresh ${rest}\` first.`,
        )
        return
      }
      const lines: string[] = [`**${m.displayName ?? m.name}** (${m.name})`]
      if (m.upstreamName) lines.push(`Upstream name: ${m.upstreamName}`)
      if (m.description) lines.push(m.description)
      if (m.owner?.name) lines.push(`Owner: ${m.owner.name}${m.owner.url ? ` (${m.owner.url})` : ''}`)
      lines.push('', `${m.plugins.length} plugin${m.plugins.length === 1 ? '' : 's'}:`)
      for (const p of m.plugins) {
        const ver = p.verified ? ' [verified]' : ''
        const cat = p.category ? ` (${p.category})` : ''
        lines.push(`  ${p.name}${ver}${cat}`)
        if (p.description) lines.push(`    ${p.description}`)
      }
      addCommandMessage(text, lines.join('\n'))
      return
    }

    addCommandMessage(text, 'Usage: `/plugin marketplace <list|add|remove|refresh|info>`')
  }

  /**
   * `/plugin` 总入口：取第一个词作为子命令，路由到对应的处理函数，
   * 剩余部分作为 rest 传下去。空参视同 `list`，未知子命令打印用法。
   *
   * @param text 用户原始输入
   * @param arg `/plugin` 之后的完整参数串
   */
  async function handlePlugin(text: string, arg: string): Promise<void> {
    const trimmed = arg.trim()
    const parts = trimmed.split(/\s+/)
    const sub = (parts[0] ?? '').toLowerCase()
    const rest = parts.slice(1).join(' ').trim()

    if (sub === 'marketplace') return handlePluginMarketplace(text, rest)
    if (sub === '' || sub === 'list') return pluginList(text, arg)
    if (sub === 'info') return pluginInfo(text, rest)
    if (sub === 'install') return pluginInstall(text, rest)
    if (sub === 'uninstall') return pluginUninstall(text, rest)
    if (sub === 'enable') return pluginToggle(text, rest, true)
    if (sub === 'disable') return pluginToggle(text, rest, false)
    if (sub === 'search') return pluginSearch(text, rest)
    if (sub === 'update') return pluginUpdate(text, rest)
    if (sub === 'refresh') return void pluginRefresh(text)
    if (sub === 'doctor') return pluginDoctor(text)

    addCommandMessage(
      text,
      'Usage: `/plugin <list|info|install|uninstall|enable|disable|search|update|refresh|doctor|marketplace>`',
    )
  }

  return { handlePlugin }
}
