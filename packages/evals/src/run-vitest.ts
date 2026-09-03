/**
 * run-vitest.ts — 命令行入口（vitest 版）：`pnpm eval`（见 package.json）。
 *
 * 这是个"启动器"脚本：它自己不跑评测，而是把命令行参数翻译成
 * 环境变量，再 spawn 一个子进程（真正的评测逻辑在 evals/coding.eval.ts
 * 这个 vitest 测试文件里，它会读取这里设置的环境变量 TEGENT_EVAL_MODEL 等）：
 *
 * （注意：下面的命令含通配符路径，若写进块注释会被误认成注释结束符，因此改用行注释书写）
 */

// pnpm exec vitest run --config vitest.eval.config.ts \
//   --reporter=vitest-evals/reporter --reporter=json \
//   --outputFile.json=results/vitest-results.json

/**
 *
 * 与 run.ts 的区别：这条链路跑在 vitest 里，享受 vitest-evals 的
 * 富报告（可用 `pnpm eval:report` 起本地服务器看结果）。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { defaultResultsDir, evalPackageDir } from './tasks.js'

/** 解析后的 CLI 选项；passthrough 收集不认识的参数原样转交给 vitest */
type VitestEvalCliOptions = {
  modelId?: string
  taskId?: string
  maxTurns?: number
  keepWorkspaces: boolean
  /** --info：让 reporter 输出更详细的信息 */
  info: boolean
  /** 透传给 vitest 的额外参数（如 -t "fix-test" 过滤测试名） */
  passthrough: string[]
}

/** 打印帮助文本 */
function printHelp(): void {
  console.log(
    [
      'Usage: pnpm eval -- [options] [vitest options]',
      '',
      'Options:',
      '  --model <provider:model>  Model to evaluate; defaults to Tegent config',
      '  --task <id>              Run one task instead of the full set',
      '  --max-turns <n>          Maximum turns per task (default: 20)',
      '  --keep                   Keep temporary workspaces for debugging',
      '  --info                   Print detailed vitest-evals reporter output',
      '  -h, --help               Show this help',
      '',
      'Examples:',
      '  pnpm eval -- --task fix-test --model deepseek:deepseek-chat',
      '  pnpm eval -- --info --task scope-control',
    ].join('\n'),
  )
}

/**
 * 手工解析 CLI 参数（与 run.ts 的 parseArgs 同风格）。
 * 区别：不认识的参数不报错，而是收进 passthrough 传给 vitest。
 */
function parseArgs(argv: string[]): VitestEvalCliOptions {
  const options: VitestEvalCliOptions = { keepWorkspaces: false, info: false, passthrough: [] }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--model') options.modelId = argv[++i]
    else if (arg === '--task') options.taskId = argv[++i]
    else if (arg === '--max-turns') options.maxTurns = Number(argv[++i])
    else if (arg === '--keep') options.keepWorkspaces = true
    else if (arg === '--info' || arg === '--verbose' || arg === '-v') options.info = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--') {
      // `pnpm run eval -- <args>` 会把分隔符 -- 原样转发进来（打头出现）。
      // 文档用法是把启动器 flag 放在 -- 之后，所以这里直接丢弃分隔符、
      // 继续正常解析，而不是切换成"其后全部透传"；否则若原样透传给
      // vitest，-- 后面的 flag 会被它当成位置参数（文件过滤）而失效。
      continue
    } else options.passthrough.push(arg)
  }

  // --max-turns 传了但不是正整数时报错（未传时是 undefined，跳过校验）
  if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)) {
    throw new Error('--max-turns must be a positive integer')
  }
  return options
}

/**
 * 启动 vitest 子进程跑评测。
 *
 * 参数传递不走命令行（怕被 vitest 抢着解析），而是全部塞进环境变量：
 *   TEGENT_EVAL_MODEL         评测模型
 *   TEGENT_EVAL_TASK          只跑这条任务
 *   TEGENT_EVAL_MAX_TURNS     最大轮数
 *   TEGENT_EVAL_KEEP_WORKSPACES  保留工作区（"1" = 开）
 *   VITEST_EVALS_REPORT_LEVEL  reporter 详细程度（--info 时设为 info）
 *
 * @returns 子进程退出码（null = 被信号杀死），main() 会把它设为进程退出码
 */
async function runVitest(options: VitestEvalCliOptions): Promise<number | null> {
  // 确保 results/ 目录存在，vitest 的 json reporter 要往里写文件
  await fs.mkdir(defaultResultsDir, { recursive: true })
  // Windows 上 pnpm 的可执行文件是 pnpm.cmd
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  // 注意：这里用的是相对路径 results/...，配合下面的 cwd: evalPackageDir
  const outputFile = path.join('results', 'vitest-results.json')
  const args = [
    'exec',
    'vitest',
    'run',                       // run 模式：跑完就退出（不带 watch）
    '--config',                  // 用专门的评测配置（include 只认 evals/*.eval.ts，
    'vitest.eval.config.ts',     //   默认的 *.test.ts include 收不到评测文件）
    '--reporter=vitest-evals/reporter', // vitest-evals 的富报告（终端展示）
    '--reporter=json',           // 同时输出机器可读的 JSON
    `--outputFile.json=${outputFile}`,  // JSON 写到 results/vitest-results.json
    ...options.passthrough,      // 用户透传的 vitest 参数
  ]
  const env = {
    ...process.env,
    ...(options.modelId ? { TEGENT_EVAL_MODEL: options.modelId } : {}),
    ...(options.taskId ? { TEGENT_EVAL_TASK: options.taskId } : {}),
    ...(options.maxTurns ? { TEGENT_EVAL_MAX_TURNS: String(options.maxTurns) } : {}),
    ...(options.keepWorkspaces ? { TEGENT_EVAL_KEEP_WORKSPACES: '1' } : {}),
    ...(options.info ? { VITEST_EVALS_REPORT_LEVEL: 'info' } : {}),
  }

  // stdio: 'inherit' 让子进程直接共享当前终端 —— vitest 的输出实时可见
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: evalPackageDir, // 在 packages/evals 目录下执行，保证路径正确
      env,
      stdio: 'inherit',
      windowsHide: true,
    })

    // 启动失败（如 pnpm 不存在）→ reject；正常结束 → resolve 退出码
    child.on('error', reject)
    child.on('close', resolve)
  })
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  // vitest 的退出码就是我们的退出码；null（被信号杀）视为失败 1
  const exitCode = await runVitest(options)
  process.exitCode = exitCode ?? 1
}

// CLI 入口：只打印错误消息，退出码 1
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
