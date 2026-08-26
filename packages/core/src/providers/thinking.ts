// 不同模型厂商对“回答前多花一些 token 做推理”的能力命名完全不同，
// 默认值也不一致：Gemini 2.5 Pro 和 Kimi K2.5 默认开启；Claude Sonnet、
// DeepSeek V4、Qwen Max 和大多数模型默认关闭；GPT-4.1、Grok-3、
// GLM-4-Plus 这些具体模型 ID 上则没有可用的 thinking 概念。
// 用户看到的 `/thinking on|off` 需要是一颗统一开关，所以这里负责把它
// 翻译成各家 AI SDK 最接近的 providerOptions。
//
// `/thinking` 到各 provider 参数的大致映射如下：
//
//   anthropic   thinking: { type: 'enabled' | 'disabled', budgetTokens }
//   deepseek    thinking: { type: 'enabled' | 'disabled' }
//   moonshotai  thinking: { type: 'enabled' | 'disabled' }
//   alibaba     enableThinking: boolean
//   google      thinkingConfig: { thinkingBudget: -1（动态）| 0（关闭）}
//   xai         reasoningEffort: 'high' | 'low'       （仅 grok-3-mini）
//   openai      reasoningEffort: 'high' | 'minimal'   （仅 o 系列）
//   zhipu       不能按单次请求设置；需要在创建模型时配置 chat-setting。
//               当前默认 GLM-4-Plus 没有 thinking；GLM-4.5+ 以后若要支持，
//               需要在模型创建阶段接线。因此这里先跳过。
//
// Anthropic 的预算给得比较宽，但不是无限：8000 个 reasoning token 足以覆盖
// 除超长 agent loop 之外的大多数场景，同时也远低于 1M 上下文窗口。使用 Opus
// 且确实需要更大预算的用户可以改这里后重新 build；为了一个大多数人只会
// 开/关的功能再暴露 `/thinking budget` 参数，复杂度不太划算。
import { providerOf } from './capabilities.js'

const ANTHROPIC_BUDGET_TOKENS = 8000

/**
 * 根据模型 ID 和用户选择的开关状态，生成对应 provider 需要的 `providerOptions`。
 * 如果这个模型或 provider 没有可设置的 thinking 参数，就返回空对象。
 * 这样调用方可以直接 spread 或 merge，不需要在外层写一堆 provider 判断。
 *
 * `enabled` 的含义：
 *   true  - 尽量启用该 provider 支持的较强推理模式
 *   false - 尽量关闭；如果 provider 本身默认 thinking-on 且有强制最低预算，
 *           就把它压到 SDK 接受的最低值。例如 Gemini 2.5 Pro 最低不能低于
 *           128 token，我们仍然发送 SDK 允许的“关闭 / 最低”配置。
 */
export function getThinkingProviderOptions(modelId: string, enabled: boolean): Record<string, Record<string, unknown>> {
  const provider = providerOf(modelId)
  switch (provider) {
    case 'anthropic':
      return enabled
        ? { anthropic: { thinking: { type: 'enabled', budgetTokens: ANTHROPIC_BUDGET_TOKENS } } }
        : { anthropic: { thinking: { type: 'disabled' } } }

    case 'deepseek':
      // DeepSeek V4 系列支持这个开关；旧的 `deepseek-chat` /
      // `deepseek-reasoner` 对不认识的 providerOptions 会静默忽略。
      return enabled
        ? { deepseek: { thinking: { type: 'enabled' } } }
        : { deepseek: { thinking: { type: 'disabled' } } }

    case 'moonshotai':
      // kimi-k2.5 默认就是 thinking 模型；显式传 `disabled` 可以让
      // Moonshot 在服务端关闭推理。
      return enabled
        ? { moonshotai: { thinking: { type: 'enabled' } } }
        : { moonshotai: { thinking: { type: 'disabled' } } }

    case 'alibaba':
      // Hybrid Qwen 模型支持按请求设置 `enableThinking`；专用推理模型
      // （例如 qwq-plus、qwen3-*-thinking-*）会忽略 `enableThinking: false`，
      // 继续保持 thinking 开启。
      return { alibaba: { enableThinking: enabled } }

    case 'google':
      // Gemini 2.5 Pro 不能完全关闭 thinking（最低预算 128），但 OFF 时我们
      // 仍发送 `thinkingBudget: 0`，让 SDK 或服务端自行钳制到最低值。
      // 2.5 Flash 和 Lite 会把 0 理解成“不思考”。`-1` 是 SDK 约定的
      // “动态预算，由模型自行决定”，也就是 Pro 默认使用的模式；ON 时统一用它。
      return enabled
        ? { google: { thinkingConfig: { thinkingBudget: -1 } } }
        : { google: { thinkingConfig: { thinkingBudget: 0 } } }

    case 'xai':
      // 只有 grok-3-mini 和 grok-4-mini 会识别 `reasoningEffort`；grok-3
      // 和 grok-4 会忽略。给不支持的模型发送这个参数是安全的：SDK 会透传，
      // API 会静默丢弃。
      return enabled ? { xai: { reasoningEffort: 'high' } } : { xai: { reasoningEffort: 'low' } }

    case 'openai':
      // 只有 o 系列和 gpt-5 reasoning 模型会使用 `reasoningEffort`；
      // gpt-4.1 会忽略。和 xAI 一样，传给不支持的模型也只是安全透传。
      return enabled ? { openai: { reasoningEffort: 'high' } } : { openai: { reasoningEffort: 'minimal' } }

    case 'zhipu':
    case 'custom':
    default:
      return {}
  }
}

/** 把 thinking 相关的 providerOptions 合并进已有 providerOptions。
 *  这里不能覆盖无关配置，例如 Anthropic 的 cache-control。
 *  每个 provider 下面只做一层深合并：这样 `x.thinking` 和
 *  `x.cacheControl` 可以同时存在于 `providerOptions.anthropic`。 */
export function mergeThinkingOptions(
  base: Record<string, unknown> | undefined,
  thinking: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(base ?? {}) }
  for (const [provider, entry] of Object.entries(thinking)) {
    const existing = (merged[provider] as Record<string, unknown> | undefined) ?? {}
    merged[provider] = { ...existing, ...entry }
  }
  return merged
}
