// 该模块替换 hook 命令字符串中的 `${name}` 和 `${env:NAME}` 模式。未知变量会保留
// 原始文本，例如 `${name}`，这样拼写错误会体现在最终 shell 命令的错误信息里，而不是
// 静默展开为空字符串。后者很容易导致“command not found”一类错误，却看不出真正问题
// 出在变量名上。
//
// 支持的变量见 [[plugin-marketplace-design]] 第 8.4 节：
//
//    ${pluginDir}      所属插件安装目录的绝对路径
//                      （版本化缓存目录，重新安装或升级时可能被清理）
//    ${pluginDataDir}  插件持久化数据目录的绝对路径
//                      （~/.tegent/plugins/data/<sanitised-plugin-id>/）
//                      卸载重装和版本升级后仍会保留。调用方会在展开前按需创建该目录；
//                      本模块只负责替换字符串。
//    ${cwd}            当前工作目录
//    ${homedir}        用户主目录
//    ${sep}            当前系统的路径分隔符（Windows 为 `\`，其他系统为 `/`）
//    ${env:NAME}       进程环境变量 `NAME`，未设置时为空字符串
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pluginDataDir as pluginDataDirPath } from '../plugins/paths.js'

export interface VariableContext {
  pluginDir: string
  /** 插件级持久化数据目录；传入 `pluginId` 时由 [[buildVariableContext]] 预先创建。 */
  pluginDataDir?: string
  cwd: string
  homedir?: string
  sep?: string
}

/**
 * 根据当前进程和调用方上下文构造默认变量。
 *
 * 传入 `pluginId` 后会启用 `${pluginDataDir}`：函数会解析插件专属数据目录并执行
 * 递归创建，让插件脚本可以立即写入。目录已存在时，mkdirSync 基本只是一次廉价空操作。
 *
 * @param input 构造变量所需的插件目录、工作目录和可选插件 id。
 * @returns 可传给 [[expandVariables]] 的变量上下文。
 */
export function buildVariableContext(input: { pluginDir: string; cwd: string; pluginId?: string }): VariableContext {
  let dataDir: string | undefined
  if (input.pluginId) {
    dataDir = pluginDataDirPath(input.pluginId)
    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch {

    }
  }
  return {
    pluginDir: input.pluginDir,
    pluginDataDir: dataDir,
    cwd: input.cwd,
    homedir: os.homedir(),
    sep: path.sep,
  }
}

/**
 * 展开 hook 命令中的变量引用。
 *
 * 支持 `${pluginDir}`、`${pluginDataDir}`、`${cwd}`、`${homedir}`、`${sep}` 和
 * `${env:NAME}`。未知变量或未知命名空间会保留原样，方便最终 shell 错误暴露原始问题。
 *
 * @param source 原始 hook 命令字符串。
 * @param ctx 变量上下文。
 * @returns 完成变量替换后的命令字符串。
 */
export function expandVariables(source: string, ctx: VariableContext): string {
  return source.replace(/\$\{([^}]+)\}/g, (whole, expr: string) => {
    const colonIdx = expr.indexOf(':')
    if (colonIdx > 0) {
      const ns = expr.slice(0, colonIdx)
      const key = expr.slice(colonIdx + 1)
      if (ns === 'env') return process.env[key] ?? ''
      // 未知命名空间保留原样。
      return whole
    }
    switch (expr) {
      case 'pluginDir':
        return ctx.pluginDir
      case 'pluginDataDir':
        return ctx.pluginDataDir ?? whole
      case 'cwd':
        return ctx.cwd
      case 'homedir':
        return ctx.homedir ?? ''
      case 'sep':
        return ctx.sep ?? path.sep
      default:
        return whole
    }
  })
}
