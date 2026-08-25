import { createRequire } from 'node:module'

/** ripgrep 二进制路径的缓存。首次使用时才惰性解析，之后整个进程
 *  复用同一个值。 */
const _require = createRequire(import.meta.url)

/** Cached path to the ripgrep binary. Resolved lazily on first use,
 *  reused for the rest of the process. */
let _rgPath: string | null = null

/** 解析 `glob` / `grep` 工具使用的 ripgrep 二进制路径。
 *  优先用 `@vscode/ripgrep`（它为每个平台附带预编译的二进制），失败时
 *  回退到 PATH 上的 `rg` —— 这样即使该包的 postinstall 挂了，
 *  装了系统级 ripgrep 的开发机也还能正常工作。 */
export function getRipgrepPath(): string {
  if (_rgPath) return _rgPath
  try {
    const rg = _require('@vscode/ripgrep') as { rgPath: string }
    _rgPath = rg.rgPath
  } catch {
    _rgPath = 'rg'
  }
  return _rgPath
}
