/**
 * 上游（Magpie）实际可用的生图模型目录。
 *
 * Magpie 的 GET /v1/models 默认只列对话模型；带上 `X-Magpie-Drawers` 头
 * 才会额外返回生图模型（kind: "image"，modalities.output 含 "image"）。
 * 这里按上游地址缓存 60 秒，失败不抛异常，调用方回落到静态清单。
 */
import { config } from '../config.js'

export interface ImageModelInfo {
  id: string
  label: string
}

interface CacheEntry {
  models: ImageModelInfo[]
  at: number
}

const TTL_MS = 60_000
const TIMEOUT_MS = 10_000

/**
 * 明确不用的生图模型：混元出图带「AI生成 WORKBUDDY」水印，
 * 即使 Magpie 返回了也不放进清单。
 */
const HIDDEN_IMAGE_MODELS = new Set(['workbuddy/hunyuan-image-alpha'])

export class ImageModelCatalog {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<ImageModelInfo[]>>()

  /** 上游列不出来时用静态清单兜底，保证客户端至少还能选到默认模型 */
  private fallback(): ImageModelInfo[] {
    return config.imageModels.map(({ id, label }) => ({ id, label }))
  }

  async list(baseUrl: string, opts: { force?: boolean } = {}): Promise<ImageModelInfo[]> {
    const key = baseUrl.trim().replace(/\/+$/, '')
    const hit = this.cache.get(key)
    if (!opts.force && hit && Date.now() - hit.at < TTL_MS) return hit.models

    const running = this.inflight.get(key)
    if (running) return running

    const task = this.fetchModels(key)
      .then(models => {
        const result = models.length ? models : this.fallback()
        this.cache.set(key, { models: result, at: Date.now() })
        return result
      })
      .catch(() => {
        const result = this.fallback()
        this.cache.set(key, { models: result, at: Date.now() })
        return result
      })
      .finally(() => {
        this.inflight.delete(key)
      })

    this.inflight.set(key, task)
    return task
  }

  private async fetchModels(baseUrl: string): Promise<ImageModelInfo[]> {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        accept: 'application/json',
        'x-magpie-drawers': '1',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return []

    const payload = (await response.json()) as unknown
    return parseImageModels(payload)
  }
}

function parseImageModels(payload: unknown): ImageModelInfo[] {
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown } | null)?.data)
      ? ((payload as { data: unknown[] }).data)
      : Array.isArray((payload as { models?: unknown } | null)?.models)
        ? ((payload as { models: unknown[] }).models)
        : []

  const result: ImageModelInfo[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id.trim()) continue

    const modalities = record.modalities as { output?: unknown } | undefined
    const outputs = Array.isArray(modalities?.output) ? modalities.output : []
    const isImage = record.kind === 'image' || outputs.includes('image')
    if (!isImage) continue

    const id = record.id.trim()
    if (seen.has(id) || HIDDEN_IMAGE_MODELS.has(id)) continue
    seen.add(id)

    // 自己维护的短名称优先（例如 GPT Image 2），其次是上游显示名
    const label =
      config.imageModels.find(model => model.id === id)?.label ||
      text(record.display_name) ||
      text(record.magpie_label) ||
      id

    result.push({ id, label })
  }

  return result
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
