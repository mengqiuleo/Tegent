import { jsonSchema } from 'ai'
import type { LanguageModel, ToolSet } from 'ai'

import type { z } from 'zod'
import type { EditDiffPayload } from '../agent/diff.js'
import type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
import type { SubAgentDefinition, SubAgentEvent, SubAgentTrace } from '../agent/sub-agents/types.js'
import type { Tool } from '../mcp/type.js'
import type { SkillRegistry } from '../skills/registry.js'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan'
export type PermissionLevel = 'always-allow' | 'ask' | 'deny'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  currentContextTokens: number
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  activeForm: string
  status: TodoStatus
}

export interface CheckpointEntry {
  id: string
  messageCount: number
  createdAt: string
}

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
  // options 缺省表示开放式问题，由用户自由输入而不是从候选中选择。
  onAskUser: (question: string, options?: { label: string; description: string }[] | undefined) => Promise<string>
  // exitPlanMode 发起计划审批时触发。
  // 返回 true 表示离开计划模式并开始实施；false 表示退回计划模式继续修改计划。
  onPlanApprovalRequest: (planText: string) => Promise<boolean>
  // permissionMode 改变时触发，UI 用它刷新底部状态并可持久化到配置。
  onPlanModeChange: (mode: PermissionMode) => void
  // 模型调用 todoWrite 后触发。
  onTodosUpdate: (todos: TodoItem[]) => void
  // shell 工具输出的流式 chunk。
  onShellOutput: (chunk: string) => void
  // token 用量更新。
  onUsageUpdate: (usage: TokenUsage) => void
  // 上下文压缩完成后返回的摘要。
  onContextCompressed: (summary: string) => void
  // 上下文压缩过程中每个阶段的进度描述，用于 UI spinner 文案。
  onCompressionProgress?: (description: string) => void
  // 记忆提取器写入一条记忆后触发，notice 是单行描述。
  onMemoryWrite?: (notice: string) => void
  // agentLoop 内部错误统一从这里抛给外层 UI。
  onError: (error: Error) => void
  onSubAgentEvent?: (event: SubAgentEvent) => void
}


export interface ToolFilter {
  allow?: string[]
  deny?: string[]
}



export interface AgentOptions {
  modelId: string
  trustMode: boolean
  maxTurns?: number
  permissionMode?: PermissionMode
  systemPromptExtra?: string
  abortSignal?: AbortSignal
  toolFilter?: ToolFilter
  subAgentRegistry?: SubAgentRegistry
  // 会话级 skill 注册表。有已启用 skill 时 loop 会给模型注入 activateSkill 工具。
  // 注册表对象在整个会话内保持身份不变，/skill refresh 通过原地 reload 更新内容，
  // 因此这里缓存引用是安全的。子代理通过 ...parentOptions 展开自然继承。
  skillRegistry?: SkillRegistry
  // 会话级 MCP 工具注册表。启动时由 registerMcpServers 连接各 Server 并填充
  //（连不上的自动跳过，不拖垮启动）；loop 每轮用 toToolSet() 合并进工具列表，
  // 执行走 processToolCalls 的手动分支，非只读工具照样过权限闸门。
  // 子代理通过 ...parentOptions 展开自然继承。
  mcpRegistry?: ToolRegistry
  modelRegistry?: {
    languageModel: (id: `${string}:${string}`) => LanguageModel
  }
}

export type { SubAgentDefinition, SubAgentEvent, SubAgentRegistry, SubAgentTrace }

export type LanguageModelLike = LanguageModel

export type BuiltInProviderName =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'alibaba'
  | 'zhipu'
  | 'moonshotai'

export type ProviderName = BuiltInProviderName | 'custom'
export type ModelId = `${ProviderName}:${string}`

export const MODEL_ALIASES: Record<string, ModelId> = {
  sonnet: 'anthropic:claude-sonnet-4-6',
  opus: 'anthropic:claude-opus-4-7',
  haiku: 'anthropic:claude-haiku-4-5',
  gpt: 'openai:gpt-4.1',
  openai: 'openai:gpt-4.1',
  gemini: 'google:gemini-2.5-pro',
  grok: 'xai:grok-3',
  deepseek: 'deepseek:deepseek-v4-flash',
  qwen: 'alibaba:qwen-max',
  glm: 'zhipu:glm-4-plus',
  kimi: 'moonshotai:kimi-k2.5',
}

