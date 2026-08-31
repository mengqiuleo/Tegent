import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { suggestRuleLabel } from '@tegent/core'
import type { DisplayMessage, DisplayToolCall, TodoItem } from '@tegent/core'
import type { ActiveToolCall } from '../hooks/use-agent.js'
import { HISTORY_MAX, appendInputHistory, loadInputHistory } from '../input-history.js'
import type { InputHistoryEntry } from '../input-history.js'
import { formatTokenCount, getToolInputPreview, getToolLabel } from '../utils.js'
import { inputReducer } from './chat-input/reducer.js'
import type { PermissionRequest, SelectRequest, SlashCommand, SpinnerState } from './chat-input/types.js'
import { fuzzyMatches, renderMessageLabel, toolPreview, toolStatusColor, truncate } from '../utils/toolkit.js'

/** Ink 动态区最多直接渲染的历史消息数量，避免长会话把输入框挤出屏幕。 */
const MAX_VISIBLE_MESSAGES = 30
/** slash command 菜单最多展示的候选数量，超过后只显示前 N 项。 */
const MAX_VISIBLE_MENU_ITEMS = 8
/** PageUp/PageDown 每次让光标跨越的逻辑行数。 */
const MAX_VERTICAL_CURSOR_JUMP = 10
/** 双击 Esc 清空输入框的最大间隔，单位毫秒。 */
const DOUBLE_ESC_WINDOW_MS = 500

interface ChatInputProps {
  /** CLI scrollback 消息。Ink 版直接渲染最近一段消息，不走原版 stdout 提交路径。 */
  messages: readonly DisplayMessage[]
  /** 兼容原 ChatInput 的 prop；Ink 版不需要根据 header 行数做光标锚定。 */
  initialContentRows?: number
  onSubmit: (text: string) => void
  /** Ctrl+C 入口；App 负责双击退出和当前轮取消。 */
  onInterrupt: () => void
  /** loading 时 Esc 的取消入口。 */
  onEscapeCancel?: () => void
  /** 当前是否有 agent turn 在执行。 */
  isLoading?: boolean
  /** 输入框 footer 的短提示。 */
  notice?: string | null
  /** 禁用普通键盘输入；Ctrl+C 仍由 Ink useInput 兜住。 */
  disabled?: boolean
  /** 完全隐藏输入区域。 */
  hidden?: boolean
  /** spinner 状态；由 App 根据 useAgent.state 派生。 */
  spinner?: SpinnerState | null
  /** 正在运行的工具调用。 */
  activeToolCalls?: readonly ActiveToolCall[]
  /** 模型维护的 todo 列表。 */
  todos?: readonly TodoItem[]
  /** 错误提示。 */
  errorMessage?: string | null
  /** 权限弹窗请求。 */
  permission?: PermissionRequest | null
  /** SelectOptions 弹窗请求。 */
  selectRequest?: SelectRequest | null
  /** slash command 补全候选。 */
  commands?: readonly SlashCommand[]
  /** 当前权限模式，用于 footer 状态提示。 */
  permissionMode?: 'default' | 'acceptEdits' | 'plan'
  /** 当前上下文窗口用量。 */
  contextUsage?: { used: number; window: number } | null
}

interface CommandMatch {
  /** slash command 名称或 subcommand 名称。 */
  name: string
  /** 展示在补全菜单右侧的说明文字。 */
  description: string
  /** 用户接受补全后写回输入框或直接提交的完整文本。 */
  applyText: string
  /** 命令参数提示，例如 `[model-id]`；只有命令本身支持参数时存在。 */
  argumentHint?: string
}

interface FreeformState {
  /** SelectOptions 中 Other 自由输入框的文本。 */
  text: string
  /** SelectOptions 中 Other 自由输入框的光标位置。 */
  cursor: number
}


/**
 * 渲染一条 scrollback 消息。
 *
 * @param props.msg useAgent 已经转换好的 DisplayMessage。
 * @returns Ink 消息块。
 */
function MessageBlock({ msg }: { msg: DisplayMessage }) {
  // label 决定每条消息左侧显示 you/assistant/info/$。
  const label = renderMessageLabel(msg)
  // 用户和命令回显更醒目，用 cyan；其它消息降低视觉权重。
  const labelColor = msg.role === 'user' || msg.kind === 'command-echo' ? 'cyan' : 'gray'
  // 普通文本按行渲染；trimEnd 避免末尾空行额外撑高消息块。
  const lines = msg.content.length > 0 ? msg.content.trimEnd().split('\n') : []

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* 有文本内容时先渲染消息标签和每一行正文。 */}
      {lines.length > 0 ? (
        <Box flexDirection="column">
          <Text color={labelColor}>{label}</Text>
          {lines.map((line, idx) => (
            <Text key={`${msg.id}-line-${idx}`}>{line}</Text>
          ))}
        </Box>
      ) : null}
      {/* 工具结果挂在 assistant 消息上，逐条交给 ToolResult 渲染。 */}
      {msg.toolCalls?.map((tc) => (
        <ToolResult key={tc.id} toolCall={tc} />
      ))}
    </Box>
  )
}

/**
 * 渲染已经完成并进入 scrollback 的工具结果。
 *
 * @param props.toolCall 工具结果展示对象。
 * @returns Ink 工具结果块。
 */
