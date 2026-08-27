// CLI 斜杠命令层：用户输入以 / 开头时在这里分流，不进 agentLoop。
// core 导出的 registry / settings API 就是为这一层准备的：
//   /skill /plugin /mcp 负责会话内管理；/<skillname> 把 skill 正文直接注入对话
//   （core 注释里的第二条激活路径，和 activateSkill 工具共用同一个 wrapper）。
import {
  closeMcpServers,
  getMcpConfigPath,
  loadMcpServers,
  pluginSkillDirs,
  registerMcpServers,
  reloadPluginRegistry,
  reloadSkillRegistry,
  setPluginDisabled,
  setSkillDisabled,
  wrapActivatedSkill,
} from '@tegent/core'
import type { ConnectedMcpServer, PluginRegistry, SkillRegistry, ToolRegistry } from '@tegent/core'

/** 会话级注册表容器：index.ts 启动时组装，斜杠命令在这里原地更新。 */
export interface CliSession {
  skillRegistry: SkillRegistry
  pluginRegistry: PluginRegistry
  mcpRegistry: ToolRegistry
  // 已连接的 MCP Server。/mcp refresh 原地替换数组内容（保持数组身份），
  // index.ts 退出时 closeMcpServers(mcpServers) 才能关到最新一批连接。
  mcpServers: ConnectedMcpServer[]
}

export interface SlashCommandContext {
  session: CliSession
  /** 命令输出统一走 system 消息；Ink 渲染期间打 console 会把 TUI 画面搅乱。 */
  print: (text: string) => void
  /** 把内容作为 user 消息送进 agentLoop（/<skillname> 激活用），不在消息区回显。 */
  submitToAgent: (text: string) => void
}

const HELP_TEXT = [
  'Commands:',
  '  /help                     Show this help',
  '  /skill [list]             List skills (including disabled)',
  '  /skill refresh            Rescan skill directories and settings',
  '  /skill enable <name>      Enable a skill (project settings)',
  '  /skill disable <name>     Disable a skill (project settings)',
  '  /plugin [list]            List plugins (including disabled)',
  '  /plugin refresh           Rescan plugin directories and settings',
  '  /plugin enable <id>       Enable a plugin (project settings)',
  '  /plugin disable <id>      Disable a plugin (project settings)',
  '  /mcp                      List connected MCP servers',
  '  /mcp refresh              Reconnect all MCP servers',
  '  /<skillname>              Activate a skill directly, e.g. /dataviz',
].join('\n')

/** 描述、工具名单这类长文本的展示截断。 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/** skill / plugin refresh 共用的变更摘要渲染（两个 Summary 结构刻意同构）。 */
function formatReloadSummary(
  label: string,
  summary: { added: string[]; removed: string[]; changed: string[]; unchanged: string[] },
): string {
  const counts = [
    `+${summary.added.length}`,
    `~${summary.changed.length}`,
    `-${summary.removed.length}`,
    `=${summary.unchanged.length}`,
  ].join(' ')
  const touched = [...summary.added, ...summary.changed, ...summary.removed]
  return touched.length > 0 ? `${label}: ${counts}\n  ${touched.join(', ')}` : `${label}: ${counts}`
}

/** 重扫 skill 目录（含插件贡献目录）+ 禁用设置，原地刷新 skill 注册表。 */
async function reloadSkills(session: CliSession) {
  return reloadSkillRegistry(session.skillRegistry, {
    extraDirs: pluginSkillDirs(session.pluginRegistry.list()),
  })
}

function listSkills(ctx: SlashCommandContext) {
  const entries = ctx.session.skillRegistry.listAll()
  if (entries.length === 0) {
    ctx.print(
      'No skills loaded. Put skills in ~/.tegent/skills or .tegent/skills (one SKILL.md per directory).',
    )
    return
  }
  const disabledCount = entries.filter((s) => s.disabled).length
  const lines = [`Skills (${entries.length} loaded, ${disabledCount} disabled):`]
  for (const s of entries) {
    const origin = s.pluginId ? `plugin:${s.pluginId}` : s.source
    const status = s.disabled ? 'disabled' : 'enabled'
    lines.push(
      `  ${s.name.padEnd(24)}${status.padEnd(10)}${origin.padEnd(34)}${truncate(s.description, 80)}`,
    )
  }
  ctx.print(lines.join('\n'))
}

