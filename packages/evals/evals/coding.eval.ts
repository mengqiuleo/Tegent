import { expect } from 'vitest'
import { describeEval, toolCalls } from 'vitest-evals'

import { loadEvalTasks, selectEvalTasks } from '../src/tasks.js'
import { createTegentVitestHarness, hasConfiguredEvalModel } from '../src/vitest-harness.js'

const selectedTasks = selectEvalTasks(await loadEvalTasks(), process.env.TEGENT_EVAL_TASK)
const harness = createTegentVitestHarness()

describeEval(
  'tegent coding agent',
  {
    harness,
    judgeThreshold: null,
    skipIf: () => !hasConfiguredEvalModel(),
  },
  (it) => {
    it.for(selectedTasks)('$id - $name', async (task, { run }) => {
      const result = await run(task)
      const failedChecks = result.output.checks.filter((check) => !check.passed)

      expect(result.output.errors).toEqual([])
      expect(failedChecks, failedChecks.map((check) => check.message).join('\n')).toEqual([])
      expect(result.output.success).toBe(true)
      expect(toolCalls(result)).toHaveLength(result.output.toolCalls)
    })
  },
)
