export { agentLoop, saveSession } from './agent/loop.js'
export type { LoopState } from './agent/loop.js'

// Provider Registry
export { createModelRegistry } from './providers/registry.js'

// Config
export { getAvailableProviders, getEnvVarName, getMcpConfigPath, loadMcpServers, resolveModelId } from './config/index.js'

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


// MCP
export { ToolRegistry } from './types/index.js'
export { registerMcpServers, closeMcpServers } from './mcp/index.js'
export type { McpServerConfig, ConnectedMcpServer } from './mcp/client.js'
export type { Tool as McpTool, ToolResult as McpToolResult } from './mcp/type.js'

// Skills
export {
  SkillRegistry,
  createSkillRegistry,
  reloadSkillRegistry,
  formatSkillActivationBody,
  wrapActivatedSkill,
} from './skills/registry.js'
export type { SkillDefinition, SkillEntry, SkillReloadSummary } from './skills/registry.js'
export { getScopedDisabledSkills, setSkillDisabled, skillSettingsPath } from './skills/settings.js'
export type { SkillSettingsScope } from './skills/settings.js'

// Plugins
export { PluginRegistry, createPluginRegistry, reloadPluginRegistry } from './plugins/registry.js'
export type { PluginDefinition, PluginEntry, PluginManifest, PluginReloadSummary, PluginSource } from './plugins/types.js'
export { loadPlugins } from './plugins/loader.js'
export type { LoadPluginsOptions } from './plugins/loader.js'
export {
  formatPluginId,
  isValidPluginName,
  parsePluginId,
  pluginCacheDir,
  pluginManifestPath,
  projectPluginsDir,
} from './plugins/utils.js'
export { pluginSkillDirs } from './plugins/integration.js'
export {
  getScopedDisabledPlugins,
  loadDisabledPluginsSet,
  pluginSettingsPath,
  setPluginDisabled,
} from './plugins/settings.js'
export type { PluginSettingsScope } from './plugins/settings.js'