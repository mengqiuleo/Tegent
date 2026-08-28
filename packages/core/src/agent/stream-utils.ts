import type { ModelMessage } from 'ai'

export interface StreamResult {
  // 逐块消费的异步流：文本、工具调用、错误都会从这里出来。
  fullStream: AsyncIterable<{
    type: string
    text?: string
    toolName?: string
    input?: unknown
    output?: unknown
    toolCallId?: string
    /** type === 'error' 时，这是 SDK 包装后的 provider 错误。
     *  SDK 在请求失败时不会从 fullStream 迭代里直接 throw，而是把错误作为 chunk 入队后关闭流。
     *  外层的 streamChunksToUI 会重新抛出它，这样统一 try/catch 才能分类处理。 */
    error?: unknown
  }>
  // 完整响应消息，流结束后用于合并进 LoopState.messages。
  response: Promise<{ messages: ModelMessage[] }>
  // token 用量 promise，可能因为请求失败而 reject，所以需要 drain。
  usage: Promise<
    | {
        inputTokens?: number
        outputTokens?: number
        /** AI SDK v6 会把 provider 的缓存字段归一到这里。
         *  cacheReadTokens 是 inputTokens 的子集，不要重复计数；
         *  cacheWriteTokens 对应 Anthropic 的 cache_creation_input_tokens。 */
        inputTokenDetails?: {
          cacheReadTokens?: number
          cacheWriteTokens?: number
        }
      }
    | undefined
  >
  // 模型停止原因，例如 stop、tool-calls、length。
  finishReason: Promise<string>
  // 本轮模型请求里出现的工具调用列表。
  toolCalls: Promise<
    Array<{
      toolName: string
      toolCallId: string
      input: Record<string, unknown>
    }>
  >
}

// StreamResult 接口裁剪
// 真实对象可能长这样
// {
//   fullStream,
//   response,
//   usage,
//   finishReason,
//   toolCalls,
//   text,
//   steps,
//   request,
//   warnings,
//   ...
// }

// 我们这里只关心这些
// {
//   fullStream,
//   response,
//   usage,
//   finishReason,
//   toolCalls,
// }

/**
 * 静默消费 StreamResult 上还没完成的 promise，防止流错误后出现未处理 rejection。
 * AI SDK 内部 flush() 在没有完成 step 时可能用 NoOutputGeneratedError reject；
 * 如果不 drain，Node.js 会把完整错误打印到 stderr。
 */
export function drainStreamResult(result: StreamResult): void {
  // 故意只 catch 不 await：目的是吞掉后续 reject，避免影响主错误处理路径。
  const noop = () => {}
  Promise.resolve(result.response).catch(noop)
  Promise.resolve(result.finishReason).catch(noop)
  Promise.resolve(result.usage).catch(noop)
  Promise.resolve(result.toolCalls).catch(noop)
}

/**
 * drainStreamResult：
result.response      可能失败，提前 catch
result.finishReason  可能失败，提前 catch
result.usage         可能失败，提前 catch
result.toolCalls     可能失败，提前 catch


为什么要这么做
streamText(...) 返回的不是一个单独结果，而是一组东西：
result.fullStream     流式输出，用来一块一块读模型回复
result.response       最终响应 Promise
result.usage          token 用量 Promise
result.finishReason   停止原因 Promise
result.toolCalls      工具调用 Promise

问题在于：请求失败时，这几个 Promise 可能会几乎同时 reject。
主逻辑真正关心的是：
await streamChunksToUI(result, callbacks)

代码流程
1. 调 streamText(...)，拿到 result
2. 立刻 drainStreamResult(result)
   给 response / usage / finishReason / toolCalls 挂 catch
3. try {
     await streamChunksToUI(result, callbacks)
   }
4. 如果流式输出出错，进入 catch
5. catch 里统一判断：
   - 是用户 abort？
   - 是上下文太长？
   - 是 API 错误？


我们目前只关心 streamChunksToUI 的错误，并且将他的错误展示在 UI 上。然后其他的错误我们不关心不展示在UI 上，但是也是要捕获的
try {
  await streamChunksToUI(result, callbacks)
} catch (err) {
  // 这里只接住了 fullStream 那条错误
}
  那 response / usage / finishReason / toolCalls 这几条 Promise 的错误，可能就变成没人处理。
drainStreamResult(result)
本质上是提前做这个事：
result.response.catch(() => {})
result.usage.catch(() => {})
result.finishReason.catch(() => {})
result.toolCalls.catch(() => {})
 */