function ToolResult({ toolCall }: { toolCall: DisplayToolCall }) {
  // 将内部工具名转换成更适合 UI 展示的标签，例如 shell -> Bash/Zsh。
  const label = getToolLabel(toolCall.toolName)
  // 从工具 input 中提取短预览，例如文件路径或命令文本。
  const preview = toolPreview(toolCall.toolName, toolCall.input)
  // 根据工具状态决定整条工具标题的颜色。
  const color = toolStatusColor(toolCall.status)
  // 工具输出压成单行摘要；避免长输出把 scrollback 直接撑满。
  const output = toolCall.output ? truncate(toolCall.output.replace(/\s+/g, ' ').trim(), 180) : ''

  return (
    <Box flexDirection="column">
      <Text color={color}>
        {' '}
        {'●'} {label}
        {preview ? `(${preview})` : ''}
      </Text>
      {output ? <Text color={toolCall.status === 'error' ? 'red' : 'gray'}> ⎿ {output}</Text> : null}
    </Box>
  )
}

/**
 * 渲染当前仍在运行的工具调用。
 *
 * @param props.tools useAgent.state.activeToolCalls。
 * @returns Ink 工具运行区。
 */
function ActiveTools({ tools }: { tools: readonly ActiveToolCall[] }) {
  // 没有运行中工具时不渲染这一块，避免产生空白区域。
  if (tools.length === 0) return null

  return (
    <Box flexDirection="column">
      {tools.map((tool) => {
        // 运行中工具也用和已完成工具一致的标签格式。
        const label = getToolLabel(tool.toolName)
        // 运行中工具预览展示命令、路径或任务描述，帮助用户知道正在做什么。
        const preview = toolPreview(tool.toolName, tool.input)
        return (
          <Box key={tool.id} flexDirection="column">
            <Text color="yellow">
              {' '}
              {'●'} {label}
              {preview ? `(${preview})` : ''}
            </Text>
            <Text color="gray"> ⎿ {tool.progress ?? 'Running...'}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * 渲染模型通过 TodoWrite 维护的 todo 面板。
 *
 * @param props.todos 当前 todo 列表。
 * @returns Ink todo 面板。
 */
function Todos({ todos }: { todos: readonly TodoItem[] }) {
  // 没有 todo 时不渲染 todo 面板。
  if (todos.length === 0) return null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {todos.map((todo, idx) => {
        // 根据 todo 状态选择对应图标：完成、进行中、待开始。
        const glyph =
          todo.status === 'completed'
            ? '✓'
            : todo.status === 'in_progress'
              ? '◼'
              : '◻'
        // 完成用绿色，进行中用黄色，待开始用灰色。
        const color = todo.status === 'completed' ? 'green' : todo.status === 'in_progress' ? 'yellow' : 'gray'
        return (
          <Text key={`${todo.content}-${idx}`} color={color}>
            {/* 进行中的 todo 优先展示 activeForm，让文案更像“正在做什么”。 */}
            {glyph} {todo.status === 'in_progress' ? todo.activeForm || todo.content : todo.content}
          </Text>
        )
      })}
    </Box>
  )
}

/**
 * 渲染权限确认弹窗。
 *
 * @param props.permission 当前权限请求。
 * @param props.selected 当前选中的选项下标。
 * @returns Ink 权限弹窗。
 */
function PermissionDialog({ permission, selected }: { permission: PermissionRequest; selected: number }) {
  // MCP 工具展示 server/rawName；内置工具展示格式化后的工具名。
  const title = permission.mcp
    ? `TEGENT wants to use MCP tool: ${permission.mcp.serverName}/${permission.mcp.rawName}`
    : `TEGENT wants to use ${getToolLabel(permission.toolName)}`
  // 权限弹窗中展示一段短参数预览，帮助用户判断是否授权。
  const preview = toolPreview(permission.toolName, permission.input, 120)
  // suggestRuleLabel 不为 null 表示可以生成 always-allow 规则。
  const hasAlways = suggestRuleLabel(permission.toolName, permission.input, !!permission.mcp) !== null
  // 支持永久授权时显示 Yes/Always/No，否则只显示 Yes/No。
  const choices = hasAlways ? ['Yes', 'Always', 'No'] : ['Yes', 'No']

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow">{title}</Text>
      {preview ? <Text color="gray">{preview}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {choices.map((choice, idx) => (
          <Text key={choice} color={idx === selected ? 'cyan' : undefined}>
            {idx === selected ? '❯' : ' '} {choice}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

/**
 * 渲染 askUser/slash command 复用的选择器弹窗。
 *
 * @param props.request 当前选择器请求。
 * @param props.selected 当前选中的选项下标。
 * @param props.freeform 自由输入缓冲区。
 * @returns Ink 选择器。
 */
function SelectDialog({
  request,
  selected,
  freeform,
}: {
  request: SelectRequest
  selected: number
  freeform: FreeformState
}) {
  // 当前高亮选项；如果它是 freeform，就在下面显示 Other 输入行。
  const option = request.options[selected]

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan">{request.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {request.options.map((opt, idx) => (
          <Box key={`${opt.label}-${idx}`} flexDirection="column">
            <Text color={idx === selected ? 'cyan' : undefined}>
              {/* 当前选中项用指针标记，其余项用空格保持对齐。 */}
              {idx === selected ? '❯' : ' '} {opt.label}
              {/* compact 布局把描述放在同一行，节省垂直空间。 */}
              {request.layout === 'compact' && opt.description ? <Text color="gray"> {opt.description}</Text> : null}
            </Text>
            {/* 非 compact 布局把描述放到下一行，便于展示较长说明。 */}
            {request.layout !== 'compact' && opt.description ? <Text color="gray"> {opt.description}</Text> : null}
          </Box>
        ))}
      </Box>
      {/* Other/freeform 选项会渲染一个内联输入框，并用 inverse Text 显示光标。 */}
      {option?.freeform ? (
        <Text>
          Other: {freeform.text.slice(0, freeform.cursor)}
          <Text inverse>{freeform.text[freeform.cursor] ?? ' '}</Text>
          {freeform.text.slice(freeform.cursor + 1)}
        </Text>
      ) : null}
      {/* 有 preview 时展示前 8 行，避免预览太长挤掉输入区域。 */}
      {option?.preview?.length ? (
        <Box flexDirection="column" marginTop={1}>
          {option.preview.slice(0, 8).map((line, idx) => (
            <Text key={`preview-${idx}`}>{line}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

/**
 * 渲染 slash command 补全菜单。
 *
 * @param props.commandMatches slash 命令候选。
 * @param props.selected 当前选中下标。
 * @returns Ink 菜单。
 */
function CompletionMenu({
  commandMatches,
  selected,
}: {
  commandMatches: readonly CommandMatch[]
  selected: number
}) {
  // 先把候选统一成菜单行结构，下面渲染逻辑就不需要关心来源。
  const rows = commandMatches.map((cmd) => ({
    // key 用最终写回文本，保证同名不同层级候选也能区分。
    key: cmd.applyText,
    // title 是菜单左侧主文本。
    title: cmd.name,
    // suffix 放参数提示；没有参数提示时为空。
    suffix: cmd.argumentHint ?? '',
    // description 是菜单右侧说明。
    description: cmd.description,
  }))

  // 没有候选时不渲染菜单。
  if (rows.length === 0) return null

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {/* 菜单只渲染前 MAX_VISIBLE_MENU_ITEMS 项，避免候选过多占满屏幕。 */}
      {rows.slice(0, MAX_VISIBLE_MENU_ITEMS).map((row, idx) => (
        <Text key={row.key} color={idx === selected ? 'cyan' : undefined}>
          {/* 当前选中项用指针提示；其它项前面放空格保持列对齐。 */}
          {idx === selected ? '❯' : ' '} {row.title}
          {row.suffix ? <Text color="gray"> {row.suffix}</Text> : null}
          {row.description ? <Text color="gray"> {row.description}</Text> : null}
        </Text>
      ))}
    </Box>
  )
}

/**
 * 渲染输入框底部状态行。
 *
 * @param props.permissionMode 当前权限模式。
 * @param props.contextUsage 上下文窗口用量。
 * @param props.notice 临时提示。
 * @returns Ink footer。
 */
function Footer({
  permissionMode,
  contextUsage,
  notice,
}: {
  permissionMode: ChatInputProps['permissionMode']
  contextUsage: ChatInputProps['contextUsage']
  notice?: string | null
}) {
  // 根据权限模式生成左侧模式提示；default 模式不展示额外文案。
  const modeText =
    permissionMode === 'plan' ? '⏸ plan mode' : permissionMode === 'acceptEdits' ? 'accept edits' : ''
  // 有上下文窗口信息时展示 used/window 和百分比。
  const usageText = contextUsage
    ? `${formatTokenCount(contextUsage.used)} / ${formatTokenCount(contextUsage.window)} · ${Math.round(
        (contextUsage.used / contextUsage.window) * 100,
      )}%`
    : ''

  // 三种 footer 内容都为空时，整行不渲染。
  if (!modeText && !usageText && !notice) return null

  return (
    <Box justifyContent="space-between">
      {/* notice 优先级最高；没有 notice 时展示模式提示。 */}
      <Text color={notice ? 'yellow' : 'gray'}>{notice ?? modeText}</Text>
      {usageText ? <Text color="gray">{usageText}</Text> : null}
    </Box>
  )
}

export function ChatInput({
  messages,
  onSubmit,
  onInterrupt,
  onEscapeCancel,
  isLoading = false,
  notice,
  disabled = false,
  hidden = false,
  spinner,
  activeToolCalls = [],
  todos = [],
  errorMessage,
  permission,
  selectRequest,
  commands = [],
  permissionMode = 'default',
  contextUsage,
}: ChatInputProps) {
  // 主输入框内容和光标位置。用 reducer 保证“改文本 + 移光标”是一次原子状态更新。
  const [{ text, cursor }, dispatch] = useReducer(inputReducer, { text: '', cursor: 0 })
  // 某些键盘处理需要同步读到最新光标，ref 避免闭包拿旧 cursor。
  const cursorRef = useRef(0)
  useEffect(() => {
    // 每次 React 状态里的 cursor 更新后，同步到 ref，键盘回调可以立即读到最新值。
    cursorRef.current = cursor
  }, [cursor])

  // completionIndex 记录 slash 补全菜单当前高亮第几项。
  const [completionIndex, setCompletionIndex] = useState(0)

  // 弹窗本地状态：权限选项、选择器选项、Other 自由输入。
  // permissionSelected 表示权限弹窗当前高亮 Yes/Always/No 的哪一项。
  const [permissionSelected, setPermissionSelected] = useState(0)
  // selectIndex 表示 SelectOptions 弹窗当前高亮哪一项。
  const [selectIndex, setSelectIndex] = useState(0)
  // freeform 保存 SelectOptions 中 Other 输入框的文本和光标。
  const [freeform, setFreeform] = useState<FreeformState>({ text: '', cursor: 0 })

  // spinner 自己计时，避免要求父组件为了动画频繁重渲染。
  // spinnerFrame 是 0-3 的动画帧下标，用来从 '⠋⠙⠹⠸' 中取当前字符。
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  // lastEscapeAtRef 记录上一次按 Esc 的时间，用来判断是否双击 Esc 清空输入。
  const lastEscapeAtRef = useRef(0)

  // 输入历史用 ref 保存，因为 Up/Down 快速连按时需要同步更新索引，不适合等 React state 落地。
  // historyRef 保存从磁盘加载的输入历史，以及当前会话新增的历史。
  const historyRef = useRef<InputHistoryEntry[]>([])
  // historyIndexRef 表示当前正在查看倒数第几条历史；0 表示没有进入历史导航。
  const historyIndexRef = useRef(0)
  // historyDraftRef 保存用户开始翻历史前的草稿，Down 回到最新位置时恢复它。
  const historyDraftRef = useRef<{ text: string; cursor: number } | null>(null)
  // initialCwdRef 固定启动时 cwd，历史文件始终写入同一个项目目录。
  const initialCwdRef = useRef(process.cwd())

  // useStdout 提供终端尺寸；rows 用来估算可以显示多少条最近消息。
  const { stdout } = useStdout()
  const rows = stdout?.rows ?? 30

  /**
   * 当前可见的最近消息。
   *
   * 原版把历史写进真实 scrollback；Ink 版直接渲染一段尾部历史，避免巨量消息撑爆动态区域。
   */
  const visibleMessages = useMemo(() => {
    // 预留输入框、菜单、弹窗、spinner 等动态区域的高度。
    const reservedRows = 14
    // 根据终端行数动态收缩历史消息数量，但至少保留 5 条。
    const maxMessages = Math.min(MAX_VISIBLE_MESSAGES, Math.max(5, rows - reservedRows))
    // 只展示尾部消息，避免 Ink 动态区域过高。
    return messages.slice(-maxMessages)
  }, [messages, rows])

  /**
   * slash command 补全候选。
   *
   * 第一阶段补命令名，第二阶段补 subcommand；`applyText` 保存接受补全后应该写回输入框的完整文本。
   */
  const matches: CommandMatch[] = (() => {
    // 只有输入以 / 开头时才进入 slash command 补全。
    if (!text.startsWith('/')) return []
    // 第一个空格用来区分“补命令名”和“补子命令”两个阶段。
    const firstSpace = text.indexOf(' ')
    if (firstSpace === -1) {
      // 命令名阶段：去掉开头 /，拿剩余文本做 fuzzy query。
      const query = text.slice(1).toLowerCase()
      // query 为空时展示所有命令；非空时按 fuzzyMatches 过滤。
      const filtered = !query
        ? commands
        : commands.filter((cmd) => fuzzyMatches(cmd.name.slice(1).toLowerCase(), query))
      // 只取前几项，并转换成菜单渲染需要的 CommandMatch。
      return filtered.slice(0, MAX_VISIBLE_MENU_ITEMS).map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        applyText: cmd.name,
        argumentHint: cmd.argumentHint,
      }))
    }

    // 子命令阶段：head 是主命令，tail 是主命令后面的输入。
    const head = text.slice(0, firstSpace)
    const tail = text.slice(firstSpace + 1)
    // tail 已经包含空格时，说明用户开始输入参数，本期不再继续补全。
    if (tail.includes(' ')) return []

    // 找到当前主命令定义；没有 subcommands 时不展示二级补全。
    const cmd = commands.find((c) => c.name === head)
    if (!cmd?.subcommands) return []

    // 子命令阶段同样用 fuzzy query 过滤候选。
    const query = tail.toLowerCase()
    const filtered = !query
      ? cmd.subcommands
      : cmd.subcommands.filter((sub) => fuzzyMatches(sub.name.toLowerCase(), query))
    // 子命令接受补全后写回成 `/main sub` 形式。
    return filtered.slice(0, MAX_VISIBLE_MENU_ITEMS).map((sub) => ({
      name: sub.name,
      description: sub.description,
      applyText: `${head} ${sub.name}`,
    }))
  })()

  // slash 补全当前选中项的安全下标；候选数量变化时用取模把 completionIndex 拉回有效范围。
  const safeCommandIndex = matches.length > 0 ? completionIndex % matches.length : 0
  // 当前选中的 slash 命令候选；没有候选时为 null，Enter/Tab 就不会接受补全。
  const currentMatch = matches.length > 0 ? matches[safeCommandIndex] : null
  // 补全菜单是否打开；当前只有 slash 菜单。
  const menuOpen = matches.length > 0

  // 启动时读取项目本地输入历史；失败静默吞掉，历史不是核心功能。
  useEffect(() => {
    let cancelled = false
    void loadInputHistory(initialCwdRef.current).then((entries) => {
      if (!cancelled) historyRef.current = entries
    })
    return () => {
      cancelled = true
    }
  }, [])

  // spinner 动画帧；只有 spinner 存在时启动定时器。
  useEffect(() => {
    if (!spinner) return
    const timer = setInterval(() => {
      setSpinnerFrame((frame) => (frame + 1) % 4)
    }, 200)
    return () => clearInterval(timer)
  }, [spinner])

  // 新权限请求出现时，默认选中第一个选项。
  useEffect(() => {
    queueMicrotask(() => setPermissionSelected(0))
  }, [permission])

  // 新选择器出现时，重置选项和自由输入。
  useEffect(() => {
    queueMicrotask(() => {
      setSelectIndex(0)
      setFreeform({ text: '', cursor: 0 })
    })
  }, [selectRequest])

  /**
   * 清空输入历史导航状态。
   */
  const resetHistoryNav = () => {
    // 回到 0 表示退出历史浏览状态。
    historyIndexRef.current = 0
    // 草稿只在历史浏览期间需要，退出后清空。
    historyDraftRef.current = null
  }

  /**
   * 把一次成功提交写入内存历史和磁盘历史。
   *
   * @param raw 输入框里的原始文本。
   */
  const pushHistory = (raw: string) => {
    // 空白输入不写历史。
    if (!raw.trim()) return
    // 连续提交同一条输入时不重复写历史。
    const last = historyRef.current[historyRef.current.length - 1]
    if (last && last.text === raw) return
    // 历史条目保存原始文本和时间戳。
    const entry: InputHistoryEntry = { text: raw, ts: Date.now() }
    // 先写入内存历史，Up/Down 立即可用。
    historyRef.current.push(entry)
    // 内存中只保留最近 HISTORY_MAX 条；磁盘文件不在这里裁剪。
    if (historyRef.current.length > HISTORY_MAX) historyRef.current.shift()
    // 磁盘历史是 best-effort，失败不会打断用户提交。
    void appendInputHistory(entry, initialCwdRef.current)
  }

  /**
   * 把历史条目恢复到输入框。
   *
   * @param entry 历史条目。
   * @param cursorAt 恢复后光标放在开头还是结尾。
   */
  const restoreHistoryEntry = (entry: { text: string }, cursorAt: 'start' | 'end') => {
    // 恢复历史文本，并按调用方要求把光标放在开头或结尾。
    dispatch({ type: 'SET_TEXT', text: entry.text, cursor: cursorAt === 'start' ? 0 : entry.text.length })
    // 恢复历史后重置补全菜单选中项。
    setCompletionIndex(0)
  }

  /**
   * 向更旧的历史记录导航。
   */
  const navigateHistoryUp = () => {
    // 没有历史时 Up 不做任何事。
    if (historyRef.current.length === 0) return
    // 已经走到最旧历史时继续 Up 不再变化。
    if (historyIndexRef.current >= historyRef.current.length) return
    if (historyIndexRef.current === 0) {
      // 第一次进入历史浏览时，保存当前草稿，方便 Down 回来。
      historyDraftRef.current = { text, cursor: cursorRef.current }
    }
    // index 表示“从最后一条开始往前数第几条”。
    historyIndexRef.current += 1
    // 根据 index 从数组尾部取历史项。
    const entry = historyRef.current[historyRef.current.length - historyIndexRef.current]
    // Up 取到历史后，把光标放在开头，符合原输入体验。
    if (entry) restoreHistoryEntry(entry, 'start')
  }

  /**
   * 向更新的历史记录导航；回到 0 时恢复用户开始翻历史前的草稿。
   */
  const navigateHistoryDown = () => {
    // 没进入历史浏览时 Down 不处理历史。
    if (historyIndexRef.current <= 0) return
    // 往较新的历史移动一格。
    historyIndexRef.current -= 1
    if (historyIndexRef.current === 0) {
      // 回到 0 表示离开历史浏览，要恢复用户原来的草稿。
      const draft = historyDraftRef.current
      historyDraftRef.current = null
      if (draft) {
        // 有草稿时恢复草稿文本和光标。
        dispatch({ type: 'SET_TEXT', text: draft.text, cursor: draft.cursor })
      } else {
        // 没有草稿时清空输入框。
        dispatch({ type: 'RESET' })
      }
      setCompletionIndex(0)
      return
    }
    // 仍在历史浏览中时，显示下一条更新的历史，并把光标放在结尾。
    const entry = historyRef.current[historyRef.current.length - historyIndexRef.current]
    if (entry) restoreHistoryEntry(entry, 'end')
  }

  /**
   * 按逻辑行上下移动光标。
   *
   * @param delta 移动的行数，负数向上，正数向下。
   * @returns 如果光标真的移动了返回 true；已经到边界则返回 false。
   */
  const moveCursorVertically = (delta: number): boolean => {
    // 用换行符拆出逻辑行，Ink 版这里不做终端 cell 宽度换行计算。
    const lines = text.split('\n')
    // line/col 保存当前光标所在逻辑行和列。
    let line = 0
    let col = cursorRef.current
    // charsSoFar 记录扫描到当前行之前累计了多少字符。
    let charsSoFar = 0
    for (let i = 0; i < lines.length; i++) {
      // 找到包含当前 cursor 的逻辑行。
      if (charsSoFar + lines[i].length >= cursorRef.current && cursorRef.current >= charsSoFar) {
        line = i
        col = cursorRef.current - charsSoFar
        break
      }
      // 每行长度加 1 是为了计算换行符本身。
      charsSoFar += lines[i].length + 1
    }
    // 目标行会被限制在第一行和最后一行之间。
    const targetLine = Math.max(0, Math.min(lines.length - 1, line + delta))
    // 目标行没有变化，说明已经到边界。
    if (targetLine === line) return false
    // 如果目标行更短，列号压到目标行末尾。
    const targetCol = Math.min(col, lines[targetLine].length)
    // 把目标行列重新换算成字符串下标。
    let newPos = 0
    for (let i = 0; i < targetLine; i++) newPos += lines[i].length + 1
    newPos += targetCol
    // 通过 reducer 原子更新光标。
    dispatch({ type: 'SET_CURSOR', cursor: newPos })
    return true
  }

  /**
   * 提交当前输入框内容。
   *
   * @param override 可选的替代文本；slash 菜单按 Enter 时用它直接提交选中的命令。
   */
  const submitInput = (override?: string) => {
    // override 用于 slash 菜单：接受候选时直接提交候选文本。
    const raw = override ?? text
    // 空输入不提交。
    if (!raw.trim()) return
    // spinner 存在说明 agent 正在跑，避免重复提交。
    if (spinner) return
    pushHistory(raw)
    // 提交后退出历史浏览状态。
    resetHistoryNav()
    // 把文本交给 App，由 App 决定是 slash command 还是 agent submit。
    onSubmit(raw)
    // 提交后清空输入框和本地临时状态。
    dispatch({ type: 'RESET' })
    setCompletionIndex(0)
  }

  /**
   * 权限弹窗的键盘处理。
   *
   * @param key 规范化后的按键名。
   * @returns 如果当前按键被权限弹窗消费，返回 true。
   */
  const handlePermissionKey = (key: string): boolean => {
    // 没有权限弹窗时，告诉外层“我没有消费这个按键”。
    if (!permission) return false
    // 是否支持 Always 取决于当前工具调用能不能生成持久授权规则。
    const hasAlways = suggestRuleLabel(permission.toolName, permission.input, !!permission.mcp) !== null
    // choices 的实际 resolve 值；数组顺序必须和 PermissionDialog 里的 choices 展示顺序一致。
    const decisions: ('yes' | 'always' | 'no')[] = hasAlways ? ['yes', 'always', 'no'] : ['yes', 'no']
    // maxIdx 用于上下循环选择。
    const maxIdx = decisions.length - 1
    // 上键向前移动，第一项再往上会循环到最后一项。
    if (key === 'up') setPermissionSelected((idx) => (idx > 0 ? idx - 1 : maxIdx))
    // 下键向后移动，最后一项再往下会循环到第一项。
    else if (key === 'down') setPermissionSelected((idx) => (idx < maxIdx ? idx + 1 : 0))
    // Enter 用当前选中项 resolve 给 useAgent。
    else if (key === 'return') permission.onResolve(decisions[permissionSelected]!)
    // 有权限弹窗时，其它按键也不应落到主输入框，因此返回 true 表示已消费。
    else return true
    return true
  }

  /**
   * SelectOptions 弹窗的键盘处理。
   *
   * @param key 规范化后的按键名。
   * @returns 如果当前按键被选择器消费，返回 true。
   */
  const handleSelectKey = (key: string): boolean => {
    // 没有选择器弹窗时，告诉外层“我没有消费这个按键”。
    if (!selectRequest) return false
    // 当前高亮选项；freeform 选项会额外启用文本编辑逻辑。
    const option = selectRequest.options[selectIndex]
    // isFreeform 表示当前选项是否是 Other 自由输入。
    const isFreeform = !!option?.freeform

    if (key === 'escape') {
      // dismissible 的选择器允许 Esc 关闭并返回空答案。
      if (selectRequest.dismissible) selectRequest.onResolve('')
      return true
    }
    if (key === 'up') {
      // 上键循环移动选项。
      setSelectIndex((idx) => (idx > 0 ? idx - 1 : selectRequest.options.length - 1))
      return true
    }
    if (key === 'down') {
      // 下键循环移动选项。
      setSelectIndex((idx) => (idx < selectRequest.options.length - 1 ? idx + 1 : 0))
      return true
    }
    if (isFreeform && key === 'backspace') {
      // freeform 输入框中，Backspace 删除光标前字符。
      setFreeform(({ text, cursor }) =>
        cursor === 0 ? { text, cursor } : { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 },
      )
      return true
    }
    if (isFreeform && key === 'delete') {
      // freeform 输入框中，Delete 删除光标所在字符。
      setFreeform(({ text, cursor }) =>
        cursor >= text.length ? { text, cursor } : { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor },
      )
      return true
    }
    if (isFreeform && key === 'left') {
      // freeform 输入框中，左键移动内部光标。
      setFreeform(({ text, cursor }) => ({ text, cursor: Math.max(0, cursor - 1) }))
      return true
    }
    if (isFreeform && key === 'right') {
      // freeform 输入框中，右键移动内部光标。
      setFreeform(({ text, cursor }) => ({ text, cursor: Math.min(text.length, cursor + 1) }))
      return true
    }
    if (isFreeform && key === 'home') {
      // freeform 输入框中，Home 跳到开头。
      setFreeform(({ text }) => ({ text, cursor: 0 }))
      return true
    }
    if (isFreeform && key === 'end') {
      // freeform 输入框中，End 跳到结尾。
      setFreeform(({ text }) => ({ text, cursor: text.length }))
      return true
    }
    if (key === 'return') {
      // Enter 接受当前选项。
      if (!option) return true
      if (option.freeform) {
        // freeform 只有非空输入才 resolve，避免误提交空 Other。
        const trimmed = freeform.text.trim()
        if (trimmed) selectRequest.onResolve(trimmed)
      } else {
        // 普通选项直接把 label 作为答案返回。
        selectRequest.onResolve(option.label)
      }
      return true
    }
    // 有选择器时，其它按键不落到主输入框。
    return true
  }

  /**
   * 插入普通文本。
   *
   * @param chunk Ink useInput 传入的文本片段。
   */
  const handleTextInput = (chunk: string) => {
    // Ink 可能传入空字符串；空输入无需处理。
    if (!chunk) return
    if (permission) {
      // 权限弹窗打开时，y/a/n 快捷键直接 resolve，不插入主输入框。
      const ch = chunk.toLowerCase()
      if (ch === 'y') permission.onResolve('yes')
      else if (ch === 'a' && suggestRuleLabel(permission.toolName, permission.input, !!permission.mcp) !== null)
        permission.onResolve('always')
      else if (ch === 'n') permission.onResolve('no')
      return
    }
    if (selectRequest) {
      // 选择器打开时，普通文本只写入 freeform 选项；普通选项忽略文本输入。
      const option = selectRequest.options[selectIndex]
      if (option?.freeform) {
        // 在 freeform 光标位置插入文本，并把光标移动到插入内容之后。
        setFreeform(({ text, cursor }) => ({
          text: text.slice(0, cursor) + chunk + text.slice(cursor),
          cursor: cursor + chunk.length,
        }))
      }
      return
    }
    // 没有弹窗时，普通文本插入主输入框当前光标位置。
    dispatch({ type: 'INSERT', pos: cursorRef.current, chunk })
    // 输入改变后把补全菜单选择重置到第一项。
    setCompletionIndex(0)
  }

  // 直接使用 Ink 的 useInput。本期不做 bracketed paste、自定义 debounce、Alt+Enter/Ctrl+Enter 编码兼容。
  // usePromptInput 的旧接线保留在 git 历史和当前注释掉的 import 中，后续需要终端兼容增强时可以再接回。
  useInput(
    (input, key) => {
      // Ctrl+C 即使 disabled 也必须可用；App 会负责第一次取消、第二次退出。
      if ((key.ctrl && input.toLowerCase() === 'c') || input === '\x03') {
        onInterrupt()
        return
      }

      // disabled 时只保留 Ctrl+C，其它输入全部忽略。
      if (disabled) return

      // Ink 的 key 类型没有声明 Home/End/PageUp/PageDown，这里用扩展类型读取可能存在的字段。
      const extendedKey = key as typeof key & {
        home?: boolean
        end?: boolean
        pageUp?: boolean
        pageDown?: boolean
      }

      if (key.return) {
        // 弹窗优先消费 Enter，避免主输入框误提交。
        if (handlePermissionKey('return')) return
        if (handleSelectKey('return')) return
        // 有 slash 补全候选时，Enter 直接提交候选命令。
        if (currentMatch) {
          submitInput(currentMatch.applyText)
          return
        }
        // 反斜杠 + Enter 保留为“插入换行”的简易路径。
        const cur = cursorRef.current
        if (cur > 0 && text[cur - 1] === '\\') {
          const next = text.slice(0, cur - 1) + '\n' + text.slice(cur)
          dispatch({ type: 'SET_TEXT', text: next, cursor: cur })
          setCompletionIndex(0)
          return
        }
        // 普通 Enter 提交当前输入。
        submitInput()
        return
      }

      if (key.escape) {
        // 选择器优先处理 Esc，例如 dismissible picker 可以关闭。
        if (handleSelectKey('escape')) return
        // loading 时 Esc 走取消当前 agent turn。
        if (isLoading && onEscapeCancel) {
          onEscapeCancel()
          return
        }
        // 输入框为空时 Esc 不做事。
        if (text.length === 0) return
        // 双击 Esc 清空输入；单击 Esc 只记录时间，避免误清。
        const now = Date.now()
        if (now - lastEscapeAtRef.current <= DOUBLE_ESC_WINDOW_MS) {
          dispatch({ type: 'RESET' })
          setCompletionIndex(0)
          resetHistoryNav()
          lastEscapeAtRef.current = 0
        } else {
          lastEscapeAtRef.current = now
        }
        return
      }

      if (key.backspace) {
        // 选择器 freeform 优先处理 Backspace。
        if (handleSelectKey('backspace')) return
        const pos = cursorRef.current
        // 光标在开头时无法继续删除。
        if (pos === 0) return
        // 本期无 paste ref，所以 Backspace 固定删除 1 个字符。
        dispatch({ type: 'BACKSPACE_REF', pos, deleteCount: 1 })
        setCompletionIndex(0)
        return
      }

      if (key.delete) {
        // 选择器 freeform 优先处理 Delete。
        if (handleSelectKey('delete')) return
        const pos = cursorRef.current
        if (pos >= text.length) {
          // Ink 在部分键盘上会把退格键报成 delete；光标在末尾时按“删前一个字符”处理，
          // 避免最后一个字符永远删不掉。
          if (pos > 0) dispatch({ type: 'BACKSPACE_REF', pos, deleteCount: 1 })
        } else {
          // 主输入框中间位置仍保持 Delete 语义：删除光标所在字符。
          dispatch({ type: 'DELETE', pos })
        }
        return
      }

      if (key.leftArrow) {
        // 选择器 freeform 优先处理左键。
        if (handleSelectKey('left')) return
        // 主输入框左键向前移动一个字符。
        dispatch({ type: 'SET_CURSOR', cursor: Math.max(0, cursorRef.current - 1) })
        return
      }

      if (key.rightArrow) {
        // 选择器 freeform 优先处理右键。
        if (handleSelectKey('right')) return
        // 主输入框右键向后移动一个字符。
        dispatch({ type: 'SET_CURSOR', cursor: Math.min(text.length, cursorRef.current + 1) })
        return
      }

      if (extendedKey.home) {
        // 选择器 freeform 优先处理 Home。
        if (handleSelectKey('home')) return
        // 主输入框 Home 跳到开头。
        dispatch({ type: 'SET_CURSOR', cursor: 0 })
        return
      }

      if (extendedKey.end) {
        // 选择器 freeform 优先处理 End。
        if (handleSelectKey('end')) return
        // 主输入框 End 跳到结尾。
        dispatch({ type: 'SET_CURSOR', cursor: text.length })
        return
      }

      if (key.tab) {
        // Tab 接受 slash 补全，但不提交，只把候选写回输入框。
        if (currentMatch) {
          dispatch({ type: 'SET_TEXT', text: currentMatch.applyText, cursor: currentMatch.applyText.length })
          setCompletionIndex(0)
        }
        return
      }

      if (key.upArrow) {
        // 权限弹窗和选择器优先消费上下键。
        if (handlePermissionKey('up')) return
        if (handleSelectKey('up')) return
        // inHistoryNav 用来判断当前是否正在浏览历史；浏览历史时 slash 菜单不抢单项上下键。
        const inHistoryNav = historyIndexRef.current > 0
        if (menuOpen && (!inHistoryNav || matches.length > 1)) {
          // slash 菜单打开时，上键移动菜单选中项。
          setCompletionIndex((idx) => (idx - 1 + matches.length) % matches.length)
          return
        }
        // 没有菜单可移动时，先尝试按逻辑行上移；到边界后再翻历史。
        if (!moveCursorVertically(-1)) navigateHistoryUp()
        return
      }

      if (key.downArrow) {
        // 权限弹窗和选择器优先消费上下键。
        if (handlePermissionKey('down')) return
        if (handleSelectKey('down')) return
        // inHistoryNav 用来判断当前是否正在浏览历史；浏览历史时 slash 菜单不抢单项上下键。
        const inHistoryNav = historyIndexRef.current > 0
        if (menuOpen && (!inHistoryNav || matches.length > 1)) {
          // slash 菜单打开时，下键移动菜单选中项。
          setCompletionIndex((idx) => (idx + 1) % matches.length)
          return
        }
        // 没有菜单可移动时，先尝试按逻辑行下移；到边界后再向较新的历史导航。
        if (!moveCursorVertically(1)) navigateHistoryDown()
        return
      }

      if (extendedKey.pageUp) {
        // PageUp 一次跨多行移动光标。
        moveCursorVertically(-MAX_VERTICAL_CURSOR_JUMP)
        return
      }

      if (extendedKey.pageDown) {
        // PageDown 一次跨多行移动光标。
        moveCursorVertically(MAX_VERTICAL_CURSOR_JUMP)
        return
      }

      // 没有命中特殊键时，把 input 当普通文本插入。
      handleTextInput(input)
    },
    { isActive: !hidden },
  )

  if (hidden) return null

  const menuSelected = safeCommandIndex

  return (
    <Box flexDirection="column">
      {/* 顶部历史区：只渲染最近一段消息，避免长会话撑满屏幕。 */}
      <Box flexDirection="column">
        {/* {visibleMessages.map((msg) => (
          <MessageBlock key={msg.id} msg={msg} />
        ))} */}
        {messages.map((msg) => (
          <MessageBlock key={msg.id} msg={msg} />
        ))}
      </Box>

      {/* 模型维护的 todo 面板，只有存在 todo 时 Todos 才会实际渲染。 */}
      <Todos todos={todos} />

      {/* 当前 turn 或上一轮产生的错误提示。 */}
      {errorMessage ? <Text color="red">Error: {errorMessage}</Text> : null}

      {/* 正在运行的工具调用区，例如 shell/read/edit 的 live 状态。 */}
      <ActiveTools tools={activeToolCalls} />

      {/* agent 正在思考或使用工具时显示 spinner。 */}
      {spinner ? (
        <Text color={spinner.mode === 'tool-use' ? 'yellow' : 'gray'}>
          {'⠋⠙⠹⠸'[spinnerFrame] ?? '⠋'} {spinner.label}...
        </Text>
      ) : null}

      {/* 权限弹窗和 SelectOptions 弹窗互相独立，由 App/useAgent 传入请求对象控制。 */}
      {permission ? <PermissionDialog permission={permission} selected={permissionSelected} /> : null}
      {selectRequest ? <SelectDialog request={selectRequest} selected={selectIndex} freeform={freeform} /> : null}

      {/* slash 补全菜单只在没有弹窗时显示。 */}
      {menuOpen && !permission && !selectRequest ? (
        <CompletionMenu commandMatches={matches} selected={menuSelected} />
      ) : null}

      {/* 主输入框：光标前文本、反色光标字符、光标后文本分三段渲染。 */}
      <Box borderStyle="single" borderColor={isLoading ? 'gray' : 'cyan'} paddingX={1}>
        <Text color="cyan">› </Text>
        <Text>{text.slice(0, cursor)}</Text>
        <Text inverse>{text[cursor] ?? ' '}</Text>
        <Text>{text.slice(cursor + 1)}</Text>
      </Box>

      {/* 底部状态行：权限模式、上下文用量、临时 notice。 */}
      <Footer permissionMode={permissionMode} contextUsage={contextUsage} notice={notice} />
    </Box>
  )
}
