import os from 'node:os'
import path from 'node:path'


/** 项目内本地配置目录名。
 *  例如当前仓库里的 `.tegent/`，通常用于存放项目级自动记忆、会话数据等本地状态。 */
export const TEGENT_DIR = '.tegent'

/** 用户级配置目录（默认 `~/.tegent`）。 */
export const USER_TEGENT_DIR = path.join(os.homedir(), '.tegent')