import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import type { SubAgentDefinition } from './types.js'

const frontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  shellRestrictions: z.array(z.string()).optional(),
})

function userTeCodeDir(): string {
  return process.env.X_CODE_HOME ?? path.join(process.env.HOME ?? process.cwd(), '.tegent')
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const data: Record<string, unknown> = {}
  const yamlBlock = match[1]!

  for (const line of yamlBlock.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx < 1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    let value: string | number | string[] = trimmed.slice(colonIdx + 1).trim()

    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
      continue
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    data[key] = /^\d+$/.test(value) ? Number(value) : value
  }

  return { data, body: match[2]!.trim() }
}

async function loadAgentsFromDir(dir: string, source: SubAgentDefinition['source']): Promise<SubAgentDefinition[]> {
  const agents: SubAgentDefinition[] = []

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return agents
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue

    const filePath = path.join(dir, entry)
    try {
      const parsed = parseFrontmatter(await fs.readFile(filePath, 'utf-8'))
      if (!parsed) continue

      const result = frontmatterSchema.safeParse(parsed.data)
      if (!result.success) continue

      const frontmatter = result.data
      agents.push({
        name: frontmatter.name,
        description: frontmatter.description,
        prompt: parsed.body,
        tools: frontmatter.tools,
        disallowedTools: frontmatter.disallowedTools,
        model: frontmatter.model,
        maxTurns: frontmatter.maxTurns ?? 30,
        shellRestrictions: frontmatter.shellRestrictions,
        source,
      })
    } catch {
      // One broken custom agent should not stop the CLI from starting.
    }
  }

  return agents
}

export async function loadCustomAgents(): Promise<SubAgentDefinition[]> {
  const userAgents = await loadAgentsFromDir(path.join(userTeCodeDir(), 'agents'), 'user')
  const projectAgents = await loadAgentsFromDir(path.join(process.cwd(), '.tegent', 'agents'), 'project')

  return [...userAgents, ...projectAgents]
}
