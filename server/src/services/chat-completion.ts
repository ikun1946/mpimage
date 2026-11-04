import { ApiError } from '../lib/errors.js'

export interface ChatCallOptions {
  baseUrl: string
  model: string
  timeoutMs: number
}

export interface ChatTokens {
  input: number
  output: number | null
  total: number | null
}

export interface ChatCallParams {
  messages: unknown
  maxTokens: number
  /** 采样温度；扩写要发散所以偏高，观察/自检要稳定所以偏低。默认 0.8 */
  temperature?: number
}

export interface ChatCallResult {
  content: string
  model: string
  tokens: ChatTokens
  /** 上游给出的结束原因；length 表示输出被 max_tokens 截断 */
  finishReason?: string
}

/** 采样温度：默认 0.8，扩写偏发散；观察与自检要稳定，传更低的 0.2 */
const DEFAULT_TEMPERATURE = 0.8

/**
 * OpenAI 兼容的对话调用：提示词优化与参考图观察共用。
 * 只做「发请求、解析、翻译错误」，业务提示词全部留在调用方。
 */
export async function callChatCompletion(
  options: ChatCallOptions,
  params: ChatCallParams,
): Promise<ChatCallResult> {
  let upstream: Response
  try {
    upstream = await fetch(`${options.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: params.messages,
        stream: false,
        // 推理模型默认会先输出思考过程，关掉才会把正文放进 content
        reasoning: { effort: 'none' },
        temperature: params.temperature ?? DEFAULT_TEMPERATURE,
        max_tokens: params.maxTokens,
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (error) {
    const isTimeout = (error as Error).name === 'TimeoutError'
    throw new ApiError(
      isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      isTimeout ? '提示词优化超时，请重试' : '无法连接 Magpie，请确认 Magpie 正在运行',
      isTimeout ? 504 : 502,
    )
  }

  const raw = await upstream.text()
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new ApiError('UPSTREAM_BAD_RESPONSE', 'Magpie 返回了无法解析的响应', 502)
  }

  if (!upstream.ok) {
    throw new ApiError(
      'UPSTREAM_ERROR',
      extractErrorMessage(payload) || '提示词优化失败',
      upstream.status,
    )
  }

  const content = extractContent(payload)
  if (!content) {
    throw new ApiError('UPSTREAM_BAD_RESPONSE', '模型没有返回提示词', 502)
  }

  const finishReason = extractFinishReason(payload)
  // 撞上 max_tokens 时 content 是半句话，当成功返回会写进用户的输入框
  if (finishReason === 'length') {
    throw new ApiError(
      'UPSTREAM_TRUNCATED',
      '模型输出被截断，请重试或把描述写短一点',
      502,
    )
  }

  return {
    content,
    model: extractModel(payload) || options.model,
    tokens: extractTokens(payload),
    finishReason,
  }
}

export function mergeTokens(first: ChatTokens, second: ChatTokens): ChatTokens {
  return {
    input: first.input + second.input,
    output: addNullable(first.output, second.output),
    total: addNullable(first.total, second.total),
  }
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null
  return (a ?? 0) + (b ?? 0)
}

function extractContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const message = (choices[0] as { message?: unknown })?.message
  if (!message || typeof message !== 'object') return undefined
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' && content.trim() ? content : undefined
}

function extractFinishReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const reason = (choices[0] as { finish_reason?: unknown })?.finish_reason
  return typeof reason === 'string' && reason ? reason : undefined
}

function extractModel(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const model = (payload as { model?: unknown }).model
  return typeof model === 'string' && model ? model : undefined
}

/** 对话接口的 usage 字段比生图接口稳定，缺失时仍然给 null 而不是瞎估 */
function extractTokens(payload: unknown): ChatTokens {
  const usage =
    payload && typeof payload === 'object' ? (payload as { usage?: unknown }).usage : undefined
  const source = usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : {}

  return {
    input: pickNumber(source.prompt_tokens) ?? 0,
    output: pickNumber(source.completion_tokens),
    total: pickNumber(source.total_tokens),
  }
}

function pickNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value)
  return null
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const error = (payload as { error?: unknown }).error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return undefined
}
