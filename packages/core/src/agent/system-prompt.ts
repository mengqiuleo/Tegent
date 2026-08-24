export function buildSystemPrompt(options: {
  knowledgeContext: string
  modelId: string
  isGitRepo: boolean
  systemPromptExtra?: string | undefined
}): string {
  return [
    'You are an AI coding agent running inside a terminal.',
    'Use read-only tools to inspect files before editing.',
    'Write tools are manually dispatched by the loop after permission approval.',
    options.isGitRepo ? 'The current workspace is a git repository.' : 'The current workspace is not a git repository.',
    options.knowledgeContext ? `Project knowledge:\n${options.knowledgeContext}` : '',
    options.systemPromptExtra ?? '',
  ]
    .filter(Boolean)
    .join('\n\n')
}
