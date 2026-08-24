import { zhipu } from 'zhipu-ai-provider'

import { createAlibaba } from '@ai-sdk/alibaba'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createMoonshotAI } from '@ai-sdk/moonshotai'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createXai } from '@ai-sdk/xai'
import { createProviderRegistry } from 'ai'

import { getProviderOptions } from '../agent/config.js'

export function createModelRegistry() {
  const opts = getProviderOptions()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: Record<string, any> = {}

  if (opts.anthropic) providers.anthropic = createAnthropic({ fetch: permanentErrorFetch })
  if (opts.openai) providers.openai = createOpenAI({ fetch: permanentErrorFetch })
  if (opts.google) providers.google = createGoogleGenerativeAI({ fetch: permanentErrorFetch })
  if (opts.xai) providers.xai = createXai({ fetch: permanentErrorFetch })
  if (opts.deepseek) providers.deepseek = createDeepSeek({ fetch: deepseekReasoningFetch })
  if (opts.alibaba) {
    providers.alibaba = createAlibaba({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      fetch: permanentErrorFetch,
    })
  }
  if (opts.zhipu) providers.zhipu = zhipu
  if (opts.moonshotai) providers.moonshotai = createMoonshotAI({ fetch: permanentErrorFetch })

  if (opts.custom.apiKey && opts.custom.baseURL) {
    providers.custom = createOpenAICompatible({
      name: 'custom',
      apiKey: opts.custom.apiKey,
      baseURL: opts.custom.baseURL,
      fetch: permanentErrorFetch,
    })
  }

  return createProviderRegistry(providers)
}

const deepseekReasoningFetch: typeof fetch = async (input, init) => {
  if (!init?.body || typeof init.body !== 'string') return permanentErrorFetch(input, init)

  try {
    const body = JSON.parse(init.body) as { model?: string; messages?: Array<Record<string, unknown>> }
    if (typeof body.model === 'string' && body.model.includes('deepseek-v4') && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.role === 'assistant' && msg.reasoning_content == null) {
          msg.reasoning_content = ''
        }
      }
      return permanentErrorFetch(input, { ...init, body: JSON.stringify(body) })
    }
  } catch {
    // If the SDK body is not the JSON shape we expect, keep the request unchanged.
  }

  return permanentErrorFetch(input, init)
}

type PermanentErrorMatcher = string | RegExp

const PERMANENT_ERROR_CATEGORIES: ReadonlyArray<{
  status: number
  statusText: string
  patterns: readonly PermanentErrorMatcher[]
}> = [
  {
    status: 402,
    statusText: 'Payment Required',
    patterns: [
      'insufficient balance',
      'insufficient_balance',
      'insufficient_quota',
      'exceeded_current_quota',
      'please recharge',
    ],
  },
  {
    status: 413,
    statusText: 'Payload Too Large',
    patterns: ['context_length_exceeded', 'maximum context length', 'prompt is too long', 'context window'],
  },
  {
    status: 422,
    statusText: 'Unprocessable Entity',
    patterns: ['content_policy_violation', 'content_filter', 'input_blocked', 'unsafe content'],
  },
  {
    status: 401,
    statusText: 'Unauthorized',
    patterns: ['invalid api key', 'invalid_api_key', 'api key not found', 'expired api key'],
  },
  {
    status: 404,
    statusText: 'Not Found',
    patterns: ['model_not_found', 'model not found', 'unknown model', /\bmodel\b[^]*?\bdoes not exist\b/],
  },
] as const

const permanentErrorFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  if (response.status < 400) return response

  const text = await response
    .clone()
    .text()
    .catch(() => '')
  if (!text) return response

  const lower = text.toLowerCase()
  for (const category of PERMANENT_ERROR_CATEGORIES) {
    const hit = category.patterns.some((p) => (typeof p === 'string' ? lower.includes(p) : p.test(lower)))
    if (!hit) continue
    if (response.status === category.status) return response
    return new Response(text, {
      status: category.status,
      statusText: category.statusText,
      headers: response.headers,
    })
  }

  return response
}
