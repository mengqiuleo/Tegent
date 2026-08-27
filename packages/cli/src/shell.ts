
// 多个启动提示函数都需要知道用户当前使用的 Shell，才能生成正确的复制粘贴命令。
// formatPersistCommand 用来集中维护原本散落在 printNoApiKeyMessage
// 和 printNoWebSearchKeyHint 中重复出现的 switch(shell) 逻辑。

// CLI 当前支持生成持久化命令的 Shell 类型集合。
export type ShellType = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'sh'

/**
 * 检测当前进程所在的 Shell 类型。
 *
 * Windows 下优先通过 PSModulePath 判断 PowerShell，否则回退为 cmd。
 * 非 Windows 下优先读取 SHELL 环境变量中的可执行文件名；无法识别时，
 * macOS 默认使用 zsh，其他平台默认使用 bash。
 *
 * @returns 当前推断出的 Shell 类型。
 */
export function detectShell(): ShellType {
  // Windows 平台没有通用的 SHELL 环境变量，因此需要单独判断。
  if (process.platform === 'win32') {
    // PowerShell 通常会设置 PSModulePath，可作为轻量检测依据。
    if (process.env.PSModulePath) return 'powershell'
    // Windows 上未检测到 PowerShell 时，默认按 CMD 生成命令。
    return 'cmd'
  }
  // Unix-like 平台通常会通过 SHELL 暴露当前用户的登录 Shell 路径。
  const shellPath = process.env.SHELL ?? ''
  // 只取路径最后一段，例如 /bin/zsh 会得到 zsh。
  const base = shellPath.split('/').pop() ?? ''
  // 如果识别到项目支持的 Shell 名称，就直接返回。
  if (base === 'zsh' || base === 'bash' || base === 'fish' || base === 'sh') return base
  // macOS 默认 Shell 近年是 zsh，因此无法识别时优先给 zsh 命令。
  if (process.platform === 'darwin') return 'zsh'
  // 其他 Unix-like 环境默认回退到 bash，覆盖多数 Linux 发行版场景。
  return 'bash'
}

/**
 * 生成一条可复制粘贴的环境变量持久化命令。
 *
 * 返回值只包含命令本身，不包含提示前缀或换行；调用方负责用 chalk
 * 添加颜色以及拼接周围的说明文案。
 *
 * @param envVar - 要持久化的环境变量名，例如 `ANTHROPIC_API_KEY`。
 * @param exampleValue - 展示给用户的示例变量值，例如 `sk-ant-...`。
 * @param shell - detectShell 返回的 Shell 类型。
 * @returns 与指定 Shell 匹配的环境变量持久化命令。
 */
export function formatPersistCommand(envVar: string, exampleValue: string, shell: ShellType): string {
  // 根据不同 Shell 的配置机制，返回对应的持久化写入命令。
  switch (shell) {
    case 'powershell':
      // PowerShell 使用 .NET API 写入用户级环境变量。
      return `[Environment]::SetEnvironmentVariable('${envVar}','${exampleValue}','User')`
    case 'cmd':
      // CMD 使用 setx 写入用户环境变量，后续新开的终端会读取到。
      return `setx ${envVar} "${exampleValue}"`
    case 'zsh':
      // zsh 将 export 语句追加到 ~/.zshrc，并立即 source 让当前终端生效。
      return `echo 'export ${envVar}=${exampleValue}' >> ~/.zshrc && source ~/.zshrc`
    case 'fish':
      // fish 使用 universal variable，天然跨会话持久保存。
      return `set -Ux ${envVar} ${exampleValue}`
    case 'bash':
    default:
      // bash 和兜底分支都写入 ~/.bashrc，并立即 source 让当前终端生效。
      return `echo 'export ${envVar}=${exampleValue}' >> ~/.bashrc && source ~/.bashrc`
  }
}
