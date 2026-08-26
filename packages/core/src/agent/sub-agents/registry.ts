import { builtInAgents } from './built-in.js'
import { loadCustomAgents } from './loader.js'
import type { SubAgentDefinition } from './types.js'

export class SubAgentRegistry {
  private agents: Map<string, SubAgentDefinition>

  constructor(agents: SubAgentDefinition[]) {
    this.agents = new Map()
    for (const agent of agents) {
      this.agents.set(agent.name, agent)
    }
  }

  get(name: string): SubAgentDefinition | undefined {
    return this.agents.get(name)
  }

  list(): SubAgentDefinition[] {
    return [...this.agents.values()]
  }

  names(): string[] {
    return [...this.agents.keys()]
  }
}

export function createBuiltInRegistry(): SubAgentRegistry {
  return new SubAgentRegistry(builtInAgents)
}

export async function createSubAgentRegistry(): Promise<SubAgentRegistry> {
  const custom = await loadCustomAgents()
  return new SubAgentRegistry([...builtInAgents, ...custom])
}
