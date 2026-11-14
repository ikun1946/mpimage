import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 请求日志：生图、提示词优化、提示词改写都按条记录，成功失败都留。
 *
 * 与 realtime-monitor 的区别：监控是进程内的环形缓冲，重启就没了；
 * 这份日志落盘，管理端可以按条展开看提示词、参数、耗时、失败原因，
 * 并按保留天数自动清理，避免越攒越大。
 */

export type RequestLogKind = 'image' | 'prompt-optimize' | 'prompt-revise'
export type RequestLogStatus = 'success' | 'failed'

export interface RequestLogImage {
  path: string
  width?: number
  height?: number
  bytes?: number
}

export interface RequestLogEntry {
  id: string
  kind: RequestLogKind
  status: RequestLogStatus
  startedAt: number
  endedAt: number
  durationMs: number
  user: { id: string; name: string }
  model: string
  source?: string
  ratio?: string
  /** 提示词全文（优化/改写时是输入的那一版） */
  prompt: string
  /** 优化/改写产出的提示词 */
  output?: string
  images?: RequestLogImage[]
  counts?: { requested?: number; ok?: number; failed?: number; references?: number }
  params?: Record<string, string | number | boolean | null>
  timings?: Record<string, number>
  tokens?: { input?: number | null; output?: number | null; total?: number | null }
  error?: { code?: string; message: string; log?: string[] }
}

interface RequestLogFile {
  version: 1
  retentionDays: number
  entries: RequestLogEntry[]
}

export interface RequestLogListOptions {
  limit?: number
  offset?: number
  status?: RequestLogStatus | 'all'
  kind?: RequestLogKind | 'all'
  query?: string
}

