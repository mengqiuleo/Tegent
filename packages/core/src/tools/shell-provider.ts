import { type ResultPromise, execa } from 'execa'

import os from 'node:os'

export type ShellType = 'bash' | 'zsh' | 'powershell'


export const MAX_SHELL_BUFFER = 20 * 1024 * 1024


export interface ShellSpawnOptions {
  timeout: number
  env?: NodeJS.ProcessEnv
  cwd?: string
  signal?: AbortSignal | undefined
}


export interface ShellProvider {
  type: ShellType
  spawn(command: string, opts: ShellSpawnOptions): ResultPromise
}

function createPosixProvider(executable: string, type: 'bash' | 'zsh'): ShellProvider {
  return {
    type,
    spawn(command, opts) {
      // execa 会从选项对象推断出 ResultPromise<具体选项类型>，在
      // exactOptionalPropertyTypes 下与接口的裸 ResultPromise<Options> 因
      // Promise.then 逆变而互不兼容，这里是一次性的边界断言。
      // 另外 exactOptionalPropertyTypes 不允许显式传 undefined，execa 的
      // cwd / cancelSignal 只接受省略，因此只在有值时才展开进选项对象。
      return execa(executable, ['-c', command], {
        timeout: opts.timeout,
        maxBuffer: MAX_SHELL_BUFFER,
        reject: false,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.signal !== undefined ? { cancelSignal: opts.signal } : {}),
        env: { ...(opts.env ?? process.env), PYTHONIOENCODING: 'utf-8' },
      }) as ResultPromise
    },
  }
}


function encodePowerShellCommand(psCommand: string): string {
  return Buffer.from(psCommand, 'utf16le').toString('base64')
}

function createPowerShellProvider(executable: string): ShellProvider {
  return {
    type: 'powershell',
    spawn(command, opts) {
      const wrapped = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        "$ProgressPreference = 'SilentlyContinue'",
        command,
        '$__ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
        'exit $__ec',
      ].join('\n')
      return execa(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(wrapped)], {
        timeout: opts.timeout,
        maxBuffer: MAX_SHELL_BUFFER,
        reject: false,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.signal !== undefined ? { cancelSignal: opts.signal } : {}),
        env: { ...(opts.env ?? process.env), PYTHONIOENCODING: 'utf-8' },
      }) as ResultPromise
    },
  }
}

// 平台分派入口：决定这个进程用哪个 provider。
export function getShellProvider(): ShellProvider {
  if (os.platform() === 'win32') {
    // Git Bash / MSYS2 / Cygwin 会把 SHELL 设成 Unix 风格路径。存在时
    // 优先用它，让 Unix 工具生态按预期工作。
    const shell = process.env.SHELL
    if (shell && /\b(bash|zsh)$/i.test(shell)) {
      return createPosixProvider(shell, shell.endsWith('zsh') ? 'zsh' : 'bash')
    }
    return createPowerShellProvider('powershell.exe')
  }
  // macOS / Linux：用登录 shell，兜底 /bin/bash。
  const userShell = process.env.SHELL ?? '/bin/bash'
  return createPosixProvider(userShell, userShell.endsWith('zsh') ? 'zsh' : 'bash')
}
