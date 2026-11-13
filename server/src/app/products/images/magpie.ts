import { ApiError } from '../../platform/errors.js'

export interface MagpieOptions {
  baseUrl: string
  model: string
  timeoutMs: number
  /** 自定义供应商的密钥；Magpie 本机网关一般不需要 */
  apiKey?: string
}

export interface TokenUsage {
  /** 提示词（输入）消耗的 token */
  inputTokens: number
  /** 生成（输出）消耗的 token；无上游数据时为 null */
  outputTokens: number | null
  totalTokens: number | null
  /** upstream = 上游真实返回；estimated = 本地按字符估算 */
  source: 'upstream' | 'estimated'
  /** 上游返回的原始 usage 字段（若有），便于日后扩展 */
  raw?: unknown
}

export interface MagpieImageResult {
  buffer: Buffer
  model: string
  tokens: TokenUsage
  /** 监控用的阶段耗时（毫秒）；取不到的值不填 */
  metrics?: {
    upstream_headers_ms?: number
    upstream_ms?: number
    parse_ms?: number
    download_ms?: number
  }
}

export interface ReferenceImage {
  buffer: Buffer
  mimeType: string
  filename?: string
}

function bearer(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

export async function requestImage(
  options: MagpieOptions,
  params: { prompt: string; ratioHint: string },
): Promise<MagpieImageResult> {
  const prompt = `${params.prompt}\n\n${params.ratioHint}`
  return callImageEndpoint(
    options,
    `${options.baseUrl}/v1/images/generations`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...bearer(options.apiKey),
      },
      body: JSON.stringify({
        model: options.model,
        // 不传 size：实测传 size 会让构图走样，文字描述比例反而更准
        prompt,
        n: 1,
      }),
    },
    prompt,
  )
}

/**
 * 图生图（面部参考 / 多图参考）：把参考图作为 image 字段传给 /v1/images/edits。
 * 多张图沿用 OpenAI 风格的同名重复字段，按传入顺序逐张 append。
 * 和纯文本生成共用响应解析、超时与错误翻译。
 */
export async function requestImageEdit(
  options: MagpieOptions,
  params: { prompt: string; ratioHint: string; images: ReferenceImage[] },
): Promise<MagpieImageResult> {
  const prompt = `${params.prompt}\n\n${params.ratioHint}`
  const form = new FormData()
  form.append('model', options.model)
  form.append('prompt', prompt)
  form.append('n', '1')
  for (const image of params.images) {
    form.append(
      'image',
      new Blob([new Uint8Array(image.buffer)], { type: image.mimeType }),
      image.filename || 'reference.png',
    )
  }

  return callImageEndpoint(
    options,
    `${options.baseUrl}/v1/images/edits`,
    { method: 'POST', body: form, headers: bearer(options.apiKey) },
    prompt,
  )
}

/**
 * 上游把长连接掐断时的重试。
 *
 * Magpie 的 codex 通道请求 chatgpt.com 出图时，上游会在生成途中主动断开
 * （网关侧表现为 EOF / connection reset）。实测这类失败集中在 60/90/120 秒，
 * 也就是上游的出图窗口本身，而不是本机的超时设置——同一条链路也跑出过
 * 125 秒才成功的请求。
 *
 * 所以这类失败重试一次通常就能出图。安全策略拦截、内容审核不通过之类
 * 属于「重试也没用」的错误，不在这里重试，直接抛给上层。
 */
const RETRYABLE_UPSTREAM = /EOF|connection reset|broken pipe|unexpected end of file|forcibly closed/i

/** 判断错误是否值得重试一次：只对连接被掐断、网关无响应这类重试 */
function isRetryableUpstreamError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.code === 'UPSTREAM_TIMEOUT') return true
  return error.code === 'UPSTREAM_DISCONNECTED'
}

/** 最多试 3 次：上游断开在实测里占比不低，多给一次机会明显能救回一部分 */
const MAX_ATTEMPTS = 3
/** 首次重试等多久；之后翻倍，末尾再加一点随机，避免和上游同步节奏撞车 */
const RETRY_BASE_DELAY_MS = 1500
/** 整条重试链的时间预算：超过就不再重试，把机会留给用户手动触发 */
const RETRY_BUDGET_MS = 240_000

function retryDelay(attempt: number): number {
  const backoff = RETRY_BASE_DELAY_MS * 2 ** attempt
  const jitter = Math.floor(Math.random() * 800)
  return Math.min(backoff + jitter, 15_000)
}

