/**
 * 生图实时监控：进程内记录、聚合与快照。
 *
 * 只记录真实能测到的阶段（排队、账号领取、令牌刷新、上游、解析、存储、总额度写入），
 * 不伪造 DNS/TCP/TLS、SSE 之外的网络细节。所有耗时都是整数毫秒。
 */

export type MonitorBranch = 'account' | 'custom' | 'magpie'
export type MonitorStatus = 'running' | 'success' | 'failed'

export type MonitorMetrics = Record<string, number>

export interface MonitorAttempt {
  attempt: number
  account_id?: string
  account_label?: string
  account_email?: string
  plan?: string
  acquire_ms?: number
  refresh_ms?: number
  upstream_ms?: number
  outcome: string
  error?: string
}

export interface MonitorImage {
  index: number
  status: MonitorStatus
  stage: string
  stage_label: string
  model?: string
  mime_type?: string
  bytes?: number
  width?: number
  height?: number
  stored_path?: string
  duration_ms?: number
  metrics: MonitorMetrics
  error?: string
}

export interface MonitorRecord {
  call_id: string
  job_id: string
  endpoint: string
  model: string
  branch: MonitorBranch
  status: MonitorStatus
  stage: string
  stage_label: string
  started_at: number
  updated_at: number
  ended_at?: number
  duration_ms?: number
  image_count: number
  images_done: number
  images_failed: number
  reference_count: number
  user: { id: string; name: string }
  metrics: MonitorMetrics
  attempts: MonitorAttempt[]
  images: MonitorImage[]
  account?: { id: string; label: string; email: string; plan: string }
  error?: string
  /** 内部：最近一次 stage 开始时间，仅用于 stage_elapsed_ms */
  stage_started_at?: number
}

export interface MonitorEvent {
  at: number
  call_id: string
  model: string
  stage: string
  stage_label: string
  status: MonitorStatus
  duration_ms?: number
}

const METRIC_LABELS: Record<string, string> = {
  total_ms: '总耗时',
  validate_ms: '参数校验',
  model_resolve_ms: '模型解析',
  quota_check_ms: '额度检查',
  reference_load_ms: '参考图读取',
  config_read_ms: '配置读取',
  queue_wait_ms: '排队等待',
  account_acquire_ms: '账号领取',
  token_refresh_ms: '令牌刷新',
  upstream_headers_ms: '上游响应头',
  upstream_ms: '上游请求',
  sse_first_event_ms: 'SSE 首事件',
  sse_max_gap_ms: 'SSE 最大空窗',
  download_ms: '图片下载',
  parse_ms: '图片解析',
  store_ms: '图片存储',
  title_ms: '标题生成',
  usage_write_ms: '用量写入',
  image_total_ms: '单图总耗时',
}

const STAGE_LABELS: Record<string, string> = {
  queued: '排队等待',
  generating: '上游生成',
  storing: '图片存储',
  done: '已完成',
  failed: '失败',
  refreshing: '刷新令牌',
}

const BOTTLENECK_KEYS = [
  'queue_wait_ms',
  'account_acquire_ms',
  'token_refresh_ms',
  'upstream_headers_ms',
  'upstream_ms',
  'parse_ms',
  'store_ms',
  'title_ms',
  'usage_write_ms',
  'total_ms',
]

const ACTIVE_LIMIT = 100
const RECENT_LIMIT = 80
const SLOW_LIMIT = 50
const EVENT_LIMIT = 80
const RECENT_CAPACITY = clampInt(process.env.IMAGE_MONITOR_COMPLETED_LIMIT, 500, 50, 5000)
const EVENT_CAPACITY = clampInt(process.env.IMAGE_MONITOR_EVENT_LIMIT, 1000, 100, 10000)
const ACTIVE_TTL_MS = clampInt(process.env.IMAGE_MONITOR_ACTIVE_TTL_MS, 30 * 60_000, 60_000, 24 * 60 * 60_000)

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function ms(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(0, Math.floor(numeric)) : 0
}

function p95(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(sorted.length * 0.95)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] || 0
}

