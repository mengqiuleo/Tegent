// MCP stdio 服务器的 `env` 会直接传给 spawn()。它可能来自：
//   1. 用户执行 `xc mcp add --env KEY=VAL`；
//   2. 用户级或项目级 mcp.json；
//   3. 插件 manifest 自带的 mcpServers。
//
// 本模块重点防护第三种来源。用户在安装插件时授予了插件信任，
// 但类似 `NODE_OPTIONS=--require ./evil.js` 的键可以让插件在下次
// 启动 Node MCP 服务器时执行任意代码，把“安装 manifest”的信任
// 升级成用户账户下的代码执行。Linux 的 LD_PRELOAD、macOS 的
// DYLD_INSERT_LIBRARIES，以及 Python/Perl/Ruby 的启动钩子也有类似风险。
//
// 校验放在真正 spawn 之前的 registry.connectOneServer 边界，
// 因而所有配置来源都会经过同一个检查，而不仅是 CLI 参数。
//
// 这里使用拒绝名单而不是允许名单：MCP 服务器通常需要任意环境变量
// 来传递 token 或应用配置，允许名单会破坏正常使用；拒绝名单只拦截
// “启动时加载代码”这一类高风险变量。

/** 运行时会解释为“启动时加载代码”的环境变量名称。
 *  比较时忽略大小写，具体见 {@link assertSafeEnv}。 */
const DANGEROUS_ENV_KEYS = new Set<string>([
  // Node 启动参数。
  'NODE_OPTIONS',
  // Linux 动态链接器。
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  // macOS 动态链接器。
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  // Shell 初始化和每条命令的钩子：BASH_ENV 影响非交互 bash，
  // ENV 影响 POSIX sh，PROMPT_COMMAND 影响每次交互式提示符。
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  // Python 启动和模块搜索路径。
  'PYTHONSTARTUP',
  'PYTHONPATH',
  // Perl 启动参数和模块搜索路径。
  'PERL5OPT',
  'PERL5LIB',
  // Ruby 启动参数和模块搜索路径。
  'RUBYOPT',
  'RUBYLIB',
])

export class UnsafeEnvError extends Error {
  constructor(public readonly key: string) {
    super(
      `Env key "${key}" is blocked by the MCP env safety check: it is a runtime ` +
        `code-loading hook (NODE_OPTIONS / LD_PRELOAD-class) and would let an MCP ` +
        `config or plugin manifest run arbitrary code at server start. If you ` +
        `really need this, export it in the shell that launches xc instead.`,
    )
    this.name = 'UnsafeEnvError'
  }
}

/**
 * 当 `env` 包含拒绝名单中的键时抛出 {@link UnsafeEnvError}。
 *
 * 比较时忽略大小写。Windows 在操作系统层面不区分环境变量名大小写，
 * 只拒绝 `NODE_OPTIONS` 却放过 `Node_Options` 没有实际安全价值。
 * POSIX 虽然区分大小写，但正常配置不会依赖这些危险键的非大写变体。
 *
 * @param env 即将传给 stdio 子进程的环境变量映射。
 * @throws {UnsafeEnvError} 发现高风险环境变量时抛出。
 */
export function assertSafeEnv(env: Record<string, string> | undefined): void {
  if (!env) return
  for (const k of Object.keys(env)) {
    if (DANGEROUS_ENV_KEYS.has(k.toUpperCase())) {
      throw new UnsafeEnvError(k)
    }
  }
}
