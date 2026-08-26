import { type LoadSkillsOptions, loadSkills } from './loader.js' // 导入 skill 加载选项类型和实际加载函数。
import { loadDisabledSkillsSet } from './settings.js' // 导入禁用 skill 名称集合的读取函数。


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
    this.byName = new Map() // 初始化内部 map。
    // 同名 skill 采用后写覆盖前写。
    // `loadSkills()` 会先返回用户级 skill，再返回项目级 skill。
    // 因此项目级同名 skill 会覆盖用户级 skill。
    for (const skill of skills) {
      this.byName.set(skill.name, { ...skill, disabled: disabled.has(skill.name) }) // 写入条目并计算禁用状态。
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
    const previous = this.byName // 保存旧 map，用于稍后计算 diff。
    const next = new Map<string, SkillEntry>() // 创建新的 map，承载刷新后的条目。
    for (const skill of skills) {
      next.set(skill.name, { ...skill, disabled: disabled.has(skill.name) }) // 写入新条目并重新计算禁用状态。
    }

    const summary: SkillReloadSummary = { added: [], removed: [], changed: [], unchanged: [] } // 初始化刷新摘要。
    for (const [name, entry] of next) {
      const prev = previous.get(name) // 查找同名旧条目。
      if (!prev) {
        summary.added.push(name) // 旧 map 中不存在，说明这是新增 skill。
      } else if (
        prev.description !== entry.description ||
        prev.content !== entry.content ||
        prev.source !== entry.source ||
        prev.disabled !== entry.disabled
      ) {
        summary.changed.push(name) // 关键字段或禁用状态不同，说明这个 skill 已变化。
      } else {
        summary.unchanged.push(name) // 新旧字段一致，说明这个 skill 未变化。
      }
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) summary.removed.push(name) // 旧 map 有而新 map 没有，说明这个 skill 已移除。
    }

    this.byName = next // 用刷新后的 map 替换内部索引。
    return summary // 返回调用方可展示的刷新摘要。
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
    const entry = this.byName.get(name) // 从内部索引中读取条目。
    if (!entry || entry.disabled) return undefined // 不存在或已禁用时，对外表现为不可用。
    return entry // 返回可用 skill 定义。
  }

  /**
   * 列出所有已启用的 skill。
   *
   * @returns 已启用 skill 定义列表。
   */
  list(): SkillDefinition[] {
    return [...this.byName.values()].filter((s) => !s.disabled) // 展开内部条目并过滤掉禁用项。
  }

  /**
   * 列出所有已启用 skill 的名称。
   *
   * @returns 已启用 skill 名称列表。
   */
  names(): string[] {
    return [...this.byName.values()].filter((s) => !s.disabled).map((s) => s.name) // 过滤禁用项后提取名称。
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
    return [...this.byName.values()] // 直接返回内部条目的数组副本。
  }

  /**
   * 按名称获取原始 skill 条目。
   *
   * @param name - skill 名称。
   * @returns 找到时返回条目，包括 disabled 标记；否则返回 `undefined`。
   */
  getEntry(name: string): SkillEntry | undefined {
    return this.byName.get(name) // 不过滤 disabled，直接返回内部条目。
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
  const lines: string[] = [skill.content.trim(), ''] // 先放入去掉首尾空白的 skill 正文，再留一个空行。
  lines.push(`Base directory for this skill: ${skill.dir}`) // 写入 skill 基础目录，供模型解析相对路径。
  lines.push(
    'Relative paths in this skill (e.g., scripts/foo.sh, references/api.md) are resolved against the base directory above.',
  ) // 写入相对路径解析规则提示；这是会进入模型上下文的英文文本，保持原文不翻译。
  if (skill.files.length > 0) {
    lines.push('', 'Files in this skill directory:') // 有文件列表时，先插入空行和列表标题。
    const shown = skill.files.slice(0, MAX_RENDERED_FILES) // 截出最多可渲染的文件路径。
    for (const f of shown) lines.push(`- ${f}`) // 把每个文件路径渲染为 markdown bullet。
    if (skill.files.length > MAX_RENDERED_FILES) {
      lines.push(`- ... and ${skill.files.length - MAX_RENDERED_FILES} more file(s) not shown`) // 超出上限时写入剩余数量。
    }
  }
  return lines.join('\n') // 用换行符拼成最终激活正文。
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
  return `<activated_skill name="${skill.name}">\n${formatSkillActivationBody(skill)}\n</activated_skill>` // 拼接 XML 外壳和正文。
}

/**
 * 创建并初始化 skill 注册表。
 *
 * @param opts - skill 加载选项。
 * @returns 加载完成的 `SkillRegistry` 实例。
 */
export async function createSkillRegistry(opts: LoadSkillsOptions = {}): Promise<SkillRegistry> {
  const [skills, disabled] = await Promise.all([loadSkills(opts), loadDisabledSkillsSet()]) // 并行读取 skill 列表和禁用集合。
  return new SkillRegistry(skills, disabled) // 用加载结果创建注册表。
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
  const [skills, disabled] = await Promise.all([loadSkills(opts), loadDisabledSkillsSet()]) // 并行重新读取 skill 和禁用设置。
  return registry.reload(skills, disabled) // 用最新数据原地刷新注册表并返回 diff 摘要。
}
