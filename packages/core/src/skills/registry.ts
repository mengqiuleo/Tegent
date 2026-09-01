import { type LoadSkillsOptions, loadSkills } from './loader.js'
import { loadDisabledSkillsSet } from './settings.js'


export interface SkillDefinition {
  /**
   * skill 名称。
   */
  name: string

  /**
   * skill 的短描述。
   */
  description: string

  /**
   * `SKILL.md` 的正文内容。
   */
  content: string

  /**
   * skill 来源。
   *
   * `user` 表示用户级 skill，`project` 表示项目级 skill。
   */
  source: 'user' | 'project'

  /**
   * skill 目录的绝对路径。
   *
   * 这个目录就是包含 `SKILL.md` 的目录。
   * 激活 skill 时会把它告诉模型，让模型能把相对路径解析到随 skill 打包的脚本、引用和资源文件。
   */
  dir: string

  /**
   * skill 目录中的相对文件路径列表。
   *
   * 列表不包含 `SKILL.md`，也会跳过隐藏目录和重型目录。
   * 激活 skill 时会和正文一起展示，让模型知道有哪些打包资源，不必自己 glob。
   * 列表在 loader 阶段会被 `MAX_LISTED_FILES` 限制；过长列表会用 `"... N more"` 标记截断。
   */
  files: string[]

  /**
   * 贡献该 skill 的插件 id。
   *
   * 只有来自插件贡献的 skill 才有这个字段。
   * 格式通常是 `name@marketplace`。
   * UI 会把它显示为 “(from plugin: …)”，`/skill uninstall` 也会据此重定向到 `/plugin uninstall`。
   */
  pluginId?: string
}

/**
 * 注册表内部保存的 skill 条目。
 *
 * 它在 `SkillDefinition` 基础上额外记录当前是否禁用。
 */
export interface SkillEntry extends SkillDefinition {
  disabled: boolean
}

/**
 * `reloadSkillRegistry()` 返回的刷新摘要。
 *
 * `/skill refresh` 会用它生成用户可见消息：
 * 例如 added、removed、changed、unchanged 的列表，类似 `/mcp refresh` 的输出。
 */
export interface SkillReloadSummary {
  /**
   * 新增的 skill 名称。
   */
  added: string[]

  /**
   * 已移除的 skill 名称。
   */
  removed: string[]

  /**
   * 内容、描述、来源或禁用状态发生变化的 skill 名称。
   */
  changed: string[]

  /**
   * 与刷新前保持一致的 skill 名称。
   */
  unchanged: string[]
}

/**
 * 会话级 skill 注册表。
 *
 * 它用 skill 名称建立索引，并负责按 disabled 状态过滤 agent 可见的 skill。
 */
export class SkillRegistry {
  private byName: Map<string, SkillEntry> // 以 skill 名称为 key 的注册表内部索引。

  /**
   * 创建一个 skill 注册表。
   *
   * @param skills - 已加载的 skill 定义列表。
   * @param disabled - 当前被禁用的 skill 名称集合。
   */
  constructor(skills: SkillDefinition[], disabled: ReadonlySet<string> = new Set()) {
    this.byName = new Map() 
    for (const skill of skills) {
      this.byName.set(skill.name, { ...skill, disabled: disabled.has(skill.name) })
    }
  }

  /**
   * 用新加载的 skill 列表替换内存中的注册表内容。
   *
   * @param skills - 新加载的 skill 定义列表。
   * @param disabled - 新读取的禁用 skill 名称集合。
   * @returns 和旧状态对比后的逐名称变更摘要。
   *
   * `/skill refresh` 会调用它。
   * 方法会保持 `SkillRegistry` 对象身份不变，只替换内部 map。
   * 这样 agent loop、CLI slash completion、App.tsx handler 等已缓存的 `options.skillRegistry`
   * 引用仍然指向这个对象。
   */
  reload(skills: SkillDefinition[], disabled: ReadonlySet<string>): SkillReloadSummary {
    const previous = this.byName
    const next = new Map<string, SkillEntry>() 
    for (const skill of skills) {
      next.set(skill.name, { ...skill, disabled: disabled.has(skill.name) }) 
    }

    const summary: SkillReloadSummary = { added: [], removed: [], changed: [], unchanged: [] } 
    for (const [name, entry] of next) {
      const prev = previous.get(name) 
      if (!prev) {
        summary.added.push(name) 
      } else if (
        prev.description !== entry.description ||
        prev.content !== entry.content ||
        prev.source !== entry.source ||
        prev.disabled !== entry.disabled
      ) {
        summary.changed.push(name) 
      } else {
        summary.unchanged.push(name)
      }
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) summary.removed.push(name) 
    }

