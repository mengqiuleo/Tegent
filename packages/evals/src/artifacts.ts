/**
 * artifacts.ts — 评测结果「落盘」模块。
 *
 * 一次运行结束后，把结果写成两份文件到 results/ 目录：
 * - <runId>.json：机器可读的完整结果（含 trace，供程序分析/对比）
 * - <runId>.md  ：人类可读的 Markdown 摘要（由 summary.ts 渲染）
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { renderSummaryMarkdown, type EvalRunSummary } from './summary.js'
import type { EvalResult } from './types.js'

/** 落盘的产物数据结构（直接复用 summary.ts 的汇总类型） */
export type EvalRunArtifact = EvalRunSummary

/** writeRunArtifacts 的返回值：两个产物文件的路径 */
export type WrittenArtifacts = {
  jsonPath: string
  summaryPath: string
}

/**
 * 组装落盘用的 artifact 对象。
 * 单独抽成一个函数（而不是直接写对象字面量）是为了让数据的"组装"
 * 和"写文件"解耦，也方便单测分别覆盖。
 */
export function buildRunArtifact(args: {
  runId: string
  modelId: string
  createdAt: string
  results: EvalResult[]
}): EvalRunArtifact {
  return {
    runId: args.runId,
    modelId: args.modelId,
    createdAt: args.createdAt,
    results: args.results,
  }
}

/**
 * 把结果写入 results/ 目录：
 * 1. 确保目录存在（recursive 使多级目录也能创建）。
 * 2. JSON 版本：格式化缩进 2 空格，末尾补换行（POSIX 文本文件习惯）。
 * 3. Markdown 版本：调用 summary.ts 的渲染函数。
 *
 * @returns 两个文件的完整路径
 */
export async function writeRunArtifacts(resultsDir: string, artifact: EvalRunArtifact): Promise<WrittenArtifacts> {
  await fs.mkdir(resultsDir, { recursive: true })
  const jsonPath = path.join(resultsDir, `${artifact.runId}.json`)
  const summaryPath = path.join(resultsDir, `${artifact.runId}.md`)

  await fs.writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  await fs.writeFile(summaryPath, renderSummaryMarkdown(artifact), 'utf8')

  return { jsonPath, summaryPath }
}
