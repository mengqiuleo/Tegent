import type { ModelMessage } from 'ai'

import type { PermissionMode, TodoItem, TokenUsage } from '../types/index.js'
import type { CheckpointEntry } from './snapshot.js'

// LoopState 是一次 CLI 会话里 agentLoop 共享的“内存态”。它跨用户多次提交复用，
// 所以这里既保存模型消息、token、权限模式，也保存 Todo、checkpoint、prompt cache 等
// 会话级信息。不要把只属于单个 runTurn 的临时变量塞进这里，否则会污染下一轮。

export interface LoopState {
  // 当前会话完整消息历史。压缩、恢复、工具结果修复都会改这个数组。
  messages: ModelMessage[]
  // 累计 token 用量和最近上下文窗口快照。
  tokenUsage: TokenUsage
  // 最近一次 API 响应返回的真实 input token 数，用于触发上下文压缩。
  lastInputTokens: number
  // 本地可读的会话 ID，用于 session jsonl、plan 文件等命名。
  sessionId: string
  // 会话开始时间，ISO 字符串。
  startedAt: string
  // 本会话改过的文件集合，用于摘要和 UI 展示。
  filesModified: Set<string>
  // 最近执行过的工具调用滚动记录，key 是“工具名 + 稳定序列化输入”的 hash。
  // doom-loop guard 用它判断模型是否在重复调用同一个失败工具。
  recentToolCalls: Array<{ toolName: string; hash: string }>
  // 会话级系统提示词缓存。每个会话只构建一次，让 OpenAI-compatible provider
  // 能利用稳定前缀自动缓存。permissionMode 变化时会置为 null，下轮按新 overlay 重建。
  systemPromptCache: string | null
  // 当前审批模式。用户可通过 /plan 改，模型也可通过 enterPlanMode/exitPlanMode 工具改。
  // tool-execution 会读取它来决定系统提示词 overlay 和工具暴露方式。
  permissionMode: PermissionMode
  // 计划模式下的计划文件路径：.x-code/plans/{sessionId}.md；非计划模式为 null。
  // 第一次 enterPlanMode 时懒创建，并在本次计划会话中复用，退出时清空。
  currentPlanPath: string | null
  // 从用户第一条消息生成的小写短横线 slug，用于给 session usage 文件起可读名字。
  // 只在第一轮设置一次；会话中途改名会让前面已经写到磁盘的 usage 文件失联。
  taskSlug: string
  // 模型通过 todoWrite 维护的当前清单。todoWrite 是全量替换，不是增量 patch。
  // 只保存在内存里：/clear 和 /resume 会清空；/compact 会保留，让多步任务能延续。
  todos: TodoItem[]
  // /rewind 命令依赖的每条用户消息快照。createCheckpoint 会在用户消息落入 messages 后写入。
  // 内存里最多保留 100 条；压缩会重写消息数组，所以 markBoundaryAndReflush 会清空旧锚点。
  // jsonl 中也会保存 meta:checkpoint；恢复时“最后一个 boundary 之后为准”自然会丢掉压缩前快照。
  checkpoints: CheckpointEntry[]
  // 已经持久化到 session jsonl 的消息数量。agent loop 在回合边界 flush 新增消息，
  // 也就是追加 state.messages.slice(persistedMessageCount)，然后推进计数。
  // 压缩后重置为 state.messages.length，因为重写后的消息会在 compact-boundary 后重新 flush。
  persistedMessageCount: number

  // ---- 缓存失效检测 ----

  // 上一轮的 cache-read token 数。用于发现意外缓存 miss，例如代码改动破坏了系统提示词字节稳定性。
  prevTurnCacheRead: number
  // true 表示下一轮 cache-read 下降是预期内的，例如刚压缩过或切了 permissionMode。
  // 只豁免一轮，之后自动清掉。
  expectCacheMiss: boolean

  // ---- 子代理支持：agentLoop 设置一次，tool-execution 读取 ----

  // 子代理系统提示词用的知识上下文。父 agentLoop 调 buildKnowledgeContext 后缓存到这里；
  // 子代理循环本身不再单独构建知识上下文。
  knowledgeContext?: string
  // 当前 cwd 是否是 git repo。缓存给子代理系统提示词使用。
  isGitRepo?: boolean
}

/** 生成可读的 session id：YYYYMMDD-HHMMSS-mmm。
 *  使用本地时间，末尾毫秒用于区分快速连续启动的会话。
 *  这种格式比 Date.now().toString(36) 生成的短码更容易在 .x-code/sessions/ 中肉眼扫描，
 *  也和 plan 文件命名保持一致，目录排序体验更统一。 */
function generateSessionId(now: Date = new Date()): string {
  // 使用本地时间拼出可排序、可肉眼识别的 ID。
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  )
}

export function createLoopState(initialMode: PermissionMode = 'default'): LoopState {
  // 所有会话级字段集中初始化，方便 /clear、/resume、子代理创建新状态时保持一致。
  return {
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 0,
    },
    lastInputTokens: 0,
    sessionId: generateSessionId(),
    startedAt: new Date().toISOString(),
    filesModified: new Set(),
    recentToolCalls: [],
    systemPromptCache: null,
    permissionMode: initialMode,
    // plan 文件路径要等看到用户任务文本后才能生成，所以这里先置空。
    // 真正的 slug 和路径会在 agentLoop / enterPlanMode handler 中创建。
    currentPlanPath: null,
    taskSlug: '',
    todos: [],
    checkpoints: [],
    persistedMessageCount: 0,
    prevTurnCacheRead: 0,
    expectCacheMiss: false,
  }
}