async function callImageEndpoint(
  options: MagpieOptions,
  url: string,
  init: RequestInit,
  promptText: string,
): Promise<MagpieImageResult> {
  let lastError: unknown
  const startedAt = Date.now()
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await callImageEndpointOnce(options, url, init, promptText)
    } catch (error) {
      lastError = error
      if (!isRetryableUpstreamError(error)) throw error
      // 时间预算用完了就别再试了：单次失败本身就要跑 60-120 秒，
      // 三次下来用户等太久，不如把选择权交回给用户。
      if (Date.now() - startedAt >= RETRY_BUDGET_MS) throw error
      await new Promise(resolve => setTimeout(resolve, retryDelay(attempt)))
    }
  }
  throw lastError
}

async function callImageEndpointOnce(
  options: MagpieOptions,
  url: string,
  init: RequestInit,
  promptText: string,
): Promise<MagpieImageResult> {
  let upstream: Response
  const fetchStartedAt = Date.now()

  try {
    upstream = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (error) {
    const isTimeout = (error as Error).name === 'TimeoutError'
    throw new ApiError(
      isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      isTimeout ? '生成超时，请稍后重试' : '无法连接 Magpie，请确认 Magpie 正在运行',
      502,
    )
  }

  const headersMs = Date.now() - fetchStartedAt
  const raw = await upstream.text()
  const upstreamMs = Date.now() - fetchStartedAt
  let payload: unknown
  const parseStartedAt = Date.now()
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new ApiError('UPSTREAM_BAD_RESPONSE', 'Magpie 返回了无法解析的响应', 502)
  }
  const parseMs = Date.now() - parseStartedAt

  if (!upstream.ok) {
    const message = extractErrorMessage(payload) || '图片生成失败'
    // 上游中途断开连接：单独一个错误码，方便上层识别并重试
    if (RETRYABLE_UPSTREAM.test(message)) {
      throw new ApiError(
        'UPSTREAM_DISCONNECTED',
        '上游在生成途中断开了连接（不是本机超时）。直接重试通常就能出图，也可以换用其它模型',
        502,
      )
    }
    throw new ApiError('UPSTREAM_ERROR', translateUpstreamError(message), upstream.status)
  }

  const downloadStartedAt = Date.now()
  const buffer = await readImagePayload(payload, options.timeoutMs)
  const downloadMs = Date.now() - downloadStartedAt
  if (!buffer || buffer.byteLength === 0) {
    throw new ApiError('UPSTREAM_BAD_RESPONSE', 'Magpie 没有返回图片数据', 502)
  }

  return {
    buffer,
    model: extractModel(payload) || options.model,
    tokens: extractTokenUsage(payload) ?? estimateTokens(promptText),
    metrics: {
      upstream_headers_ms: headersMs,
      upstream_ms: upstreamMs,
      parse_ms: parseMs,
      download_ms: downloadMs,
    },
  }
}

/**
 * 提取上游返回的 token 用量。
 * 图像接口是否返回 usage 取决于上游实现：OpenAI 系 gpt-image 会返回
 * usage.input_tokens / output_tokens / total_tokens，部分网关则不返回。
 * 这里兼容多种字段形态，取不到就返回 undefined，由调用方降级为估算。
 */
function extractTokenUsage(payload: unknown): TokenUsage | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const usage = (payload as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return undefined

  const source = usage as Record<string, unknown>
  const inputTokens = pickNumber(source.input_tokens, source.prompt_tokens)
  const outputTokens = pickNumber(source.output_tokens, source.completion_tokens)
  const totalTokens = pickNumber(source.total_tokens)

  if (inputTokens === null && outputTokens === null && totalTokens === null) return undefined

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens,
    totalTokens: totalTokens ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    source: 'upstream',
    raw: usage,
  }
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value)
  }
  return null
}

/**
 * 本地 token 估算（上游不返回 usage 时使用）。
 * 规则：中日韩字符按 1 字 1 token，其余按 4 字符 1 token，与常见分词器的
 * 粗粒度估算接近，误差足够用于「提示词有多长」的判断，但不是计费依据。
 */
export function estimateTokens(text: string): TokenUsage {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const isCjk =
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    if (isCjk) cjk += 1
    else other += 1
  }
  const inputTokens = cjk + Math.ceil(other / 4)
  return {
    inputTokens,
    outputTokens: null,
    totalTokens: null,
    source: 'estimated',
  }
}

