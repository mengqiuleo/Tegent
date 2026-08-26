import { tool } from 'ai'

import { z } from 'zod'

export const exitPlanMode = tool({
  description:
    'Use this tool when you are in plan mode and have finished writing your plan. The user sees the plan content in an approval dialog and chooses Yes or No. Do NOT use askUser to request plan approval.',
  inputSchema: z.object({
    plan: z.string().optional(),
  }),
})
