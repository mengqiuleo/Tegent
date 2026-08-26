import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 只收集真正的单测；tests/smoke.ts 是需要手动执行、真实调模型的冒烟脚本。
    include: ['tests/**/*.test.ts'],
  },
})
