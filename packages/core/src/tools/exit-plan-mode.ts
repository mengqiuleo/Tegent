import { tool } from 'ai'

import { z } from 'zod'


export const exitPlanMode = tool({
  description:
    'Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval. This tool reads the plan from the file you wrote during planning — pass an optional `plan` parameter only if you want to override what is in the file. The user sees the plan content in an approval dialog and chooses Yes/No. The model cannot leave plan mode without user approval; if rejected, revise the plan file (using edit) and call this again. Do NOT use this for research / Q&A — only when the user has asked you to implement something and you have a complete plan written to the plan file. Do NOT use askUser to ask "is this plan okay?" — exitPlanMode is the only correct way to request plan approval.',
  inputSchema: z.object({
    plan: z
      .string()
      .optional()
      .describe(
        'Optional override for the plan body. By default the plan body comes from the plan file you wrote during planning — only pass this argument if you want to use different content (rare).',
      ),
  }),
})
