import type { ModelMessage } from 'ai'

type ContentPartLike = { type?: string; text?: string }

export function extractText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as ContentPartLike[])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
}
