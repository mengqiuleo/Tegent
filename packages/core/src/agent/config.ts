import fsSync from 'node:fs'
import path from 'node:path'

import { MODEL_ALIASES, PROVIDER_DETECTION_ORDER } from './types.js'
import type { BuiltInProviderName, ModelId, ProviderName } from './types.js'

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

function userXcodeDir(): string {
  return process.env.X_CODE_HOME ?? path.join(process.env.HOME ?? process.cwd(), '.x-code')
}

export function getUserConfigPath(): string {
  return path.join(userXcodeDir(), 'config.json')
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
    // Missing or malformed config is treated as "no persisted preference".
  }
  return {}
}

export function saveUserConfig(update: Partial<UserConfig>): void {
  const merged: UserConfig = { ...loadUserConfig(), ...update }
  try {
    fsSync.mkdirSync(userXcodeDir(), { recursive: true })
    fsSync.writeFileSync(getUserConfigPath(), JSON.stringify(merged, null, 2) + '\n', 'utf-8')
  } catch {
    // Best effort only: a read-only home directory should not crash the CLI.
  }
}

export function resolveModelId(input?: string): ModelId | null {
  const explicit = input ?? loadUserConfig().model ?? process.env.X_CODE_MODEL
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
