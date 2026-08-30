// API 密钥始终来自环境变量
//
// 默认**模型**可来自四个来源，按优先级排序：
//   2. `~/.tegent/config.json` 的 `model` 字段 —— 由 `/model` 选择器写入
//   3. .env 环境变量
//   4. 智能默认值：按 PROVIDER_DETECTION_ORDER 顺序第一个持有密钥的提供商

import fsSync from 'node:fs'
import path from 'node:path'

import { MODEL_ALIASES, PROVIDER_DETECTION_ORDER } from '../types/index.js'
import { userTeCodeDir } from '../utils.js'

/** 提供商 → 环境变量映射 */
const ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  alibaba: 'ALIBABA_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
}

/** 获取某提供商的 API 密钥 —— 仅从环境变量读取 */
function getApiKey(provider: string): string | undefined {
  const envKey = ENV_MAP[provider]
  return envKey ? process.env[envKey] : undefined
}

/** 获取某提供商对应的环境变量名 */
export function getEnvVarName(provider: string): string | undefined {
  return ENV_MAP[provider]
}

/** 检查哪些提供商已配置 API 密钥（仅检查环境变量） */
export function getAvailableProviders(): string[] {
  const providers = Object.keys(ENV_MAP).filter((p) => getApiKey(p))
  if (process.env.OPENAI_COMPATIBLE_API_KEY && process.env.OPENAI_COMPATIBLE_BASE_URL) {
    providers.push('custom')
  }
  return providers
}

/**
 * 按四级优先级解析模型 ID：
 *   2. `~/.tegent/config.json` 的 `model` 字段（由 /model 选择器写入）
 *   3. .env 环境变量
 *   4. 智能默认值：按 PROVIDER_DETECTION_ORDER 顺序第一个持有 API 密钥的提供商
 *
 * MODEL_ALIASES 中的别名（如 "sonnet" → "anthropic:claude-sonnet-4-5"）
 * 在所有层级都会被展开。若未配置任何提供商则返回 null。
 */
export function resolveModelId(input?: string): string | null {
  const explicit = input ?? loadUserConfig().model
  if (explicit) {
    return MODEL_ALIASES[explicit] ?? explicit
  }

  for (const { envKey, defaultModel } of PROVIDER_DETECTION_ORDER) {
    if (process.env[envKey]) return defaultModel
  }

  return null
}

// ── 用户配置文件（~/.tegent/config.json）─────────────────────────────
//
// 持久化偏好：
//   model    —— /model 选择器最近一次提交的模型 ID
//   thinking —— 由 /thinking 写入的扩展思考 / 推理开关。
//               在所有提供思考开关的提供商上统一生效（见
//               providers/thinking.ts）。默认为 undefined（视为关闭），
//               这样无感知的启动就不会默默承受默认关闭思考的提供商
//               （Sonnet、DeepSeek、Qwen）2-10 倍的延迟——与该功能
//               出现之前的行为保持一致。
//
// API 密钥有意不存储在此处（仅存环境变量，见文件头注释）。

export interface UserConfig {
  model?: string
  thinking?: boolean
  /** MCP 服务器声明。这里采用宽松类型，因为 schema 会在
   *  `mcp/config-schema.ts` 中校验——我们不希望把 Zod 类型
   *  拖进 config 模块的对外接口。加载器会先用
   *  `parseServersBlock` 校验，再构建客户端。 */
  mcpServers?: Record<string, unknown>
}

/** 
 * @returns `~/.tegent/config.json`
 */
export function getUserConfigPath(): string {
  return userConfigPath()
}

/** 用户配置文件路径（默认 `~/.tegent/config.json`） */
function userConfigPath(): string {
  return path.join(userTeCodeDir(), 'config.json')
}

/** 读取用户配置。任何失败（文件缺失、解析出错、结构不对）都返回
 *  空对象，调用方无需判空。 
 *  返回的是 `~/.tegent/config.json` 的内容，若该文件不存在或无法读取，则返回空对象。
 * */
export function loadUserConfig(): UserConfig {
  try {
    const raw = fsSync.readFileSync(userConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as UserConfig
    }
  } catch {
  }
  return {}
}

/** 向用户配置写入部分更新，保留其余键。 */
export function saveUserConfig(update: Partial<UserConfig>): void {
  const merged: UserConfig = { ...loadUserConfig(), ...update }
  try {
    fsSync.mkdirSync(userTeCodeDir(), { recursive: true })
    fsSync.writeFileSync(userConfigPath(), JSON.stringify(merged, null, 2) + '\n', 'utf-8')
  } catch {
  }
}

/** 使用来自环境变量的 API 密钥构建提供商选项 */
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
