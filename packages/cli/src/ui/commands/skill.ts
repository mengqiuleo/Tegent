// 子命令：install / list / refresh / disable / enable / uninstall。
// 未知子命令打印用法提示。
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  USER_TEGENT_DIR,
  getScopedDisabledSkills,
  reloadSkillRegistry,
  setSkillDisabled,
  skillSettingsPath,
} from '@tegent/core'
import type { AgentOptions, SkillDefinition, SkillSettingsScope } from '@tegent/core'

export interface SkillCommandDeps {
  options: AgentOptions
  addCommandMessage: (text: string, content: string) => void
  invalidateSystemPromptCache: () => void
  pendingSkillRef: { current: SkillDefinition | null }
  bumpSkillRegistryVersion: () => void
}

/** SKILL.md frontmatter 的极简 YAML name 提取器。
 *  只需找到 `name: <value>` —— 完整解析在 loader 中进行。 */
function extractSkillName(content: string): string | null {
  const match = content.match(/^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)
  return match ? match[1].trim() : null
}

/** 将 skill 参数拆分为 `(name, scope)`，识别
 *  `--scope=user` / `--scope=project` / `-s=user` 等。不带 flag 的
 *  裸参数返回 `scope: undefined`，让调用方可以按 skill 的
 *  source 取默认值。未知的 scope 字符串会被忽略（scope 保持
 *  undefined）—— 保持解析器的宽容性。 */
function parseSkillScopeFlag(arg: string): { name: string; scope?: SkillSettingsScope } {
  const tokens = arg.split(/\s+/).filter(Boolean)
  let scope: SkillSettingsScope | undefined
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
  return { name: remaining.join(' '), scope }
}