function listPlugins(ctx: SlashCommandContext) {
  const entries = ctx.session.pluginRegistry.listAll()
  if (entries.length === 0) {
    ctx.print(
      'No plugins loaded. Install to ~/.tegent/plugins/cache or .tegent/plugins (each needs .tegent-plugin/plugin.json).',
    )
    return
  }
  const disabledCount = entries.filter((p) => p.disabled).length
  const lines = [`Plugins (${entries.length} loaded, ${disabledCount} disabled):`]
  for (const p of entries) {
    const status = p.disabled ? 'disabled' : 'enabled'
    const desc = p.description ? truncate(p.description, 80) : ''
    lines.push(`  ${p.id.padEnd(28)}${p.version.padEnd(10)}${status.padEnd(10)}${p.source.padEnd(9)}${desc}`)
  }
  ctx.print(lines.join('\n'))
}

function listMcp(ctx: SlashCommandContext) {
  const configPath = getMcpConfigPath()
  const servers = ctx.session.mcpServers
  if (servers.length === 0) {
    ctx.print(
      `No MCP servers connected.\nConfig file: ${configPath}\nAdd servers under "mcpServers" in that file, then run /mcp refresh.`,
    )
    return
  }
  const lines = [`MCP servers (${servers.length} connected). Config: ${configPath}`]
  for (const server of servers) {
    const names = server.tools.map((t) => t.name).join(', ')
    lines.push(`  ${server.name.padEnd(20)}${server.tools.length} tool(s): ${truncate(names, 160)}`)
  }
  ctx.print(lines.join('\n'))
}

async function refreshSkills(ctx: SlashCommandContext) {
  ctx.print(formatReloadSummary('Skills reloaded', await reloadSkills(ctx.session)))
}

async function refreshPlugins(ctx: SlashCommandContext) {
  // 插件启停/重装影响它贡献的 skills 目录，两个注册表都要原地重载。
  const pluginSummary = await reloadPluginRegistry(ctx.session.pluginRegistry)
  const skillSummary = await reloadSkills(ctx.session)
  ctx.print(formatReloadSummary('Plugins reloaded', pluginSummary))
  ctx.print(formatReloadSummary('Skills reloaded', skillSummary))
}

async function refreshMcp(ctx: SlashCommandContext) {
  const servers = loadMcpServers()
  // 先关旧连接再重连：stdio Server 是本进程 fork 的子进程，不关会活到 CLI 退出。
  await closeMcpServers(ctx.session.mcpServers)
  ctx.session.mcpRegistry.clear()
  // registerMcpServers 对连不上的 Server 会直接 console.error（Ink 画面可能被短暂
  // 打乱），失败名单在下面按「配置里有但没连上」对比补进 system 消息。
  const connected = await registerMcpServers(ctx.session.mcpRegistry, servers)
  ctx.session.mcpServers.length = 0
  ctx.session.mcpServers.push(...connected)
  const failed = Object.keys(servers).filter((name) => !connected.some((c) => c.name === name))
  const lines = [
    `MCP reconnected: ${connected.length} connected, ${failed.length} failed, ${Object.keys(servers).length} configured`,
  ]
  if (failed.length > 0) lines.push(`  failed: ${failed.join(', ')}`)
  if (connected.length > 0) lines.push(`  connected: ${connected.map((c) => c.name).join(', ')}`)
  ctx.print(lines.join('\n'))
}

async function toggleSkill(ctx: SlashCommandContext, name: string, disable: boolean) {
  const entry = ctx.session.skillRegistry.getEntry(name)
  if (!entry) {
    ctx.print(`Skill "${name}" not found. Use /skill to list loaded skills.`)
    return
  }
  // 写 project 作用域（.tegent/settings.local.json），不动用户全局设置。
  const changed = (await setSkillDisabled(name, 'project', disable)) === 'changed'
  // 立即原地重载：下一轮 activateSkill 工具描述里的名单就会跟上。
  if (changed) await reloadSkills(ctx.session)
  const effective = ctx.session.skillRegistry.getEntry(name)?.disabled === disable
  if (effective) {
    ctx.print(`Skill "${name}" ${disable ? 'disabled' : 'enabled'} (project settings).`)
  } else {
    // 没达成目标状态：通常是用户级 settings.json 里也配置了同名 skill，项目级开关覆盖不掉。
    ctx.print(
      `Skill "${name}" is still ${disable ? 'enabled' : 'disabled'}. It may also be configured in user settings (~/.tegent/settings.json).`,
    )
  }
}

