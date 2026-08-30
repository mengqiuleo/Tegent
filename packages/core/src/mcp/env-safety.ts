// ── 这个文件在防什么 ────────────────────────────────────────────────
//
// stdio 型 MCP 服务器是本 CLI 用 spawn() 拉起的子进程，配置里的`env` 会原样传给它。`env` 有两个来源：
//   1. 用户自己写的 mcp.json（用户级或项目级）；
//   2. 插件 manifest 自带的 mcpServers。
//
// 要防的是第 2 种。用户安装插件时，授予的信任只是“允许它提供
// 这些 MCP 工具”，并不包括“允许它在我机器上执行任意代码”。
// 但有一类环境变量会在进程启动的一瞬间被运行时读取、并执行
// 其中指定的代码。比如插件在 manifest 里写：
//
//   "env": { "NODE_OPTIONS": "--require ./evil.js" }
//
// 那么下次我们 spawn 这个 Node 写的 MCP 服务器时，Node 会先
// 加载并运行 evil.js，再运行服务器本身的代码 —— 插件没有写
// 任何攻击代码，仅凭一条“配置”就拿到了以当前用户身份执行
// 任意代码的能力。Linux 的 LD_PRELOAD、macOS 的
// DYLD_INSERT_LIBRARIES，以及 Python/Perl/Ruby 的启动钩子
// 都属于这一类“启动即执行”的变量。
//
// 防御方式：维护下面这份危险键黑名单，在真正 spawn 之前（即
// registry.connectOneServer，所有配置来源的必经之路）检查 `env`，
// 命中就把该服务器标记为 failed、拒绝连接。
//
// 为什么用黑名单而不是白名单：MCP 服务器经常需要业务自定义的
// 环境变量（API token、应用配置等），白名单会把它们全部拦掉；
// 黑名单只拦“启动时加载代码”这一小类，正常使用不受影响。

/** 危险键黑名单。共同点：进程启动时运行时会读取它们，并执行 /
 *  加载其中指定的代码或库（“启动钩子”）。键名比较时统一转大写，
 *  见 {@link assertSafeEnv}。 */
const DANGEROUS_ENV_KEYS = new Set<string>([
  // Node 启动参数：NODE_OPTIONS 里的 --require 能让任意脚本
  // 先于服务器代码执行。
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

/** 检查未通过时抛出的错误，`key` 是命中的那个危险键名。 */
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
 * 检查即将传给 stdio 子进程的 `env`：只要有一个键命中上面的黑名单，
 * 就抛 {@link UnsafeEnvError}。调用方（connectOneServer）会捕获该错误，
 * 把对应服务器标记为 failed，不影响其他服务器启动。
 *
 * 键名比较前统一转大写。原因：Windows 的环境变量名在系统层面
 * 不区分大小写，`Node_Options` 和 `NODE_OPTIONS` 在那里是同一个
 * 变量 —— 只拦大写写法等于没拦。POSIX 虽然区分大小写，但没有
 * 正当场景会靠小写变体来使用这些危险键，统一拦掉没有副作用。
 *
 * @param env 即将传给 stdio 子进程的环境变量映射。
 * @throws {UnsafeEnvError} 发现危险键时抛出。
 */
export function assertSafeEnv(env: Record<string, string> | undefined): void {
  if (!env) return
  for (const k of Object.keys(env)) {
    if (DANGEROUS_ENV_KEYS.has(k.toUpperCase())) {
      throw new UnsafeEnvError(k)
    }
  }
}
