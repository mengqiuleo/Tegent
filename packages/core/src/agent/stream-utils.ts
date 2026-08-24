import type { ModelMessage } from 'ai'

export interface StreamResult {
  fullStream: AsyncIterable<{
    type: string
    text?: string
    toolName?: string
    input?: unknown
    output?: unknown
    toolCallId?: string
    error?: unknown
  }>
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

export function drainStreamResult(result: StreamResult): void {
  const noop = () => {}
  Promise.resolve(result.response).catch(noop)
  Promise.resolve(result.finishReason).catch(noop)
  Promise.resolve(result.usage).catch(noop)
  Promise.resolve(result.toolCalls).catch(noop)
}
