import type { EvalResult } from './types.js'

export type EvalRunSummary = {
  runId: string
  modelId: string
  createdAt: string
  results: EvalResult[]
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ')
}

export function renderSummaryMarkdown(summary: EvalRunSummary): string {
  const passed = summary.results.filter((result) => result.success).length
  const rows = summary.results.map((result) => {
    const checks = `${result.checks.filter((check) => check.passed).length}/${result.checks.length}`
    return [
      escapeCell(result.id),
      result.success ? 'PASS' : 'FAIL',
      checks,
      String(result.turnCount),
      String(result.toolCalls),
      formatDuration(result.durationMs),
    ].join(' | ')
  })

  return [
    '# Tegent Eval Summary',
    '',
    `- Run ID: ${summary.runId}`,
    `- Model: ${summary.modelId}`,
    `- Created: ${summary.createdAt}`,
    `- Passed: ${passed}/${summary.results.length}`,
    '',
    '| Task | Result | Checks | Turns | Tools | Duration |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...rows.map((row) => `| ${row} |`),
    '',
  ].join('\n')
}
