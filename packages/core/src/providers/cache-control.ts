// Prompt caching 是降低单个会话成本最重要的手段。当前支持的 provider 基本都
// 有缓存能力，但每家的开启方式不同：
//
//   Anthropic   - 在 SYSTEM 消息、最后一个工具定义、最后两条非 system 消息上
//                 设置 `cacheControl: { type: 'ephemeral' }`，总共四个断点，
//                 正好等于 API 上限。每个断点处的内容会在服务端缓存 5 分钟；
//                 后续请求只要前缀字节完全一致，就能命中缓存，只为未缓存的尾部
//                 付费。工具 schema 是最值得缓存的位置：同一会话每轮都一样，
//                 而且完整工具集注册后通常会有几千 token。
//
//   OpenAI      - 有自动前缀缓存；额外设置 `promptCacheKey` 可以把相同 key
//                 路由到同一缓存分片，提升命中率。`store` 控制是否保存调用记录
//                 供后续读取。这里把 sessionId 作为 key，让同一次对话的每一轮
//                 都落在同一个缓存分片上。
//
//   OpenAI 兼容 - DeepSeek / Moonshot / Alibaba / Zhipu / xAI / custom 这类
//                 provider 都提供自动前缀缓存，不需要显式参数。唯一前提是多轮
//                 请求的前缀字节稳定：如果 system prompt 每轮都带一个新时间戳，
//                 那每次都会缓存未命中。因此 LoopState 会在每个会话中只构建并
//                 缓存一次 system prompt（见 loop-state.ts），之后每轮复用同一个
//                 字符串。
//
//   Google      - Gemini 使用隐式缓存；SDK 侧没有值得按请求设置的开关。
//                 因此这里保持 no-op。
import type { ModelMessage } from 'ai'; // 引入 AI SDK 的统一消息类型，用来描述 system/user/assistant/tool 消息。

import { providerOf } from './capabilities.js'; // 根据 modelId 判断它属于 anthropic/openai/google/custom 等哪类 provider。

/** 最多给多少条普通消息加 Anthropic 缓存断点。
 *  Anthropic 每个请求最多允许 4 个 `cache_control` 块；其中一个给 system prompt，
 *  一个给最后的工具定义，剩下两个给消息尾部。opencode 的测试结果表明两个
 *  消息断点比较合适：再多加第三个会为“倒数第三条消息”付出一次缓存写入成本，
 *  但这个位置很快就会被新消息挤出尾部，收益不高。 */
const MESSAGE_CACHE_BREAKPOINTS = 2 // Anthropic 除 system 和工具外，只给最后 2 条消息打缓存断点。

export interface CacheControlArgs { // applyCacheControl 的入参结构，调用方把本轮请求材料交进来。
  /** System prompt 字符串。如果 provider 需要在它身上挂 cache_control，
   *  这里可能会把它包装成一条 system-role 消息。 */
  system: string // 本轮要发送的 system prompt；OpenAI 等 provider 仍然作为顶层 system 传入。
  /** 即将发送给模型的对话消息。 */
  messages: ModelMessage[] // 本轮要发给模型的历史消息数组，函数不会原地修改这个数组。
  /** 传给 streamText 的工具注册表。Anthropic 会给最后一个工具条目打上
   *  cache_control，让整份工具 schema 进入缓存前缀。buildTools() 在同一会话中
   *  返回同一个 Record 引用，因此 key 顺序稳定，缓存前缀的字节也稳定。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Record<string, any> // 本轮可用工具；只有 Anthropic 需要给最后一个工具追加 cacheControl。
  /** `provider:model` 形式的模型 ID，用它选择具体缓存策略。 */
  modelId: string // 例如 anthropic:claude-... 或 openai:gpt-...，用于识别 provider。
  /** 每个会话稳定不变的 key。OpenAI 的 `promptCacheKey` 用它把相同前缀固定到同一缓存分片。 */
  sessionId: string // 同一次 CLI 会话内稳定不变，用于 OpenAI promptCacheKey。
} // CacheControlArgs 结束。

