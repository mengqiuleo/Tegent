# Tegent

```
Tegent
├─ package.json
├─ packages
│  ├─ cli
│  │  ├─ bin
│  │  │  └─ tegent.js
│  │  ├─ package.json
│  │  ├─ src
│  │  │  ├─ app.tsx
│  │  │  ├─ cli-args.ts
│  │  │  ├─ index.ts
│  │  │  ├─ shell.ts
│  │  │  ├─ startup-prints.ts
│  │  │  ├─ types
│  │  │  │  └─ disparity-colors.d.ts
│  │  │  ├─ ui
│  │  │  │  ├─ commands
│  │  │  │  │  ├─ doctor.ts
│  │  │  │  │  ├─ mcp.ts
│  │  │  │  │  ├─ plugin.ts
│  │  │  │  │  └─ skill.ts
│  │  │  │  ├─ components
│  │  │  │  │  ├─ App.tsx
│  │  │  │  │  ├─ AppHeader.tsx
│  │  │  │  │  ├─ chat-input
│  │  │  │  │  │  ├─ reducer.ts
│  │  │  │  │  │  └─ types.ts
│  │  │  │  │  └─ ChatInputInk.tsx
│  │  │  │  ├─ hooks
│  │  │  │  │  ├─ use-agent-display-helpers.ts
│  │  │  │  │  ├─ use-agent-display.ts
│  │  │  │  │  └─ use-agent.ts
│  │  │  │  ├─ input-history.ts
│  │  │  │  ├─ render-diff.ts
│  │  │  │  ├─ text-width.ts
│  │  │  │  ├─ theme.ts
│  │  │  │  ├─ utils
│  │  │  │  │  └─ toolkit.ts
│  │  │  │  └─ utils.ts
│  │  │  └─ version.ts
│  │  └─ tsconfig.json
│  └─ core
│     ├─ package.json
│     ├─ src
│     │  ├─ agent
│     │  │  ├─ api-errors.ts
│     │  │  ├─ compression.ts
│     │  │  ├─ context-window.ts
│     │  │  ├─ diff.ts
│     │  │  ├─ file-ingest.ts
│     │  │  ├─ light-compact.ts
│     │  │  ├─ loop-guard.ts
│     │  │  ├─ loop-state.ts
│     │  │  ├─ loop.ts
│     │  │  ├─ memory-extractor.ts
│     │  │  ├─ messages.ts
│     │  │  ├─ plan-storage.ts
│     │  │  ├─ plan-tools.ts
│     │  │  ├─ provider-compat.ts
│     │  │  ├─ session-store.ts
│     │  │  ├─ snapshot.ts
│     │  │  ├─ stream-utils.ts
│     │  │  ├─ sub-agents
│     │  │  │  ├─ built-in.ts
│     │  │  │  ├─ index.ts
│     │  │  │  ├─ loader.ts
│     │  │  │  ├─ registry.ts
│     │  │  │  ├─ runner.ts
│     │  │  │  └─ types.ts
│     │  │  ├─ system-prompt.ts
│     │  │  ├─ tool-execution.ts
│     │  │  ├─ tool-result-sanitize.ts
│     │  │  └─ vision-fallback.ts
│     │  ├─ commands
│     │  │  ├─ index.ts
│     │  │  ├─ loader.ts
│     │  │  ├─ registry.ts
│     │  │  └─ types.ts
│     │  ├─ config
│     │  │  └─ index.ts
│     │  ├─ constants.ts
│     │  ├─ hooks
│     │  │  ├─ bus.ts
│     │  │  ├─ config-schema.ts
│     │  │  ├─ executor.ts
│     │  │  ├─ index.ts
│     │  │  ├─ registry.ts
│     │  │  ├─ types.ts
│     │  │  └─ variables.ts
│     │  ├─ index.ts
│     │  ├─ knowledge
│     │  │  ├─ auto-memory.ts
│     │  │  ├─ loader.ts
│     │  │  └─ session.ts
│     │  ├─ mcp
│     │  │  ├─ arg-parser.ts
│     │  │  ├─ client.ts
│     │  │  ├─ config-schema.ts
│     │  │  ├─ config-writer.ts
│     │  │  ├─ env-safety.ts
│     │  │  ├─ expand-env.ts
│     │  │  ├─ loader.ts
│     │  │  ├─ name-mangling.ts
│     │  │  ├─ oauth
│     │  │  │  ├─ callback-server.ts
│     │  │  │  ├─ provider.ts
│     │  │  │  └─ token-storage.ts
│     │  │  ├─ permissions.ts
│     │  │  ├─ registry.ts
│     │  │  ├─ resources.ts
│     │  │  ├─ tool-bridge.ts
│     │  │  ├─ trust.ts
│     │  │  └─ types.ts
│     │  ├─ permissions
│     │  │  ├─ index.ts
│     │  │  └─ session-store.ts
│     │  ├─ plugins
│     │  │  ├─ consent.ts
│     │  │  ├─ enable-state.ts
│     │  │  ├─ installer.ts
│     │  │  ├─ integration.ts
│     │  │  ├─ loader.ts
│     │  │  ├─ manifest.ts
│     │  │  ├─ marketplace.ts
│     │  │  ├─ paths.ts
│     │  │  ├─ refresh.ts
│     │  │  ├─ registry.ts
│     │  │  ├─ types.ts
│     │  │  └─ user-config.ts
│     │  ├─ providers
│     │  │  ├─ cache-control.ts
│     │  │  ├─ capabilities.ts
│     │  │  ├─ registry.ts
│     │  │  └─ thinking.ts
│     │  ├─ skills
│     │  │  ├─ loader.ts
│     │  │  ├─ registry.ts
│     │  │  └─ settings.ts
│     │  ├─ tools
│     │  │  ├─ activate-skill.ts
│     │  │  ├─ ask-user.ts
│     │  │  ├─ edit.ts
│     │  │  ├─ enter-plan-mode.ts
│     │  │  ├─ exit-plan-mode.ts
│     │  │  ├─ glob.ts
│     │  │  ├─ grep.ts
│     │  │  ├─ index.ts
│     │  │  ├─ list-dir.ts
│     │  │  ├─ progress.ts
│     │  │  ├─ read-file.ts
│     │  │  ├─ shell-provider.ts
│     │  │  ├─ shell-utils.ts
│     │  │  ├─ shell.ts
│     │  │  ├─ task.ts
│     │  │  ├─ todo-write.ts
│     │  │  ├─ truncate.ts
│     │  │  ├─ utils.ts
│     │  │  ├─ web-fetch.ts
│     │  │  ├─ web-search.ts
│     │  │  └─ write-file.ts
│     │  ├─ types
│     │  │  └─ index.ts
│     │  ├─ utils
│     │  │  ├─ lru-cache.ts
│     │  │  ├─ media-type.ts
│     │  │  ├─ message-helpers.ts
│     │  │  ├─ shell-error.ts
│     │  │  └─ tool-errors.ts
│     │  ├─ utils.ts
│     │  └─ version.ts
│     ├─ tests
│     │  ├─ askUser.test.ts
│     │  ├─ mcp-tools.test.ts
│     │  ├─ plan.test.ts
│     │  ├─ plugins-factory.test.ts
│     │  ├─ plugins-integration.test.ts
│     │  ├─ plugins-loader.test.ts
│     │  ├─ plugins-registry.test.ts
│     │  ├─ plugins-settings.test.ts
│     │  ├─ plugins-utils.test.ts
│     │  ├─ skills-loader.test.ts
│     │  ├─ skills-registry.test.ts
│     │  ├─ skills-settings.test.ts
│     │  └─ smoke.ts
│     ├─ tsconfig.json
│     └─ vitest.config.ts
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ README.md
└─ tsconfig.json

```