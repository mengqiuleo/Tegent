// 一个插件会用同一份 manifest 和同一个命名空间打包 skills、sub-agents、
// slash commands、MCP servers 和 hooks。插件在 CLI 启动时被发现，并在当前会话中
// 冻结；这和 skills / sub-agents 一样受 systemPromptCache 字节稳定性约束影响。
// 只有 `/plugin refresh` 会重新加载插件，并显式让 prompt cache 失效。
//
// manifest 格式刻意和 Claude Code 的 `.claude-plugin/plugin.json` 保持字节级
// 兼容，让同一个插件包可以同时安装到两个 CLI。我们也接受原生
// `.tegent-plugin/plugin.json`（新写 tegent-only 插件时推荐），并兼容根目录下
// 裸露的 `plugin.json`。

// ── 插件来源（安装时从哪里获取） ───────────────────────────────────────

/**
 * 插件安装来源的内部标准形状。
 *
 * installer 使用这个类型执行下载 / 复制，并把它记录进 `installed_plugins.json`。
 * marketplace 文件中的来源是另一种 wire format，例如字符串快捷写法、
 * `git-subdir`、`url` 等，都会先由 `normalizeMarketplaceSource` 归一化成这里的
 * 类型。`git` 和 `github` 都支持 `subdir`，因此从 monorepo 发布的插件也能正确
 * 安装；真实 Claude Code marketplace，例如 `anthropics/claude-plugins-official`，
 * 经常使用这种模式。
 *
 * `expectedSha` 是可选完整性 pin，来自 marketplace.json 中 git 类来源的 `sha`
 * 字段。设置后，installer 会 clone 仓库、运行 `git rev-parse HEAD`，并在不匹配
 * 时抛出 `InstallError`。这可以防止 marketplace 作者审核后，上游 ref 被
 * force-push 或仓库被入侵。字段缺失时跳过校验，让还没 pin sha 的 marketplace
 * 仍然可用。
 */
export type PluginSource =
  | { kind: 'git'; url: string; ref?: string; subdir?: string; expectedSha?: string }
  | { kind: 'github'; owner: string; repo: string; ref?: string; subdir?: string; expectedSha?: string }
  | { kind: 'local'; path: string }

/**
 * 插件启用状态使用的两级作用域。
 *
 *    'user'     →  ~/.tegent/settings.json
 *    'project'  →  <cwd>/.tegent/settings.local.json  （被 git 忽略）
 *
 *  这个约定和 MCP、skill 保持一致（见 packages/core/src/skills/settings.ts）。
 *  `'project'` 读取 `.local.json` 是继承自 skills 的命名习惯：它是当前仓库下的
 *  个人覆盖，不是团队共享文件。未来如果要添加会提交的团队作用域，可以在外层
 *  继续叠加，不必改变这个 union。
 */
export type PluginScope = 'user' | 'project'

// ── Manifest（插件作者编写的契约） ────────────────────────────────────

export interface PluginAuthor {
  name?: string
  email?: string
  url?: string
}

/**
 * 一个需要安装时向用户询问的配置项，例如 API key、base URL 等。
 *
 * 当 `sensitive: true` 时，语义上表示值应该进入系统 keyring 而不是普通
 * settings.json。当前存储层还是 JSON v1，但这个 schema 和 Claude Code 保持一致，
 * 让同一个插件无需为两个 CLI 编写两份配置块。
 */
export interface UserConfigItem {
  key: string
  type: 'string' | 'number' | 'boolean'
  sensitive?: boolean
  prompt?: string
  required?: boolean
  default?: string | number | boolean
  description?: string
}

/**
 * 内联 hook 配置，也就是 hooks 文件路径之外的另一种写法。
 *
 * 这里故意保持宽松形状；完整校验由 packages/core/src/hooks/config-schema.ts
 * 负责，避免 hooks 子系统的 schema 变化反向污染 plugin 类型层。
 */
export type InlineHookConfig = Record<string, unknown>

