/**
 * 插件清单（manifest）的结构。
 *
 * 每个插件根目录下必须有一个 `.tegent-plugin/plugin.json`，这个文件就是清单。
 * 结构对齐 Claude Code 的 `.claude-plugin/plugin.json`，只保留 tegent 关心的最小字段，
 * 未来需要更多贡献类型（commands、hooks 等）时再扩展。
 */
export interface PluginManifest {
  /**
   * 插件名称。
   *
   * 必须是合法插件名（见 `utils.ts` 的 `isValidPluginName`），
   * 也是注册表和 `disabledPlugins` 设置里的主键。
   */
  name: string

  /**
   * 插件版本，SemVer 字符串（这里只做非空校验，不做语义解析）。
   */
  version: string

  /**
   * 插件的短描述，展示在 `/plugin list` 之类的 UI 上。
   */
  description?: string

  /**
   * 插件作者或维护者。
   */
  author?: string

  /**
   * 插件来源的 marketplace 名称。
   *
   * 带 marketplace 的插件 id 形如 `name@marketplace`；本地直装的插件没有这个字段。
   */
  marketplace?: string
}

/**
 * 插件定义来源。
 *
 * `user` 表示安装在用户级缓存目录（`~/.tegent/plugins/cache/<name>`），
 * `project` 表示安装在项目目录（`<repo-root>/.tegent/plugins/<name>`）。
 */
export type PluginSource = 'user' | 'project'

/**
 * 一个已加载插件的核心描述。
 *
 * loader 从磁盘扫描出这个结构，registry 再按它建立索引；
 * `dir` 指向插件根目录，插件贡献的 skills、agents 等资源都以它为基准解析。
 */
export interface PluginDefinition {
  /**
   * 插件唯一 id。
   *
   * 本地插件就是 `name`；来自 marketplace 的插件是 `name@marketplace`。
   * 这个字符串会出现在 skill 的 `pluginId`、设置文件的 `disabledPlugins` 里。
   */
  id: string

  /**
   * 插件名称，与清单 `name` 字段一致。
   */
  name: string

  /**
   * 插件版本，与清单 `version` 字段一致。
   */
  version: string

  /**
   * 插件短描述；清单没写就没有这个字段。
   */
  description?: string

  /**
   * 插件作者；清单没写就没有这个字段。
   */
  author?: string

  /**
   * marketplace 名称；本地直装插件没有这个字段。
   */
  marketplace?: string

  /**
   * 插件定义来源：用户级缓存或项目目录。
   */
  source: PluginSource

  /**
   * 插件根目录的绝对路径。
   *
   * 目录结构约定（与 Claude Code 插件布局对齐）：
   *
   * ```
   * <dir>/
   *   .tegent-plugin/plugin.json   ← 清单，必须有
   *   skills/<skill-name>/SKILL.md ← 可选：贡献给 skill 注册表
   *   agents/<agent>.md            ← 可选：贡献给子代理注册表（暂未接入）
   * ```
   */
  dir: string

  /**
   * 清单文件的绝对路径，即 `<dir>/.tegent-plugin/plugin.json`。
   * 调试和错误提示时会用它指认具体文件。
   */
  manifestPath: string
}

/**
 * 注册表内部保存的插件条目。
 *
 * 它在 `PluginDefinition` 基础上额外记录当前是否被 `disabledPlugins` 设置禁用。
 */
export interface PluginEntry extends PluginDefinition {
  disabled: boolean
}

/**
 * `reloadPluginRegistry()` 返回的刷新摘要。
 *
 * `/plugin refresh` 会用它生成用户可见消息，结构刻意和 `SkillReloadSummary` 一致，
 * 方便复用同一套渲染逻辑。
 */
export interface PluginReloadSummary {
  /**
   * 新增的插件 id。
   */
  added: string[]

  /**
   * 已移除的插件 id。
   */
  removed: string[]

  /**
   * 版本、描述、来源或禁用状态发生变化的插件 id。
   */
  changed: string[]

  /**
   * 与刷新前保持一致的插件 id。
   */
  unchanged: string[]
}
