/**
 * run.ts — 命令行入口（简单版）：`pnpm eval:jsonl`（见 package.json）。
 *
 * 流程：
 *   解析命令行参数 → 解析模型 → 加载并筛选任务
 *   → 逐条跑（harness）→ 实时打印每条结果
 *   → 汇总写入 results/<runId>.json + .md → 有失败则退出码 1
 *
 * 与 run-vitest.ts 的区别：这条链路不依赖 vitest，输出是自制的
 * JSON + Markdown 报告，适合快速本地跑一把看结果。
 */

import { config as loadEnv } from 'dotenv'

import { createModelRegistry, resolveModelId } from '../../core/src/index.js'

import { buildRunArtifact, writeRunArtifacts } from './artifacts.js'
import { defaultFixturesDir, defaultResultsDir, loadEvalTasks, repoRoot, selectEvalTasks } from './tasks.js'
import { TegentCodingAgentHarness } from './tegent-harness.js'
import type { EvalResult, EvalTask, RunOptions } from './types.js'

// 读取仓库根目录 .env，让模型 API key 等配置生效
loadEnv({ path: `${repoRoot}/.env` })

/**
 * 手工解析命令行参数（不引入 yargs 等依赖，保持零负担）：
 *   --model <provider:model>  指定评测模型
 *   --task <id>               只跑某条任务
 *   --max-turns <n>           每任务最大轮数（默认 20）
 *   --keep                    保留临时工作区
 *   -h, --help                打印帮助并退出
 */
function parseArgs(argv: string[]): RunOptions {
  const options: RunOptions = { maxTurns: 20, keepWorkspaces: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // "--model foo" 的值在下一个参数里，所以用 ++i 取值后循环再跳过
    if (arg === '--model') options.modelId = argv[++i]
    else if (arg === '--task') options.taskId = argv[++i]
    else if (arg === '--max-turns') options.maxTurns = Number(argv[++i])
    else if (arg === '--keep') options.keepWorkspaces = true
    else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: pnpm eval -- [options]',
          '',
          'Options:',
          '  --model <provider:model>  Model to evaluate; defaults to Tegent config',
          '  --task <id>              Run one task instead of the full set',
          '  --max-turns <n>          Maximum turns per task (default: 20)',
          '  --keep                   Keep temporary workspaces for debugging',
        ].join('\n'),
      )
      process.exit(0)
    }
  }

  // --max-turns 传了非正整数（如 0 / abc）直接报错
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) {
    throw new Error('--max-turns must be a positive integer')
  }
  return options
}

/** 在终端打印一条任务的判卷结果：PASS/FAIL + 每条 check 的详情 */
function printResult(result: EvalResult): void {
  const status = result.success ? 'PASS' : 'FAIL'
  console.log(`${status} ${result.id} | ${result.turnCount} turns | ${result.toolCalls} tools | ${(result.durationMs / 1000).toFixed(1)}s`)
  for (const check of result.checks) console.log(`  ${check.passed ? 'ok' : '!!'} ${check.message}`)
  for (const error of result.errors) console.log(`  error: ${error}`)
  // 仅 --keep 时有 workspacePath，提示工作区位置方便手动检查
  if (result.workspacePath) console.log(`  workspace: ${result.workspacePath}`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  // resolveModelId：把 "--model deepseek:deepseek-chat" 或 .env 配置解析成实际模型 ID
  const requestedModelId = resolveModelId(options.modelId)
  if (!requestedModelId) {
    throw new Error('No model configured. Set a provider API key in .env or pass --model provider:model.')
  }

  // 加载 tasks.jsonl 全部任务；--task 时只留那一条
  const selectedTasks = selectEvalTasks(await loadEvalTasks(), options.taskId)

  // 从注册表拿到真正的 LanguageModel 实例（封装了对应 provider 的 API 调用）
  const registry = createModelRegistry()
  const model = registry.languageModel(requestedModelId as `${string}:${string}`)
  // runId 用当前时间生成，如 20260904101530 —— 同时用于报告文件名和工作区目录名
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const harness = new TegentCodingAgentHarness({
    modelId: requestedModelId,
    model,
    maxTurns: options.maxTurns,
    keepWorkspaces: options.keepWorkspaces,
    runId,
    fixturesDir: defaultFixturesDir,
  })
  const results: EvalResult[] = []

  // 串行跑每条任务（避免并发互相干扰 cwd / 限流），边跑边打印
  console.log(`Running ${selectedTasks.length} eval task(s) with ${requestedModelId}`)
  for (const task of selectedTasks) {
    const result = await harness.run(task)
    results.push(result)
    printResult(result)
  }

  // 组装并写出 results/<runId>.json 和 results/<runId>.md
  const artifact = buildRunArtifact({
    runId,
    modelId: requestedModelId,
    createdAt: new Date().toISOString(),
    results,
  })
  const writtenArtifacts = await writeRunArtifacts(defaultResultsDir, artifact)

  // 最后打印总结；有任务失败就把进程退出码置 1（CI 可以据此判红）
  const passed = results.filter((result) => result.success).length
  console.log(`\nSummary: ${passed}/${results.length} passed`)
  console.log(`Results: ${writtenArtifacts.jsonPath}`)
  console.log(`Markdown: ${writtenArtifacts.summaryPath}`)
  if (passed !== results.length) process.exitCode = 1
}

// CLI 入口：捕获异常只打印消息（不打印堆栈，保持输出干净），退出码 1
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
