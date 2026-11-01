import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { ApiError } from '../lib/errors.js'
import { checkHealth } from '../services/magpie.js'
import type { SettingsStore } from '../services/settings-store.js'
import { requireAdmin } from './auth.js'

/**
 * 上游地址必须是 http/https 绝对地址，且不带账号密码——
 * 地址会被写进 settings.json 明文保存，把凭据带进来会白白泄露。
 * 返回值丢掉 query/hash 与末尾斜杠，后面拼 /v1/... 路径才稳。
 */
function parseBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiError('UPSTREAM_INVALID', '上游地址不能为空', 400)
  }

  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ApiError(
      'UPSTREAM_INVALID',
      '上游地址必须是完整的 http/https 地址，例如 http://127.0.0.1:3425',
      400,
    )
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError('UPSTREAM_INVALID', '上游地址只支持 http 或 https', 400)
  }
  if (url.username || url.password) {
    throw new ApiError('UPSTREAM_INVALID', '上游地址不能包含账号密码', 400)
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export function registerUpstreamRoutes(
  app: FastifyInstance,
  deps: { settings: SettingsStore },
): void {
  app.get('/api/admin/upstream', async request => {
    requireAdmin(request)
    return {
      baseUrl: await deps.settings.getBaseUrl(),
      model: deps.settings.getModel(),
      fromSettings: deps.settings.isFromSettings(),
    }
  })

  app.put('/api/admin/upstream', async (request, reply) => {
    requireAdmin(request)
    const body = (request.body ?? {}) as { baseUrl?: unknown }
    const baseUrl = parseBaseUrl(body.baseUrl)
    await deps.settings.setBaseUrl(baseUrl)
    request.log.info({ baseUrl }, '上游地址已更新')
    return reply.send({ ok: true, baseUrl })
  })

  /**
   * 连通性测试：测的是请求里带的地址（可能是还没保存的），
   * 不写配置，供后台在保存前先试一下。
   */
  app.post('/api/admin/upstream/test', async request => {
    requireAdmin(request)
    const body = (request.body ?? {}) as { baseUrl?: unknown }

    let baseUrl: string
    try {
      baseUrl = parseBaseUrl(body.baseUrl)
    } catch {
      return { reachable: false, status: null, detail: '上游地址无效，请填写完整的 http/https 地址' }
    }

    const health = await checkHealth({
      baseUrl,
      model: deps.settings.getModel(),
      timeoutMs: config.requestTimeoutMs,
    })

    return {
      reachable: health.reachable,
      status: null,
      detail: health.reachable ? '上游可连通' : health.error ?? '无法连接上游',
    }
  })
}
