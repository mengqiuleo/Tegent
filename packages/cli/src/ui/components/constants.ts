/**
 * 内置 slash command 列表。
 *
 * 这份静态列表用于 `/help` 文本和 Tab 补全；skill 注册表里的命令会在运行时
 * 动态追加，不写死在这里。
 */
export const SLASH_COMMANDS = [
  { name: '/help', description: 'Show this help message' },
  {
    name: '/model',
    description: 'Pick a model (no-arg = interactive) — choice is saved',
    argumentHint: '[model-id]',
  },
  {
    name: '/thinking',
    description: 'Toggle extended thinking on/off (no-arg = show status) — saved',
    argumentHint: '[on|off]',
  },
  {
    name: '/plan',
    description: 'Toggle plan mode on/off (no-arg = show status) — saved',
    argumentHint: '[on|off]',
  },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Manually compress context' },
  { name: '/resume', description: 'Pick a past session in this project to resume', argumentHint: '[id]' },
  {
    name: '/rewind',
    description: 'Roll back files + conversation to a previous user message (no-arg = picker)',
    argumentHint: '[checkpoint-id]',
  },
  { name: '/init', description: 'Initialize project knowledge' },
  { name: '/review', description: 'Review a pull request (no-arg = list open PRs)', argumentHint: '[PR]' },
  { name: '/usage', description: 'Show current-session token usage (input/output/cache)' },
  { name: '/usage-history', description: 'List past sessions in this project' },
  { name: '/memory', description: 'Show auto-memory entries (project + user)' },
  {
    name: '/mcp',
    description: 'Manage MCP servers',
    // 在输入 `/mcp ` 或 `/mcp <prefix>` 时显示子命令菜单。
    // 顺序和 handleMcp 内部 switch 保持一致，确保菜单覆盖所有分支。
    subcommands: [
      { name: 'list', description: 'List configured MCP servers' },
      { name: 'tools', description: 'List tools from connected servers (optionally filter by server)' },
      { name: 'add', description: 'Add a new MCP server (stdio or http) to user / project config' },
      { name: 'add-json', description: 'Add an MCP server from a raw JSON config object' },
      { name: 'remove', description: 'Remove an MCP server from config' },
      { name: 'refresh', description: 'Reload mcpServers from disk and reconnect' },
    ],
  },
  {
    name: '/skill',
    description: 'Manage skills',
    subcommands: [
      { name: 'install', description: 'Fetch and install a skill from a URL' },
      { name: 'list', description: 'List installed skills (with on/off state)' },
      { name: 'refresh', description: 'Re-scan skills dirs and apply changes without restart' },
      { name: 'disable', description: 'Disable a skill (kept on disk; run /skill refresh to apply now)' },
      { name: 'enable', description: 'Re-enable a previously disabled skill' },
      { name: 'uninstall', description: 'Delete a skill directory from disk' },
    ],
  },
  {
    name: '/plugin',
    description: 'Manage plugins (bundled skills / agents / mcp / hooks)',
    // 子命令顺序镜像 handlePlugin 的 switch。
    // `marketplace` 本身是一个二级命令组，下面还有 add/remove/list/refresh/info。
    subcommands: [
      { name: 'list', description: 'List installed plugins (with enable state + source)' },
      { name: 'info', description: "Show a plugin's manifest, contributions, and hooks" },
      {
        name: 'install',
        description: 'Install a plugin from <name@marketplace>, git, github:owner/repo, or local path',
      },
      { name: 'uninstall', description: 'Remove a plugin (cache + settings entry; data dir preserved)' },
      {
        name: 'enable',
        description: 'Enable a plugin (writes settings — restart for full effect; --scope=user|project)',
      },
      { name: 'disable', description: 'Disable a plugin without uninstalling (--scope=user|project)' },
      { name: 'search', description: 'Search subscribed marketplaces by keyword' },
      { name: 'update', description: 'Reinstall a plugin from its recorded source' },
      { name: 'refresh', description: 'Live-reload plugins + skills/agents/commands/hooks/MCP servers' },
      { name: 'doctor', description: 'Show plugin load errors and integration warnings' },
      { name: 'marketplace', description: 'Manage marketplace subscriptions (add | remove | list | refresh | info)' },
    ],
  },
  { name: '/doctor', description: 'Diagnose environment, API keys, MCP servers, plugins, and agents' },
  { name: '/exit', description: 'Exit (flushes session)' },
] as const




