// 正式构建时，版本号由 esbuild 的 define 机制在构建期注入。
// 全局常量 __CLI_VERSION__ 来自 esbuild.config.js 对 package.json 的读取，
// 因此发布产物运行时不需要再访问文件系统。使用 `tsx src/index.ts`
// 启动开发模式时，则回退为从本地 package.json 中读取版本号。
import { existsSync, readFileSync } from 'node:fs' // 引入同步文件工具，用于开发模式查找并读取 package.json。
import { dirname, join } from 'node:path' // 引入路径工具，用于向上遍历目录并拼接 package.json 路径。
import { fileURLToPath } from 'node:url' // 引入 URL 转路径工具，用于把 import.meta.url 转成本地文件路径。

declare const __CLI_VERSION__: string | undefined // 声明构建期注入的全局版本常量；开发模式下可能不存在。

/**
 * 解析当前 CLI 的版本号。
 *
 * 正式构建产物优先使用构建期注入的 `__CLI_VERSION__`，以避免运行时文件读取。
 * 如果该值不存在，则认为当前可能运行在 tsx 开发模式中，于是从当前文件所在目录
 * 开始向上查找 `@tegent/cli` 的 package.json，并读取其中的 version 字段。
 * 所有失败都会回退到 `0.0.0-dev`。
 *
 * @returns 当前 CLI 版本号；无法解析时返回开发占位版本 `0.0.0-dev`。
 */
function resolveVersion(): string { // 定义内部版本解析函数。
  // 构建期 define 注入的版本号优先级最高。
  if (typeof __CLI_VERSION__ === 'string' && __CLI_VERSION__) { // 确认全局版本常量存在且非空。
    return __CLI_VERSION__ // 返回构建期注入的版本号。
  } // 结束构建期版本判断。
  // 开发模式回退：从当前文件目录开始向上查找 package.json。
  try { // 捕获路径解析、文件读取和 JSON 解析中的任意失败。
    let dir = dirname(fileURLToPath(import.meta.url)) // 取得当前模块文件所在目录，作为向上查找的起点。
    for (let i = 0; i < 6; i++) { // 最多向上检查 6 层目录，避免意外无限查找。
      const pkgPath = join(dir, 'package.json') // 拼出当前目录下 package.json 的候选路径。
      if (existsSync(pkgPath)) { // 如果当前目录存在 package.json，就尝试读取它。
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string } // 读取并解析 package.json，只关心 name 和 version。
        if (pkg.name === '@tegent/cli' && pkg.version) { // 确认这是 CLI 包自己的 package.json，且存在 version 字段。
          return pkg.version // 返回 package.json 中声明的版本号。
        } // 结束目标 package.json 判断。
      } // 结束 package.json 存在性判断。
      const parent = dirname(dir) // 计算当前目录的父目录。
      if (parent === dir) break // 如果已经到达文件系统根目录，就停止查找。
      dir = parent // 把查找目录上移一层，继续下一轮。
    } // 结束向上查找循环。
  } catch { // 任意失败都会进入这里。
    // 解析失败时继续走最终兜底版本号，不影响 CLI 启动。
  } // 结束开发模式回退解析。
  return '0.0.0-dev' // 无法解析真实版本时，返回开发占位版本。
} // 结束版本解析函数。

export const VERSION = resolveVersion() // 导出当前 CLI 版本号，供参数解析和更新检查等模块使用。