export interface CacheControlResult { // applyCacheControl 的返回结构，直接供 streamText 调用。
  /** 可能为 undefined：Anthropic 需要把 system prompt 合并进 messages 数组，
   *  才能给它挂 cache_control；这种情况下调用 streamText 时不能再单独传
   *  `system` 参数。 */
  system?: string // 非 Anthropic 一般保留 system；Anthropic 会设成 undefined。
  messages: ModelMessage[] // 处理后的消息数组；Anthropic 会在里面插入 system-role 消息。
  /** 对 Anthropic 来说，这是一个浅拷贝后的 tools record，最后一个条目会带上
   *  cache_control。其他 provider 会原样返回输入的 tools（没有传则为 undefined）。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Record<string, any> // 处理后的工具表；Anthropic 可能返回浅拷贝版本。
  /** 透传给 streamText 的顶层 providerOptions。 */
  providerOptions?: Record<string, unknown> // OpenAI 的 promptCacheKey/store 会放在这里。
} // CacheControlResult 结束。

/** 非破坏式地把指定 providerOptions 条目挂到一条消息上。 */
function tagMessage(msg: ModelMessage, provider: string, entry: Record<string, unknown>): ModelMessage { // 给单条消息追加某个 provider 的专属选项。
  const existing = (msg as { providerOptions?: Record<string, Record<string, unknown>> }).providerOptions ?? {} // 取出原本已有的 providerOptions，没有就用空对象。
  return { // 返回新对象，避免直接修改原消息。
    ...msg, // 保留原消息的 role/content 等字段。
    providerOptions: { // 重建 providerOptions。
      ...existing, // 保留其他 provider 已有的选项。
      [provider]: { ...(existing[provider] ?? {}), ...entry }, // 合并当前 provider 的旧选项和新选项。
    }, // providerOptions 结束。
  } as ModelMessage // 类型断言回 AI SDK 的 ModelMessage。
} // tagMessage 结束。

/** 构造一条带 Anthropic cache_control 的 system-role 消息。 */
function anthropicSystemMessage(system: string): ModelMessage { // Anthropic 需要把 system 当成消息才能挂 cacheControl。
  return { // 返回一条 system-role 消息。
    role: 'system', // 这条消息的角色是 system。
    content: system, // 消息内容就是原来的 system prompt 字符串。
    providerOptions: { // 给这条消息附加 provider 专属参数。
      anthropic: { cacheControl: { type: 'ephemeral' } }, // Anthropic 的临时缓存标记，服务端会缓存这个断点。
    }, // providerOptions 结束。
  } as unknown as ModelMessage // AI SDK 类型里 system 消息形状较窄，这里做一次兼容断言。
} // anthropicSystemMessage 结束。

/**
 * 根据 provider 给本轮请求加缓存配置。
 * 返回已经加好 provider 专属缓存提示的请求结构。
 * 输入的 `messages` 数组不会被原地修改；凡是需要额外 providerOptions 的消息，
 * 都会返回新的 message 对象。
 */
