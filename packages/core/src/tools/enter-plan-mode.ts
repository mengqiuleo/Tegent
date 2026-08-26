import { tool } from 'ai'

import { z } from 'zod'

export const enterPlanMode = tool({
  description: `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and keeps the work aligned.

Prefer enterPlanMode for new features, multi-file changes, unclear requirements, architectural choices, and any task with several plausible approaches. If you would normally ask the user to choose an approach, use enterPlanMode instead.`,
  inputSchema: z.object({
    topic: z.string().min(1).max(60).optional(),
  }),
})