/**
 * 内联 mcpServers 记录，也就是路径字符串之外的另一种写法。
 *
 * 它和 ~/.tegent/config.json 里的 `mcpServers` 形状一致，具体校验由现有 MCP
 * config-schema 负责，这里不重复定义。
 */
export type InlineMcpServers = Record<string, unknown>

/**
 * 从磁盘解析后的插件 manifest。
 *
 * 所有路径字段都保持原始字符串，不在这里解析；相对插件根目录的绝对路径转换由
 * [[loader]] 完成。源 JSON 中未知字段会被静默剥离（zod 默认行为），这样较新的
 * Claude Code manifest 即使包含我们还不理解的字段，也能尽量正常加载。
 */
export interface PluginManifest {
  /**
   * manifest schema 版本。
   *
   * 缺失时默认是 `"1"`。只有 manifest 契约发生破坏性变化时我们才会提升它；
   * 老插件只要字段能通过校验，仍然应该继续加载。
   */
  schemaVersion: string
  name: string
  version: string
  description?: string
  author?: PluginAuthor
  keywords?: string[]
  homepage?: string
  license?: string

  // ── 贡献项（全部可选，全部相对插件根目录解析） ───────────────────────
  /**
   * skills 目录路径。
   *
   * 目录下每个 skill 应遵循 `<name>/SKILL.md` 结构，和 `~/.tegent/skills/`
   * 保持一致。部分调用方也可能容忍单文件路径。
   */
  skills?: string
  /** sub-agent `.md` 文件目录路径，布局和 `~/.tegent/agents/` 一致。 */
  agents?: string
  /** slash command `.md` 文件目录路径。 */
  commands?: string
  /**
   * MCP server 贡献。
   *
   * 可以是指向 `{ mcpServers: { ... } }` JSON 文件的路径，也可以是内联
   * `mcpServers` 记录。内联形式和 ~/.tegent/config.json 中的形状一致。
   */
  mcpServers?: string | InlineMcpServers
  /** hooks 贡献，可以是 hooks.json 路径，也可以是内联 hook 配置对象。 */
  hooks?: string | InlineHookConfig

  // ── 插件作者声明、用户在安装时填写的配置 ─────────────────────────────
  userConfig?: UserConfigItem[]

  // ── 插件依赖和运行时兼容性声明 ───────────────────────────────────────
  /**
   * 插件依赖列表。
   *
   * 完整形式是 `name@marketplace`；如果只写裸 `name`，则默认解析到当前插件所在的
   * 同一个 marketplace。
   */
  dependencies?: string[]
  engines?: { 'tegent'?: string }
}

// ── 已加载插件（运行时注册表保存的形状） ───────────────────────────────

/**
 * 实际加载到的 manifest 格式。
 *
 * 正常运行时不会加载到 `'gemini'`，因为 Gemini 扩展会在安装阶段被拒绝
 * （见 plugin-marketplace-design.md §3.4）。保留这个值只用于错误报告：
 * “这看起来是 Gemini 扩展，但我们不支持”。
 */
export type ManifestFormat = 'native' | 'claude' | 'bare' | 'gemini'

export interface LoadedPlugin {
  /**
   * 组合 ID，形如 `name@marketplace`。
   *
   * 从本地路径安装或项目内置的插件，其 marketplace 通常是 `"local"`。
   */
  id: string
  manifest: PluginManifest
  /** 插件根目录的绝对路径。 */
  rootDir: string
  /** 实际加载的 manifest 文件绝对路径。 */
  manifestPath: string
  manifestFormat: ManifestFormat
  /**
   * 插件最初的安装来源。
   *
   * 只有极少数手动丢进缓存、没有账本 metadata 的插件会是 `undefined`。
   */
  source: PluginSource | undefined
  /** 插件所属 marketplace 名；本地路径安装或项目内置插件使用 `"local"`。 */
  marketplace: string
  scope: PluginScope
  /** 合并所有作用域后得到的最终启用状态。 */
  enabled: boolean
}

