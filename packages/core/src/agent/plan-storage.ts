// 计划文件保存在用户当前项目的 `.tegent/plans/<slug>-<YYYYMMDD-HHMMSS>.md`，
// 而不是用户级的 `~/.tegent/`。这和 `.tegent/sessions/`、`.tegent/memory/`
// 的作用域一致：按项目隔离、默认 gitignored、不会跨仓库共享。
//
// 文件名使用“主题 slug + 时间戳”的形状，和 `.tegent/plans/` 下已有的旧文件名兼容，
// 例如 `vue-3-vite-typescript-snake-game-20260420-102410.md`。
// 这样既方便人在目录里扫一眼看懂内容，也能按时间自然排序。
//
// Claude Code 把 plan 全局存到 `~/.claude/plans/{slug}.md`，
// 并使用随机词组 slug，例如 `brilliant-crystal.md`。
// 这里按用户要求改成“项目内 + 根据任务主题生成 slug”：更容易之后找回，
// 计划也会和它服务的仓库待在一起。
import fs from 'node:fs/promises'
import path from 'node:path'

import { generateText } from 'ai'
import type { LanguageModel } from 'ai'

import { getThinkingProviderOptions } from '../providers/thinking.js'
import { TEGENT_DIR } from '../constants.js'

const PLANS_SUBDIR = 'plans'
const SLUG_MAX_LEN = 40

/** 把任意任务描述转换成文件系统安全的 slug。
 *
 * 规则：
 * - 转小写。
 * - 用短横线分隔单词。
 * - 只保留 `[a-z0-9 -]`，其它内容都会被丢掉。
 * - CJK、emoji、标点可能会折叠成空字符串；这是有意的，
 *   调用方会用“只有时间戳”的文件名兜底。
 * - 最长限制为 SLUG_MAX_LEN，避免 `ls` 里列宽被很长任务名撑乱。
 *
 * 导出这个函数，是为了 session usage 文件名也能和 plan 文件使用同一种命名形状。 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/g, '')
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

function plansDir(): string {
  return path.join(process.cwd(), TEGENT_DIR, PLANS_SUBDIR)
}

/** 根据任务描述生成新的计划文件路径。
 *
 * taskText 通常是用户最近一次消息。这个函数是纯函数，不做 I/O，
 * 所以调用方可以在文件真正创建前先把路径塞进 LoopState。
 *
 * 文件名格式：
 * - 有 slug：`<slug>-<timestamp>.md`
 * - 没 slug：`<timestamp>.md`
 *
 * 如果调用方已经有预计算 slug，可以通过 opts.slug 传入，跳过本地 slugify。
 * 这对非 ASCII 任务文本尤其重要，因为本地 slugify 会返回空；
 * agentLoop 可以先用 LLM 生成一个 session-wide 的 taskSlug，再传进来复用。 */
export function makePlanFilePath(taskText: string, opts?: { slug?: string; now?: Date }): string {
  const slug = opts?.slug ?? slugify(taskText)
  const ts = formatTimestamp(opts?.now ?? new Date())
  const name = slug ? `${slug}-${ts}` : ts
  return path.join(plansDir(), `${name}.md`)
}

/** 本地 slugify 快路径的最小长度。
 *
 * 如果本地 slug 长度低于这个值，就认为用户第一条消息里 ASCII 内容太少。
 * 典型 CJK-only 消息会得到 0；英文短任务如 "fix bug" 通常会有 6 个以上字符。
 * 低于阈值时会请模型生成英文摘要，避免出现只有一个字母的无意义文件名。 */
const ASCII_FAST_PATH_MIN_LEN = 6

/** 发送给 slug 模型的原始用户文本上限。
 *
 * slug 只需要任务大意；如果用户粘了几千字需求，全部发给模型只会浪费输入 token。 */
const TASK_TEXT_TRUNCATE = 500

/** slug 生成调用的输出 token 硬上限。
 *
 * 目标输出只是“2-4 个短英文单词”，可见 token 大约 10 个。
 * 但 reasoning 模型可能在可见文本前消耗 hidden thinking token。
 * 虽然下面会尽量对支持的 provider 禁用 thinking，但 DeepSeek/Anthropic 的 disabled
 * 不一定对每个模型 id 都完全生效，所以这里留出足够余量。 */
const SLUG_MAX_OUTPUT_TOKENS = 256

/** 为会话派生一个人类可读的文件名 slug。
 *
 * 快路径：
 * 如果 `slugify(taskText)` 已经能得到至少 6 个字符，说明用户输入里有足够英文信息，
 * 直接返回本地 slug。这样零网络、零 token，覆盖英文 prompt 用户的大多数情况。
 *
 * 慢路径：
 * 对 CJK-only、emoji-heavy、极短消息这类本地 slug 为空或很短的情况，
 * 发起一次隔离的 generateText 调用，请模型给出 2-4 个小写英文单词。
 * 这里不带历史、不带工具、不带系统上下文，只给截断后的用户原文和严格指令。
 * 对支持的 provider 会禁用 thinking，避免小 token 预算被 hidden reasoning 吃掉。
 *
 * 任何失败（包括 abort）都返回空字符串。调用方把空字符串视为“退回纯时间戳命名”，
 * 这和旧行为一致，因此新增这个 helper 不会造成回归。 */
export async function generateTaskSlug(
  taskText: string,
  model: LanguageModel,
  modelId: string,
  signal?: AbortSignal,
): Promise<string> {
  const localSlug = slugify(taskText)
  if (localSlug.length >= ASCII_FAST_PATH_MIN_LEN) {
    return localSlug
  }


  try {
    const { text, usage, finishReason } = await generateText({
      model,
      // exactOptionalPropertyTypes 下不能显式传 abortSignal: undefined，
      // 所以只有真的有 signal 时才带上这个属性。
      ...(signal ? { abortSignal: signal } : {}),
      // getThinkingProviderOptions 永远返回对象（未知 provider 返回空对象），
      // 用 NonNullable 把断言类型里的 undefined 去掉，
      // 避免 exactOptionalPropertyTypes 下显式传入 undefined。
      providerOptions: getThinkingProviderOptions(modelId, false) as NonNullable<
        Parameters<typeof generateText>[0]['providerOptions']
      >,
      system:
        'You convert user task descriptions into short English filename slugs. ' +
        'Reply with ONLY 2 to 4 lowercase English words separated by spaces. ' +
        'No punctuation, no quotes, no explanation, no prefixes like "slug:". ' +
        'If the input is non-English, translate the gist into English first.',
      prompt: taskText.slice(0, TASK_TEXT_TRUNCATE),
      maxOutputTokens: SLUG_MAX_OUTPUT_TOKENS,
    })
    const slug = slugify(text)
    return slug
  } catch (err) {
    return ''
  }
}

export async function ensurePlanDir(): Promise<void> {
  await fs.mkdir(plansDir(), { recursive: true })
}

export async function readPlan(planPath: string): Promise<string> {
  try {
    return await fs.readFile(planPath, 'utf-8')
  } catch {
    return ''
  }
}

export async function writePlan(planPath: string, body: string): Promise<string> {
  await ensurePlanDir()
  await fs.writeFile(planPath, body, 'utf-8')
  return planPath
}
