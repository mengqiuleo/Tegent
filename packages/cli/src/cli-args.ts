
// 这个文件从入口文件中拆出来，是为了让参数解析逻辑不把 index.ts 里的
// 启动编排逻辑挤得太长。CLI 不提供任何配置类 flag——模型、plan 模式、
// 插件、会话恢复等全部在进入交互模式后，通过 /model、/plan、/plugin、
// /resume 等斜杠命令自行配置。这里只保留位置参数（初始提示词）和
// --version / --help 两个标准入口。
import yargs from 'yargs' // 引入 yargs，用于声明和解析命令行参数。
import { hideBin } from 'yargs/helpers' // 引入 hideBin，用于去掉 node 路径和脚本路径这两个前置参数。

import { VERSION } from './version.js' // 引入当前 CLI 版本号，用于 `--version` 输出。

/**
 * 解析当前进程的 CLI 参数。
 *
 * 该函数不注册任何配置选项；启动时的行为完全由用户配置文件
 * （~/.tegent/config.json）和环境变量决定，其余配置都在进入交互模式后
 * 用斜杠命令完成。返回值由 yargs 推断，调用方主要读取 `_`（位置参数）。
 *
 * @returns yargs 解析后的命令行参数对象。
 */
export async function parseCliArgs() {
  // 使用 hideBin(process.argv) 取得真正由用户输入的参数。
  return yargs(hideBin(process.argv))
    // 设置帮助信息里显示的命令名。
    .scriptName('tegent')
    // 设置命令用法，其中 [prompt] 表示可以直接跟一段初始提示词。
    .usage('$0 [prompt]')
    // 注册 `--version` 输出，内容来自当前包版本。
    .version(VERSION)
    // 给 `--version` 增加短别名 -v。
    .alias('v', 'version')
    // 注册 `--help` 输出。
    .help()
    // 给 `--help` 增加短别名 -h。
    .alias('h', 'help')
    // 执行解析并返回 argv；因为函数是 async，返回值会被 Promise 包裹。
    .parse()
}
