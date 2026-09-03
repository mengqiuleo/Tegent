import fs from 'node:fs/promises'
import path from 'node:path'

import { renderSummaryMarkdown, type EvalRunSummary } from './summary.js'
import type { EvalResult } from './types.js'

export type EvalRunArtifact = EvalRunSummary

export type WrittenArtifacts = {
  jsonPath: string
  summaryPath: string
}

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

export async function writeRunArtifacts(resultsDir: string, artifact: EvalRunArtifact): Promise<WrittenArtifacts> {
  await fs.mkdir(resultsDir, { recursive: true })
  const jsonPath = path.join(resultsDir, `${artifact.runId}.json`)
  const summaryPath = path.join(resultsDir, `${artifact.runId}.md`)

  await fs.writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  await fs.writeFile(summaryPath, renderSummaryMarkdown(artifact), 'utf8')

  return { jsonPath, summaryPath }
}
