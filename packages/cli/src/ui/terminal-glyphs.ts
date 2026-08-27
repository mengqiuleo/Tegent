// 旧版 ConHost（Windows Terminal 之外的 cmd.exe / Windows PowerShell 宿主）
// 默认使用的字体（Lucida Console、Consolas、SimSun、NSimSun、MS Gothic）
// 缺少许多 CP437 / Latin-1 Supplement 范围之外的 Unicode 字符。
// 像 ●、❯、⎿、✢、✶、⏸、⚡、✓、◼、•、▎ 这样的字符，要么会渲染成
// 缺字方框（□），要么宽度不正确，产生用户描述为“丑”/“坏掉了”的视觉瑕疵。
//
// 这个模块把 TUI 里所有装饰性 Unicode 字符集中到一个能力检测门之后。
// 每条渲染路径（ChatInput cell buffer、stdout-writer scrollback、
// render-markdown、AppHeader）都从这里导入字符，而不是硬编码字面量。
//
// 检测逻辑沿用 ChatInput.tsx 里已有的 spinner ASCII 降级规则：
// WT_SESSION → Windows Terminal（Cascadia Mono，完整 Unicode）；
// TERM_PROGRAM=vscode → VSCode 集成终端；win32 上两者都没有 → 旧版 ConHost。
// 非 Windows 平台始终使用丰富字符。

/** 当终端是旧版 ConHost，且无法可靠渲染 CP437 / Latin-1 Supplement
 *  （U+0000–U+00FF）和 Box Drawing 区块（U+2500–U+257F）之外的
 *  Unicode 字符时为 true。 */
export const IS_LEGACY_TERMINAL =
  process.platform === 'win32' && !process.env.WT_SESSION && process.env.TERM_PROGRAM !== 'vscode'

// ── 字符表 ───────────────────────────────────────────────────────────────
//
// 每一组导出都是：`GLYPH_NAME` = 丰富 Unicode，fallback = ASCII/Latin-1。
// 使用方导入对应名称，并在模块加载时得到正确变体。

/** 工具调用项目符号：`●` (U+25CF) → `*` */
export const GLYPH_BULLET = IS_LEGACY_TERMINAL ? '*' : '●'

/** 用户消息提示箭头：`❯` (U+276F) → `>` */
export const GLYPH_PROMPT_ARROW = IS_LEGACY_TERMINAL ? '>' : '❯'

/** 工具结果 / 子项括号：`⎿` (U+23BF) → `|` */
export const GLYPH_RESULT_BRACKET = IS_LEGACY_TERMINAL ? '|' : '⎿'

/** 权限 / 选择项指针：`❯` (U+276F) → `>` */
export const GLYPH_SELECT_POINTER = IS_LEGACY_TERMINAL ? '>' : '\u276f'

/** 计划模式指示符：`⏸` (U+23F8) → `=` */
export const GLYPH_PLAN_MODE = IS_LEGACY_TERMINAL ? '=' : '\u23f8'

/** 接受编辑指示符：`⚡` (U+26A1) → `*` */
export const GLYPH_ACCEPT_EDITS = IS_LEGACY_TERMINAL ? '*' : '\u26a1'

/** Todo 完成勾选：`✓` (U+2713) → `+` */
export const GLYPH_TODO_CHECK = IS_LEGACY_TERMINAL ? '+' : '\u2713'

/** Todo 进行中实心方块：`◼` (U+25FC) → `#` */
export const GLYPH_TODO_IN_PROGRESS = IS_LEGACY_TERMINAL ? '#' : '\u25fc'

/** Todo 待处理空心方块：`◻` (U+25FB) → `-` */
export const GLYPH_TODO_PENDING = IS_LEGACY_TERMINAL ? '-' : '\u25fb'

/** Todo 面板角括号：`⎿` (U+23BF) → `|`（同 result bracket） */
export const GLYPH_TODO_BRACKET = IS_LEGACY_TERMINAL ? '|' : '\u23bf'

/** 引用块左侧竖条：`▎` (U+258E) → `|` */
export const GLYPH_BLOCKQUOTE_BAR = IS_LEGACY_TERMINAL ? '|' : '\u258e'

/** 无序列表项目符号：`•` (U+2022) → `-` */
export const GLYPH_LIST_BULLET = IS_LEGACY_TERMINAL ? '-' : '\u2022'

/** Header 分隔竖线：`│` (U+2502) → `|` */
export const GLYPH_HEADER_PIPE = IS_LEGACY_TERMINAL ? '|' : '\u2502'

/** 省略号：`…` (U+2026) 存在于 Windows-1252 和所有 ConHost 字体中，
 *  不需要降级。为了保持一致性导出，避免使用方硬编码字面量；
 *  但它在每个平台上的值都一样。 */
export const GLYPH_ELLIPSIS = '\u2026'

// Spinner 帧：ChatInput.tsx 里原本已经有部分降级逻辑，现在集中到这里。
// ConHost 默认字体缺少 U+2722–U+273D（dingbats）。
const SPINNER_BASE_RICH = ['·', '✢', '*', '✶', '✻', '✽']
const SPINNER_BASE_ASCII = ['·', ':', '+', '*', '+', ':']
const BASE = IS_LEGACY_TERMINAL ? SPINNER_BASE_ASCII : SPINNER_BASE_RICH

/** 完整 spinner 帧序列（正向 + 反向，用于呼吸循环）。 */
export const SPINNER_FRAMES = [...BASE, ...[...BASE].reverse()]

// ── Box-drawing 字符（render-markdown 中的表格）───────────────────────────
//
// 轻量 box-drawing 范围 U+2500–U+257F 存在于每种 ConHost 字体
// （Lucida Console、Consolas、SimSun、所有 CJK fallback）中，因为它们是
// CP437，也就是原始 IBM PC 字符集的一部分。AppHeader logo 使用的双线范围
// U+2550–U+256C 也是如此。这些不需要降级。
//
// 水平分隔线字符 `─` (U+2500) 和表格字符 `┌┐└┘├┤┬┴┼│` 都在这个安全范围内。
// 不需要导出它们，因为它们在我们目标覆盖的每种终端里都能正确渲染。