function average(values: number[]): number {
  if (!values.length) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function maskEmail(email: string): string {
  const value = String(email || '').trim()
  const at = value.indexOf('@')
  if (at <= 0) return value ? `${value.slice(0, 1)}***` : ''
  return `${value.slice(0, 1)}***${value.slice(at)}`
}

export interface StartInput {
  callId: string
  jobId: string
  endpoint: string
  model: string
  branch: MonitorBranch
  imageCount: number
  referenceCount: number
  userId: string
  userName: string
  receivedAt: number
  startedAt: number
}

export class RealtimeMonitor {
  private readonly active = new Map<string, MonitorRecord>()
  private readonly completed: MonitorRecord[] = []
  private readonly events: MonitorEvent[] = []
  private version = 0
  private cachedSummary: Record<string, unknown> | null = null
  private cachedSummaryVersion = -1

  start(input: StartInput): MonitorRecord {
    const now = input.startedAt || Date.now()
    const record: MonitorRecord = {
      call_id: input.callId,
      job_id: input.jobId,
      endpoint: input.endpoint,
      model: input.model,
      branch: input.branch,
      status: 'running',
      stage: 'queued',
      stage_label: STAGE_LABELS.queued || 'queued',
      started_at: input.receivedAt || now,
      updated_at: now,
      image_count: input.imageCount,
      images_done: 0,
      images_failed: 0,
      reference_count: input.referenceCount,
      user: { id: input.userId, name: input.userName },
      metrics: {},
      attempts: [],
      images: [],
    }
    record.stage_started_at = now
    this.active.set(record.call_id, record)
    this.pushEvent(record, 'queued', 'queued', 'running')
    this.version += 1
    return record
  }

  annotate(callId: string, patch: Partial<MonitorRecord>): void {
    const record = this.active.get(callId)
    if (!record) return
    Object.assign(record, patch, { updated_at: Date.now() })
  }

  annotateAccount(
    callId: string,
    account: { id: string; label: string; email: string; plan: string } | null | undefined,
  ): void {
    if (!account) return
    const record = this.active.get(callId)
    if (!record) return
    record.account = {
      id: account.id,
      label: account.label || account.email || account.id,
      email: maskEmail(account.email),
      plan: account.plan,
    }
    record.updated_at = Date.now()
  }

  stage(callId: string, stage: string): void {
    const record = this.active.get(callId)
    if (!record) return
    record.stage = stage
    record.stage_label = STAGE_LABELS[stage] || stage
    record.stage_started_at = Date.now()
    record.updated_at = Date.now()
    this.pushEvent(record, stage, stage, 'running')
    this.version += 1
  }

  metric(callId: string, key: string, value: number): void {
    const record = this.active.get(callId)
    if (!record) return
    const next = ms(value)
    record.metrics[key] = Math.max(record.metrics[key] || 0, next)
    record.updated_at = Date.now()
    this.version += 1
  }

  imageStart(callId: string, index: number): void {
    const record = this.active.get(callId)
    if (!record) return
    if (!record.images.some(image => image.index === index)) {
      record.images.push({
        index,
        status: 'running',
        stage: 'generating',
        stage_label: STAGE_LABELS.generating || 'generating',
        metrics: {},
      })
    }
    record.updated_at = Date.now()
    this.version += 1
  }

  imageMetric(callId: string, index: number, key: string, value: number): void {
    const record = this.active.get(callId)
    const image = record?.images.find(item => item.index === index)
    if (!record || !image) return
    const next = ms(value)
    image.metrics[key] = Math.max(image.metrics[key] || 0, next)
    record.metrics[key] = Math.max(record.metrics[key] || 0, next)
    record.updated_at = Date.now()
    this.version += 1
  }

  mergeUpstreamMetrics(callId: string, index: number, metrics: MonitorMetrics | undefined): void {
    if (!metrics) return
    for (const [key, value] of Object.entries(metrics)) {
      this.imageMetric(callId, index, key, value)
    }
  }

  attempt(callId: string, attempt: MonitorAttempt): void {
    const record = this.active.get(callId)
    if (!record) return
    record.attempts.push(attempt)
    if (attempt.acquire_ms) {
      record.metrics.account_acquire_ms = Math.max(
        record.metrics.account_acquire_ms || 0,
        ms(attempt.acquire_ms),
      )
    }
    if (attempt.refresh_ms) {
      record.metrics.token_refresh_ms = Math.max(
        record.metrics.token_refresh_ms || 0,
        ms(attempt.refresh_ms),
      )
    }
    record.updated_at = Date.now()
    this.version += 1
  }

  imageFinish(
    callId: string,
    index: number,
    patch: Partial<MonitorImage> & { status: MonitorStatus },
  ): void {
    const record = this.active.get(callId)
    const image = record?.images.find(item => item.index === index)
    if (!record || !image) return
    Object.assign(image, patch, {
      stage: patch.status === 'failed' ? 'failed' : 'done',
      stage_label: (patch.status === 'failed' ? STAGE_LABELS.failed : STAGE_LABELS.done) || 'done',
    })
    if (patch.metrics) {
      for (const [key, value] of Object.entries(patch.metrics)) {
        image.metrics[key] = Math.max(image.metrics[key] || 0, ms(value))
      }
    }
    record.updated_at = Date.now()
    this.version += 1
  }

  finish(
    callId: string,
    result: { status: 'success' | 'failed'; error?: string },
  ): void {
    const record = this.active.get(callId)
    if (!record) return
    const now = Date.now()
    record.status = result.status
    record.stage = result.status === 'success' ? 'done' : 'failed'
    record.stage_label = STAGE_LABELS[record.stage] || record.stage
    record.ended_at = now
    record.duration_ms = Math.max(0, now - record.started_at)
    record.metrics.total_ms = Math.max(record.metrics.total_ms || 0, record.duration_ms)
    if (result.error) record.error = String(result.error).slice(0, 500)

    // 子图指标折回父记录，保证聚合口径完整
    for (const image of record.images) {
      for (const [key, value] of Object.entries(image.metrics)) {
        record.metrics[key] = Math.max(record.metrics[key] || 0, value)
      }
    }
    record.images_done = record.images.filter(image => image.status === 'success').length
    record.images_failed = record.images.filter(image => image.status === 'failed').length

    this.active.delete(callId)
    this.completed.push(record)
    if (this.completed.length > RECENT_CAPACITY) {
      this.completed.splice(0, this.completed.length - RECENT_CAPACITY)
    }
    this.pushEvent(record, record.stage, record.stage_label, result.status)
    this.version += 1
  }

  snapshot(): Record<string, unknown> {
    this.sweep()
    const now = Date.now()
    const completed = this.completed
    const totals = completed.map(record => record.duration_ms || 0)
    const success = completed.filter(record => record.status === 'success').length
    const failed = completed.length - success
    const metricP95: MonitorMetrics = {}
    const metricValues = new Map<string, number[]>()
    for (const record of completed) {
      for (const [key, value] of Object.entries(record.metrics)) {
        const list = metricValues.get(key) || []
        list.push(value)
        metricValues.set(key, list)
      }
    }
    for (const key of Object.keys(METRIC_LABELS)) {
      const values = metricValues.get(key)
      if (values && values.length) metricP95[key] = p95(values)
    }

    let bottleneck: { key: string; label: string; value_ms: number } | null = null
    for (const key of BOTTLENECK_KEYS) {
      const value = metricP95[key] || 0
      if (value <= 0) continue
      if (!bottleneck || value > bottleneck.value_ms) {
        bottleneck = { key, label: METRIC_LABELS[key] || key, value_ms: value }
      }
    }

    const slowCounts = {
      queue_wait: completed.filter(record => (record.metrics.queue_wait_ms || 0) > 1000).length,
      account_acquire: completed.filter(record => (record.metrics.account_acquire_ms || 0) > 3000).length,
      upstream_over_60s: completed.filter(record => (record.metrics.upstream_ms || 0) > 60_000).length,
      store: completed.filter(record => (record.metrics.store_ms || 0) > 1000).length,
      total_over_120s: completed.filter(record => (record.duration_ms || 0) > 120_000).length,
      local_reject_or_busy: completed.filter(
        record => record.status === 'failed' && /BUSY|POOL_EMPTY|RATE_LIMIT|QUOTA/i.test(record.error || ''),
      ).length,
    }

    const active = [...this.active.values()]
      .sort((a, b) => a.started_at - b.started_at)
      .slice(0, ACTIVE_LIMIT)
    const recent = [...completed].reverse().slice(0, RECENT_LIMIT)
    const slow = [...completed]
      .filter(record => (record.duration_ms || 0) > 0)
      .sort((a, b) => (b.duration_ms || 0) - (a.duration_ms || 0))
      .slice(0, SLOW_LIMIT)

    const summary = {
      active: active.length,
      completed: completed.length,
      success,
      failed,
      success_rate: completed.length ? Number(((success / completed.length) * 100).toFixed(1)) : 0,
      avg_duration_ms: average(totals),
      p95_duration_ms: p95(totals),
      metric_p95: metricP95,
      slow_counts: slowCounts,
      bottleneck,
      by_model: countBy(completed, record => record.model),
      active_by_branch: countBy(active, record => record.branch),
      active_by_stage: countBy(active, record => record.stage_label),
      stale_dropped: 0,
    }

    return {
      updated_at: new Date(now).toISOString(),
      summary,
      active: active.map(record => this.publicRecord(record, now)),
      recent: recent.map(record => this.publicRecord(record, now)),
      slow: slow.map(record => this.publicRecord(record, now)),
      events: [...this.events].reverse().slice(0, EVENT_LIMIT).map(event => ({
        ...event,
        at: new Date(event.at).toISOString(),
      })),
      metric_labels: METRIC_LABELS,
      stage_labels: STAGE_LABELS,
      caps: {
        completed: RECENT_CAPACITY,
        events: EVENT_CAPACITY,
      },
    }
  }

  private publicRecord(record: MonitorRecord, now: number): Record<string, unknown> {
    return {
      call_id: record.call_id,
      job_id: record.job_id,
      endpoint: record.endpoint,
      model: record.model,
      branch: record.branch,
      status: record.status,
      stage: record.stage,
      stage_label: record.stage_label,
      started_at: new Date(record.started_at).toISOString(),
      updated_at: new Date(record.updated_at).toISOString(),
      ended_at: record.ended_at ? new Date(record.ended_at).toISOString() : null,
      elapsed_ms: Math.max(0, (record.ended_at || now) - record.started_at),
      stage_elapsed_ms: record.stage_started_at ? Math.max(0, now - record.stage_started_at) : 0,
      duration_ms: record.duration_ms || 0,
      image_count: record.image_count,
      images_done: record.images_done,
      images_failed: record.images_failed,
      reference_count: record.reference_count,
      user: record.user,
      metrics: { ...record.metrics },
      attempts: record.attempts.map(attempt => ({ ...attempt })),
      images: record.images.map(image => ({ ...image, metrics: { ...image.metrics } })),
      account: record.account ? { ...record.account } : null,
      error: record.error || null,
    }
  }

  private pushEvent(
    record: MonitorRecord,
    stage: string,
    label: string,
    status: MonitorStatus,
  ): void {
    this.events.push({
      at: Date.now(),
      call_id: record.call_id,
      model: record.model,
      stage,
      stage_label: label,
      status,
      duration_ms: record.duration_ms,
    })
    if (this.events.length > EVENT_CAPACITY) {
      this.events.splice(0, this.events.length - EVENT_CAPACITY)
    }
  }

  private sweep(): void {
    const now = Date.now()
    let dropped = 0
    for (const [id, record] of this.active) {
      if (now - record.updated_at > ACTIVE_TTL_MS) {
        this.active.delete(id)
        dropped += 1
      }
    }
    if (dropped) {
      this.events.push({
        at: now,
        call_id: '',
        model: '',
        stage: 'stale',
        stage_label: '超时清理',
        status: 'failed',
        duration_ms: 0,
      })
    }
  }
}

function countBy<T>(items: T[], keyOf: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items) {
    const key = keyOf(item) || 'unknown'
    out[key] = (out[key] || 0) + 1
  }
  return out
}
