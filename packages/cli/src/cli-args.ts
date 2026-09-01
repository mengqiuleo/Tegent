// --version / --help 两个标准
import yargs from 'yargs' 
import { hideBin } from 'yargs/helpers' 

import { VERSION } from './version.js' 

/**
 * 解析当前进程的 CLI 参数。
 *
 * 该函数不注册任何配置选项；启动时的行为完全由用户配置文件
 * （~/.tegent/config.json）和环境变量决定，其余配置都在进入交互模式后
 * 用斜杠命令完成。解析只为让 yargs 处理 --version / --help。
 *
 * @returns yargs 解析后的命令行参数对象。
 */
export async function parseCliArgs() {
  // 使用 hideBin(process.argv) 取得真正由用户输入的参数。
  return yargs(hideBin(process.argv))
    .scriptName('tegent')
    .usage('$0')
    .version(VERSION)
    .alias('v', 'version')
    .help()
    .alias('h', 'help')
    .parse()
}
