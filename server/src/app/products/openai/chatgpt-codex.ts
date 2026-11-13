/**
 * Codex 通道：用导入账号的 access_token 调
 * POST {baseUrl}/backend-api/codex/responses（SSE）。
 *
 * 协议来自 gptGrok2api 的已核对实现：
 * - 只需要 Authorization: Bearer <access_token> 与 JSON
 * - tools 里声明 image_generation，action 为 generate / edit
 * - 结果在 SSE 的 image_generation_call.result（base64 字符串）里
 * 这条通道不依赖 Sentinel / PoW / 浏览器 TLS 指纹。
 */
import {
  estimateTokens,
  type ReferenceImage,
  type TokenUsage,
} from '../images/magpie.js'

export type CodexErrorKind =
  | 'auth'
  | 'rate'
  | 'policy'
  | 'server'
  | 'network'
  | 'timeout'
  | 'bad-response'

export class CodexUpstreamError extends Error {
  readonly kind: CodexErrorKind
  readonly status?: number
  readonly retryAfterMs?: number

  constructor(
    message: string,
    kind: CodexErrorKind,
    options: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message)
    this.name = 'CodexUpstreamError'
    this.kind = kind
    this.status = options.status
    this.retryAfterMs = options.retryAfterMs
  }
}

export interface CodexConfig {
  responsesModel: string
  imageModel: string
  size: string
  quality: string
  instructions: string
}

export interface CodexImageParams {
  baseUrl: string
  accessToken: string
  prompt: string
  ratioHint: string
  images: ReferenceImage[]
  timeoutMs: number
  codex: CodexConfig
}

export interface CodexImageResult {
  buffer: Buffer
  tokens: TokenUsage
}

/** 内容政策类拒绝，不重试其他账号 */
const POLICY_KEYWORDS = [
  'moderation',
  'policy',
  'blocked',
  'content policy',
  '不能生成',
  '无法生成',
  '违反',
  '敏感',
  '裸体',
  '色情',
  '未成年',
  '抱歉，我不能',
]

function looksLikePolicy(message: string): boolean {
  const lower = message.toLowerCase()
  return POLICY_KEYWORDS.some(keyword => lower.includes(keyword.toLowerCase()))
}

function messageFrom(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  for (const key of ['message', 'detail', 'error_description', 'error']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate
    if (candidate && typeof candidate === 'object') {
      const nested = messageFrom(candidate)
      if (nested) return nested
    }
  }
  return ''
}

/** 从任意事件对象里递归找 image_generation_call.result */
function findImageResult(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 8) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageResult(item, depth + 1)
      if (found) return found
    }
    return null
  }
  const record = value as Record<string, unknown>
  if (record.type === 'image_generation_call' && typeof record.result === 'string') {
    const result = record.result.trim()
    if (result) return result
  }
  for (const key of Object.keys(record)) {
    const found = findImageResult(record[key], depth + 1)
    if (found) return found
  }
  return null
}

function stripDataUrl(value: string): string {
  const trimmed = value.trim()
  const marker = 'base64,'
  const index = trimmed.indexOf(marker)
  return index >= 0 ? trimmed.slice(index + marker.length) : trimmed
}

function decodeImage(result: string): Buffer | null {
  try {
    const buffer = Buffer.from(stripDataUrl(result), 'base64')
    return buffer.byteLength ? buffer : null
  } catch {
    return null
  }
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.max(1000, at - Date.now())
  return undefined
}

function buildBody(params: CodexImageParams): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [
    { type: 'input_text', text: `${params.prompt}\n\n${params.ratioHint}` },
  ]
  for (const image of params.images) {
    content.push({
      type: 'input_image',
      image_url: `data:${image.mimeType};base64,${image.buffer.toString('base64')}`,
    })
  }

  return {
    model: params.codex.responsesModel,
    instructions: params.codex.instructions,
    store: false,
    input: [{ role: 'user', content }],
    tools: [
      {
        type: 'image_generation',
        model: params.codex.imageModel,
        action: params.images.length ? 'edit' : 'generate',
        size: params.codex.size,
        quality: params.codex.quality,
        output_format: 'png',
      },
    ],
    tool_choice: { type: 'image_generation' },
    stream: true,
  }
}

