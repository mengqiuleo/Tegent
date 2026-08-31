// 正式构建时，版本号由 esbuild 的 define 机制在构建期注入。
// 全局常量 __CLI_VERSION__ 来自 esbuild.config.js 对 package.json 的读取，
// 因此发布产物运行时不需要再访问文件系统。使用 `tsx src/index.ts`
// 启动开发模式时，则回退为从本地 package.json 中读取版本号。
import { existsSync, readFileSync } from 'node:fs' 
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
function resolveVersion(): string { 
  // 构建期 define 注入的版本号优先级最高。
  if (typeof __CLI_VERSION__ === 'string' && __CLI_VERSION__) { 
    return __CLI_VERSION__
  } 

  // 开发模式回退：从当前文件目录开始向上查找 package.json。
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