    this.byName = next
    return summary 
  }

  /**
   * 按名称获取已启用的 skill。
   *
   * @param name - skill 名称。
   * @returns 找到且未禁用时返回 skill 定义，否则返回 `undefined`。
   *
   * 禁用 skill 会从 agent loop 和 slash-command 分发中隐藏。
   * 如果调用方需要查看禁用标记，应使用 `getEntry()`。
   */
  get(name: string): SkillDefinition | undefined {
    const entry = this.byName.get(name) 
    if (!entry || entry.disabled) return undefined 
    return entry 
  }

  /**
   * 列出所有已启用的 skill。
   *
   * @returns 已启用 skill 定义列表。
   */
  list(): SkillDefinition[] {
    return [...this.byName.values()].filter((s) => !s.disabled) 
  }

  /**
   * 列出所有已启用 skill 的名称。
   *
   * @returns 已启用 skill 名称列表。
   */
  names(): string[] {
    return [...this.byName.values()].filter((s) => !s.disabled).map((s) => s.name) 
  }

  /**
   * 列出所有已加载 skill，包括禁用项。
   *
   * @returns 带 `disabled` 标记的完整 skill 条目列表。
   *
   * `/skill list` 以及 disable、enable、remove handler 会使用它，
   * 因为这些命令也需要看见或操作已禁用 skill。
   */
  listAll(): SkillEntry[] {
    return [...this.byName.values()] 
  }

  /**
   * 按名称获取原始 skill 条目。
   *
   * @param name - skill 名称。
   * @returns 找到时返回条目，包括 disabled 标记；否则返回 `undefined`。
   */
  getEntry(name: string): SkillEntry | undefined {
    return this.byName.get(name)
  }
}

/**
 * 激活注入时最多渲染的文件数量。
 *
 * 这个上限与 loader 中的 `MAX_LISTED_FILES` 保持镜像。
 * loader 会先排序并截断；本文件的 formatter 把 `skill.files` 当作已经有界的列表处理。
 */
const MAX_RENDERED_FILES = 50 // 和 loader 文件列表上限对齐，避免激活内容过长。

/**
 * 构建 `<activated_skill name="...">...</activated_skill>` 内部的正文。
 *
 * @param skill - 要激活的 skill。
 * @returns skill 激活时注入给模型的正文内容。
 *
 * 这个函数同时服务两条激活路径：
 * 1. 模型通过 `activateSkill` 工具自行决定激活。
 * 2. 用户显式输入 `/<skillname>` 激活。
 *
 * 格式遵循 Opencode 的约定：先放 skill 正文，再附上 footer。
 * footer 包含基础目录、相对路径解析提示和文件列表。
 * 两个调用点共享同一个 formatter，可以保证模型看到的字节流一致。
 */
export function formatSkillActivationBody(skill: SkillDefinition): string {
  const lines: string[] = [skill.content.trim(), '']
  lines.push(`Base directory for this skill: ${skill.dir}`)
  lines.push(
    'Relative paths in this skill (e.g., scripts/foo.sh, references/api.md) are resolved against the base directory above.',
  ) 
  if (skill.files.length > 0) {
    lines.push('', 'Files in this skill directory:')
    const shown = skill.files.slice(0, MAX_RENDERED_FILES) 
    for (const f of shown) lines.push(`- ${f}`) 
    if (skill.files.length > MAX_RENDERED_FILES) {
      lines.push(`- ... and ${skill.files.length - MAX_RENDERED_FILES} more file(s) not shown`) 
    }
  }
  return lines.join('\n')
}

/**
 * 用 `<activated_skill name="X">` XML 外壳包住 skill 激活正文。
 *
 * @param skill - 要激活的 skill。
 * @returns 完整的 `<activated_skill>` XML 片段。
 *
 * 两条激活路径都使用这个 wrapper，保证无论由谁触发激活，外层字节流都完全一致。
 */
export function wrapActivatedSkill(skill: SkillDefinition): string {
  return `<activated_skill name="${skill.name}">\n${formatSkillActivationBody(skill)}\n</activated_skill>` 
}

/**
 * 创建并初始化 skill 注册表。
 *
 * @param opts - skill 加载选项。
 * @returns 加载完成的 `SkillRegistry` 实例。
 */
export async function createSkillRegistry(opts: LoadSkillsOptions = {}): Promise<SkillRegistry> {
  const [skills, disabled] = await Promise.all([loadSkills(opts), loadDisabledSkillsSet()])
  return new SkillRegistry(skills, disabled) 
}

/**
 * 重新扫描 skill 目录和 settings.json，并原地刷新给定注册表。
 *
 * @param registry - 要被原地刷新的注册表对象。
 * @param opts - skill 加载选项。
 * @returns 和刷新前相比的变更摘要。
 *
 * 调用方负责让嵌入旧 skill 列表的 `systemPromptCache` 失效。
 * `/skill refresh` handler 正是这样做的。
 */
export async function reloadSkillRegistry(
  registry: SkillRegistry,
  opts: LoadSkillsOptions = {},
): Promise<SkillReloadSummary> {
  const [skills, disabled] = await Promise.all([loadSkills(opts), loadDisabledSkillsSet()])
  return registry.reload(skills, disabled) 
}
