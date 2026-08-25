import * as cheerio from 'cheerio'
import TurndownService from 'turndown'

import { tool } from 'ai'

import { z } from 'zod'

import { LruCache } from '../utils/lru-cache.js'
import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

// 单次 HTTP 请求的超时（连接 + 响应头 + 读体全部计时）。
const FETCH_TIMEOUT_MS = 15_000
// 返回给模型的 Markdown 字符上限。从 30 KB 上调过（30 KB 会把文档页
// 拦腰砍半），但仍远低于模型的上下文预算：~100 KB ≈ ~25 K token，约为
// Sonnet 200 K 窗口的 12%，单次 fetch 撑不爆上下文。注意这是单次调用
// 的上限；模型随时可以带着更窄的 prompt 重新 fetch。
const MAX_CONTENT_CHARS = 100_000
// turndown 处理前的原始 HTML 上限。10 MB 对任何真实文档页都绰绰有余；
// 由 content-length 响应头【和】流式读体（见 readResponseBody）双重约束，
// 所以没有（或不诚实的）content-length 的 chunked 响应也被兜住。
const MAX_HTTP_BYTES = 10 * 1024 * 1024
const MAX_URL_LENGTH = 2000
// URL → Markdown 的 LRU 缓存：15 分钟内重复抓同一页面直接走缓存，
// 最多驻留 50 条。
const CACHE_TTL_MS = 15 * 60 * 1000
const CACHE_MAX_ENTRIES = 50

// 先用浏览器 UA 请求（见下方 Cloudflare 回退逻辑）。
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
// 用作 Cloudflare 回退：激进的 bot 规则常常放行"诚实的 CLI UA"，
// 反而去拦截那些过不了 TLS 指纹校验的浏览器伪装者。
const VERSION = '0.0.1'
const FALLBACK_UA = `tegent/${VERSION} (+https://github.com/mengqiuleo/Tegent)`

// 当前年份，注入 description —— 模型据此判断"最新/今年"类请求的时效。
const YEAR = new Date().getFullYear()

// ── SSRF 防护 ──
// 拒绝指向内网/私有网段的 URL。对齐 Claude Code 的 validateURL：
// 主机名必须有 ≥2 个点分段（拒绝 `localhost`、裸主机名）、不得内嵌
// 凭据、不得用非 HTTP 协议、不得是私有/链路本地/回环网段的 IP。

const PRIVATE_IP_PATTERNS = [
  /^127\./, // 回环
  /^10\./, // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./, // 192.168.0.0/16
  /^169\.254\./, // 链路本地（AWS/GCP 云元数据服务所在网段）
  /^0\./, // 0.0.0.0/8
  /^::1$/, // IPv6 回环
  /^fd[0-9a-f]{2}:/i, // IPv6 ULA（唯一本地地址）
  /^fe80:/i, // IPv6 链路本地
]

function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) return true
  // URL 里的 IP 字面量 —— IPv6 形式带方括号，先剥掉再匹配
  const bare = lower.startsWith('[') ? lower.slice(1, -1) : lower
  return PRIVATE_IP_PATTERNS.some((re) => re.test(bare))
}

/** @internal 仅为测试导出。 */
export function validateFetchUrl(url: string): string | null {
  if (url.length > MAX_URL_LENGTH) return `URL exceeds ${MAX_URL_LENGTH} character limit`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'Invalid URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Unsupported protocol: ${parsed.protocol} (only http/https allowed)`
  }
  if (parsed.username || parsed.password) return 'URLs with embedded credentials are not allowed'
  const parts = parsed.hostname.split('.')
  if (parts.length < 2) return `Hostname "${parsed.hostname}" is not a public domain (must have at least two segments)`
  if (isPrivateHost(parsed.hostname)) {
    return `Fetching private/internal address "${parsed.hostname}" is blocked for security`
  }
  return null
}

// 进程级缓存：key 是 URL，value 是转换好的 Markdown（或原始 JSON）。
const fetchCache = new LruCache<string>({ maxEntries: CACHE_MAX_ENTRIES, ttlMs: CACHE_TTL_MS })

// HTML→Markdown 转换器。atx 标题（# 风格）+ 围栏代码块（```），
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
}) as { turndown: (html: string) => string }

async function doFetch(url: string, userAgent: string): Promise<Response> {
  return fetch(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}

/** 流式读取响应体，带硬性字节上限。防止 content-length 缺失或撒谎的
 *  chunked 响应把进程 OOM。 */
async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return response.text()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(Math.min(totalBytes, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const remaining = merged.byteLength - offset
    if (remaining <= 0) break
    const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
    merged.set(slice, offset)
    offset += slice.byteLength
  }
  return new TextDecoder().decode(merged)
}

function formatOutput(url: string, markdown: string, prompt?: string): string {
  if (prompt) {
    return `# Content from ${url}\n\n${markdown}\n\n---\nExtract instruction: ${prompt}`
  }
  return markdown
}

export const webFetch = tool({
  description:
    `Fetch a web page and extract its content as markdown. No API key needed. ` +
    `When summarizing the returned content for the user, preserve key details, concrete examples, ` +
    `section structure, and numbers — don't over-compress. ` +
    `Results are cached for 15 minutes per URL, so repeated reads of the same page are free. ` +
    `The current year is ${YEAR} — use it whenever the user asks for recent/latest/current information.`,
  inputSchema: z.object({
    url: z.string().url().describe('The URL to fetch'),
    prompt: z.string().optional().describe('What information to extract from the page'),
  }),
  execute: async ({ url, prompt }, { toolCallId }) => {
    try {
      const urlError = validateFetchUrl(url)
      if (urlError) return `Error: ${urlError}`


      const cached = fetchCache.get(url)
      if (cached) {
        reportProgress(toolCallId, 'Using cached copy')
        return formatOutput(url, cached, prompt)
      }

      reportProgress(toolCallId, `Fetching ${url}`)
      let response = await doFetch(url, BROWSER_UA)

      if (response.status === 403 && response.headers.get('cf-mitigated') !== null) {
        response = await doFetch(url, FALLBACK_UA)
      }

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`
      }


      const contentLength = Number(response.headers.get('content-length') ?? '0')
      if (contentLength > MAX_HTTP_BYTES) {
        const mb = Math.round(contentLength / 1024 / 1024)
        return `Error: Content too large (${mb} MB, limit ${MAX_HTTP_BYTES / 1024 / 1024} MB)`
      }

      const contentType = response.headers.get('content-type') ?? ''

      const body = await readResponseBody(response, MAX_HTTP_BYTES)

      if (contentType.includes('application/json')) {
        const json = body.slice(0, MAX_CONTENT_CHARS)
        fetchCache.set(url, json)
        return formatOutput(url, json, prompt)
      }

      const $ = cheerio.load(body)
      $('script, style, nav, footer, header, aside, .sidebar, .nav, .menu, .ads, .advertisement').remove()

      const mainContent = $('main, article, .content, .post, #content').first()
      const html = mainContent.length ? mainContent.html() : $('body').html()

      if (!html) return 'Error: Could not extract content from page.'

      let markdown: string = turndown.turndown(html)
      if (markdown.length > MAX_CONTENT_CHARS) {
        markdown = markdown.slice(0, MAX_CONTENT_CHARS) + '\n\n... [content truncated]'
      }

      fetchCache.set(url, markdown)
      return formatOutput(url, markdown, prompt)
    } catch (err) {
      return formatToolError('fetching URL', err)
    }
  },
})