export async function checkHealth(options: MagpieOptions): Promise<{
  reachable: boolean
  model: string
  baseUrl: string
  error?: string
}> {
  try {
    const response = await fetch(`${options.baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    })
    return {
      reachable: response.ok,
      model: options.model,
      baseUrl: options.baseUrl,
      ...(response.ok ? {} : { error: `Magpie 返回 ${response.status}` }),
    }
  } catch (error) {
    return {
      reachable: false,
      model: options.model,
      baseUrl: options.baseUrl,
      error: (error as Error).message,
    }
  }
}

function extractBase64(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) return undefined
  const first = data[0] as { b64_json?: unknown }
  return typeof first?.b64_json === 'string' ? first.b64_json : undefined
}

function extractImageUrl(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) return undefined
  const first = data[0] as { url?: unknown }
  if (typeof first?.url !== 'string' || !first.url.trim()) return undefined
  try {
    const url = new URL(first.url.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/** 部分上游只给图片 URL（混元等），这里下载成 Buffer，与 b64_json 路径共用后续处理 */
const MAX_IMAGE_BYTES = 40 * 1024 * 1024

async function readImagePayload(payload: unknown, timeoutMs: number): Promise<Buffer | undefined> {
  const base64 = extractBase64(payload)
  if (base64) return Buffer.from(base64, 'base64')

  const url = extractImageUrl(payload)
  if (!url) return undefined

  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const isTimeout = (error as Error).name === 'TimeoutError'
    throw new ApiError(
      isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      isTimeout ? '下载图片超时，请稍后重试' : '无法下载上游返回的图片',
      502,
    )
  }
  if (!response.ok) {
    throw new ApiError('UPSTREAM_ERROR', `下载图片失败（HTTP ${response.status}）`, 502)
  }

  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_IMAGE_BYTES) {
    throw new ApiError('IMAGE_INVALID', '上游返回的图片过大', 502)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ApiError('IMAGE_INVALID', '上游返回的图片过大', 502)
  }
  return Buffer.from(bytes)
}

function extractModel(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const model = (payload as { model?: unknown }).model
  return typeof model === 'string' ? model : undefined
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

/**
 * 上游（chatgpt.com）的安全策略拒绝时，返回的是一大段英文技术信息。
 * 这里翻译成用户能看懂的中文，同时保留原始 request id 方便排查。
 */
function translateUpstreamError(message: string): string {
  // 连接级错误先翻译成人话。
  // 上游（chatgpt.com 的 codex 通道）在出图途中把连接掐断时回的就是 EOF，
  // 失败耗时集中在 60 秒上下——这是上游主动断开，不是本服务超时，
  // 所以措辞要说「连接被中断」而不是「超时」，否则用户只会一味地重试。
  if (RETRYABLE_UPSTREAM.test(message)) {
    return '上游在生成途中断开了连接（不是本机超时）。直接重试通常就能出图，也可以换用其它模型'
  }
  if (/dial tcp|i\/o timeout|connectex|Failed to connect/i.test(message)) {
    return '连接上游超时，请检查网络或代理后重试'
  }

  if (!/rejected by the safety system/i.test(message)) return message

  const categories = [...message.matchAll(/safety_violations=\[([^\]]*)\]/g)]
    .map(match => (match[1] || '').trim())
    .filter(Boolean)

  const labels: Record<string, string> = {
    violence: '血腥暴力',
    sexual: '色情内容',
    'sexual-minors': '未成年人色情',
    hate: '仇恨言论',
    'hate-symbols': '仇恨符号',
    'self-harm': '自残伤害',
    illicit: '违法行为',
    'illicit-drugs': '违禁药物',
    'graphic-violence': '血腥暴力',
    'sexual-content': '色情内容',
    'non-consensual': '非自愿行为',
    'personal-data': '个人隐私',
    'protected-class': '歧视性内容',
  }

  const names = categories.length
    ? categories.map(item => labels[item.toLowerCase()] || item).join('、')
    : '违规内容'

  const requestId = message.match(/request ID ([0-9a-f-]{36})/i)?.[1]

  return `提示词被上游安全策略拦截（涉及${names}）。请调整画面描述后重试。${requestId ? ` 排查编号：${requestId}` : ''}`
}
