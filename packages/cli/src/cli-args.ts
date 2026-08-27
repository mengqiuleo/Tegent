
// 这个文件从入口文件中拆出来，是为了避免 8 到 10 个 flag 加上 version/help
// 别名把 index.ts 里的启动编排逻辑挤得太长。Argv 的具体形状交给 yargs
// 根据下面的 option 链自动推断；这里刻意不手写类型，这样新增或重命名 flag 时，
// 消费方的类型也会跟着同一个定义自动更新。
import yargs from 'yargs' // 引入 yargs，用于声明和解析命令行参数。
import { hideBin } from 'yargs/helpers' // 引入 hideBin，用于去掉 node 路径和脚本路径这两个前置参数。

import { VERSION } from './version.js' // 引入当前 CLI 版本号，用于 `--version` 输出。

/**
 * 解析当前进程的 CLI 参数。
 *
 * 该函数集中定义 `xc` 支持的所有通用参数，包括模型选择、信任模式、
 * 非交互式输出、plan 模式、插件与 hook 开关、调试输出以及会话恢复。
 * 返回值由 yargs 根据 option 链推断，调用方可以直接读取对应字段。
 *
 * @returns yargs 解析后的命令行参数对象。
 */
export async function parseCliArgs() {
  // 使用 hideBin(process.argv) 取得真正由用户输入的参数。
  return yargs(hideBin(process.argv))
    // 设置帮助信息里显示的命令名。
    .scriptName('tegent')
    // 设置命令用法，其中 [prompt] 表示可以直接跟一段初始提示词。
    .usage('$0 [options] [prompt]')
    // 指定本次运行要使用的模型名称或 provider:model 形式的完整模型标识。
    .option('model', {
      // 给 --model 提供短别名 -m。
      alias: 'm',
      // 该参数接收字符串。
      type: 'string',
      // yargs help 中展示的参数说明。
      describe: 'Model to use (e.g. sonnet, deepseek, openai:gpt-4.1)',
    })
    // 开启信任模式，跳过写操作确认。
    .option('trust', {
      // 给 --trust 提供短别名 -t。
      alias: 't',
      // 该参数是布尔开关。
      type: 'boolean',
      // 默认不开启信任模式。
      default: false,
      // yargs help 中展示的参数说明。
      describe: 'Trust mode: skip write operation confirmations',
    })
    // 开启非交互式模式：输出结果后直接退出。
    .option('print', {
      // 给 --print 提供短别名 -p。
      alias: 'p',
      // 该参数是布尔开关。
      type: 'boolean',
      // 默认进入交互式 TUI。
      default: false,
      // yargs help 中展示的参数说明。
      describe: 'Non-interactive mode: output result and exit',
    })
    // 限制每次提交时 agent loop 的最大轮数。
    .option('max-turns', {
      // 该参数接收数字。
      type: 'number',
      // 不设置默认值：交互模式默认不限制轮数，用户可以按 Esc 停止。
      // 传入该值后会强制设置上限；它主要服务于没有人实时介入的 `--print` 模式。
      describe: 'Cap on agent loop iterations per submission (default: unlimited)',
    })
    // 以 plan 模式启动会话。
    .option('plan', {
      // 该参数是布尔开关。
      type: 'boolean',
      // 默认不开启 plan 模式。
      default: false,
      // 不设置短别名，因为 `-p` 已经留给 `--print`。
      // Plan 模式会把模型限制在只读探索和计划文件产出中，直到用户批准后才允许编辑代码。
      describe: 'Start the session in plan mode (read-only exploration; user must approve before code edits)',
    })
    // 控制是否加载插件发现机制。
    .option('plugins', {
      // 该参数是布尔开关。
      type: 'boolean',
      // 默认启用插件。
      default: true,
      // 这里声明为正向的 `--plugins`，并默认开启，是为了让 yargs 自动派生
      // `--no-plugins` 这个否定形式。该开关主要是诊断逃生通道：当怀疑某个插件
      // 的 skill 损坏、hook 失控或其他插件行为导致问题时，`--no-plugins`
      // 会完全跳过 loadAllPlugins，只保留内置贡献。
      describe: 'Enable plugin discovery (default true). `--no-plugins` to disable for one session.',
    })
    // 控制是否执行插件 hook。
    .option('hooks', {
      // 该参数是布尔开关。
      type: 'boolean',
      // 默认启用 hook。
      default: true,
      // 这里沿用 `--plugins` 的否定形式模式，支持 `--no-hooks`。
      // 插件本身仍会加载，skill、agent、mcp 贡献也仍会注册；只有 hook 子系统会被跳过，
      // 即使用 `emptyHookBus()` 代替插件集成构建出的 hook bus。
      // 当怀疑某个 hook 很慢或失控，但又不想失去插件其他内容时，可以使用这个开关。
      describe: 'Enable plugin hooks (default true). `--no-hooks` to skip hook execution for one session.',
    })
    // 开启插件相关的实时调试输出。
    .option('plugin-debug', {
      // 该参数是布尔开关。
      type: 'boolean',
      // 默认不把插件调试信息镜像到 stderr。
      default: false,
      // 面向插件、hook、marketplace 活动的定向调试输出。
      
      // 这样无需 tail ~/.tegent/logs/ 就能实时看到调试线索。
      // 该开关等价于设置 `XC_PLUGIN_DEBUG=1`，不会改变实际行为，只改变调试线索的输出位置。
      describe: 'Mirror plugin / hook / marketplace debug breadcrumbs to stderr (also XC_PLUGIN_DEBUG=1).',
    })
    // 恢复当前项目最近一次会话，不打开选择器。
    .option('continue', {
      // 给 --continue 提供短别名 -c。
      alias: 'c',
      // 该参数是布尔开关。
      type: 'boolean',
      // 默认不自动继续上次会话。
      default: false,
      // yargs help 中展示的参数说明。
      describe: 'Resume the most recent session in this project (no picker)',
    })
    // 恢复指定会话，或在不带值时打开会话选择器。
    .option('resume', {
      // 给 --resume 提供短别名 -r。
      alias: 'r',
      // 该参数接收字符串；不带值时 yargs 会给出空字符串。
      type: 'string',
      // 该值是可选的：`xc --resume` 不带值时打开选择器；
      // `xc --resume <id-or-slug>` 会直接跳到文件名匹配的会话。
      // yargs 会把它当成 string 类型 flag，因此：
      // `argv.resume === undefined` 表示用户没有传该 flag；
      // `''` 表示用户传了 flag 但没有给值；
      // 其他字符串表示用户输入的查询 key。
      describe: 'Resume a session: `--resume` opens the picker; `--resume <id>` jumps directly',
    })
    // 注册 `--version` 输出，内容来自当前包版本。
    .version(VERSION)
    // 给 `--version` 增加短别名 `-v`。
    .alias('v', 'version')
    // 注册 `--help` 输出。
    .help()
    // 给 `--help` 增加短别名 `-h`。
    .alias('h', 'help')
    // 执行解析并返回 argv；因为函数是 async，返回值会被 Promise 包裹。
    .parse()
}
