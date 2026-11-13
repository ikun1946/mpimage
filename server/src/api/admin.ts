import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ApiError } from '../app/platform/errors.js'
import { requireAdmin, type AuthContext } from './auth.js'
import { toPublicUser, type UserRecord, type UserStore } from '../services/user-store.js'
import type { QuotaStore } from '../app/control/quota-store.js'
import type { UsageEntry, UsageStore } from '../services/usage-store.js'

interface CreateUserBody {
  username?: unknown
  displayName?: unknown
  password?: unknown
  role?: unknown
}

interface UpdateUserBody {
  displayName?: unknown
  password?: unknown
  disabled?: unknown
}

/** 账号 ID 是 UUID v4；先校验格式再查库，避免把任意输入直接当主键用。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readUuidParam(request: FastifyRequest): string {
  const raw = (request.params as { id?: string }).id ?? ''
  if (!UUID_PATTERN.test(raw)) {
    throw new ApiError('AUTH_INVALID', '账号 ID 格式无效', 400)
  }
  return raw
}

/**
 * 按 :id 操作账号库时的统一入口：先确认操作者是管理员，再用
 * 「记录 ID + 操作者 ID」联合查询目标账号（数据层会再校验操作者身份）。
 *
 * 本项目的管理模型是「管理员管理整个账号库」，所以目标账号不能绑到调用者自身；
 * 但查询始终与操作者 ID 绑定，且 ID 先过 UUID 格式校验、再确认账号存在，
 * 避免把请求里的任意字符串直接当主键查库。
 */
