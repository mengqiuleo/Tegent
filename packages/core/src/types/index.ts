import type { LanguageModel, ModelMessage } from 'ai'

import type { EditDiffPayload } from '../agent/diff.js'
import type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
import type { SubAgentEvent } from '../agent/sub-agents/types.js'
import type { CommandRegistry } from '../commands/registry.js'
import type { HookBus } from '../hooks/bus.js'
import type { McpPermissionStore } from '../mcp/permissions.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { PluginRegistry } from '../plugins/registry.js'
import type { SkillRegistry } from '../skills/registry.js'

// ---- 权限相关类型 ----

// 单个工具/命令的权限等级：
// always-allow = 本次或配置中总是允许；ask = 每次询问用户；deny = 禁止执行。
export type PermissionLevel = 'always-allow' | 'ask' | 'deny'

/**
 * 当前会话的审批模式。
 *
 * default:
 *   普通模式。写文件、编辑文件、shell 等高风险操作会按权限规则询问。
 *
 * plan:
 *   计划模式。系统提示词会要求模型只读探索并写计划，不主动改文件。
 *   这个模式主要靠提示词约束；如果模型仍尝试写操作，仍会走常规权限询问。
 *
 * acceptEdits:
 *   接受编辑模式。writeFile / edit 自动通过，减少用户在批准计划后的重复确认。
 *   shell 命令仍然按 always-allow / ask / deny 分类，危险命令不会被绕过。
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

// ---- TodoWrite 工具的清单类型 ----

// Todo 条目的状态：待处理、正在处理、已完成。
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

// 模型内部工作清单的一项。只保存在 LoopState.todos 里，不落盘。
// 结构刻意贴近 Claude Code 的 TodoWrite 入参，方便兼容类似交互。
export interface TodoItem {
  // 面向用户看的任务描述，通常是祈使句，例如“更新认证处理器”。
  content: string
  // 任务进行中时展示的现在进行时文案，例如“正在更新认证处理器”。
  activeForm: string
  // 当前任务状态。
  status: TodoStatus
}

// ---- Token 用量统计 ----

// 每轮模型调用后的 token 用量汇总。
export interface TokenUsage {
  // 输入 token 数。AI SDK v6 会把缓存读取/写入 token 也归一到输入里。
  inputTokens: number
  // 输出 token 数。
  outputTokens: number
  // 输入 + 输出的总 token 数。
  totalTokens: number
  // 从 provider 侧缓存中读到的 prompt token 数。
  // 这些 token 已包含在 inputTokens 中，这个字段只用于展示和账单解释。
  cacheReadTokens: number
  // 写入 provider 侧缓存的 token 数。
  // Anthropic 等 provider 会单独计费；不区分缓存写入的 provider 会是 0。
  cacheCreationTokens: number
  // 最近一次 API 响应占用的上下文窗口大小。
  // 注意这是“快照”，每轮覆盖，不是累计值；用于底部的 “N / M · X%” 指示。
  // 这里用 input + output，是因为主流 provider 都把上下文窗口定义为两者共享的预算池。
  currentContextTokens: number
}

// ---- UI 展示消息 ----

// CLI 滚动区里可渲染的一条消息。
export interface DisplayMessage {
  // UI 内部使用的唯一消息 ID。
  id: string
  // 消息角色：用户、助手、工具。
  role: 'user' | 'assistant' | 'tool'
  // 要显示的文本内容。
  content: string
  // 这条消息关联的工具调用列表，通常挂在 assistant 消息上。
  toolCalls?: DisplayToolCall[]
  // 创建时间戳，毫秒级。
  timestamp: number
  // 是否为流式输出中的中间文本块。
  // 为 true 时不会追加普通消息的尾部空行，避免流式文本在底部缓冲区造成行抖动。
  streamingChunk?: boolean
  // 斜杠命令的紧凑展示形式。
  // command-echo 用于显示用户输入的命令；command-result 用于显示短结果。
  // 长内容如 /help、/usage 仍走普通 assistant 消息渲染。
  kind?: 'command-echo' | 'command-result'
}

// UI 中展示的一次工具调用。
export interface DisplayToolCall {
  // provider/tool-call 层面的唯一 ID。
  id: string
  // 工具名，例如 shell_command、read_file、edit。
  toolName: string
  // 工具输入参数。用 unknown 是因为不同工具的 schema 不一样。
  input: Record<string, unknown>
  // 工具最终输出。pending/running 时通常为空。
  output?: string
  // 工具执行状态。
  // error 表示工具执行失败；denied 表示权限层拒绝，二者在 UI 上语义不同。
  status: 'pending' | 'running' | 'completed' | 'denied' | 'error'
  // 工具执行耗时，单位毫秒。
  durationMs?: number
  // writeFile / edit 产生的结构化 diff。
  // UI 用它渲染彩色差异块；非编辑工具、恢复历史、无变化编辑都不会有这个字段。
  editPayload?: EditDiffPayload
}

// ---- Agent 回调：core 到 CLI/UI 的桥 ----

// agentLoop 不直接依赖 UI，而是通过这一组回调把事件交给外层。
export interface AgentCallbacks {
  // 模型流式吐出的文本增量。
  onTextDelta: (text: string) => void
  // 模型开始调用工具时触发。
  onToolCall: (toolCallId: string, toolName: string, input: Record<string, unknown>) => void
  // 工具运行中的进度消息，例如“正在搜索...”。
  // UI 只展示最新一条进度，最终内容由 onToolResult 提供。
  onToolProgress: (toolCallId: string, message: string) => void
  // 工具结束时触发。isError 为 true 表示失败结果。
  onToolResult: (toolCallId: string, result: string, isError?: boolean) => void
  // 成功写文件或编辑文件后、onToolResult 前触发。
  // 只有真实改动才会触发；权限拒绝、报错、无变化编辑都会跳过。
  onFileEdit?: (toolCallId: string, payload: EditDiffPayload) => void
  // 工具需要用户审批时触发。
  // yes = 仅本次允许；always = 以后同类允许；no = 拒绝。
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }) => Promise<'yes' | 'always' | 'no'>
  // 模型通过 askUser 工具向用户提问时触发，返回用户选择/输入的字符串。
  onAskUser: (question: string, options: { label: string; description: string }[]) => Promise<string>
  // exitPlanMode 发起计划审批时触发。
  // 返回 true 表示离开计划模式并开始实施；false 表示退回计划模式继续修改计划。
  onPlanApprovalRequest: (planText: string) => Promise<boolean>
  // permissionMode 改变时触发，UI 用它刷新底部状态并可持久化到配置。
  onPlanModeChange: (mode: PermissionMode) => void
  // 模型调用 todoWrite 后触发。
  // todoWrite 是全量替换工具，所以这里每次传完整清单，而不是增量。
  onTodosUpdate: (todos: TodoItem[]) => void
  // shell 工具输出的流式 chunk。
  onShellOutput: (chunk: string) => void
  // token 用量更新。
  onUsageUpdate: (usage: TokenUsage) => void
  // 上下文压缩完成后返回的摘要。
  onContextCompressed: (summary: string) => void
  // 上下文压缩过程中每个阶段的进度描述，用于 UI spinner 文案。
  onCompressionProgress?: (description: string) => void
  // agentLoop 内部错误统一从这里抛给外层 UI。
  onError: (error: Error) => void
  // 子代理运行器发出的事件。
  // CLI 用这些事件渲染可折叠/展开的 task 区块。
  onSubAgentEvent?: (event: SubAgentEvent) => void
  // 回合结束后的记忆抽取器写入 AutoMemory 时触发。
  // 记忆抽取是 fire-and-forget，可能在 submit() 已返回后甚至下一轮才回调，
  // 因此实现方不要依赖本轮局部状态。
  onMemoryWrite?: (notice: MemoryWriteNotice) => void
}

// ---- Agent 启动/运行选项 ----

// agentLoop 的外部配置。CLI、子代理、print 模式都会通过这里注入能力。
export interface AgentOptions {
  // 当前使用的模型 ID，格式通常是 `<provider>:<model>`。
  modelId: string
  // 信任模式。开启后会减少某些权限询问，但仍受工具自身分类约束。
  trustMode: boolean
  // 单次 agentLoop 调用内最多迭代多少轮。
  // 交互式会话通常不设上限；子代理和 --print 模式会传入限制。
  maxTurns?: number
  // 是否为无交互打印模式。
  printMode: boolean
  // 是否启用 provider 支持的最高 reasoning/thinking 强度。
  // 由 ~/.x-code/config.json 的 thinking 字段持久化，也可用 /thinking on|off 切换。
  thinking?: boolean
  // 会话初始权限模式。未传时默认为 default。
  // CLI 的 --plan 或用户配置会设置它。
  permissionMode?: PermissionMode
  // 追加到系统提示词的额外内容。
  // 注意不要在会话中动态改变稳定前缀，否则会破坏 provider 的 prompt cache。
  systemPromptExtra?: string
  // 外部取消信号。工具执行链路也应该继续向下透传它，避免孤儿 tool_call。
  abortSignal?: AbortSignal

  // ---- 子代理支持 ----

  // 模型注册表，用于解析子代理自己的模型覆盖配置。
  // CLI 启动时注入；不传时子代理继承父级模型。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelRegistry?: { languageModel: (...args: any[]) => LanguageModel }
  // 子代理注册表。CLI 扫描内置与自定义 agent 定义后注入。
  // 不传时不会注册 task 工具，也就没有子代理能力。
  subAgentRegistry?: SubAgentRegistry
  // 工具允许/拒绝过滤器。
  // 子代理用它限制可调用工具；task 永远会放入 deny，避免递归调用子代理。
  toolFilter?: { allow?: string[]; deny?: string[] }

  // ---- Skill 支持 ----

  // Skill 注册表，由 createSkillRegistry 在 CLI 启动时构建。
  // 不传表示没有配置 skills：activateSkill 工具不会注册，系统提示词也不展示技能列表。
  skillRegistry?: SkillRegistry

  // ---- MCP 支持 ----

  // MCP 服务器注册表，由 loadMcpServers 在 CLI 启动时加载。
  // 不传表示完全禁用 MCP；会话内 registry 本身不可变，/mcp refresh 会在下一次 agentLoop 入口替换整体对象。
  mcpRegistry?: McpRegistry
  // MCP 工具调用的权限存储。
  // 负责缓存持久化的 always-allow 和仅本会话有效的允许项；不传则退回每次询问。
  mcpPermissionStore?: McpPermissionStore

  // ---- 插件支持 ----

  // 插件注册表，由 loadAllPlugins 在 CLI 启动时构建。
  // 包含成功加载的启用/禁用插件，供 /plugin 命令列出、查看、切换。
  // 插件贡献的 skills / agents / mcp 已经合并到各自 registry，这里只保留元数据面。
  pluginRegistry?: PluginRegistry

  // Hook 总线，来自启用插件的 hooks 贡献。
  // agentLoop 会通过它发 SessionStart / UserPromptSubmit / TurnComplete / SessionEnd；
  // 工具执行会额外发 PreToolUse / PostToolUse。不传表示完全不发 hook。
  hookBus?: HookBus

  // 插件文件型斜杠命令注册表。
  // App.tsx 的默认斜杠命令分发器会在内置命令和 skill registry 之后检查它；
  // 命中后展开命令正文并替换 $ARGUMENTS / ${CLAUDE_PLUGIN_ROOT}，再作为 prompt 提交给模型。
  commandRegistry?: CommandRegistry
}

// ---- 知识与自动记忆 ----

/**
 * AutoMemory 的分类枚举。
 *
 * 这里描述的是“知识从哪里来/关于谁/怎么用”，不是业务主题。
 * 这样做能让模型按不同触发条件检索记忆，减少无关记忆污染。
 *
 * user:
 *   关于用户本人的事实，例如角色、偏好、目标、限制。
 *
 * feedback:
 *   用户纠正或确认过的方法，例如“不要 mock 数据库”“这样是对的”。
 *
 * project:
 *   项目长期状态、决策、进行中的工作、非显而易见的上下文。
 *
 * reference:
 *   外部系统入口，例如 Linear 项目、Grafana 面板、文档链接等。
 */
