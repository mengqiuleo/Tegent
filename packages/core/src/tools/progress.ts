export type ProgressReporter = (message: string) => void


const reporters = new Map<string, ProgressReporter>()


export function setProgressReporter(toolCallId: string, fn: ProgressReporter): void {
  reporters.set(toolCallId, fn)
}


export function clearProgressReporter(toolCallId: string): void {
  reporters.delete(toolCallId)
}


export function reportProgress(toolCallId: string | undefined, message: string): void {
  if (!toolCallId) return

  reporters.get(toolCallId)?.(message)
}
