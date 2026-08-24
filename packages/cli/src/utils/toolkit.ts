//  从当前工作目录加载 .env 文件（逐层往上目录找，和 dotenv 的约定一致）。
// 找到第一个 .env 就用 process.loadEnvFile 加载它，然后停止。
import fs from 'node:fs'
import path from "node:path"

/**  定义 .env 加载函数，从当前目录一路向父目录查找。*/
export function loadEnvFile(): void {
  let dir = process.cwd()

  while (true) {
    const envPath = path.join(dir, '.env')

    if (fs.existsSync(envPath)) {
      try {
        process.loadEnvFile(envPath) //  调用 Node 的 .env 加载能力，把文件内容注入 process.env
      } catch {
      }
      return
    }

    const parent = path.dirname(dir)

    if (parent === dir) break
    dir = parent
  }
}