export type KnowledgeCategory = 'user' | 'feedback' | 'project' | 'reference'

// 一条自动记忆事实。
export interface KnowledgeFact {
  // 稳定 key，用于去重、覆盖或定位某条事实。
  key: string
  // 事实正文，尽量短而可直接放进系统提示词。
  fact: string
  // 事实类别，决定后续触发和组织方式。
  category: KnowledgeCategory
  // 记录日期，通常是 ISO 日期字符串。
  date: string
}

// 记忆抽取器成功写入 AutoMemory 后抛给 UI 的事件。
export interface MemoryWriteNotice {
  // 写入范围：项目级记忆或用户级记忆。
  scope: 'project' | 'user'
  // 记忆类别。
  category: KnowledgeCategory
  // 记忆 key。
  key: string
  // 记忆正文。
  fact: string
}

// 一次会话结束/压缩后保存的摘要。
export interface SessionSummary {
  // 会话 ID。
  id: string
  // 会话标题。
  title: string
  // 开始时间，通常是 ISO 字符串。
  startedAt: string
  // 结束时间，通常是 ISO 字符串。
  endedAt: string
  // 会话状态：已完成、进行中、已放弃。
  status: 'completed' | 'in_progress' | 'abandoned'
  // 总体摘要。
  summary: string
  // 本次会话达成的关键结果。
  keyResults: string[]
  // 仍待处理的事项。
  pendingWork: string[]
  // 本次会话修改过的文件路径列表。
  filesModified: string[]
  // 本次会话形成的重要决策。
  decisions: string[]
}

