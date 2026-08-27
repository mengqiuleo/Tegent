import type { FilePart, ImagePart, ModelMessage, TextPart } from 'ai'

/** 用户消息允许的内容类型。
 *
 * 可以是：
 * 1. 普通字符串，适合简单文本输入；
 * 2. parts 数组，适合带图片或文件附件的输入。 */
export type UserContent = string | Array<TextPart | ImagePart | FilePart>

/** 创建一条 user 消息。 */
export function userMessage(content: UserContent): ModelMessage {
  return { role: 'user', content }
}

/** 创建一条 tool 结果消息。 */
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

/** 把工具错误包装成模型能识别的标准字符串。
 *
 * 这里的 `Error: ` 前缀是有实际作用的：
 * tool 处理逻辑会用它判断这是不是错误，从而把 UI 里的那条工具输出标红，
 * 模型也会把它当成失败信号。 */
export function toolErrorString(message: string): string {
  return `Error: ${message}`
}

/** 把抛出的异常或未知值转换成标准的工具错误字符串。 */
export function toolErrorFromUnknown(err: unknown): string {
  return toolErrorString(err instanceof Error ? err.message : String(err))
}

/** 判断某个字符串是不是由 toolErrorString 生成的错误字符串。 */
export function isToolErrorString(value: string): boolean {
  return value.startsWith('Error:')
}
