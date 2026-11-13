/**
 * 按客户端 IP 的流量与请求统计。
 * 内存累计 + 定期落盘到 data/traffic.json，重启后延续总量。
 * 只统计客户端业务接口（口径见 lib/traffic-scope.ts），并记录口径生效时间。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TRAFFIC_SCOPE_LABEL, TRAFFIC_SCOPE_NAME, TRAFFIC_SCOPE_NOTE, type TrafficScope } from '../app/platform/traffic-scope.js'

export interface ClientTraffic {
  /** 累计请求次数 */
  requests: number
  /** 累计响应字节数 */
  bytesOut: number
  /** 累计请求字节数 */
  bytesIn: number
  /** 被限流拒绝的次数 */
  rejected: number
  lastSeen: string
}

interface TrafficDatabase {
  clients: Record<string, ClientTraffic>
  /** 服务累计启动时间戳，用于运行时间统计 */
  totalStartedAt: string
  /** 统计口径；旧版本文件没有这个字段 */
  scope?: TrafficScope
}

function emptyClient(): ClientTraffic {
  return { requests: 0, bytesOut: 0, bytesIn: 0, rejected: 0, lastSeen: '' }
}

function currentScope(since: string): TrafficScope {
  return { name: TRAFFIC_SCOPE_NAME, label: TRAFFIC_SCOPE_LABEL, since, note: TRAFFIC_SCOPE_NOTE }
}

/** 旧文件里的 scope 可能缺字段或类型不对，按整份校验后再采用 */
function isScope(value: unknown): value is TrafficScope {
  if (!value || typeof value !== 'object') return false
  const scope = value as Partial<TrafficScope>
  return (
    typeof scope.name === 'string' &&
    typeof scope.label === 'string' &&
    typeof scope.since === 'string' &&
    typeof scope.note === 'string'
  )
}

export class TrafficStore {
  private readonly file: string
  private db: TrafficDatabase = { clients: {}, totalStartedAt: new Date().toISOString() }
  private dirty = false

  constructor(dataDir: string) {
    this.file = join(dataDir, 'traffic.json')
  }

  async init(): Promise<void> {
    let scope: TrafficScope | null = null
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<TrafficDatabase>
      if (parsed && typeof parsed === 'object') {
        this.db = {
          clients: parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {},
          totalStartedAt: parsed.totalStartedAt || new Date().toISOString(),
          // 兼容旧文件：没有 scope 字段时下面按新口径补齐
          scope: isScope(parsed.scope) ? parsed.scope : undefined,
        }
        scope = this.db.scope ?? null
      }
    } catch {
      // 首次运行没有历史文件
    }
    if (!this.db.totalStartedAt) this.db.totalStartedAt = new Date().toISOString()
    // 首次按新口径启动：写入生效时间与备注。历史累计保留，
    // 所以 since 之前的部分仍含后台查询与健康探测（note 里已注明）。
    if (!scope || scope.name !== TRAFFIC_SCOPE_NAME) {
      this.db.scope = currentScope(new Date().toISOString())
      this.dirty = true
    }
  }

  record(ip: string, bytesIn: number, bytesOut: number, rejected = false): void {
    const client = this.db.clients[ip] || emptyClient()
    client.requests += 1
    client.bytesIn += bytesIn
    client.bytesOut += bytesOut
    if (rejected) client.rejected += 1
    client.lastSeen = new Date().toISOString()
    this.db.clients[ip] = client
    this.dirty = true
  }

  snapshot(): {
    clients: Array<ClientTraffic & { ip: string }>
    total: ClientTraffic
    /** 累计起点（沿用历史：旧口径的流量也在这里面） */
    since: string
    /** 当前统计口径 */
    scope: TrafficScope
  } {
    const clients = Object.entries(this.db.clients)
      .map(([ip, stat]) => ({ ip, ...stat }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 100)

    const total = emptyClient()
    for (const client of Object.values(this.db.clients)) {
      total.requests += client.requests
      total.bytesIn += client.bytesIn
      total.bytesOut += client.bytesOut
      total.rejected += client.rejected
    }

    return {
      clients,
      total,
      since: this.db.totalStartedAt,
      // init 一定会补齐 scope，这里再兜底一次，避免旧文件读出来是空
      scope: this.db.scope ?? currentScope(this.db.totalStartedAt),
    }
  }

  /** 定期调用：有变更才写盘。 */
  async flushIfDirty(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(this.db, null, 2), 'utf8')
    await rename(temp, this.file)
  }
}
