import yargs from 'yargs'
import { hideBin } from 'yargs/helpers' // 引入 hideBin，用于去掉 node 路径和脚本路径这两个前置参数。

export async function parseCliArgs() {
  return yargs(hideBin(process.argv))
    .scriptName('tegent')
    // 设置命令用法，其中 [prompt] 表示可以直接跟一段初始提示词。
    .usage('$0 [options] [prompt]')
    .option('model', {
      alias: 'm',
      type: 'string',
      describe: 'Model to use (e.g. sonnet, deepseek, openai:gpt-4.1)',
    })
    .option('trust', {
      alias: 't',
      type: 'boolean',
      default: false,
      describe: 'Trust mode: skip write operation confirmations',
    })
    .option('max-turns', {
      type: 'number',
      // 不设置默认值：交互模式默认不限制轮数，用户可以按 Esc 停止。
      // 传入该值后会强制设置上限
      describe: 'Cap on agent loop iterations per submission (default: unlimited)',
    })
    .option('plan', {
      type: 'boolean',
      default: false,
      // 不设置短别名，因为 `-p` 已经留给 `--print`。
      // Plan 模式会把模型限制在只读探索和计划文件产出中，直到用户批准后才允许编辑代码。
      describe: 'Start the session in plan mode (read-only exploration; user must approve before code edits)',
    })
    .option('plugins', {
      type: 'boolean',
      default: true,
      describe: 'Enable plugin discovery (default true). `--no-plugins` to disable for one session.',
    })
    .option('hooks', {
      type: 'boolean',
      default: true,
      describe: 'Enable plugin hooks (default true). `--no-hooks` to skip hook execution for one session.',
    })
    .help()
    .alias('h', 'help')
    .parse()
}