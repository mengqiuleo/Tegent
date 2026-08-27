// CLI 启动时会基于用户、项目和插件贡献的 command 文件构建这个注册表。
// 当 App.tsx 的默认 slash 分发器遇到 `/<name>`，且它既不是内置命令也不是
// skill 命令时，就会到这里查询文件型 command。它和 SkillRegistry 一样，
// 默认采用“启动时冻结”的模型，避免在会话中偷偷改变可见命令集合。
import fs from 'node:fs'

import { pluginDataDir } from '../plugins/paths.js'
import { type LoadCommandsOptions, loadPluginCommands } from './loader.js'
import type { CommandDefinition } from './types.js'

/**
 * 注册表热重载后的差异摘要。
 *
 * `/plugin refresh` 会用它生成面向用户的刷新结果提示。
 */
export interface CommandReloadSummary {
  /** 本次刷新后新出现的命令名。 */
  added: string[]
  /** 本次刷新后消失的命令名。 */
  removed: string[]
  /** 名称仍存在但正文或插件上下文发生变化的命令名。 */
  changed: string[]
  /** 名称、正文和插件上下文都没有变化的命令名。 */
  unchanged: string[]
}

/**
 * 内存中的文件型 slash command 注册表。
 *
 * 注册表只按命令名索引 CommandDefinition。构造和 reload 都遵循“后写覆盖”，
 * 因此加载器只需要控制数组顺序，就能表达 project > plugin > user 的优先级。
 */
export class CommandRegistry {
  private byName: Map<string, CommandDefinition>

  /**
   * 创建注册表并写入初始命令集合。
   *
   * @param commands - 按优先级从低到高排列的命令列表；同名项以后面的定义为准。
   */
  constructor(commands: ReadonlyArray<CommandDefinition> = []) {
    this.byName = new Map()
    // 同名冲突时后写覆盖，与 SkillRegistry 合并 user → plugin → project 的方式一致。
    for (const c of commands) this.byName.set(c.name, c)
  }

  /**
   * 按名称查找命令。
   *
   * @param name - 不带前导 `/` 的 command 名称。
   * @returns 找到时返回命令定义，否则返回 undefined。
   */
  get(name: string): CommandDefinition | undefined {
    return this.byName.get(name)
  }

  /**
   * 返回当前所有可用命令定义。
   *
   * @returns 按 Map 插入顺序排列的 CommandDefinition 快照。
   */
  list(): CommandDefinition[] {
    return [...this.byName.values()]
  }

  /**
   * 返回当前所有可用命令名。
   *
   * @returns 不带前导 `/` 的命令名列表。
   */
  names(): string[] {
    return [...this.byName.keys()]
  }

  /**
   * 用新加载的命令集合替换注册表内容。
   *
   * 这个方法服务于 `/plugin refresh`。它会保持 CommandRegistry 对象引用不变，
   * 只替换内部 Map，因此 App.tsx、agent options 或其他闭包里捕获的
   * `options.commandRegistry` 引用仍然有效。
   *
   * @param commands - 新加载出的完整命令列表。
   * @returns 新旧注册表之间的 added / removed / changed / unchanged 摘要。
   */
  reload(commands: ReadonlyArray<CommandDefinition>): CommandReloadSummary {
    const previous = this.byName
    const next = new Map<string, CommandDefinition>()
    // 构造下一版 Map 时继续保留后写覆盖语义。
    for (const c of commands) next.set(c.name, c)
    const summary: CommandReloadSummary = { added: [], removed: [], changed: [], unchanged: [] }
    for (const [name, cmd] of next) {
      const prev = previous.get(name)
      // 只比较会影响执行或插件上下文的字段；description 只影响展示，不改变执行语义。
      if (!prev) summary.added.push(name)
      else if (prev.body !== cmd.body || prev.pluginId !== cmd.pluginId || prev.pluginRoot !== cmd.pluginRoot)
        summary.changed.push(name)
      else summary.unchanged.push(name)
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) summary.removed.push(name)
    }
    this.byName = next
    return summary
  }
}

/**
 * 从磁盘加载 command 文件并创建注册表。
 *
 * @param opts - 可选的插件 command 目录集合。
 * @returns 已填充的 CommandRegistry 实例。
 */
export async function createCommandRegistry(opts: LoadCommandsOptions = {}): Promise<CommandRegistry> {
  const commands = await loadPluginCommands(opts)
  return new CommandRegistry(commands)
}

/**
 * 重新扫描 command 目录，并在原注册表对象上完成热替换。
 *
 * 调用方负责传入最新的插件 extraDirs；通常来自 refresh 后重新计算的
 * pluginIntegration.commandsDirs。
 *
 * @param registry - 需要原地更新的注册表。
 * @param opts - 最新的插件 command 目录集合。
 * @returns 注册表刷新前后的差异摘要。
 */
export async function reloadCommandRegistry(
  registry: CommandRegistry,
  opts: LoadCommandsOptions = {},
): Promise<CommandReloadSummary> {
  const commands = await loadPluginCommands(opts)
  return registry.reload(commands)
}

/**
 * 在 command 正文提交给模型前，应用 Claude Code 风格的占位符替换。
 *
 * 支持的占位符对齐真实 Claude Code 插件 command 文件
 * `anthropics/claude-code/plugins/<plugin>/commands/<cmd>.md`：
 *
 * `$ARGUMENTS` / `${ARGUMENTS}`：用户在命令名后输入的文本，例如
 * `/code-review 123` 中的 `123`；没有参数时为空字符串。
 *
 * `${CLAUDE_PLUGIN_ROOT}`：拥有该 command 的插件安装目录绝对路径。该目录带版本号，
 * 插件重新安装时可能被清理，因此适合引用插件随包脚本，不适合作持久化数据目录。
 *
 * `${CLAUDE_PLUGIN_DATA}`：插件专属持久数据目录，位于
 * `~/.x-code/plugins/data/<id>/`。首次替换时会自动创建，重装和升级插件后仍保留。
 * 如果命令没有插件上下文，则保持为空字符串。
 *
 * @param cmd - 要展开的命令定义。
 * @param args - 用户输入中命令名后面的原始参数文本。
 * @returns 已替换占位符、可以直接作为用户 prompt 提交给 agent 的正文。
 */
export function expandCommandBody(cmd: CommandDefinition, args: string): string {
  const root = cmd.pluginRoot ?? ''
  let dataDir = ''
  if (cmd.pluginId && cmd.body.includes('${CLAUDE_PLUGIN_DATA}')) {
    dataDir = pluginDataDir(cmd.pluginId)
    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch {
      // mkdir 失败时仍保留 dataDir 字符串；如果后续命令脚本真的写入该目录，
      // 用户会从 shell 错误里看到更具体的失败原因。
    }
  }
  // 替换顺序刻意把带花括号的形式和裸 `$ARGUMENTS` 都覆盖，兼容不同 command 文件写法。
  return cmd.body
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
    .replaceAll('${CLAUDE_PLUGIN_DATA}', dataDir)
    .replaceAll('${ARGUMENTS}', args)
    .replaceAll('$ARGUMENTS', args)
}
