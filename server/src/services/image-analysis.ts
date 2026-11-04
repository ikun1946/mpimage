import { createHash } from 'node:crypto'
import {
  callChatCompletion,
  type ChatCallOptions,
  type ChatTokens,
} from './chat-completion.js'
import type { ReferenceImage } from './reference-images.js'

export interface ImageObservation {
  /** 1 为第一张参考图，与生图接口的 image 字段顺序一致 */
  index: number
  /** 单行要点：主体、构图、背景、光线、色调、风格、画面文字 */
  detail: string
  /** 图上真实存在、用户可能要求改动的对象或区域 */
  targets: string[]
}

/**
 * 观察结果按图片内容缓存：同一张参考图反复改措辞时不重复调用视觉模型。
 * 缓存在进程内存里，容量与有效期都很小，重启即失效。
 */
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_LIMIT = 64

interface CachedObservation {
  detail: string
  targets: string[]
  at: number
}

const cache = new Map<string, CachedObservation>()

const SYSTEM_PROMPT = `你是图像观察员，负责在改图之前把参考图看清楚。只输出一个 JSON 对象，不要 Markdown、不要解释、不要任何前后缀。
格式：{"images":[{"index":1,"subject":"…","composition":"…","background":"…","lighting":"…","palette":"…","style":"…","text":"…","targets":["…"]}]}
1. 按输入顺序编号，第一张是图1，逐张一条，条数必须与输入张数一致。
2. 每个字段用中文，20 字以内：subject 写主体（人物/物体）的数量、外观与服饰；composition 写景别、机位与主体在画面中的位置；background 写场景与背景元素；lighting 写光源方向与明暗；palette 写主色与整体色调；style 写画风与质感；text 写画面里可见的文字，没有就写「无」。
3. targets 只列画面里真实存在、用户可能点名要改的对象或区域（例如帽子、外套、左手、背景里的路灯、招牌文字），最多 6 项，没有就给空数组。
4. 只写看得见的内容，看不清写「不清晰」，不要猜、不要编故事、不要描述画外内容。`

export interface ImageAnalysis {
  observations: ImageObservation[]
  /** 本次真正发生的观察调用所消耗的 token；全部命中缓存时为 0 */
  tokens: ChatTokens
}

/**
 * 逐张观察参考图。任何一步失败都返回 null，由调用方降级为
 * 「图片和提示词一起送模型」的老路径，不把错误抛给用户。
 */
export async function analyzeReferenceImages(
  options: ChatCallOptions,
  images: ReferenceImage[],
): Promise<ImageAnalysis | null> {
  if (images.length === 0) return null

  const hashes = images.map(image => createHash('sha256').update(image.buffer).digest('hex'))
  const now = Date.now()
  const missing: number[] = []

  hashes.forEach((hash, index) => {
    if (!readCache(hash, now)) missing.push(index)
  })

  let tokens: ChatTokens = { input: 0, output: 0, total: 0 }
  if (missing.length > 0) {
    const subset: ReferenceImage[] = []
    for (const index of missing) {
      const image = images[index]
      if (!image) return null
      subset.push(image)
    }

    let parsed: ParsedObservations
    try {
      parsed = await requestObservations(options, subset)
    } catch {
      return null
    }
    // 缺任意一张的观察结果就不算成功：改图目标可能正好是漏掉的那张
    if (missing.some((_, position) => !parsed.items.has(position))) return null
    for (const [position, index] of missing.entries()) {
      const observation = parsed.items.get(position)
      const hash = hashes[index]
      if (!observation || !hash) return null
      writeCache(hash, observation, now)
    }
    tokens = parsed.tokens
  }

  const observations: ImageObservation[] = []
  for (const [index, hash] of hashes.entries()) {
    const cached = readCache(hash, now)
    if (!cached) return null
    observations.push({ index: index + 1, detail: cached.detail, targets: cached.targets })
  }

  return { observations, tokens }
}

/** 拼成第二阶段可读的观察摘要：一张图一行 */
export function formatObservations(observations: ImageObservation[]): string {
  return observations
    .map(observation => {
      const targets = observation.targets.length
        ? `；可改目标：${observation.targets.join('、')}`
        : ''
      return `图${observation.index}：${observation.detail}${targets}`
    })
    .join('\n')
}

interface ParsedObservations {
  items: Map<number, CachedObservation>
  tokens: ChatTokens
}

async function requestObservations(
  options: ChatCallOptions,
  images: ReferenceImage[],
): Promise<ParsedObservations> {
  const result = await callChatCompletion(options, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `逐张观察下面 ${images.length} 张参考图，按格式输出 JSON。` },
          ...images.flatMap((image, index) => [
            { type: 'text', text: `图${index + 1}：` },
            {
              type: 'image_url',
              image_url: { url: `data:${image.mimeType};base64,${image.buffer.toString('base64')}` },
            },
          ]),
        ],
      },
    ],
    maxTokens: 700,
    // 观察要的是稳定可解析的 JSON，温度压到最低
    temperature: 0.2,
  })

  const parsed = parseObservations(result.content)
  if (parsed.size === 0) throw new Error('observation unparsable')
  return { items: parsed, tokens: result.tokens }
}

/** 模型偶尔加 ```json 围栏或前后缀，先截出第一对花括号再试；实在解析不了就按整段散文兜底 */
function parseObservations(content: string): Map<number, CachedObservation> {
  const observations = new Map<number, CachedObservation>()
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const payload = JSON.parse(content.slice(start, end + 1)) as { images?: unknown }
      const list = Array.isArray(payload.images) ? payload.images : []
      list.forEach((item, position) => {
        if (!item || typeof item !== 'object') return
        const source = item as Record<string, unknown>
        const index = typeof source.index === 'number' && Number.isInteger(source.index) && source.index > 0
          ? source.index - 1
          : position
        observations.set(index, {
          detail: buildDetail(source),
          targets: pickTargets(source.targets),
          at: 0,
        })
      })
    } catch {
      // 落到下面的散文兜底
    }
  }

  if (observations.size === 0) {
    const prose = content.replace(/```[a-zA-Z]*\n?/g, '').replace(/\s+/g, ' ').trim()
    if (prose) {
      observations.set(0, { detail: prose.slice(0, 240), targets: [], at: 0 })
    }
  }

  return observations
}

const DETAIL_FIELDS: Array<[string, string]> = [
  ['subject', '主体'],
  ['composition', '构图'],
  ['background', '背景'],
  ['lighting', '光线'],
  ['palette', '色调'],
  ['style', '风格'],
  ['text', '画面文字'],
]

function buildDetail(source: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, label] of DETAIL_FIELDS) {
    const value = typeof source[key] === 'string' ? source[key].trim() : ''
    if (!value) continue
    parts.push(`${label}：${value.slice(0, 40)}`)
  }
  return parts.join('；') || '不清晰'
}

function pickTargets(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item && item !== '无')
    .slice(0, 6)
}

function readCache(hash: string, now: number): CachedObservation | null {
  const cached = cache.get(hash)
  if (!cached) return null
  if (now - cached.at > CACHE_TTL_MS) {
    cache.delete(hash)
    return null
  }
  // 命中后挪到队尾，让淘汰顺序按最近使用
  cache.delete(hash)
  cache.set(hash, cached)
  return cached
}

function writeCache(hash: string, observation: CachedObservation, now: number): void {
  cache.delete(hash)
  cache.set(hash, { ...observation, at: now })
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}
