export { agentLoop, saveSession } from './agent/loop.js'
export type { LoopState } from './agent/loop.js'

// Provider Registry
export { createModelRegistry } from './providers/registry.js'

// Config
export { getAvailableProviders, getEnvVarName, resolveModelId } from './config/index.js'

// type
export { PROVIDER_DETECTION_ORDER, PROVIDER_KEY_URLS } from './types/index.js'
export type { AgentOptions, PermissionMode, TodoItem } from './types/index.js'
export type { LanguageModelLike as LanguageModel } from './types/index.js'

// Permissions
export { checkPermission, getPermissionLevel } from './permissions/index.js'
export { addSessionAllowRule, clearSessionRules, buildAllowRule } from './permissions/index.js'
export {
  extractCommandPrefix,
  extractCompoundPrefixes,
  extractCompoundRules,
  suggestRuleLabel,
} from './permissions/index.js'
export { loadPersistedRules, persistRule } from './permissions/index.js'
export type { AllowRule } from './permissions/session-store.js'