/**
 * 非致命插件加载错误。
 *
 * loader 会收集这些错误并通过 `/plugin doctor` 展示。单个坏插件不能让整个 CLI
 * 启动失败。
 */
export interface PluginLoadError {
  /** 如果流程已经走到能识别插件身份，则记录 `name@marketplace`。 */
  id?: string
  /** 触发错误的文件系统路径；即使 manifest 没解析出来也会尽量记录。 */
  path: string
  message: string
}

// ── Marketplace（索引 / 目录格式） ────────────────────────────────────

/**
 * marketplace 中的一条插件列表项。
 *
 * `source` 告诉 installer 应该从哪里获取插件内容。
 */
export interface MarketplaceEntry {
  name: string
  description?: string
  category?: string
  /**
   * marketplace 维护者给出的“已审核”声明。
   *
   * UI 会展示这个标记，但系统不会因此授予额外信任；安装授权流程仍然照常执行。
   */
  verified?: boolean
  source: PluginSource
  /** marketplace pin 的版本号；缺失时 installer 会从下载到的 manifest 读取版本。 */
  version?: string
  homepage?: string
  keywords?: string[]
}

export interface Marketplace {
  schemaVersion: string
  /**
   * marketplace 面向用户的规范身份，也就是用户订阅时输入的别名。
   *
   * 例如 `anthropic-marketplace`。存储路径、安装 ID（`<plugin>@<name>`）和查询
   * 都以这个别名为准。
   */
  name: string
  /**
   * marketplace.json 中上游自声明的名称。
   *
   * 例如 `claude-plugins-official`。当它和用户订阅别名不同时，`info` 可以展示给
   * 用户看；但它永远不作为查找身份使用。
   */
  upstreamName?: string
  displayName?: string
  description?: string
  owner?: { name?: string; url?: string }
  plugins: MarketplaceEntry[]
}

/**
 * `~/.tegent/plugins/known_marketplaces.json` 中的一条订阅记录。
 *
 * `source` 字符串可以是 git URL（`github:owner/repo`、`https://...`），也可以是
 * 直接指向 marketplace.json 的 HTTPS URL。
 */
export interface KnownMarketplace {
  name: string
  source: string
  /**
   * 内置订阅项会设置这个字段，例如默认的 `anthropic-marketplace`。
   *
   * 保留名称只接受规范来源，具体见 [[marketplace]] 中的
   * RESERVED_MARKETPLACE_NAMES。
   */
  reservedName?: boolean
  /** 保留名称期望指向的 GitHub org；指向其他位置的注册请求会被拒绝。 */
  officialSource?: string
}

export interface KnownMarketplaces {
  marketplaces: KnownMarketplace[]
  /**
   * 为 true 时，只允许从 `marketplaces` 列表里的已订阅 marketplace 安装插件。
   *
   * 默认关闭；企业管理员可以打开它做来源约束。
   */
  strictKnownMarketplaces?: boolean
  /**
   * 强制禁用的插件 ID 列表。
   *
   * 通常写 `name@marketplace`，并且会无视用户 settings 中的启用状态，是偏管理员
   * 策略的 block list。
   */
  blockedPlugins?: string[]
}

// ── 已安装插件注册表（~/.tegent/plugins/installed_plugins.json） ───────

/**
 * 已安装插件账本中的单条记录。
 *
 * 这里保存每个缓存安装的关键 metadata，让更新、卸载和作用域变更可以不用重新读取
 * 每个 manifest。
 */
export interface InstalledPluginRecord {
  id: string
  name: string
  marketplace: string
  version: string
  source: PluginSource
  installedAt: string
  /**
   * 触发安装的作用域，也就是启用状态应该记录到哪个 settings.json。
   *
   * 默认是 user 作用域。
   */
  installScope: PluginScope
}

export interface InstalledPlugins {
  schemaVersion: string
  plugins: InstalledPluginRecord[]
}