// ---- 模型别名 ----

// 用户在 /model 或 --model 中可输入的短别名。
// 值是实际传给 provider/AI SDK 的完整模型 ID。
export const MODEL_ALIASES: Record<string, string> = {
  sonnet: 'anthropic:claude-sonnet-4-6',
  opus: 'anthropic:claude-opus-4-7',
  haiku: 'anthropic:claude-haiku-4-5',
  gpt4: 'openai:gpt-4.1',
  gemini: 'google:gemini-2.5-pro',
  deepseek: 'deepseek:deepseek-v4-flash',
  'deepseek-pro': 'deepseek:deepseek-v4-pro',
  qwen: 'alibaba:qwen-max',
  glm: 'zhipu:glm-4-plus',
  kimi: 'moonshotai:kimi-k2.5',
}

// ---- provider 自动检测顺序 ----

// 没有显式指定模型时，CLI 会按这个顺序检查环境变量，
// 找到第一个可用 API key 后选择对应 defaultModel。
export const PROVIDER_DETECTION_ORDER = [
  { envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek:deepseek-v4-flash' },
  { envKey: 'ANTHROPIC_API_KEY', defaultModel: 'anthropic:claude-sonnet-4-6' },
  { envKey: 'OPENAI_API_KEY', defaultModel: 'openai:gpt-4.1' },
  { envKey: 'ALIBABA_API_KEY', defaultModel: 'alibaba:qwen-max' },
  { envKey: 'GOOGLE_GENERATIVE_AI_API_KEY', defaultModel: 'google:gemini-2.5-pro' },
  { envKey: 'XAI_API_KEY', defaultModel: 'xai:grok-3' },
  { envKey: 'ZHIPU_API_KEY', defaultModel: 'zhipu:glm-4-plus' },
  { envKey: 'MOONSHOT_API_KEY', defaultModel: 'moonshotai:kimi-k2.5' },
] as const

// ---- /model 交互选择器里的模型条目 ----

export interface ProviderModel {
  // 完整 `<provider>:<model>` ID，会传给 AI SDK。
  id: string
  // 选择器里显示的短标签。
  label: string
  // 标签下面的一行说明。
  description: string
}

// 按 provider 手工维护的模型目录。
// 这里只放确认可用或明确生产稳定的模型，避免交互选择器塞满实验型号。
// 需要冷门模型的用户仍可直接输入完整 `<provider>:<model>`。
export const PROVIDER_MODELS: Record<string, readonly ProviderModel[]> = {
  anthropic: [
    {
      id: 'anthropic:claude-sonnet-4-6',
      label: 'Sonnet 4.6',
      description: 'Balanced default — good for coding + reasoning, 1M context',
    },
    {
      id: 'anthropic:claude-opus-4-7',
      label: 'Opus 4.7',
      description: 'Most capable, strongest at agentic coding, 1M context',
    },
    { id: 'anthropic:claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest, cheapest — shorter replies' },
  ],
  openai: [
    { id: 'openai:gpt-4.1', label: 'GPT-4.1', description: 'General-purpose, 1M context window' },
    { id: 'openai:gpt-4.1-mini', label: 'GPT-4.1 Mini', description: 'Cheaper tier of 4.1, 1M context' },
    { id: 'openai:o3', label: 'o3', description: 'Reasoning model — slower, stronger on hard problems' },
    { id: 'openai:o4-mini', label: 'o4-mini', description: 'Smaller reasoning model' },
  ],
  deepseek: [
    {
      id: 'deepseek:deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      description: 'Fast, efficient general-purpose, 1M context',
    },
    {
      id: 'deepseek:deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      description: 'Flagship, stronger reasoning, 1M context',
    },
  ],
  alibaba: [
    { id: 'alibaba:qwen-max', label: 'Qwen Max', description: 'Strongest general Qwen, 128k context' },
    { id: 'alibaba:qwen-plus', label: 'Qwen Plus', description: 'Balanced cost/quality' },
    { id: 'alibaba:qwen-turbo', label: 'Qwen Turbo', description: 'Cheapest, fast' },
    { id: 'alibaba:qwen3-max', label: 'Qwen3 Max', description: 'Latest flagship' },
    { id: 'alibaba:qwen3-coder-plus', label: 'Qwen3 Coder Plus', description: 'Tuned for coding tasks' },
    { id: 'alibaba:qwq-plus', label: 'QwQ Plus', description: 'Reasoning model' },
  ],
  google: [
    { id: 'google:gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: '1M context, strong long-doc handling' },
    { id: 'google:gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Cheaper/faster tier' },
  ],
  xai: [
    { id: 'xai:grok-3', label: 'Grok 3', description: '131k context' },
    { id: 'xai:grok-3-mini', label: 'Grok 3 Mini', description: 'Smaller/cheaper variant' },
  ],
  zhipu: [{ id: 'zhipu:glm-4-plus', label: 'GLM-4 Plus', description: '128k context' }],
  moonshotai: [{ id: 'moonshotai:kimi-k2.5', label: 'Kimi K2.5', description: '131k context' }],
}

// ---- provider API key 获取地址 ----

// /model 或配置流程缺少 key 时，可以把用户指向这些控制台页面。
export const PROVIDER_KEY_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
  xai: 'https://console.x.ai/',
  deepseek: 'https://platform.deepseek.com/api_keys',
  alibaba: 'https://dashscope.console.aliyun.com/apiKey',
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
  moonshotai: 'https://platform.moonshot.ai/console/api-keys',
}

// ---- 重新导出 AI SDK 类型 ----

// 外部模块可以统一从 core 的 types 入口拿到这些 AI SDK 类型。
export type { ModelMessage, LanguageModel }

// ---- 重新导出子代理类型 ----

// 子代理相关类型也从这里转发，减少外部依赖内部路径。
export type { SubAgentEvent, SubAgentDefinition, SubAgentTrace } from '../agent/sub-agents/types.js'
export type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
