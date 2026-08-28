export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 把工具失败格式化成一段面向模型的工具结果字符串。
 *  `action` 是短动词短语，例如 "reading file"、"searching"。 */
export function formatToolError(action: string, err: unknown): string {
  return `Error ${action}: ${toErrorMessage(err)}`
}