export const PROVIDER_DETECTION_ORDER = [
  { envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek:deepseek-v4-flash' },
  { envKey: 'ANTHROPIC_API_KEY', defaultModel: 'anthropic:claude-sonnet-4-6' },
  { envKey: 'OPENAI_API_KEY', defaultModel: 'openai:gpt-4.1' },
  { envKey: 'ALIBABA_API_KEY', defaultModel: 'alibaba:qwen-max' },
  { envKey: 'GOOGLE_GENERATIVE_AI_API_KEY', defaultModel: 'google:gemini-2.5-pro' },
  { envKey: 'XAI_API_KEY', defaultModel: 'xai:grok-3' },
  { envKey: 'ZHIPU_API_KEY', defaultModel: 'zhipu:glm-4-plus' },
  { envKey: 'MOONSHOT_API_KEY', defaultModel: 'moonshotai:kimi-k2.5' },
] as const satisfies ReadonlyArray<{ envKey: string; defaultModel: ModelId }>

export interface ProviderModel {
  id: ModelId
  label: string
  description: string
}

export const PROVIDER_MODELS: Record<string, readonly ProviderModel[]> = {
  anthropic: [
    {
      id: 'anthropic:claude-sonnet-4-6',
      label: 'Sonnet 4.6',
      description: 'Balanced default for coding and reasoning, 1M context',
    },
    {
      id: 'anthropic:claude-opus-4-7',
      label: 'Opus 4.7',
      description: 'Most capable Claude model for agentic coding',
    },
    { id: 'anthropic:claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest Claude tier' },
  ],
  openai: [
    { id: 'openai:gpt-4.1', label: 'GPT-4.1', description: 'General-purpose OpenAI model, 1M context' },
    { id: 'openai:gpt-4.1-mini', label: 'GPT-4.1 Mini', description: 'Cheaper and faster 4.1 tier' },
  ],
  google: [
    { id: 'google:gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Strong long-context model' },
    { id: 'google:gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Faster Gemini tier' },
  ],
  xai: [
    { id: 'xai:grok-3', label: 'Grok 3', description: 'General-purpose xAI model' },
    { id: 'xai:grok-3-mini', label: 'Grok 3 Mini', description: 'Smaller and cheaper Grok tier' },
  ],
  deepseek: [
    { id: 'deepseek:deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'Fast default DeepSeek model' },
    { id: 'deepseek:deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'Stronger DeepSeek model' },
  ],
  alibaba: [
    { id: 'alibaba:qwen-max', label: 'Qwen Max', description: 'Strongest general Qwen model' },
    { id: 'alibaba:qwen-plus', label: 'Qwen Plus', description: 'Balanced Qwen model' },
  ],
  zhipu: [{ id: 'zhipu:glm-4-plus', label: 'GLM-4 Plus', description: 'Default Zhipu model' }],
  moonshotai: [{ id: 'moonshotai:kimi-k2.5', label: 'Kimi K2.5', description: 'Default Moonshot model' }],
}

export const PROVIDER_KEY_URLS: Record<BuiltInProviderName, string> = {
  anthropic: 'https://console.anthropic.com/',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
  xai: 'https://console.x.ai/',
  deepseek: 'https://platform.deepseek.com/api_keys',
  alibaba: 'https://dashscope.console.aliyun.com/apiKey',
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
  moonshotai: 'https://platform.moonshot.ai/console/api-keys',
}



/**
 * 工具注册表。
 *
 * Claude Code 的工具注册方式是在 tools.ts 中硬编码一个数组（getAllBaseTools），
 * 然后通过 getTools() 和 assembleToolPool() 层层过滤：
 *
 *   getAllBaseTools() → 全量工具列表（含条件编译的工具）
 *   getTools(permCtx) → 过滤 deny 规则 + isEnabled 检查
 *   assembleToolPool(permCtx, mcpTools) → 合并 MCP 工具 + 去重
 *
 * 我们简化为一个 Map + register/get/getAll/toToolSet 四个方法。
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * 注册一个工具。
   * 对应 Claude Code: getAllBaseTools() 数组中的每一项
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * 按名称获取工具。
   * 对应 Claude Code: findToolByName()（src/Tool.ts 第 358-360 行）
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有已注册工具。
   * 对应 Claude Code: getTools()（src/tools.ts 第 271-327 行）
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 转成 AI SDK 的 ToolSet，供 streamText 的 tools 参数使用。
   *
   * 刻意不生成 execute：MCP 工具要走 processToolCalls 的手动执行分支，
   * 非只读工具才能过权限闸门（AI SDK 的自动执行会绕开这层检查），
   * 进度回报和 isError 处理也和 writeFile/shell 保持一致。
   */
  toToolSet(): ToolSet {
    const set: Record<string, { description: string; inputSchema: ReturnType<typeof jsonSchema> }> = {}
    for (const tool of this.tools.values()) {
      set[tool.name] = {
        description: tool.description,
        // 本地 ToolInputSchema 带 unknown 索引签名，直接赋给 JSONSchema7 会因
        // 可选属性不兼容报错，这里收窄一次；运行时就是透传同一个对象。
        inputSchema: jsonSchema(tool.inputSchema as Parameters<typeof jsonSchema>[0]),
      }
    }
    return set as ToolSet
  }
}