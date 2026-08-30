import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 项目内本地配置目录名。
 *  例如当前仓库里的 `.tegent/`，通常用于存放项目级自动记忆、会话数据等本地状态 */
export const TEGENT_DIR = '.tegent'


/** 用户级配置目录（默认 `~/.tegent`） */
export const USER_TEGENT_DIR = path.join(os.homedir(), '.tegent')

/**
 * @returns 用户级配置目录（默认 `~/.tegent`）的绝对路径
 */
export function userTeCodeDir(): string {
  return USER_TEGENT_DIR
}


/** 检查文件或目录是否存在。访问失败时返回 false，不向外抛异常。 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** 安全读取文本文件。读取失败时返回空字符串，适合“可选配置文件”场景。 */
export async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}


/** 安全读取并解析 JSON 文件。读取或解析失败时返回 null。 */
export async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
}
