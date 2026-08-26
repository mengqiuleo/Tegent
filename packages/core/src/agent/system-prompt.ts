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
