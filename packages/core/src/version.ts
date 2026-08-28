import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FALLBACK_VERSION = '0.0.0-dev'

function resolveVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 8; i++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string }
        if ((pkg.name === '@tegent/core' || pkg.name === '@tegent/cli') && pkg.version) {
          return pkg.version
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {

  }
  return FALLBACK_VERSION
}

export const VERSION = resolveVersion()
