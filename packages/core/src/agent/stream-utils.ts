import type { ModelMessage } from 'ai'

export type StreamChunkType =
  | 'text-delta'
  | 'tool-call'
  | 'tool-result'
  | 'reasoning-start'
  | 'reasoning-delta'
  | 'reasoning-end'
  | 'error'
  | 'finish'
  | (string & {})

export interface StreamChunk {
  type: StreamChunkType
  text?: string
  toolName?: string
  input?: unknown
  output?: unknown
  toolCallId?: string
  error?: unknown
  finishReason?: string
}

export interface StreamResult {
  fullStream: AsyncIterable<StreamChunk>
  response: Promise<{ messages: ModelMessage[] }>
  usage: Promise<
    | {
        inputTokens?: number
        outputTokens?: number
        inputTokenDetails?: {
          cacheReadTokens?: number
          cacheWriteTokens?: number
        }
      }
    | undefined
  >
  finishReason: Promise<string>
  toolCalls: Promise<Array<{ toolName: string; toolCallId: string; input: Record<string, unknown> }>>
}

// fullStream、response、usage、finishReason、toolCalls 共享同一个底层请求。
// 流出错时这些 Promise 会一起 reject；提前挂空 catch 可以避免 Node 误报未处理拒绝。
export function drainStreamResult(result: StreamResult): void {
  const noop = () => {}
  Promise.resolve(result.response).catch(noop)
  Promise.resolve(result.finishReason).catch(noop)
  Promise.resolve(result.usage).catch(noop)
  Promise.resolve(result.toolCalls).catch(noop)
}