async function togglePlugin(ctx: SlashCommandContext, id: string, disable: boolean) {
  const entry = ctx.session.pluginRegistry.getEntry(id)
  if (!entry) {
    ctx.print(`Plugin "${id}" not found. Use /plugin to list loaded plugins.`)
    return
  }
  const changed = (await setPluginDisabled(id, 'project', disable)) === 'changed'
  // 插件启停影响它贡献的 skills 目录；无论 changed 与否都重载两个注册表，
  // 保证 registry 状态和 settings 文件始终对齐。
  await reloadPluginRegistry(ctx.session.pluginRegistry)
  const skillSummary = await reloadSkills(ctx.session)
  const effective = ctx.session.pluginRegistry.getEntry(id)?.disabled === disable
  if (effective) {
    ctx.print(`Plugin "${id}" ${disable ? 'disabled' : 'enabled'} (project settings).`)
  } else {
    ctx.print(
      `Plugin "${id}" is still ${disable ? 'enabled' : 'disabled'}. It may also be configured in user settings (~/.tegent/settings.json).`,
    )
  }
  // 插件贡献的 skill 集合可能变了；有实际变化时顺带汇报 skill 侧结果。
  const touched = [...skillSummary.added, ...skillSummary.removed, ...skillSummary.changed]
  if (touched.length > 0) ctx.print(formatReloadSummary('Skills reloaded', skillSummary))
}

/**
 * 处理一条以 / 开头的输入。
 *
 * 所有 / 开头的输入都在这里终结（返回 true）：认识的命令执行；不认识的先按
 * skill 名尝试直接激活；再不行就报错提示。任何情况都不会漏进 agentLoop。
 */
export async function handleSlashCommand(input: string, ctx: SlashCommandContext): Promise<boolean> {
  if (!input.startsWith('/')) return false
  const parts = input.slice(1).trim().split(/\s+/)
  const command = parts[0] ?? ''
  const sub = parts[1]
  const arg = parts[2]

  if (command === 'help') {
    ctx.print(HELP_TEXT)
    return true
  }

  if (command === 'skill') {
    if (sub === undefined || sub === 'list') {
      listSkills(ctx)
    } else if (sub === 'refresh') {
      await refreshSkills(ctx)
    } else if (sub === 'enable' || sub === 'disable') {
      if (!arg) {
        ctx.print(`Usage: /skill ${sub} <name>`)
      } else {
        await toggleSkill(ctx, arg, sub === 'disable')
      }
    } else {
      ctx.print(`Unknown /skill subcommand: ${sub}\n${HELP_TEXT}`)
    }
    return true
  }

  if (command === 'plugin') {
    if (sub === undefined || sub === 'list') {
      listPlugins(ctx)
    } else if (sub === 'refresh') {
      await refreshPlugins(ctx)
    } else if (sub === 'enable' || sub === 'disable') {
      if (!arg) {
        ctx.print(`Usage: /plugin ${sub} <id>`)
      } else {
        await togglePlugin(ctx, arg, sub === 'disable')
      }
    } else {
      ctx.print(`Unknown /plugin subcommand: ${sub}\n${HELP_TEXT}`)
    }
    return true
  }

  if (command === 'mcp') {
    if (sub === undefined) {
      listMcp(ctx)
    } else if (sub === 'refresh') {
      await refreshMcp(ctx)
    } else {
      ctx.print(`Unknown /mcp subcommand: ${sub}\n${HELP_TEXT}`)
    }
    return true
  }

  // 剩下的按「直接激活 skill」处理：/<skillname> 把 skill 正文注入当前对话，
  // 和模型自主调 activateSkill 走同一个 wrapper，模型看到的字节流完全一致。
  // 禁用 skill 走 get() 返回 undefined，会落到下面的未知命令提示。
  const skill = ctx.session.skillRegistry.get(command)
  if (skill) {
    ctx.submitToAgent(wrapActivatedSkill(skill))
    ctx.print(`Skill "${skill.name}" activated.`)
    return true
  }

  ctx.print(`Unknown command or skill: /${command}\nType /help for commands, /skill to list skills.`)
  return true
}
