/**
 * summary.ts — 把一次评测运行渲染成「Markdown 摘要报告」。
 *
 * 产出一个 results/<runId>.md 文件，内容长这样：
 *
 *   # Tegent Eval Summary
 *   - Run ID: 20260904...
 *   - Passed: 2/3
 *   | Task | Result | Checks | Turns | Tools | Duration |
 *   | fix-test | PASS | 3/3 | 5 | 12 | 18.2s |
 *   ...
 *
 * 适合贴到 PR / README 里给人快速浏览。
 */

import type { EvalResult } from './types.js'

/** 一次完整评测运行（可能包含多条任务）的汇总数据 */
export type EvalRunSummary = {
  /** 本次运行的 ID（时间戳格式，如 20260904T101530） */
  runId: string
  /** 使用的模型 ID */
  modelId: string
  /** 运行创建时间（ISO 格式字符串） */
  createdAt: string
  /** 每条任务的结果 */
  results: EvalResult[]
}

/** 毫秒 -> "18.2s" 这种人类友好的时长 */
function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * 转义 Markdown 表格单元格里的特殊字符：
 * `|` 会破坏表格列结构（转义为 \|），换行符会撑破表格（替换为空格）。
 */
function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ')
}

/**
 * 渲染 Markdown 摘要：头部元信息（Run ID / 模型 / 通过率）+ 每任务一行的结果表。
 * 表格列：任务 ID | PASS/FAIL | 通过的 check 数 | 轮数 | 工具调用数 | 耗时。
 */
export function renderSummaryMarkdown(summary: EvalRunSummary): string {
  const passed = summary.results.filter((result) => result.success).length
  const rows = summary.results.map((result) => {
    // "2/3" 形式的 check 通过数
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
    // 后四列用 `---:` 表示数字列右对齐
    '| Task | Result | Checks | Turns | Tools | Duration |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...rows.map((row) => `| ${row} |`),
    '',
  ].join('\n')
}
