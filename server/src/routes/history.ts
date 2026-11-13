import type { FastifyInstance } from 'fastify'
import { buildFileUrl } from '../lib/url.js'
import type { QuotaStore } from '../services/quota-store.js'
import type { UsageStore } from '../services/usage-store.js'
import { requireAuth } from './auth.js'

export function registerHistoryRoutes(
  app: FastifyInstance,
  deps: { usage: UsageStore; quotas: QuotaStore },
): void {
  // 当前账号的今日额度状态（dailyLimit 0 = 不限额）
  app.get('/api/quota', async request => {
    const auth = requireAuth(request)
    const quota = deps.quotas.get(auth.userId)
    const usedToday = await deps.usage.countToday(auth.userId)
    return {
      dailyLimit: quota.dailyLimit,
      usedToday,
      remaining: quota.dailyLimit > 0 ? Math.max(0, quota.dailyLimit - usedToday) : null,
    }
  })
  // 当前登录账号自己的生成记录，最新在前
  app.get('/api/history', async request => {
    const auth = requireAuth(request)

    const query = request.query as { limit?: unknown } | undefined
    const parsed = Number.parseInt(String(query?.limit ?? ''), 10)
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 200

    const entries = await deps.usage.entriesForUser(auth.userId)

    return {
      entries: entries.slice(0, limit).map(entry => ({
        id: entry.id,
        source: entry.source,
        category: entry.category,
        name: entry.name,
        prompt: entry.prompt,
        ratio: entry.ratio,
        width: entry.width,
        height: entry.height,
        bytes: entry.bytes,
        durationMs: entry.durationMs,
        tokensInput: entry.tokensInput ?? null,
        tokensOutput: entry.tokensOutput ?? null,
        tokensSource: entry.tokensSource || '',
        createdAt: entry.createdAt,
        batchId: entry.batchId || '',
        imageUrl: buildFileUrl(request, entry.relativePath),
      })),
    }
  })
}