const MAX_ENTRIES = 2000
const DEFAULT_RETENTION_DAYS = 30
const MIN_RETENTION_DAYS = 1
const MAX_RETENTION_DAYS = 365
const WRITE_DEBOUNCE_MS = 400
/** 自动清理最多每小时跑一次，别每条都算 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

export class RequestLogStore {
  private readonly file: string
  private entries: RequestLogEntry[] = []
  private retentionDays = DEFAULT_RETENTION_DAYS
  private loaded = false
  private dirty = false
  private timer: NodeJS.Timeout | null = null
  private lastCleanupAt = 0
  private flushing: Promise<void> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<RequestLogFile>
      this.entries = Array.isArray(parsed.entries) ? parsed.entries : []
      const days = Number(parsed.retentionDays)
      if (Number.isFinite(days) && days >= MIN_RETENTION_DAYS) {
        this.retentionDays = Math.min(Math.round(days), MAX_RETENTION_DAYS)
      }
    } catch {
      this.entries = []
    }
    this.loaded = true
    this.prune()
  }

  /** 记一条。任何失败都吞掉：日志不能反过来影响业务。 */
  append(entry: RequestLogEntry): void {
    try {
      this.entries.unshift(entry)
      this.prune()
      this.scheduleWrite()
    } catch {
      // 忽略
    }
  }

  list(options: RequestLogListOptions = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
    const offset = Math.max(options.offset ?? 0, 0)
    const status = options.status && options.status !== 'all' ? options.status : null
    const kind = options.kind && options.kind !== 'all' ? options.kind : null
    const query = (options.query || '').trim().toLowerCase()

    const matched = this.entries.filter(entry => {
      if (status && entry.status !== status) return false
      if (kind && entry.kind !== kind) return false
      if (!query) return true
      return (
        entry.prompt.toLowerCase().includes(query) ||
        (entry.output || '').toLowerCase().includes(query) ||
        entry.model.toLowerCase().includes(query) ||
        entry.user.name.toLowerCase().includes(query) ||
        entry.id.toLowerCase().includes(query) ||
        (entry.error?.message || '').toLowerCase().includes(query)
      )
    })

    return {
      total: matched.length,
      entries: matched.slice(offset, offset + limit).map(toSummary),
    }
  }

  get(id: string): RequestLogEntry | null {
    return this.entries.find(entry => entry.id === id) || null
  }

  /** 最近 24 小时的概览：条数、成功率、平均耗时、提示词优化的消耗 */
  stats() {
    const since = Date.now() - 24 * 60 * 60 * 1000
    const recent = this.entries.filter(entry => entry.startedAt >= since)
    const images = recent.filter(entry => entry.kind === 'image')
    const prompts = recent.filter(entry => entry.kind !== 'image')
    const ok = images.filter(entry => entry.status === 'success')
    const failed = images.filter(entry => entry.status === 'failed')
    const avg = (list: RequestLogEntry[]) =>
      list.length ? Math.round(list.reduce((sum, item) => sum + item.durationMs, 0) / list.length) : 0
    const sumTokens = (list: RequestLogEntry[]) =>
      list.reduce((sum, item) => sum + (item.tokens?.total ?? 0), 0)

    return {
      windowHours: 24,
      total: recent.length,
      images: {
        total: images.length,
        success: ok.length,
        failed: failed.length,
        successRate: images.length ? +((ok.length / images.length) * 100).toFixed(1) : 0,
        avgDurationMs: avg(images),
        imagesProduced: ok.reduce((sum, item) => sum + (item.counts?.ok ?? 0), 0),
      },
      prompts: {
        total: prompts.length,
        failed: prompts.filter(entry => entry.status === 'failed').length,
        avgDurationMs: avg(prompts),
        tokens: sumTokens(prompts),
        optimize: prompts.filter(entry => entry.kind === 'prompt-optimize').length,
        revise: prompts.filter(entry => entry.kind === 'prompt-revise').length,
      },
      stored: this.entries.length,
      retentionDays: this.retentionDays,
    }
  }

  getRetention(): number {
    return this.retentionDays
  }

  setRetention(days: number): number {
    const next = Math.min(Math.max(Math.round(days), MIN_RETENTION_DAYS), MAX_RETENTION_DAYS)
    this.retentionDays = next
    this.prune()
    this.scheduleWrite()
    return next
  }

  clear(): number {
    const removed = this.entries.length
    this.entries = []
    this.scheduleWrite()
    return removed
  }

  /** 进程退出前把没落盘的一次性写完 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.writeNow()
  }

  /** 按保留天数裁掉旧记录，并兜住总条数上限 */
  private prune(): void {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000
    const kept = this.entries.filter(entry => entry.startedAt >= cutoff)
    if (kept.length > MAX_ENTRIES) kept.length = MAX_ENTRIES
    if (kept.length !== this.entries.length) {
      this.entries = kept
      this.dirty = true
    }
    this.lastCleanupAt = Date.now()
  }

  private scheduleWrite(): void {
    if (!this.loaded) return
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (Date.now() - this.lastCleanupAt > CLEANUP_INTERVAL_MS) this.prune()
      void this.writeNow()
    }, WRITE_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  private async writeNow(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const payload: RequestLogFile = {
      version: 1,
      retentionDays: this.retentionDays,
      entries: this.entries,
    }
    this.flushing = this.flushing.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true })
        const temp = `${this.file}.tmp`
        await writeFile(temp, JSON.stringify(payload), 'utf8')
        await rename(temp, this.file)
      } catch {
        this.dirty = true
      }
    })
    await this.flushing
  }
}

/** 列表只带摘要，提示词截断，避免一页拉回几十万字 */
function toSummary(entry: RequestLogEntry) {
  return {
    id: entry.id,
    kind: entry.kind,
    status: entry.status,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationMs: entry.durationMs,
    user: entry.user,
    model: entry.model,
    source: entry.source,
    ratio: entry.ratio,
    promptPreview: entry.prompt.slice(0, 120),
    outputPreview: (entry.output || '').slice(0, 120),
    counts: entry.counts,
    imageCount: entry.images?.length ?? 0,
    tokens: entry.tokens,
    error: entry.error ? { code: entry.error.code, message: entry.error.message } : undefined,
  }
}