/** 逐行解析 SSE，拿到第一张结果就返回 */
async function readSseImage(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<Buffer> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let failure: CodexUpstreamError | null = null
  const deadline = Date.now() + timeoutMs
  let image: Buffer | null = null

  const handleEvent = (event: unknown) => {
    if (!event || typeof event !== 'object') return
    const record = event as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : ''

    const result = findImageResult(event)
    if (result) {
      const decoded = decodeImage(result)
      if (decoded) image = decoded
      return
    }

    if (type === 'response.failed' || type === 'error') {
      const message = messageFrom(record.error) || messageFrom(record.response) || '上游生成失败'
      failure = new CodexUpstreamError(
        message,
        looksLikePolicy(message) ? 'policy' : 'server',
      )
      return
    }

    // 有些网关把错误塞在顶层 error 字段里
    if (record.error) {
      const message = messageFrom(record.error)
      if (message) {
        failure = new CodexUpstreamError(
          message,
          looksLikePolicy(message) ? 'policy' : 'server',
        )
      }
    }
  }

  try {
    while (!image) {
      if (Date.now() > deadline) {
        throw new CodexUpstreamError('生成超时，请稍后重试', 'timeout')
      }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const rawLine = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')

        if (!rawLine || rawLine.startsWith(':')) continue
        if (!rawLine.startsWith('data:')) continue
        const data = rawLine.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          handleEvent(JSON.parse(data))
        } catch {
          // 单行坏了不影响后续事件
        }
        if (image) break
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 已经结束的流取消会抛错，忽略
    }
  }

  if (!image && failure) throw failure
  if (!image) {
    throw new CodexUpstreamError('上游没有返回图片数据', 'bad-response')
  }
  return image
}

export async function requestCodexImage(params: CodexImageParams): Promise<CodexImageResult> {
  const url = `${params.baseUrl}/backend-api/codex/responses`
  const promptText = `${params.prompt}\n\n${params.ratioHint}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(buildBody(params)),
      signal: AbortSignal.timeout(params.timeoutMs),
    })
  } catch (error) {
    const name = (error as Error).name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new CodexUpstreamError('生成超时，请稍后重试', 'timeout')
    }
    throw new CodexUpstreamError(`无法连接 ChatGPT：${(error as Error).message}`, 'network')
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let detail = text.slice(0, 500)
    try {
      const payload = JSON.parse(text) as unknown
      detail = messageFrom(payload) || detail
    } catch {
      // 保留原始文本
    }
    const status = response.status
    if (status === 401 || status === 403) {
      if (looksLikePolicy(detail)) {
        throw new CodexUpstreamError(detail || '内容未通过上游审核', 'policy', { status })
      }
      throw new CodexUpstreamError(detail || `账号鉴权失败（HTTP ${status}）`, 'auth', { status })
    }
    if (status === 429) {
      throw new CodexUpstreamError(detail || '上游限流', 'rate', {
        status,
        retryAfterMs: retryAfterMs(response),
      })
    }
    if (status >= 500) {
      throw new CodexUpstreamError(detail || `上游服务不可用（HTTP ${status}）`, 'server', { status })
    }
    throw new CodexUpstreamError(detail || `上游返回 HTTP ${status}`, 'bad-response', { status })
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  let buffer: Buffer

  if (contentType.includes('text/event-stream') && response.body) {
    buffer = await readSseImage(response.body, params.timeoutMs)
  } else {
    // 少数网关直接返回 JSON；兼容 data[].b64_json 与 image_generation_call.result
    const text = await response.text().catch(() => '')
    let payload: unknown = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }
    const result = findImageResult(payload)
    const decoded = result ? decodeImage(result) : null
    if (!decoded) {
      const message = messageFrom(payload) || '上游没有返回图片数据'
      throw new CodexUpstreamError(
        message,
        looksLikePolicy(message) ? 'policy' : 'bad-response',
      )
    }
    buffer = decoded
  }

  return { buffer, tokens: estimateTokens(promptText) }
}