async function requireTargetAccount(
  request: FastifyRequest,
  users: UserStore,
): Promise<{ admin: AuthContext; user: UserRecord }> {
  const admin = requireAdmin(request)
  const id = readUuidParam(request)
  const user = await users.findByIdForActor(id, admin.userId)
  if (!user) throw new ApiError('AUTH_INVALID', '账号不存在', 404)
  return { admin, user }
}

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: { users: UserStore; usage: UsageStore; quotas: QuotaStore },
): void {
  // 以下所有接口都要求管理员身份
  app.get('/api/admin/users', async request => {
    requireAdmin(request)
    const users = await deps.users.list()
    return { users: users.map(toPublicUser) }
  })

  app.post('/api/admin/users', async request => {
    requireAdmin(request)
    const body = (request.body ?? {}) as CreateUserBody

    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const displayName = typeof body.displayName === 'string' ? body.displayName : ''
    const role = body.role === 'admin' ? 'admin' : 'user'

    if (!username) throw new ApiError('INVALID_STYLES', '用户名不能为空')
    if (password.length < 6) {
      throw new ApiError('INVALID_STYLES', '密码至少 6 位')
    }

    try {
      const user = await deps.users.create({ username, displayName, password, role })
      return { user: toPublicUser(user) }
    } catch (error) {
      throw new ApiError('INVALID_STYLES', (error as Error).message)
    }
  })

  app.patch('/api/admin/users/:id', async request => {
    const { user: target } = await requireTargetAccount(request, deps.users)
    const body = (request.body ?? {}) as UpdateUserBody

    if (typeof body.displayName === 'string') {
      await deps.users.setDisplayName(target.id, body.displayName)
    }
    if (typeof body.password === 'string' && body.password) {
      if (body.password.length < 6) {
        throw new ApiError('INVALID_STYLES', '密码至少 6 位')
      }
      await deps.users.setPassword(target.id, body.password)
    }
    if (typeof body.disabled === 'boolean') {
      await deps.users.setDisabled(target.id, body.disabled)
    }

    const user = await deps.users.findById(target.id)
    if (!user) throw new ApiError('AUTH_INVALID', '账号不存在', 404)
    return { user: toPublicUser(user) }
  })

  app.delete('/api/admin/users/:id', async request => {
    const { admin, user: target } = await requireTargetAccount(request, deps.users)

    if (target.id === admin.userId) {
      throw new ApiError('INVALID_STYLES', '不能删除当前登录的管理员账号')
    }
    await deps.users.remove(target.id)
    return { ok: true }
  })

  // 统计：总量 + 按账号细分
  app.get('/api/admin/stats', async request => {
    requireAdmin(request)
    const entries = await deps.usage.entries()
    return buildStats(entries)
  })

  /* ===== 自助申请账号的审核 =====
     申请人在客户端登录页提交后，记录先以 pending 状态存在 users.json；
     只有这里通过之后才算真正注册成功（登录接口此前一律拒绝）。 */

  app.get('/api/admin/registrations', async request => {
    requireAdmin(request)
    const registrations = await deps.users.listPending()
    return { registrations: registrations.map(toPublicUser) }
  })

  app.post('/api/admin/registrations/:id/approve', async request => {
    const admin = requireAdmin(request)
    const id = readUuidParam(request)
    // 目标申请同样按「记录 ID + 操作者 ID」取，数据层再确认操作者是管理员
    const target = await deps.users.findByIdForActor(id, admin.userId)
    if (!target || !target.pending) {
      throw new ApiError('AUTH_INVALID', '该申请不存在或已经处理过', 404)
    }
    const record = await deps.users.approve(target.id)
    if (!record) throw new ApiError('AUTH_INVALID', '该申请不存在或已经处理过', 404)

    request.log.info(
      { actor: admin.userId, actorName: admin.username, target: record.username },
      '通过了账号申请，账号已可登录',
    )
    return { user: toPublicUser(record) }
  })

  app.post('/api/admin/registrations/:id/reject', async request => {
    const admin = requireAdmin(request)
    const id = readUuidParam(request)
    const target = await deps.users.findByIdForActor(id, admin.userId)
    if (!target || !target.pending) {
      throw new ApiError('AUTH_INVALID', '该申请不存在或已经处理过', 404)
    }
    const record = await deps.users.reject(target.id)
    if (!record) throw new ApiError('AUTH_INVALID', '该申请不存在或已经处理过', 404)

    request.log.info(
      { actor: admin.userId, actorName: admin.username, target: record.username },
      '拒绝了账号申请，已删除该记录',
    )
    return { ok: true, username: record.username }
  })

  // 每账号每日额度：列表（含今日已用张数）
  app.get('/api/admin/quotas', async request => {
    requireAdmin(request)
    const users = await deps.users.list()
    const quotas = deps.quotas.list()
    const rows = []
    for (const user of users) {
      rows.push({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        dailyLimit: quotas[user.id]?.dailyLimit || 0,
        usedToday: await deps.usage.countToday(user.id),
        updatedAt: quotas[user.id]?.updatedAt || '',
      })
    }
    return { quotas: rows }
  })

  /**
   * 设置某账号每日额度：dailyLimit <= 0 表示不限额。
   *
   * 授权模型：这是管理员对「账号库」的操作，作用对象天然是任意账号，
   * 因此授权闸口是 requireAdmin（非管理员一律 403），而不是把目标 ID
   * 绑到调用者自身——绑自身会让「给其他账号设额度」这件事无法实现。
   * 目标账号统一从 requireTargetAccount 取：UUID 校验 + 与操作者 ID 联合查询，
   * 并记录操作者，便于审计。
   */
  app.put('/api/admin/users/:id/quota', async (request, reply) => {
    const { admin, user } = await requireTargetAccount(request, deps.users)

    const body = (request.body ?? {}) as { dailyLimit?: unknown }
    const dailyLimit = Math.max(0, Math.min(Math.floor(Number(body.dailyLimit) || 0), 10_000))
    const entry = await deps.quotas.set(user.id, dailyLimit)

    request.log.info(
      { actor: admin.userId, actorName: admin.username, target: user.id, targetName: user.username, dailyLimit },
      '设置了账号每日生图额度',
    )

    return reply.send({
      quota: {
        userId: user.id,
        username: user.username,
        dailyLimit: entry.dailyLimit,
        usedToday: await deps.usage.countToday(user.id),
      },
    })
  })

  // 生图趋势折线图：today 按小时分桶，其余按天分桶，数据取自本地 usage.json
  app.get('/api/admin/stats/trend', async request => {
    requireAdmin(request)
    const query = (request.query ?? {}) as { range?: unknown }
    const range =
      typeof query.range === 'string' && query.range in TREND_RANGES
        ? (query.range as TrendRange)
        : '7d'
    const entries = await deps.usage.entries()
    return buildTrend(entries, range)
  })
}

