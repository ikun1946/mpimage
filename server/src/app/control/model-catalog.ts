/**
 * 上游模型目录：代理 GET /v1/models，做归一化并按上游地址缓存。
 * 上游网关的返回形态不统一（{data:[...]}、{models:[...]}、裸数组），
 * 这里只认 id，能力字段一律只看上游显式声明，绝不按名字猜——
 * 猜错的代价是给纯文本模型发图，或者把视觉模型当文本模型用。
 */
import { ApiError } from '../platform/errors.js'

export interface ModelInfo {
  id: string
  label: string
  capabilities: { text: boolean | null; vision: boolean | null }
}

export interface ModelCatalogResult {
  models: ModelInfo[]
  /** upstream = 本次真实拉取；cache = 命中缓存 */
  source: string
  /** 拉取时间（ISO 字符串）；命中缓存时是那次拉取的时间 */
  fetchedAt: string
  cached: boolean
}

interface CatalogOptions {
  /** 缓存有效期，默认 60 秒 */
  ttlMs?: number
  /** 单次拉取超时，默认 10 秒 */
  timeoutMs?: number
}

interface CacheEntry {
  result: ModelCatalogResult
  at: number
}

const DEFAULT_TTL_MS = 60_000
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_ID_LENGTH = 120

export class ModelCatalog {
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly cache = new Map<string, CacheEntry>()

  constructor(options: CatalogOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * 缓存以 baseUrl 为键：后台换了地址，旧缓存自然不会再被读到。
   * force 用于「刷新」按钮，跳过缓存但照常回写。
   */
  async list(baseUrl: string, opts: { force?: boolean } = {}): Promise<ModelCatalogResult> {
    const key = baseUrl.trim().replace(/\/+$/, '')
    const hit = this.cache.get(key)
    if (!opts.force && hit && Date.now() - hit.at < this.ttlMs) {
      return { ...hit.result, source: 'cache', cached: true }
    }

    const models = parseModels(await fetchModels(key, this.timeoutMs))
    const result: ModelCatalogResult = {
      models,
      source: 'upstream',
      fetchedAt: new Date().toISOString(),
      cached: false,
    }
    this.cache.set(key, { result, at: Date.now() })
    return result
  }
}

async function fetchModels(baseUrl: string, timeoutMs: number): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/v1/models`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const isTimeout = (error as Error).name === 'TimeoutError'
    throw new ApiError(
      isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      isTimeout ? '获取模型列表超时，请稍后重试' : '无法连接上游，请确认上游服务正在运行',
      isTimeout ? 504 : 502,
    )
  }

  const raw = await response.text()

  if (!response.ok) {
    // 上游消息最能说明问题（401 的鉴权提示、网关的报错都在这），解析不出来才退回状态码
    throw new ApiError(
      'UPSTREAM_ERROR',
      upstreamMessage(raw) ?? `上游返回 ${response.status}`,
      502,
    )
  }

  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError('UPSTREAM_BAD_RESPONSE', '上游返回了无法解析的模型列表', 502)
  }
}

function upstreamMessage(raw: string): string | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!payload || typeof payload !== 'object') return undefined

  const error = (payload as { error?: unknown }).error
  if (typeof error === 'string' && error.trim()) return error.trim()
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  const message = (payload as { message?: unknown }).message
  if (typeof message === 'string' && message.trim()) return message.trim()
  return undefined
}

/** 三种形态都兼容；一个数组都找不到说明上游不是模型接口，按坏响应处理 */
function extractEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data
    if (Array.isArray(data)) return data
    const models = (payload as { models?: unknown }).models
    if (Array.isArray(models)) return models
  }
  throw new ApiError('UPSTREAM_BAD_RESPONSE', '上游返回的模型列表格式无法识别', 502)
}

/**
 * id 要能原样拼进上游请求，所以空白、空串、超长的一律丢掉；
 * 同名重复项保留第一个，保证顺序稳定。
 */
function parseModels(payload: unknown): ModelInfo[] {
  const seen = new Set<string>()
  const models: ModelInfo[] = []

  for (const entry of extractEntries(payload)) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = record.id
    if (typeof id !== 'string') continue
    if (!id || id.length > MAX_ID_LENGTH || /\s/.test(id)) continue
    if (seen.has(id)) continue
    seen.add(id)

    const name = record.name
    models.push({
      id,
      label: typeof name === 'string' && name.trim() ? name.trim() : id,
      capabilities: readCapabilities(record),
    })
  }

  return models
}

/**
 * 只看显式字段：
 * - capabilities.vision 是布尔就用它（最明确的声明）；
 * - 否则看 modalities / input_modalities / architecture.input_modalities 有没有 image；
 * - text 同理看这些列表有没有 text。
 * 三个来源都没有，就返回 null，交给界面显示「未知」。
 */
function readCapabilities(record: Record<string, unknown>): ModelInfo['capabilities'] {
  const lists = collectModalities(record)
  const visionFlag = readVisionFlag(record)

  let vision: boolean | null = visionFlag
  if (vision === null && lists.length > 0) {
    vision = lists.some(list => list.includes('image'))
  }

  const text = lists.length > 0 ? lists.some(list => list.includes('text')) : null

  return { text, vision }
}

function readVisionFlag(record: Record<string, unknown>): boolean | null {
  const capabilities = record.capabilities
  if (!capabilities || typeof capabilities !== 'object') return null
  const vision = (capabilities as { vision?: unknown }).vision
  return typeof vision === 'boolean' ? vision : null
}

/** 收集所有输入模态列表，统一小写后用于判断 text/image */
function collectModalities(record: Record<string, unknown>): string[][] {
  const lists: string[][] = []

  const push = (value: unknown): void => {
    if (!Array.isArray(value)) return
    lists.push(value.filter((item): item is string => typeof item === 'string').map(item => item.toLowerCase()))
  }

  push(record.modalities)
  push(record.input_modalities)

  const architecture = record.architecture
  if (architecture && typeof architecture === 'object') {
    push((architecture as { input_modalities?: unknown }).input_modalities)
  }

  return lists
}
