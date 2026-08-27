// “command” 是一个 markdown 文件：它可以由插件随包提供，也可以由用户放在
// `~/.tegent/commands/`，或由项目放在 `<repo>/.tegent/commands/`。
// CLI 启动时会把这些文件注册成 slash command。真实 Claude Code 插件通常把它们
// 放在 plugin.json 旁边的 `commands/<name>.md`，例如 `code-review` 插件里的
// `commands/code-review.md` 会注册成 `/code-review`。
//
// 文件格式对齐已验证过的 Claude Code command 约定：
//
//     ---
//     description: Code review a pull request
//     allowed-tools: Bash(gh pr view:*)      # 当前实现会解析但暂不执行限制语义
//     ---
//
//     <body：提交给模型执行的 prompt 模板>
//
// 正文发送给模型前会应用这些替换：
//   $ARGUMENTS              用户在命令名后输入的文本
//   ${ARGUMENTS}            同上，只是花括号形式
//   ${CLAUDE_PLUGIN_ROOT}   插件根目录绝对路径，方便正文引用随包脚本
//   ${CLAUDE_PLUGIN_DATA}   插件专属持久数据目录，方便正文保存跨版本状态

/**
 * 一个文件型 slash command 的完整运行时定义。
 *
 * 该结构是 loader 解析 markdown 后交给 CommandRegistry 的最小数据模型。
 */
export interface CommandDefinition {
  /**
   * 不带前导 `/` 的命令调用名。
   *
   * 它由文件名推导而来，例如 `code-review.md` 会变成 `code-review`。
   */
  name: string
  /**
   * frontmatter 的 `description` 字段提供的一行摘要。
   *
   * `/help` 和 `/plugin info` 会用它给命令打标签。没有 frontmatter
   * 或没有 description 的命令仍然合法，所以这里是可选字段。
   */
  description?: string
  /**
   * prompt 模板正文。
   *
   * 它来自 frontmatter 后面的全部内容，并在加载时 trim；真正执行前还会由
   * expandCommandBody 替换 `$ARGUMENTS` 等占位符。
   */
  body: string
  /**
   * 命令来源。
   *
   * `'user'` 表示 `~/.tegent/commands/*.md`，`'project'` 表示
   * `<repo-root>/.tegent/commands/*.md`，`'plugin'` 表示插件贡献的
   * `commands/*.md`。这个字段与 SkillDefinition / SubAgentDefinition 的来源模型对齐。
   */
  source: 'user' | 'project' | 'plugin'
  /**
   * 插件来源命令所属插件的 id。
   *
   * 仅当 source === 'plugin' 时存在，格式通常是 `name@marketplace`。
   * `/plugin info` 会展示它，expandCommandBody 也会用它定位插件数据目录。
   */
  pluginId?: string
  /**
   * 插件根目录的绝对路径。
   *
   * 执行 command 前会把它替换进正文里的 `${CLAUDE_PLUGIN_ROOT}`，
   * 让 command 模板可以可靠引用插件随包脚本或资源。
   */
  pluginRoot?: string
}