const TREND_RANGES = {
  today: 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '180d': 180,
} as const

type TrendRange = keyof typeof TREND_RANGES

export interface TrendUserBreakdown {
  username: string
  displayName: string
  count: number
  tokens: number
}

export interface TrendBucket {
  label: string
  count: number
  /** 该时间段消耗的 token 合计（入 + 出） */
  tokens: number
  /** 按账号拆分，按张数降序 */
  users: TrendUserBreakdown[]
}

export interface TrendPayload {
  range: TrendRange
  buckets: TrendBucket[]
  total: number
}

/**
 * 汇总一个时间区间的数据：总张数、总 token、以及按账号的明细。
 * token = tokensInput + tokensOutput（旧记录没有 token 字段，按 0 计）。
 */
function summarize(entries: UsageEntry[], fromMs: number, toMs: number): {
  count: number
  tokens: number
  users: TrendUserBreakdown[]
} {
  const perUser = new Map<string, TrendUserBreakdown>()
  let count = 0
  let tokens = 0

  for (const entry of entries) {
    const time = new Date(entry.createdAt).getTime()
    if (!Number.isFinite(time) || time < fromMs || time >= toMs) continue

    const entryTokens = (entry.tokensInput || 0) + (entry.tokensOutput || 0)
    count += 1
    tokens += entryTokens

    const key = entry.userId || entry.username || 'unknown'
    const existing = perUser.get(key)
    if (existing) {
      existing.count += 1
      existing.tokens += entryTokens
    } else {
      perUser.set(key, {
        username: entry.username || '（未知）',
        displayName: entry.displayName || entry.username || '（未知）',
        count: 1,
        tokens: entryTokens,
      })
    }
  }

  const users = [...perUser.values()].sort((a, b) => b.count - a.count || b.tokens - a.tokens)
  return { count, tokens, users }
}

export function buildTrend(entries: UsageEntry[], range: TrendRange): TrendPayload {
  const buckets: TrendBucket[] = []
  const now = new Date()

  if (range === 'today') {
    // 今天：按小时分桶，看每个时间点生成了多少
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    for (let hour = 0; hour < 24; hour += 1) {
      const from = dayStart + hour * 3_600_000
      const summary = summarize(entries, from, from + 3_600_000)
      buckets.push({ label: `${hour}时`, ...summary })
    }
  } else {
    const days = TREND_RANGES[range]
    const firstDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))
    for (let i = 0; i < days; i += 1) {
      const from = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + i)
      const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1)
      const label = `${String(from.getMonth() + 1).padStart(2, '0')}/${String(from.getDate()).padStart(2, '0')}`
      const summary = summarize(entries, from.getTime(), to.getTime())
      buckets.push({ label, ...summary })
    }
  }

  return { range, buckets, total: buckets.reduce((sum, bucket) => sum + bucket.count, 0) }
}

export interface AccountStat {
  userId: string
  username: string
  displayName: string
  count: number
  bytes: number
  /** 该账号累计 token 消耗（入 + 出） */
  tokens: number
  /** 有 token 数据的张数：旧记录没有 token 字段，算均值时要排除 */
  tokenCount: number
  /** 平均每张消耗 token，只统计有 token 数据的记录 */
  avgTokens: number
  lastGeneratedAt: string
}

