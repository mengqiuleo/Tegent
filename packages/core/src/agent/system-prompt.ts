import { getShellProvider } from "../tools/shell-provider.js"

export function buildSystemPrompt(options: {
  knowledgeContext: string
  modelId: string
  isGitRepo: boolean
  planMode?: boolean | undefined
  planFilePath?: string | undefined
  systemPromptExtra?: string | undefined
}): string {
  return [
    'You are an AI coding agent running inside a terminal.',
    'Use read-only tools to inspect files before editing.',
    'Write tools are manually dispatched by the loop after permission approval.',
    options.isGitRepo ? 'The current workspace is a git repository.' : 'The current workspace is not a git repository.',
    options.planMode
      ? [
          'Plan mode is active.',
          `The plan file for this session lives at: ${options.planFilePath ?? '(unknown)'}`,
          'Only edit the plan file until the user approves it via exitPlanMode.',
        ].join('\n')
      : '',
    options.knowledgeContext ? `Project knowledge:\n${options.knowledgeContext}` : '',
    options.systemPromptExtra ?? '',
  ]
    .filter(Boolean)
    .join('\n\n')
}


export function buildSubAgentSystemPrompt(options: {
  agentPrompt: string
  knowledgeContext: string
  isGitRepo: boolean
}): string {
  const shell = getShellProvider()

  return `You are a specialized sub-agent invoked by a parent coding assistant.

# Your role
${options.agentPrompt}

# Environment
- Platform: ${process.platform}
- Shell: ${shell.type}
- Working Directory: ${process.cwd()}
- Is Git Repo: ${options.isGitRepo ? 'yes' : 'no'}

# Knowledge context
${options.knowledgeContext || '(none)'}

# Output contract
- You operate in an isolated context. The parent agent receives ONLY your final assistant message.
- Make the final message self-contained: include important file paths, snippets, and conclusions inline.
- Do not dump raw tool output; synthesize the result.
- You cannot spawn further sub-agents.`
}