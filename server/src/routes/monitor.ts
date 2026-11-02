import type { FastifyInstance } from 'fastify'
import os from 'node:os'
import { ApiError } from '../lib/errors.js'
import { requireAdmin } from './auth.js'
import type { ConcurrencyStore } from '../services/concurrency-store.js'
import type { RateLimiter } from '../services/rate-limiter.js'
import type { TrafficStore } from '../services/traffic-store.js'
import type { SerialGate } from '../lib/serial-gate.js'

export function registerMonitorRoutes(
  app: FastifyInstance,
  deps: {
    traffic: TrafficStore
    rateLimiter: RateLimiter
    processStartedAt: number
    gate: SerialGate
    concurrency: ConcurrencyStore
  },
): void {
  // 管理端监控总览：流量、运行时间、限流状态
  app.get('/api/admin/monitor', async request => {
    requireAdmin(request)

    const snapshot = deps.traffic.snapshot()
    const uptimeMs = Date.now() - deps.processStartedAt

    return {
      uptime: {
        startedAt: new Date(deps.processStartedAt).toISOString(),
        uptimeMs,
        uptimeText: formatUptime(uptimeMs),
      },
      host: {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()}`,
        totalMemoryGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
        loadAvg: os.loadavg()[0] || 0,
      },
      traffic: {
        scope: snapshot.scope,
        total: snapshot.total,
        since: snapshot.since,
        clients: snapshot.clients,
      },
      rateLimit: deps.rateLimiter.status(),
      queue: {
        busy: deps.gate.isBusy,
        active: deps.gate.activeCount,
        limit: deps.gate.limitCount,
        waiting: deps.gate.queueLength,
      },
    }
  })

  // 管理端限流配置：读取 + 修改
  app.get('/api/admin/rate-limit', async request => {
    requireAdmin(request)
    return deps.rateLimiter.status()
  })

  app.put('/api/admin/rate-limit', async (request, reply) => {
    requireAdmin(request)
    const body = (request.body ?? {}) as {
      enabled?: unknown
      windowMs?: unknown
      maxRequests?: unknown
    }

    const config = await deps.rateLimiter.updateConfig({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      windowMs: Number(body.windowMs) > 0 ? Number(body.windowMs) : undefined,
      maxRequests: Number(body.maxRequests) > 0 ? Number(body.maxRequests) : undefined,
    })

    return reply.send({ config })
  })

  /** 生图并发上限：读取 + 运行时调整（改完立即生效，并写入 concurrency.json） */
  app.get('/api/admin/concurrency', async request => {
    requireAdmin(request)
    return concurrencyStatus(deps)
  })

  app.put('/api/admin/concurrency', async (request, reply) => {
    requireAdmin(request)
    const body = (request.body ?? {}) as { limit?: unknown }
    // 只接受 JSON 数字：null/''/布尔/数组经 Number() 会变成 0，不能当作“不限”放行
    const limit = typeof body.limit === 'number' ? body.limit : Number.NaN
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new ApiError('CONCURRENCY_INVALID', '生图并发必须是 0 或正整数，0 表示不限制', 400)
    }

    const saved = await deps.concurrency.set(limit)
    deps.gate.setLimit(saved)
    request.log.info({ limit: saved }, '生图并发上限已调整')
    return reply.send(concurrencyStatus(deps))
  })
}

function concurrencyStatus(deps: { gate: SerialGate; concurrency: ConcurrencyStore }) {
  const limit = deps.gate.limitCount
  return {
    limit,
    unlimited: limit === 0,
    active: deps.gate.activeCount,
    waiting: deps.gate.queueLength,
    persisted: deps.concurrency.get(),
  }
}

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86_400)
  const hours = String(Math.floor((totalSec % 86_400) / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0')
  const seconds = String(totalSec % 60).padStart(2, '0')
  if (days > 0) return `${days} 天 ${hours}:${minutes}:${seconds}`
  return `${hours}:${minutes}:${seconds}`
}
