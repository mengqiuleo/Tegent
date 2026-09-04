/**
 * vitest.eval.config.ts — 专给 `pnpm eval` 用的 vitest 配置。
 *
 * 单测（`pnpm test`）继续吃默认 include（只认 *.test.ts / *.spec.ts），
 * 而评测文件是 evals/*.eval.ts 后缀，不写进 include 的话 vitest 一个都
 * 收不到（命令行位置参数只是 filter，不能替代 include）。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 只收集评测文件；不用默认的 *.test.ts 模式
    include: ['evals/**/*.eval.ts'],
    // 每条任务要跑完整 agent 循环（最多 20 轮），vitest-evals 默认 60s 不够用
    testTimeout: 10 * 60 * 1000,
  },
})