export function createSkillCommandHandler(deps: SkillCommandDeps) {
  const { options, addCommandMessage, invalidateSystemPromptCache, pendingSkillRef, bumpSkillRegistryVersion } = deps

  async function handleSkill(text: string, arg: string): Promise<void> {
    const parts = arg.trim().split(/\s+/)
    const sub = parts[0]?.toLowerCase()
    const subArg = parts.slice(1).join(' ').trim()

    if (sub === 'install') {
      if (!subArg) {
        addCommandMessage(text, 'Usage: `/skill install <url>`')
        return
      }
      let content: string
      try {
        const res = await fetch(subArg)
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        content = await res.text()
      } catch (err) {
        addCommandMessage(text, `Failed to fetch \`${subArg}\`: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      const name = extractSkillName(content) // skill 取名
      if (!name) {
        addCommandMessage(text, 'Invalid SKILL.md: missing `name` in frontmatter.')
        return
      }

      const skillDir = path.join(USER_TEGENT_DIR, 'skills', name)
      const skillFile = path.join(skillDir, 'SKILL.md')
      try {
        await fs.mkdir(skillDir, { recursive: true })
        await fs.writeFile(skillFile, content, 'utf-8') // fetch 的 content 写入文件
      } catch (err) {
        addCommandMessage(text, `Failed to save skill: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      addCommandMessage(
        text,
        `Skill **${name}** installed to \`${skillFile}\`\nRun \`/skill refresh\` to use \`/${name}\` now, or restart xc.`,
      )
      return
    }

    if (sub === 'list') {
      const skills = options.skillRegistry?.listAll() ?? []
      if (skills.length === 0) {
        const skillsPath = path.join(USER_TEGENT_DIR, 'skills', '<name>', 'SKILL.md')
        addCommandMessage(
          text,
          `No skills loaded. Place SKILL.md files in \`${skillsPath}\` then run \`/skill refresh\` (or restart).`,
        )
        return
      }
      const lines = skills.map((s) => {
        const tag = s.disabled ? '[off]' : '[on] '
        return `- ${tag} **${s.name}** (${s.source}): ${s.description}`
      })
      addCommandMessage(text, `**Loaded skills** (${skills.length}):\n${lines.join('\n')}`)
      return
    }

    if (sub === 'refresh') {
      if (!options.skillRegistry) {
        addCommandMessage(text, 'No skill registry to refresh.')
        return
      }
      let summary
      try {
        summary = await reloadSkillRegistry(options.skillRegistry)
      } catch (err) {
        addCommandMessage(text, `Failed to reload skills: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      // 使 prompt 缓存失效：系统提示词的 `## Available
      // Skills` 块和 activateSkill 工具描述都内嵌了
      // skill 列表。宁可承受一次缓存未命中，也不要把过期的
      // skill 信息发给模型。与 /mcp refresh 的取舍相同。
      invalidateSystemPromptCache()
      // 若用户曾对刚被移除或禁用的 skill 执行 `/<skillname>`，
      // 丢弃该 pending skill —— 否则下一条普通用户消息
      // 会注入已失效的 skill 内容。
      const pending = pendingSkillRef.current
      if (pending && !options.skillRegistry.get(pending.name)) {
        pendingSkillRef.current = null
      }
      // 强制 slash 命令的 Tab 补全 + /help 列表基于
      // 新的 skill 集合重新 memo。注册表对象身份不变
      // （reload() 原地修改），因此版本计数器是 React
      // 重新计算 memoized 列表所需的信号。
      bumpSkillRegistryVersion()

      const summaryParts: string[] = []
      if (summary.added.length) summaryParts.push(`added: ${summary.added.join(', ')}`)
      if (summary.removed.length) summaryParts.push(`removed: ${summary.removed.join(', ')}`)
      if (summary.changed.length) summaryParts.push(`changed: ${summary.changed.join(', ')}`)
      if (summary.unchanged.length) summaryParts.push(`unchanged: ${summary.unchanged.join(', ')}`)
      if (summaryParts.length === 0) summaryParts.push('no skills found')
      const lines = [`Reloaded skills — ${summaryParts.join('; ')}.`]
      // 主结果与提示说明之间用紧凑的 `\n` —— 与
      // /mcp refresh 及 /skill 的 install / disable /
      // enable / remove 所用模式保持一致。单个命令的结果块内
      // 不留空行。
      lines.push('Note: next message rebuilds the system prompt, so prompt-cache will miss once.')
      addCommandMessage(text, lines.join('\n'))
      return
    }

    if (sub === 'disable' || sub === 'enable') {
      const name = subArg.trim()
      if (!name) {
        addCommandMessage(text, `Usage: \`/skill ${sub} <name> [--scope=user|project]\``)
        return
      }
      const { name: bareName, scope } = parseSkillScopeFlag(name)
      const entry = options.skillRegistry?.getEntry(bareName)
      if (!entry) {
        addCommandMessage(
          text,
          `No skill named \`${bareName}\` is loaded. Run \`/skill list\` to see available skills.`,
        )
        return
      }
      // 将 disable 的 scope 默认取 skill 自身的 source，用户无需
      // 输入 --scope 就能得到预期的“禁用项目 skill yansu”效果。
      // 重新启用是对称的：先从 source scope 清除；如果 skill
      // 实际上仍处于禁用状态，那是因为另一个 scope
      // 也列出了它，届时我们会提示出来。
      const effectiveScope: SkillSettingsScope = scope ?? entry.source
      const disable = sub === 'disable'
      let result: 'changed' | 'noop'
      try {
        result = await setSkillDisabled(bareName, effectiveScope, disable)
      } catch (err) {
        addCommandMessage(text, `Failed to update settings: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      const settingsFile = skillSettingsPath(effectiveScope)
      if (result === 'noop') {
        addCommandMessage(
          text,
          disable
            ? `Skill **${bareName}** is already disabled in ${effectiveScope} settings (\`${settingsFile}\`).`
            : `Skill **${bareName}** is not disabled in ${effectiveScope} settings (\`${settingsFile}\`).`,
        )
        return
      }
      // 重新启用后，检查另一个 scope 是否仍将其隐藏
      // —— 常见误区：用户在 user scope 禁用后，
      // 期望 project 级别的 enable 能将其恢复。
      let otherScopeNote = ''
      if (!disable) {
        const other: SkillSettingsScope = effectiveScope === 'user' ? 'project' : 'user'
        try {
          const stillDisabled = (await getScopedDisabledSkills(other)).includes(bareName)
          if (stillDisabled) {
            otherScopeNote = `\n_Note: \`${bareName}\` is also listed in ${other} settings (\`${skillSettingsPath(other)}\`). Run \`/skill enable ${bareName} --scope=${other}\` to fully re-enable._`
          }
        } catch {
          // 尽力而为的提示 —— 静默失败即可
        }
      }
      const verb = disable ? 'Disabled' : 'Enabled'
      addCommandMessage(
        text,
        `${verb} skill **${bareName}** in ${effectiveScope} settings (\`${settingsFile}\`).${otherScopeNote}\nRun \`/skill refresh\` to apply now, or restart xc.`,
      )
      return
    }

    if (sub === 'uninstall') {
      const name = subArg.trim()
      if (!name) {
        addCommandMessage(text, 'Usage: `/skill uninstall <name>`')
        return
      }
      const entry = options.skillRegistry?.getEntry(name)
      if (!entry) {
        addCommandMessage(text, `No skill named \`${name}\` is loaded. Run \`/skill list\` to see available skills.`)
        return
      }
      // 插件提供的 skill 位于插件的缓存目录下，而非
      // <baseDir>/skills/ 下。这里的 `/skill uninstall` 会算出
      // 错误的路径，要么静默无操作，要么删掉无关的目录
      // —— 改为引导用户使用 `/plugin uninstall`。
      if (entry.pluginId) {
        addCommandMessage(
          text,
          `Skill **${name}** comes from plugin \`${entry.pluginId}\` — uninstall it with \`/plugin uninstall ${entry.pluginId}\` instead of \`/skill uninstall\`.`,
        )
        return
      }
      const baseDir = entry.source === 'user' ? USER_TEGENT_DIR : path.join(process.cwd(), '.tegent')
      const skillDir = path.join(baseDir, 'skills', name)
      try {
        await fs.rm(skillDir, { recursive: true, force: true })
      } catch (err) {
        addCommandMessage(text, `Failed to remove \`${skillDir}\`: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      // 同时清除所有 disable 条目 —— 留下指向已卸载 skill 的
      // 过期条目，会静默吞掉将来同名的重新安装
      // （它会以禁用状态回归）。
      try {
        await setSkillDisabled(name, 'user', false)
        await setSkillDisabled(name, 'project', false)
      } catch {
        // 尽力而为 —— 主删除操作已成功
      }
      addCommandMessage(
        text,
        `Uninstalled skill **${name}** from \`${skillDir}\`.\nRun \`/skill refresh\` to apply now, or restart xc.`,
      )
      return
    }

    addCommandMessage(
      text,
      'Usage: `/skill install <url>` · `/skill list` · `/skill refresh` · `/skill disable <name>` · `/skill enable <name>` · `/skill uninstall <name>`',
    )
  }

  return { handleSkill }
}
