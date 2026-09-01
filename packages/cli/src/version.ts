// 版本号在运行时通过向上查找 @tegent/cli 的 package.json 解析。
// npm 发布的包总会自带 package.json（npm 强制将其打入 tarball），因此无论是
// `tsx src/index.ts` 开发模式，还是从 dist/ 运行的构建产物（含 npm 安装后的
// 全局 bin），都能在包根目录找到它。查找基于 import.meta.url 而非 cwd，
// 在任意工作目录下执行 CLI 均可正确解析。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 解析当前 CLI 的版本号。
 *
 * 从当前文件所在目录开始向上（最多 6 层）查找 `@tegent/cli` 的 package.json，
 * 读取其中的 version 字段。开发模式下当前文件位于 src/，构建产物位于 dist/，
 * 向上一层即可到达包根目录；npm 安装后 package.json 依然在包根目录，逻辑不变。
 * 所有失败路径都会回退到 `0.0.0-dev`。
 *
 * @returns 当前 CLI 版本号；无法解析时返回开发占位版本 `0.0.0-dev`。
 */
function resolveVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string }
        if (pkg.name === '@tegent/cli' && pkg.version) {
          return pkg.version
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {

  }
  return '0.0.0-dev'
}

export const VERSION = resolveVersion()
