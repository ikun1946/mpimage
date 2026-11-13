import type { FastifyInstance } from 'fastify'
import type { UpdateChecker } from '../services/update-checker.js'
import { requireAuth } from './auth.js'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 本机请求（桌面端自己）不需要登录；局域网其他设备必须登录后才能看版本信息 */
export function isLoopbackAddress(ip: string | undefined): boolean {
  return typeof ip === 'string' && LOOPBACK_ADDRESSES.has(ip)
}

export function registerUpdateRoutes(
  app: FastifyInstance,
  deps: { checker: UpdateChecker },
): void {
  app.get('/api/update/status', async request => {
    if (!isLoopbackAddress(request.ip)) requireAuth(request)
    const query = (request.query ?? {}) as { force?: unknown }
    return deps.checker.getStatus(query.force === '1')
  })
}
