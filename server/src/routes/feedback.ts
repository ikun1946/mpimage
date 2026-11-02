import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ApiError } from '../lib/errors.js'
import { requireAdmin, requireAuth } from './auth.js'
import type {
  FeedbackCategory,
  FeedbackCategoryFilter,
  FeedbackEntry,
  FeedbackStatus,
  FeedbackStatusFilter,
  FeedbackStore,
} from '../services/feedback-store.js'

interface SubmitBody {
  category?: unknown
  content?: unknown
  page?: unknown
  appVersion?: unknown
}

const CATEGORIES: FeedbackCategory[] = ['bug', 'suggestion', 'other']
const STATUSES: FeedbackStatus[] = ['new', 'resolved']
const CONTENT_MIN = 5
const CONTENT_MAX = 2000
const PAGE_MAX = 64
const APP_VERSION_MAX = 32
/** 管理员回复上限 */
const REPLY_MAX = 1000
/** 后台关键词上限 */
const QUERY_MAX = 64
/** 节流：同一账号 60 秒内最多 3 条，第 4 条回 429 */
const THROTTLE_WINDOW_MS = 60_000
const THROTTLE_MAX = 3
/** 单个账号自己的反馈列表上限 */
const MINE_LIMIT_DEFAULT = 20
const MINE_LIMIT_MAX = 200
/** 后台列表上限（按契约默认 200） */
const ADMIN_LIMIT_DEFAULT = 200
const ADMIN_LIMIT_MAX = 200

export function registerFeedbackRoutes(app: FastifyInstance, deps: { feedback: FeedbackStore }): void {
  /** 每账号最近一次提交的时间戳（内存），进程重启即重置——节流只需短期生效 */
  const recentSubmits = new Map<string, number[]>()

  app.post('/api/feedback', async request => {
    const auth = requireAuth(request)
    const body = (request.body ?? {}) as SubmitBody

    const category = body.category
    if (typeof category !== 'string' || !CATEGORIES.includes(category as FeedbackCategory)) {
      throw new ApiError('FEEDBACK_INVALID', '反馈类型无效', 400)
    }

    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (content.length < CONTENT_MIN) {
      throw new ApiError('FEEDBACK_INVALID', `反馈内容至少 ${CONTENT_MIN} 个字`, 400)
    }
    if (content.length > CONTENT_MAX) {
      throw new ApiError('FEEDBACK_INVALID', `反馈内容不能超过 ${CONTENT_MAX} 个字符`, 400)
    }
    const page = readOptionalText(body.page, PAGE_MAX, '页面标识')
    const appVersion = readOptionalText(body.appVersion, APP_VERSION_MAX, '客户端版本')

    // 先校验再计数：不合法的提交不该占用节流额度
    enforceSubmitThrottle(recentSubmits, auth.userId)

    const entry = await deps.feedback.add({
      userId: auth.userId,
      username: auth.username,
      displayName: auth.displayName,
      category: category as FeedbackCategory,
      content,
      page,
      appVersion,
    })
    request.log.info({ userId: auth.userId, category, feedbackId: entry.id }, '收到意见反馈')

    return { feedback: toOwnSummary(entry) }
  })

  app.get('/api/feedback/mine', async request => {
    const auth = requireAuth(request)
    const limit = readLimit(request, MINE_LIMIT_DEFAULT, MINE_LIMIT_MAX)

    // list 的 limit 上限即库容量，取全量后按账号过滤再截断，无需给存储层加按人查询的参数
    const all = await deps.feedback.list({ status: 'all' })
    const feedback = all
      .filter(entry => entry.userId === auth.userId)
      .slice(0, limit)
      .map(toOwnSummary)

    return { feedback }
  })

  app.get('/api/admin/feedback', async request => {
    requireAdmin(request)

    const query = request.query as
      | { status?: unknown; limit?: unknown; category?: unknown; q?: unknown }
      | undefined
    const rawStatus = typeof query?.status === 'string' && query.status ? query.status : 'all'
    if (rawStatus !== 'all' && !STATUSES.includes(rawStatus as FeedbackStatus)) {
      throw new ApiError('FEEDBACK_INVALID', '筛选状态无效', 400)
    }
    const rawCategory =
      typeof query?.category === 'string' && query.category ? query.category : 'all'
    if (rawCategory !== 'all' && !CATEGORIES.includes(rawCategory as FeedbackCategory)) {
      throw new ApiError('FEEDBACK_INVALID', '筛选类型无效', 400)
    }
    const keyword = readQueryText(query?.q, QUERY_MAX, '关键词')

    const limit = readLimit(request, ADMIN_LIMIT_DEFAULT, ADMIN_LIMIT_MAX)
    const feedback = await deps.feedback.list({
      status: rawStatus as FeedbackStatusFilter,
      category: rawCategory as FeedbackCategoryFilter,
      q: keyword,
      limit,
    })

    // counts 始终是全局状态计数，不随状态、类型、关键词筛选变化
    return { feedback, counts: deps.feedback.counts() }
  })

  app.patch('/api/admin/feedback/:id', async request => {
    const admin = requireAdmin(request)
    const id = (request.params as { id?: string }).id ?? ''
    const body = (request.body ?? {}) as { status?: unknown; reply?: unknown }

    const status = body.status
    if (typeof status !== 'string' || !STATUSES.includes(status as FeedbackStatus)) {
      throw new ApiError('FEEDBACK_INVALID', '处理状态无效，只能是 new 或 resolved', 400)
    }

    // reply 缺省表示保留原回复；空串清空回复及其时间与处理人
    let reply: string | undefined
    if (body.reply !== undefined && body.reply !== null) {
      if (typeof body.reply !== 'string') {
        throw new ApiError('FEEDBACK_INVALID', '回复格式无效', 400)
      }
      if (body.reply.trim().length > REPLY_MAX) {
        throw new ApiError('FEEDBACK_INVALID', `回复不能超过 ${REPLY_MAX} 个字符`, 400)
      }
      reply = body.reply.trim()
    }

    const feedback = await deps.feedback.update(
      id,
      { status: status as FeedbackStatus, reply },
      admin.userId,
    )
    // 契约里「找不到」用 404；错误码只有 FEEDBACK_INVALID 一种，沿用它的默认 400 之外的显式状态码
    if (!feedback) throw new ApiError('FEEDBACK_INVALID', '反馈不存在', 404)

    request.log.info(
      { adminId: admin.userId, feedbackId: feedback.id, status, replied: reply !== undefined },
      '管理员更新了反馈',
    )
    return { feedback }
  })
}

