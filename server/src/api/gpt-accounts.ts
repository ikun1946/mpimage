/**
 * 后台账号池管理接口（全部要求管理员）。
 *
 * 安全约定：
 * - 响应只回脱敏视图，access_token / refresh_token 永不离开服务端
 * - 所有变更走 POST（与现有 CORS 放行的方法一致）
 * - “测试账号”是异步任务：桌面 IPC 单次请求 20 秒就超时，
 *   这里立即返回 jobId，面板轮询进度。
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { config } from '../app/platform/config.js'
import { ApiError } from '../app/platform/errors.js'
import { requireAdmin } from './auth.js'
import type { GptAccountPool } from '../app/control/accounts/account-pool.js'
import type { GptAccountStore } from '../app/control/accounts/gpt-account-store.js'
import {
  ACCOUNT_MODELS,
  type GptAccountSource,
} from '../app/control/accounts/account-types.js'
import { validateAccount } from '../app/products/openai/chatgpt-auth.js'

const MAX_IMPORT_CHARS = 2 * 1024 * 1024
const MAX_IDS = 50
const CHECK_JOB_TTL_MS = 10 * 60 * 1000
const CHECK_JOB_LIMIT = 20

interface CheckJobItem {
  id: string
  label: string
  ok: boolean
  message: string
}

interface CheckJob {
  id: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'done'
  total: number
  done: number
  failed: number
  results: CheckJobItem[]
}

const checkJobs = new Map<string, CheckJob>()

function pruneJobs(): void {
  const now = Date.now()
  for (const [id, job] of checkJobs) {
    const at = job.finishedAt ?? job.startedAt
    if (job.status === 'done' && now - at > CHECK_JOB_TTL_MS) checkJobs.delete(id)
  }
  while (checkJobs.size > CHECK_JOB_LIMIT) {
    const oldest = checkJobs.keys().next().value
    if (oldest === undefined) break
    checkJobs.delete(oldest)
  }
}

function parseIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ApiError('UPSTREAM_INVALID', '账号 ID 列表格式不正确', 400)
  }
  const ids = [...new Set(raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
    .map(item => item.trim())
    .slice(0, MAX_IDS)
  if (!ids.length) throw new ApiError('UPSTREAM_INVALID', '请先选择账号', 400)
  return ids
}

export function registerGptAccountRoutes(
  app: FastifyInstance,
  deps: { store: GptAccountStore; pool: GptAccountPool },
): void {
  const { store, pool } = deps

  function listPayload() {
    const inflight = pool.snapshotInflight()
    const available = new Set(store.availableModels().map(spec => spec.id))
    return {
      enabled: config.gptAccounts.enabled,
      accounts: store.listPublic().map(account => ({
        ...account,
        inflight: inflight.get(account.id) ?? 0,
      })),
      models: ACCOUNT_MODELS.map(spec => ({
        id: spec.id,
        label: spec.label,
        available: available.has(spec.id),
        accounts: store.countForModel(spec),
      })),
    }
  }

  app.get('/api/admin/gpt-accounts', async request => {
    requireAdmin(request)
    pruneJobs()
    return listPayload()
  })

  app.post('/api/admin/gpt-accounts/import', async request => {
    requireAdmin(request)
    const body = (request.body ?? {}) as { text?: unknown; source?: unknown }
    const text = typeof body.text === 'string' ? body.text : ''
    if (!text.trim()) {
      throw new ApiError('UPSTREAM_INVALID', '请粘贴要导入的账号内容', 400)
    }
    if (text.length > MAX_IMPORT_CHARS) {
      throw new ApiError('UPSTREAM_INVALID', '导入内容过大，请分批导入', 400)
    }
    const sourceRaw = typeof body.source === 'string' ? body.source.trim().toLowerCase() : ''
    if (sourceRaw && sourceRaw !== 'codex' && sourceRaw !== 'web') {
      throw new ApiError('UPSTREAM_INVALID', '账号类型只能是 codex 或 web', 400)
    }
    const source: GptAccountSource | undefined =
      sourceRaw === 'codex' || sourceRaw === 'web' ? sourceRaw : undefined

    const result = await store.importText(text, { defaultSource: source })
    request.log.info(
      { imported: result.imported, updated: result.updated, skipped: result.skipped },
      'GPT 账号导入完成',
    )
    return {
      ...result,
      ...listPayload(),
    }
  })

  app.post('/api/admin/gpt-accounts/update', async request => {
    requireAdmin(request)
    const body = (request.body ?? {}) as {
      id?: unknown
      label?: unknown
      enabled?: unknown
      maxConcurrency?: unknown
    }
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) throw new ApiError('UPSTREAM_INVALID', '缺少账号 ID', 400)
    const updated = await store.updateSettings(id, {
      ...(typeof body.label === 'string' ? { label: body.label } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.maxConcurrency === 'number' ? { maxConcurrency: body.maxConcurrency } : {}),
    })
    if (!updated) throw new ApiError('UPSTREAM_INVALID', '账号不存在', 404)
    return { account: updated, ...listPayload() }
  })

  app.post('/api/admin/gpt-accounts/delete', async request => {
    requireAdmin(request)
    const body = (request.body ?? {}) as { ids?: unknown }
    const removed = await store.remove(parseIds(body.ids))
    request.log.info({ removed }, 'GPT 账号已删除')
    return { removed, ...listPayload() }
  })

  app.post('/api/admin/gpt-accounts/clear-cooldown', async request => {
    requireAdmin(request)
    const body = (request.body ?? {}) as { ids?: unknown }
    const cleared = await store.clearCooldown(parseIds(body.ids))
    return { cleared, ...listPayload() }
  })

  app.post('/api/admin/gpt-accounts/check', async request => {
    requireAdmin(request)
    const body = (request.body ?? {}) as { ids?: unknown }
    const ids = parseIds(body.ids)

    pruneJobs()
    const job: CheckJob = {
      id: randomUUID(),
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      total: ids.length,
      done: 0,
      failed: 0,
      results: [],
    }
    checkJobs.set(job.id, job)

    // 顺序校验：同一时间只打一个上游，避免自己把自己限流
    void (async () => {
      for (const id of ids) {
        const account = store.get(id)
        if (!account) {
          job.results.push({ id, label: '', ok: false, message: '账号已删除' })
          job.failed += 1
          job.done += 1
          continue
        }
        let result: { ok: boolean; message: string }
        try {
          result = await validateAccount(store, account)
        } catch (error) {
          result = { ok: false, message: (error as Error).message || '校验失败' }
        }
        job.results.push({
          id,
          label: account.label || account.email || account.id,
          ok: result.ok,
          message: result.message,
        })
        if (!result.ok) job.failed += 1
        job.done += 1
      }
      job.status = 'done'
      job.finishedAt = Date.now()
      await store.flush().catch(() => undefined)
    })()

    return { jobId: job.id, total: job.total }
  })

  app.get('/api/admin/gpt-accounts/check/:id', async request => {
    requireAdmin(request)
    pruneJobs()
    const id = (request.params as { id?: string }).id ?? ''
    const job = checkJobs.get(id)
    if (!job) throw new ApiError('UPSTREAM_INVALID', '校验任务不存在或已过期', 404)
    return job
  })
}
