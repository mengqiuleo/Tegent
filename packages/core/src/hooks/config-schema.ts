// 无论 `HookConfig` 来自磁盘上的 hooks.json，还是来自插件 manifest 中的内联对象，
// 都使用同一套 schema 校验。这样可以保证两条加载路径的失败模式一致，插件作者不会
// 因为配置写法不同而看到两套不同的错误。
//
// `matcher` 里的错误正则不会被视为 schema 错误。要求作者在 zod 严格模式下编写并
// 测试正则会过于繁琐；总线会在 emit 时捕获 RegExp 构造错误，并降级为“匹配所有工具”，
// 同时写入日志供排查。
import { z } from 'zod'

import type { HookConfig } from './types.js'

const hookEntrySchema = z.object({
  matcher: z.string().optional(), // matcher 只对 PreToolUse / PostToolUse 有意义，用来匹配工具名。
  command: z.string().min(1),
  // 平台专用命令覆盖项。它们都是可选的；当前平台没有对应覆盖项时会回退到 `command`。
  // 这里不要求至少填写一个覆盖项，因为基础 `command` 本身始终是必填的。
  commandWindows: z.string().min(1).optional(), // 平台专用命令覆盖项。
  commandDarwin: z.string().min(1).optional(),
  commandLinux: z.string().min(1).optional(),
  timeout: z.number().int().positive().max(30_000).optional(), // timeout 最大 30 秒。
  description: z.string().optional(),
  failurePolicy: z.enum(['allow', 'block']).optional(), // failurePolicy 默认宽松，hook 崩了也 allow；设置成 block 才会失败时阻止。
})


/**
 * hook 事件：
SessionStart：
UserPromptSubmit
PreToolUse
PostToolUse
PreCompact
PostCompact
SubagentStart
SubagentStop
TurnComplete
SessionEnd
 */

export const hookConfigSchema = z
  .object({
    SessionStart: z.array(hookEntrySchema).optional(),
    UserPromptSubmit: z.array(hookEntrySchema).optional(),
    PreToolUse: z.array(hookEntrySchema).optional(),
    PostToolUse: z.array(hookEntrySchema).optional(),
    PreCompact: z.array(hookEntrySchema).optional(),
    PostCompact: z.array(hookEntrySchema).optional(),
    SubagentStart: z.array(hookEntrySchema).optional(),
    SubagentStop: z.array(hookEntrySchema).optional(),
    TurnComplete: z.array(hookEntrySchema).optional(),
    SessionEnd: z.array(hookEntrySchema).optional(),
  })
  // 允许未知 key，以便未来新增事件名时旧版本仍能读取配置。
  .passthrough()

export class HookConfigParseError extends Error {
  /**
   * 构造 hook 配置解析错误。
   *
   * @param message 已整理好的校验失败信息。
   * @param sourceLabel 配置来源标签，例如 manifest 路径或 hooks.json 路径。
   */
  constructor(
    message: string,
    public readonly sourceLabel: string,
  ) {
    super(message)
    this.name = 'HookConfigParseError'
  }
}

/**
 * 校验已经解析成对象的 hook 配置。
 *
 * 该函数同时服务于 manifest 内联配置，以及 hooks.json 经过 JSON.parse 后得到的对象。
 * 传入的来源标签会保存在错误对象中，便于上层把问题定位回具体文件或插件。
 *
 * @param raw 待校验的未知对象。
 * @param sourceLabel 配置来源标签。
 * @returns 只包含当前版本已知事件名的 HookConfig。
 * @throws HookConfigParseError 当配置结构不符合 schema 时抛出。
 */
export function parseHookConfig(raw: unknown, sourceLabel: string): HookConfig {
  const result = hookConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new HookConfigParseError(`invalid hooks config — ${issues}`, sourceLabel)
  }
  // 在类型边界剥离未来版本的未知 key。passthrough 会把它们保留在运行时对象上，
  // 但当前 HookConfig 类型只认识下面这十个事件。
  const known: HookConfig = {}
  for (const k of [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SubagentStart',
    'SubagentStop',
    'TurnComplete',
    'SessionEnd',
  ] as const) {
    const arr = (result.data as Record<string, unknown>)[k]
    if (Array.isArray(arr)) known[k] = arr as HookConfig[typeof k]
  }
  return known
}
