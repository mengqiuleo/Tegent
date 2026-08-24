import { PROVIDER_DETECTION_ORDER, PROVIDER_KEY_URLS } from "@tegent/core"
import chalk from "chalk"

/**
 * 打印缺少 provider API key 时的启动错误提示。
 *
 * 会列出当前支持的 provider 环境变量、对应的 key 获取地址
 */
export function printNoApiKeyMessage(): void {
  const envName = (s: string) => chalk.yellow(s)

  console.error(chalk.red.bold('Error: No API key found.') + '\n')
  console.error('Set at least one provider API key via environment variable:\n')
  for (const { envKey } of PROVIDER_DETECTION_ORDER) {
    const provider = envKey
      .replace(/_API_KEY$/, '')
      .replace('GOOGLE_GENERATIVE_AI', 'google')
      .replace('MOONSHOT', 'moonshotai') 
      .toLowerCase()
    const url = PROVIDER_KEY_URLS[provider as keyof typeof PROVIDER_KEY_URLS] ?? ''
    console.error(`  ${envName(envKey.padEnd(32))} ${chalk.dim(url)}`)
  }
  console.error(
    `\n  ${envName('OPENAI_COMPATIBLE_API_KEY'.padEnd(32))} ${chalk.dim('(custom OpenAI-compatible endpoint)')}`, // 展示自定义兼容端点的 key 名称和说明。
  )
}