/**
 * `/init` 的 prompt 正文。
 *
 * 它会作为用户消息提交给 agent，让 agent 用完整工具链（Read/Glob/Grep/Edit/Write）
 * 检查代码库，再基于真实证据编写 AGENTS.md，而不是套静态模板。
 *
 * 相比 Claude Code 旧版 OLD_INIT，这里有几个设计取舍：
 * - 目标文件是 AGENTS.md，这是本项目约定，而不是 CLAUDE.md。
 * - 明确提到 AGENTS.local.md 是个人层，避免模型把用户个人偏好
 *   （沙箱 URL、角色、语气等）写进团队共享文件。
 * - 携带 NEW_INIT 的极简规则：如果删掉某一行不会让 agent 犯错，就删。
 *   这能显著避免 AGENTS.md 膨胀，因为该文件每轮都会被读取。
 * - 要求模型用 Edit 合并已有 AGENTS.md，而不是覆盖，
 *   这样用户手写内容在重复执行 /init 时不会丢失。
 */
export const INIT_PROMPT = `Please analyze this codebase and create an AGENTS.md file at the project root. AGENTS.md is loaded into every TEGENT session, so future agents will read it as their primary project context.

What to include:
1. Common commands the agent should prefer: how to build, lint, run tests, run a single test. Only include what's non-obvious from manifest files.
2. High-level architecture that requires reading multiple files to understand — module boundaries, key data flows, the "big picture" a new contributor needs.
3. Important conventions that DIFFER from language defaults (e.g. "prefer type over interface", "errors live in errors.ts, never inline").
4. Non-obvious gotchas, required env vars, repo etiquette (branch naming, commit style).

Usage notes:
- If AGENTS.md already exists, read it first and use the Edit tool to merge improvements rather than overwriting — preserve the user's hand-written content.
- Apply the minimalism test to every line: "If I removed this line, would the agent make a mistake?" If no, cut it. AGENTS.md is read every turn — bloat costs tokens forever.
- If a README.md exists, mine it for project overview / commands / setup steps. If \`.cursor/rules/\`, \`.cursorrules\`, \`.github/copilot-instructions.md\`, \`.windsurfrules\`, or \`.clinerules\` exist, fold the important parts in.
- Do not list every file or component — those are discoverable via Glob/Grep. Focus on what's NOT discoverable.
- Do not invent sections like "Common Development Tasks", "Tips for Development", or "Support and Documentation" — only write what's expressly grounded in files you've read.
- Do not include generic engineering advice ("write clean code", "add tests"), standard language conventions, or obvious commands ("npm test", "cargo test").
- Personal preferences (the user's role, sandbox URLs, communication style) belong in AGENTS.local.md — gitignored, loaded alongside AGENTS.md. Mention this only if the user has clearly personal context to record; otherwise leave AGENTS.local.md alone.

Prefix the file with:

\`\`\`
# AGENTS.md

This file is loaded into the agent's context at the start of every session. Keep it concise — the agent reads it every turn.
\`\`\`

When you finish, summarize what you wrote (or what you changed if updating an existing file) in a few bullets so the user can review.`



/**
 * 构造 `/review` 使用的 prompt 正文。
 *
 * 该模板对齐 Claude Code 本地 /review：引导 agent 直接调用 `gh`，
 * 然后输出结构化代码评审。不带参数的分支被刻意收紧：
 * 如果 `gh pr list` 为空，就说明没有 open PR，直接停止。
 * 否则模型很容易额外花很多工具调用去检查 gh auth、分支、未提交 diff 等，
 * 再转去评审它碰巧发现的东西，既浪费也不是用户请求。
 * “直接用 gh，不要 wrappers”这句是为了抑制模型幻觉出 rtk、gh-aux 等包装命令。
 *
 * @param args - `/review` 后面的原始参数，通常是 PR 编号，也可能为空。
 * @returns 提交给 agent 的 review prompt。
 */
export const REVIEW_PROMPT = (args: string) => `You are an expert code reviewer. Use \`gh\` directly — no wrappers.

If no PR number is provided in the args:
1. Run \`gh pr list\` to show open PRs.
2. If the output is empty, reply with exactly: "No open PRs in this repository — re-run \`/review <number>\` to review a specific PR." and stop.
3. Otherwise, list the open PRs and ask the user which to review. Stop and wait.
4. Do NOT investigate further — no \`gh auth\`, no branch / diff / status checks, no reviewing uncommitted changes. The user will re-invoke /review.

If a PR number is provided:
1. Run \`gh pr view <number>\` to get PR details.
2. Run \`gh pr diff <number>\` to get the diff.
3. Write a concise but thorough review with clear sections and bullet points covering:
   - Overview of what the PR does
   - Code correctness
   - Project conventions
   - Performance implications
   - Test coverage
   - Security considerations
   - Specific suggestions and risks

PR number: ${args}`