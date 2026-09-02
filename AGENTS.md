# Repository Guidelines

## Project Structure & Module Organization

Tegent is a pnpm workspace with two TypeScript packages:

- `packages/core/src/` contains the agent loop, providers, tools, MCP, plugins, skills, permissions, and shared types.
- `packages/cli/src/` contains the Ink terminal UI and command handlers; `packages/cli/bin/tegent.js` is the packaged entry point.
- `packages/core/tests/` contains Vitest tests; `smoke.ts` is a manual provider integration script.
- Root `tsconfig.json` coordinates project references.

Keep changes in the owning package and use existing folders and module boundaries. Core changes that affect CLI behavior should include focused tests where practical.

## Build, Test, and Development Commands

Run these from the repository root:

- `pnpm install` installs workspace dependencies using the pinned pnpm version (`10.33.1`).
- `pnpm build` builds both packages recursively.
- `pnpm test` runs all configured tests recursively.
- `pnpm dev` builds `@tegent/core` and starts the CLI in development mode.
- `pnpm start` runs the built CLI.
- `pnpm --filter @tegent/core test:watch` runs Vitest interactively.
- `pnpm exec tsx packages/core/tests/smoke.ts "your prompt"` runs the manual DeepSeek smoke test; configure `.env` first.

Use `pnpm clean` to remove package build output.

## Eval Workflow

The eval suite lives in `packages/core/evals/`. Configure a provider key in the root `.env`, then run `pnpm eval`. Use `pnpm eval -- --task fix-test --model deepseek:deepseek-chat` to run one task, or add `--keep` to preserve its temporary workspace. Add JSONL tasks to `packages/core/evals/tasks.jsonl`; use fixtures and checks for expected answers, file contents, JSON fields, commands, or allowed changes. Results go to ignored `packages/core/evals/results/`.

## Coding Style & Naming Conventions

Use strict TypeScript, ES modules, two-space indentation, and no semicolons. Follow nearby import ordering and use `.js` extensions in relative imports. Use `camelCase` for functions/variables, `PascalCase` for components/classes, and descriptive filenames such as `tool-execution.ts`. No lint or formatter script is configured; verify with `pnpm build`.

## Testing Guidelines

Write `*.test.ts` files under `packages/core/tests/`, using `describe` and `it`. Cover behavior and edge cases for tools, registries, plugins, skills, and sessions. The test command does not run `smoke.ts`; run it manually when credentials and network access are available.

## Commit & Pull Request Guidelines

Use short Conventional Commit-style subjects such as `feat: ...`, `fix: ...`, and `chore: ...`. Pull requests should explain the change, identify affected packages, link issues when relevant, include CLI screenshots or reproduction steps, and mention tests/configuration.

## Security & Configuration Tips

Never commit `.env` or API keys. Add provider credentials only to a local `.env`, using `.env.example` as the template. Avoid logging secrets in tests, smoke scripts, or CLI output.