/** 登录用户看到的自己那条反馈：不含账号信息，但含管理员回复。 */
function toOwnSummary(entry: FeedbackEntry): {
  id: string
  category: FeedbackCategory
  content: string
  page: string
  appVersion: string
  createdAt: string
  status: FeedbackStatus
  reply: string
  repliedAt: string
} {
  return {
    id: entry.id,
    category: entry.category,
    content: entry.content,
    page: entry.page,
    appVersion: entry.appVersion,
    createdAt: entry.createdAt,
    status: entry.status,
    reply: entry.reply,
    repliedAt: entry.repliedAt,
  }
}

function readOptionalText(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new ApiError('FEEDBACK_INVALID', `${label}格式无效`, 400)
  }
  const text = value.trim()
  if (text.length > max) {
    throw new ApiError('FEEDBACK_INVALID', `${label}不能超过 ${max} 个字符`, 400)
  }
  return text
}

/** 读取查询串里的关键词：重复传参时取第一个，未传返回空串。 */
function readQueryText(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return ''
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') {
    throw new ApiError('FEEDBACK_INVALID', `${label}格式无效`, 400)
  }
  const text = raw.trim()
  if (text.length > max) {
    throw new ApiError('FEEDBACK_INVALID', `${label}不能超过 ${max} 个字符`, 400)
  }
  return text
}

function readLimit(request: FastifyRequest, fallback: number, max: number): number {
  const query = request.query as { limit?: unknown } | undefined
  const parsed = Number.parseInt(String(query?.limit ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

/**
 * 滑动窗口节流：窗口内已有 3 条则拒绝本次，并记为 429。
 * 通过后立刻记一次时间戳——提交成功即占用额度，校验失败的提交不走到这里。
 */
function enforceSubmitThrottle(recentSubmits: Map<string, number[]>, userId: string): void {
  const now = Date.now()

  // 长期运行时节流表会积累已失效的账号，超过阈值时顺手清理
  if (recentSubmits.size > 5000) {
    for (const [key, stamps] of recentSubmits) {
      if (stamps.every(stamp => now - stamp >= THROTTLE_WINDOW_MS)) recentSubmits.delete(key)
    }
  }

  const recent = (recentSubmits.get(userId) ?? []).filter(stamp => now - stamp < THROTTLE_WINDOW_MS)
  if (recent.length >= THROTTLE_MAX) {
    recentSubmits.set(userId, recent)
    const oldest = recent[0] ?? now
    const waitSec = Math.max(1, Math.ceil((oldest + THROTTLE_WINDOW_MS - now) / 1000))
    throw new ApiError('RATE_LIMITED', `提交过于频繁，请 ${waitSec} 秒后再试`, 429)
  }

  recent.push(now)
  recentSubmits.set(userId, recent)
}