/** 按画幅（比例）聚合的 token 用量 */
export interface RatioStat {
  ratio: string
  count: number
  tokenCount: number
  tokens: number
  /** 平均每张消耗 token，只统计有 token 数据的记录 */
  avgTokens: number
}

export interface StatsPayload {
  totalImages: number
  totalBytes: number
  /** 全站累计 token 消耗（入 + 出） */
  totalTokens: number
  /** 全站平均每张 token（只统计有 token 数据的记录） */
  avgTokens: number
  accountCount: number
  /** 按累计 token 降序，即 token 排行 */
  accounts: AccountStat[]
  /** 按画幅聚合的 token 均值，张数多的在前 */
  ratioStats: RatioStat[]
  recent: Array<{
    id: string
    username: string
    displayName: string
    category: string
    name: string
    ratio: string
    width: number
    height: number
    bytes: number
    tokens: number
    createdAt: string
  }>
}

function entryTokens(entry: UsageEntry): number {
  return (entry.tokensInput || 0) + (entry.tokensOutput || 0)
}

/** 四舍五入到整数，避免表格里出现 1234.5678 这种噪声 */
function average(tokens: number, count: number): number {
  return count > 0 ? Math.round(tokens / count) : 0
}

export function buildStats(entries: UsageEntry[]): StatsPayload {
  const byAccount = new Map<string, AccountStat>()
  const byRatio = new Map<string, RatioStat>()
  let totalTokens = 0
  let totalTokenCount = 0

  for (const entry of entries) {
    const tokens = entryTokens(entry)
    const hasTokens = tokens > 0

    // 按账号
    const key = entry.userId || '__anonymous__'
    const existing = byAccount.get(key)
    if (existing) {
      existing.count += 1
      existing.bytes += entry.bytes
      existing.tokens += tokens
      if (hasTokens) existing.tokenCount += 1
      if (entry.createdAt > existing.lastGeneratedAt) {
        existing.lastGeneratedAt = entry.createdAt
      }
    } else {
      byAccount.set(key, {
        userId: entry.userId,
        username: entry.username || '（未登录）',
        displayName: entry.displayName || '（未登录）',
        count: 1,
        bytes: entry.bytes,
        tokens,
        tokenCount: hasTokens ? 1 : 0,
        avgTokens: 0,
        lastGeneratedAt: entry.createdAt,
      })
    }

    // 按画幅
    const ratio = entry.ratio || '未知'
    const ratioExisting = byRatio.get(ratio)
    if (ratioExisting) {
      ratioExisting.count += 1
      ratioExisting.tokens += tokens
      if (hasTokens) ratioExisting.tokenCount += 1
    } else {
      byRatio.set(ratio, {
        ratio,
        count: 1,
        tokenCount: hasTokens ? 1 : 0,
        tokens,
        avgTokens: 0,
      })
    }

    totalTokens += tokens
    if (hasTokens) totalTokenCount += 1
  }

  const accounts = [...byAccount.values()]
    .map(item => ({ ...item, avgTokens: average(item.tokens, item.tokenCount) }))
    .sort((a, b) => b.tokens - a.tokens || b.count - a.count)

  const ratioStats = [...byRatio.values()]
    .map(item => ({ ...item, avgTokens: average(item.tokens, item.tokenCount) }))
    .sort((a, b) => b.count - a.count || b.avgTokens - a.avgTokens)

  return {
    totalImages: entries.length,
    totalTokens,
    avgTokens: average(totalTokens, totalTokenCount),
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    accountCount: accounts.length,
    accounts,
    ratioStats,
    recent: entries
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 50)
      .map(entry => ({
        id: entry.id,
        username: entry.username || '（未登录）',
        displayName: entry.displayName || '（未登录）',
        category: entry.category,
        name: entry.name,
        ratio: entry.ratio,
        width: entry.width,
        height: entry.height,
        bytes: entry.bytes,
        tokens: entryTokens(entry),
        createdAt: entry.createdAt,
      })),
  }
}
