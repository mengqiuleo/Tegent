# Repository Guidelines

## Project Structure & Module Organization

Tegent is a pnpm workspace containing two TypeScript packages:

- `packages/core/src/` contains the agent loop, providers, tools, MCP integration, plugins, skills, permissions, and shared types.
- `packages/cli/src/` contains the Ink-based terminal application, command handlers, shell integration, and UI components.
- `packages/cli/bin/tegent.js` is the packaged CLI entry point.
- `packages/core/tests/` contains Vitest unit tests. `smoke.ts` is a manual, real-provider integration script.
- Root `tsconfig.json` coordinates the package project references; `pnpm-lock.yaml` records dependencies.

Keep changes in the owning package and use existing folders and module boundaries. Core changes that affect CLI behavior should include focused tests where practical.

## Build, Test, and Development Commands

Run these from the repository root:

- `pnpm install` installs workspace dependencies using the pinned pnpm version (`10.33.1`).
- `pnpm build` builds both packages recursively.
- `pnpm test` runs all configured tests recursively.
- `pnpm dev` builds `@tegent/core` and starts the CLI in development mode.
- `pnpm start` runs the built CLI.
- `pnpm --filter @tegent/core test:watch` runs Vitest interactively while developing core code.
- `pnpm exec tsx packages/core/tests/smoke.ts "your prompt"` runs the manual DeepSeek smoke test; configure `.env` from `.env.example` first.

Use `pnpm clean` to remove package build output.

## Coding Style & Naming Conventions

Use TypeScript with strict checking, ES modules, two-space indentation, and semicolons omitted. Follow nearby code for import ordering and prefer `.js` extensions in relative imports. Use `camelCase` for variables and functions, `PascalCase` for React components and classes, and descriptive kebab-free filenames such as `tool-execution.ts`. No repository lint or formatter script is currently configured; keep formatting consistent with adjacent files and verify with `pnpm build`.

## Testing Guidelines

Write Vitest tests as `*.test.ts` under `packages/core/tests/`, grouping cases with `describe` and `it`. Cover behavior and edge cases for core logic, especially tools, registries, plugins, skills, and session handling. The configured test command does not run `smoke.ts`; run it manually only when provider credentials and network access are available.

## Commit & Pull Request Guidelines

Recent commits use short Conventional Commit-style subjects such as `feat: ...`, `fix: ...`, and `chore: ...`; keep subjects concise and action-oriented. Pull requests should explain the behavior changed, identify affected packages, link related issues when applicable, and include terminal screenshots or reproduction steps for CLI/UI changes. Mention tests and any required environment variables.

## Security & Configuration Tips

Never commit `.env` or API keys. Add provider credentials only to a local `.env`, using `.env.example` as the template. Avoid logging secrets in tests, smoke scripts, or CLI output.
