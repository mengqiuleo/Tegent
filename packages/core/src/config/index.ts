import fsSync from 'node:fs'
import path from 'node:path'

import { MODEL_ALIASES, PROVIDER_DETECTION_ORDER } from '../types/index.js'
import type { BuiltInProviderName, ModelId, ProviderName } from '../types/index.js'

export const ENV_MAP: Record<BuiltInProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  alibaba: 'ALIBABA_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
}

export interface UserConfig {
  model?: string
}

function userTeCodeDir(): string {
  return path.join(process.cwd(), '.tegent')
}

export function getUserConfigPath(): string {
  return path.join(userTeCodeDir(), 'config.json')
}

export function getApiKey(provider: string): string | undefined {
  const envKey = ENV_MAP[provider as BuiltInProviderName]
  return envKey ? process.env[envKey] : undefined
}

export function getEnvVarName(provider: string): string | undefined {
  return ENV_MAP[provider as BuiltInProviderName]
}

export function getAvailableProviders(): ProviderName[] {
  const providers: ProviderName[] = (Object.keys(ENV_MAP) as BuiltInProviderName[]).filter((p) => getApiKey(p))
  if (process.env.OPENAI_COMPATIBLE_API_KEY && process.env.OPENAI_COMPATIBLE_BASE_URL) {
    providers.push('custom')
  }
  return providers
}

export function loadUserConfig(): UserConfig {
  try {
    const raw = fsSync.readFileSync(getUserConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as UserConfig
    }
  } catch {

  }
  return {}
}

export function saveUserConfig(update: Partial<UserConfig>): void {
  const merged: UserConfig = { ...loadUserConfig(), ...update }
  try {
    fsSync.mkdirSync(userTeCodeDir(), { recursive: true })
    fsSync.writeFileSync(getUserConfigPath(), JSON.stringify(merged, null, 2) + '\n', 'utf-8')
  } catch {

  }
}

export function resolveModelId(input?: string): ModelId | null {
  const explicit = input ?? loadUserConfig().model
  if (explicit) return (MODEL_ALIASES[explicit] ?? explicit) as ModelId

  for (const { envKey, defaultModel } of PROVIDER_DETECTION_ORDER) {
    if (process.env[envKey]) return defaultModel
  }

  return null
}

export function providerOfModel(modelId: string): string {
  const idx = modelId.indexOf(':')
  return idx > 0 ? modelId.slice(0, idx) : 'unknown'
}

export function isProviderAvailableForModel(modelId: string): boolean {
  return getAvailableProviders().includes(providerOfModel(modelId) as ProviderName)
}

export function getProviderOptions() {
  return {
    anthropic: getApiKey('anthropic'),
    openai: getApiKey('openai'),
    google: getApiKey('google'),
    xai: getApiKey('xai'),
    deepseek: getApiKey('deepseek'),
    alibaba: getApiKey('alibaba'),
    zhipu: getApiKey('zhipu'),
    moonshotai: getApiKey('moonshotai'),
    custom: {
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
      baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL,
    },
  }
}
