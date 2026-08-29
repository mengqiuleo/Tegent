// ChatInput 的公开和内部数据类型。

/** slash 补全菜单中的一行。顶层命令行和子命令行都用这个结构渲染：
 *  展示列使用 `name`/`description`，但接受补全时使用 `applyText`，
 *  这样子命令行（`{ name: 'list', applyText: '/mcp list' }`）能正确替换整个输入。 */
export interface MenuItem {
  name: string
  description: string
  applyText: string
  /** 菜单里显示在 `name` 后面的暗色后缀（例如 `/thinking` 的 `[on|off]`）。
   *  只在第一阶段菜单行里填充；子命令行不带这个字段，因为描述列已经说明了参数形状。 */
  argumentHint?: string
}

export interface SlashCommand {
  name: string
  description: string
  /** slash 菜单里显示在命令名后面的灰色占位提示。
   *  例如 `argumentHint: '[on|off]'` 会让菜单行显示为
   *  `/thinking [on|off]  Toggle extended thinking ...`。用于接受参数、
   *  但没有固定可枚举子命令的命令（例如 `/model <model-id>`、`/review [PR]`）。 */
  argumentHint?: string
  /** 固定且可枚举的子命令。存在时，输入 `/cmd `（带结尾空格）或
   *  `/cmd <prefix>` 会基于 `subcommands` 显示第二阶段模糊匹配菜单，
   *  UI 和顶层命令菜单一致。这个字段留给第二个 token 较多、容易忘记的命令使用
   *  （`/mcp` 有 8 个）。 */
  subcommands?: ReadonlyArray<{ name: string; description: string }>
}

export interface SpinnerState {
  label: string
  mode: 'requesting' | 'responding' | 'thinking' | 'tool-use'
}

export interface PermissionRequest {
  toolName: string
  input: Record<string, unknown>
  onResolve: (decision: 'yes' | 'always' | 'no') => void
  /** 当工具解析到 MCP 注册表条目时由 use-agent 设置。
   *  用于驱动对话框里的 MCP 风格标题、预览和 always-allow 标签。
   *  内置工具（shell/edit/writeFile/...）没有这个字段。 */
  mcp?: { serverName: string; rawName: string }
}

export interface SelectRequest {
  question: string
  /** `freeform: true` 标记自动追加的 "Other" 行；选中后会打开内联文本输入，
   *  而不是把字面 label 作为结果返回。这个设计对应 Claude Code 的
   *  `__other__` 哨兵值；这里保留为 flag，让 resolver 能直接返回用户输入的文本，
   *  不需要经过哨兵值来回转换。
   *
   *  `preview` 携带预渲染的 ANSI 行；当该选项获得焦点时，对话框会把它们画在
   *  选项列表下方。`/syntax` picker 用它在用户方向键切换主题时展示实时颜色样例。
   *  每一行都应该已经是完整的 ANSI 样式字符串；对话框只会把它包装成类似
   *  `RawAnsi` 的单元格行，不再做额外处理。 */
  options: { label: string; description: string; freeform?: boolean; preview?: string[] }[]
  onResolve: (answer: string) => void
  /** 用户主动打开的 picker（如 `/syntax`、`/model`）会设为 true：
   *  Esc 会关闭对话框并返回空答案。AI 发起的对话框（askUser 工具、计划批准）
   *  保持 falsy：Esc 会被吞掉，避免模型静默收到一个空答案。 */
  dismissible?: boolean
  /** 控制带 description 的选项如何渲染：
   *  - `compact`（默认）：label 和 description 在同一行，
   *    通过右侧 padding 对齐成两列。适合短 label。
   *  - `compact-vertical`：description 在 label 下方单独缩进一行。
   *    适合较长描述（askUser）。 */
  layout?: 'compact' | 'compact-vertical'
}
