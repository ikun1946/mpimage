/**
 * 每客户端限流：滑动窗口计数（内存），配置持久化到 data/rate-limit.json。
 * windowMs 内超过 maxRequests 的客户端收到 429。
 * enabled=false 或 maxRequests<=0 表示不限流。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface RateLimitConfig {
  enabled: boolean
  /** 滑动窗口长度（毫秒） */
  windowMs: number
  /** 窗口内允许的最大请求数 */
  maxRequests: number
  updatedAt: string
}

interface Bucket {
  /** 窗口起点毫秒时间戳 */
  windowStart: number
  count: number
}

const DEFAULT_CONFIG: RateLimitConfig = {
  enabled: false,
  windowMs: 60_000,
  maxRequests: 60,
  updatedAt: '',
}

export class RateLimiter {
  private readonly file: string
  private config: RateLimitConfig = { ...DEFAULT_CONFIG }
  private buckets = new Map<string, Bucket>()
  /** 最近一次被限流的客户端与剩余等待秒数，供管理端展示 */
  private lastRejected: { ip: string; retryAfterSec: number; at: string } | null = null

  constructor(dataDir: string) {
    this.file = join(dataDir, 'rate-limit.json')
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<RateLimitConfig>
      this.config = {
        enabled: Boolean(parsed.enabled),
        windowMs: Number(parsed.windowMs) > 0 ? Number(parsed.windowMs) : DEFAULT_CONFIG.windowMs,
        maxRequests: Number(parsed.maxRequests) > 0 ? Number(parsed.maxRequests) : DEFAULT_CONFIG.maxRequests,
        updatedAt: parsed.updatedAt || '',
      }
    } catch {
      // 首次运行使用默认配置
    }
  }

  getConfig(): RateLimitConfig {
    return { ...this.config }
  }

  async updateConfig(patch: Partial<Pick<RateLimitConfig, 'enabled' | 'windowMs' | 'maxRequests'>>): Promise<RateLimitConfig> {
    if (typeof patch.enabled === 'boolean') this.config.enabled = patch.enabled
    if (Number(patch.windowMs) > 0) this.config.windowMs = Math.min(Number(patch.windowMs), 3_600_000)
    if (Number(patch.maxRequests) > 0) this.config.maxRequests = Math.min(Number(patch.maxRequests), 100_000)
    this.config.updatedAt = new Date().toISOString()

    await mkdir(join(this.file, '..'), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(this.config, null, 2), 'utf8')
    await rename(temp, this.file)
    return this.getConfig()
  }

  /**
   * 尝试放行一个请求。
   * 返回 null 表示放行；返回秒数表示被限流，需等待这么多秒。
   */
  tryAccept(ip: string): number | null {
    if (!this.config.enabled || this.config.maxRequests <= 0) return null

    const now = Date.now()
    const bucket = this.buckets.get(ip)

    if (!bucket || now - bucket.windowStart >= this.config.windowMs) {
      this.buckets.set(ip, { windowStart: now, count: 1 })
      return null
    }

    bucket.count += 1
    if (bucket.count > this.config.maxRequests) {
      const retryAfterSec = Math.ceil((bucket.windowStart + this.config.windowMs - now) / 1000)
      this.lastRejected = { ip, retryAfterSec, at: new Date().toISOString() }
      return retryAfterSec
    }
    return null
  }

  status(): { config: RateLimitConfig; activeClients: number; lastRejected: { ip: string; retryAfterSec: number; at: string } | null } {
    // 顺带清理过期桶，防止长期运行内存膨胀
    const now = Date.now()
    for (const [ip, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.config.windowMs) this.buckets.delete(ip)
    }
    return {
      config: this.getConfig(),
      activeClients: this.buckets.size,
      lastRejected: this.lastRejected,
    }
  }
}
