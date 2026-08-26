import type { LanguageModel } from 'ai'

import type { z } from 'zod'
import type { EditDiffPayload } from '../agent/diff.js'
import type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
import type { SubAgentDefinition, SubAgentEvent, SubAgentTrace } from '../agent/sub-agents/types.js'

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