export function applyCacheControl(args: CacheControlArgs): CacheControlResult { // 入口函数：根据 provider 给本轮请求加缓存配置。
  const provider = providerOf(args.modelId) // 从 modelId 推断 provider 类型，例如 anthropic/openai/google/custom。

  if (provider === 'anthropic') { // Anthropic 需要显式给若干内容块打 cache_control。
    // 把 system prompt 合并进 messages，方便给它加 cache_control；
    // 然后把最后 N 条非 system 消息也标记成缓存断点。
    const nonSystemTail = args.messages.slice(-MESSAGE_CACHE_BREAKPOINTS) // 取最后 2 条消息，作为消息尾部缓存断点。
    const tailSet = new Set(nonSystemTail) // 转成 Set，方便 map 时判断某条消息是否在尾部。
    const tagged = args.messages.map((m) => // 遍历原消息数组，生成处理后的新数组。
      tailSet.has(m) ? tagMessage(m, 'anthropic', { cacheControl: { type: 'ephemeral' } }) : m, // 尾部消息加 cacheControl，其他消息原样复用。
    ) // tagged 是添加了消息尾部缓存断点后的消息列表。
    return { // 返回 Anthropic 专用请求结构。
      system: undefined, // Anthropic 的 system 已经放进 messages，顶层 system 不能再传。
      messages: [anthropicSystemMessage(args.system), ...tagged], // 第一条放带 cacheControl 的 system 消息，后面接历史消息。
      tools: tagLastTool(args.tools), // 给最后一个工具也加 cacheControl，让工具 schema 可缓存。
    } // Anthropic 分支结束。
  } // provider === 'anthropic' 分支结束。

  if (provider === 'openai') { // OpenAI 不需要给消息块打标，但可以传 promptCacheKey。
    // `store: false` 表示不需要保存调用记录供 API 后续读取；真正节省成本的是
    // `promptCacheKey`，它会把相同前缀路由到同一个缓存分片。
    return { // 返回 OpenAI 专用请求结构。
      system: args.system, // system prompt 仍然作为顶层 system 传入。
      messages: args.messages, // 消息数组不需要改写。
      tools: args.tools, // 工具表不需要改写。
      providerOptions: { // 顶层 providerOptions 会传给 streamText。
        openai: { promptCacheKey: args.sessionId, store: false }, // 用稳定 sessionId 提高前缀缓存命中率，并关闭调用记录存储。
      }, // providerOptions 结束。
    } // OpenAI 分支结束。
  } // provider === 'openai' 分支结束。

  // OpenAI 兼容 provider 和 Gemini：没有显式开关，只依赖稳定前缀。
  // 调用方必须保证 buildSystemPrompt 的结果缓存在 LoopState 中，让每轮发送的
  // system 字符串保持一致。
  return { system: args.system, messages: args.messages, tools: args.tools } // 其他 provider 原样返回，靠 provider 自己的自动/隐式缓存。
} // applyCacheControl 结束。

/** 浅拷贝 `tools`，并给最后一个工具条目挂 Anthropic cache_control 断点。
 *  这样整份工具 schema 会进入一个缓存前缀槽位。没有工具时原样返回输入：
 *  Anthropic 不接受给不存在的块设置空 `cache_control`，而且这种情况也没内容可缓存。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tagLastTool(tools: Record<string, any> | undefined): Record<string, any> | undefined { // 只服务 Anthropic：标记最后一个工具。
  if (!tools) return tools // 没有工具表就直接返回 undefined。
  const names = Object.keys(tools) // 拿到工具名列表，顺序就是对象键的插入顺序。
  if (names.length === 0) return tools // 工具表为空时也不需要处理。
  const lastName = names[names.length - 1] // 找到最后一个工具名。
  const lastTool = tools[lastName] // 取出最后一个工具定义。
  const existing = (lastTool?.providerOptions ?? {}) as Record<string, Record<string, unknown>> // 保留这个工具已有的 providerOptions。
  const tagged = { // 构造一个新的工具对象。
    ...lastTool, // 保留工具原本的 description/inputSchema/execute 等字段。
    providerOptions: { // 重建工具级 providerOptions。
      ...existing, // 保留其他 provider 的工具级选项。
      anthropic: { ...(existing.anthropic ?? {}), cacheControl: { type: 'ephemeral' } }, // 给 Anthropic 加工具缓存断点。
    }, // providerOptions 结束。
  } // tagged 工具构造结束。
  return { ...tools, [lastName]: tagged } // 返回浅拷贝后的工具表，只替换最后一个工具。
} // tagLastTool 结束。
