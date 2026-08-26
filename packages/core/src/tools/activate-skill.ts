import { tool } from 'ai'

import { z } from 'zod'

import type { SkillRegistry } from '../skills/registry.js'
import { wrapActivatedSkill } from '../skills/registry.js'

export function createActivateSkillTool(registry: SkillRegistry) {
  const nameList = registry.names().join(', ')

  return tool({
    description: `Activate a skill to inject its instructions into the conversation. Available skills: ${nameList}. Call this when the current task clearly matches one of those skill descriptions.`,
    inputSchema: z.object({
      name: z.string().describe('Name of the skill to activate'),
    }),
    execute: async ({ name }) => {
      const skill = registry.get(name)
      if (!skill) {
        const available = registry.names()
        return available.length > 0
          ? `Skill "${name}" not found. Available: ${available.join(', ')}`
          : `Skill "${name}" not found. No skills are currently loaded.`
      }
      return wrapActivatedSkill(skill)
    },
  })
}
