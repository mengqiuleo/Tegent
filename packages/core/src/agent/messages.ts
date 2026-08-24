import type { FilePart, ImagePart, ModelMessage, TextPart } from 'ai'

export type UserContent = string | Array<TextPart | ImagePart | FilePart>

export function toolResultMessage(toolCallId: string, toolName: string, result: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'text', value: result },
      },
    ],
  }
}

export function toolErrorString(message: string): string {
  return `Error: ${message}`
}

export function toolErrorFromUnknown(err: unknown): string {
  return toolErrorString(err instanceof Error ? err.message : String(err))
}

export function isToolErrorString(value: string): boolean {
  return value.startsWith('Error:')
}
