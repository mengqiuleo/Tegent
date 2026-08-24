import type { LanguageModel } from 'ai'

import type { z } from 'zod'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

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
  onTextDelta: (text: string) => void
  onToolCall: (toolCallId: string, toolName: string, input: Record<string, unknown>) => void
  onToolProgress: (toolCallId: string, message: string) => void
  onToolResult: (toolCallId: string, result: string, isError?: boolean) => void
  onAskUser: (question: string, options?: Array<{ label: string; description: string }>) => Promise<string>
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }) => Promise<'yes' | 'always' | 'no'>
  onShellOutput: (chunk: string) => void
  onUsageUpdate: (usage: TokenUsage) => void
  onContextCompressed: (summary: string) => void
  onCompressionProgress?: (description: string) => void
  onError: (error: Error) => void
  onMemoryWrite?: (notice: string) => void
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
}

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
