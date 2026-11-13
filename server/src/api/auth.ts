import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ApiError } from '../app/platform/errors.js'
import { SESSION_COOKIE, type SessionStore } from '../app/platform/session.js'
import { toPublicUser, type UserStore } from '../services/user-store.js'
import { config } from '../app/platform/config.js'

interface LoginBody {
  username?: unknown
  password?: unknown
}

interface RegisterBody {
  username?: unknown
  displayName?: unknown
  password?: unknown
}

/* 用户名：3–24 位，字母/数字/下划线/点/横线/汉字；不接受空格和符号，
   避免出现难以输入或与展示混淆的账号名 */
const USERNAME_PATTERN = /^[A-Za-z0-9_.\-\u4e00-\u9fa5]{3,24}$/
const PASSWORD_MIN = 6
const PASSWORD_MAX = 128
const DISPLAY_NAME_MAX = 24
/** 待审核申请上限：防止有人批量灌申请把审核队列刷爆 */
const MAX_PENDING = 30

export interface AuthContext {
  userId: string
  username: string
  displayName: string
  role: 'admin' | 'user'
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext
  }
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { users: UserStore; sessions: SessionStore },
): void {
  app.post('/api/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as LoginBody
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    if (!username || !password) {
      throw new ApiError('AUTH_INVALID', '请输入用户名和密码')
    }

    const result = await deps.users.authenticate(username, password)
    if (!result.ok) {
      if (result.reason === 'pending') {
        throw new ApiError('AUTH_PENDING', '账号正在等待管理员审核，审核通过后即可登录', 403)
      }
      throw new ApiError('AUTH_INVALID', '用户名或密码不正确，或账号已被停用')
    }
    const user = result.user

    const session = deps.sessions.create(user.id)
    reply.setCookie(SESSION_COOKIE, session.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60,
    })

    return { user: toPublicUser(user) }
  })

  // 首次部署：若一个账号都没有，允许用管理密钥引导创建第一个管理员。
  // 密钥来自 ADMIN_SETUP_KEY，未设置时该接口不可用。
  // 账号库是否为空，用于登录页显示引导创建
  app.get('/api/auth/status', async () => {
    const users = await deps.users.list()
    return {
      needsSetup: users.length === 0,
      setupEnabled: Boolean(config.adminSetupKey),
      // 账号库初始化后开放自助申请（仍需管理员审核）
      registrationOpen: users.length > 0,
    }
  })
  app.post('/api/auth/setup', async (request) => {
    if (!config.adminSetupKey) {
      throw new ApiError('AUTH_FORBIDDEN', '未配置管理密钥，无法引导创建账号', 403)
    }

    const body = (request.body ?? {}) as { setupKey?: unknown; username?: unknown; password?: unknown; displayName?: unknown }
    const setupKey = typeof body.setupKey === 'string' ? body.setupKey : ''
    if (setupKey !== config.adminSetupKey) {
      throw new ApiError('AUTH_FORBIDDEN', '管理密钥不正确', 403)
    }

    const existing = await deps.users.list()
    if (existing.length > 0) {
      throw new ApiError('AUTH_INVALID', '账号库已初始化，请直接登录', 409)
    }

    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username) throw new ApiError('AUTH_INVALID', '用户名不能为空')
    if (password.length < 6) throw new ApiError('AUTH_INVALID', '密码至少 6 位')

    const user = await deps.users.create({
      username,
      displayName: typeof body.displayName === 'string' ? body.displayName : username,
      password,
      role: 'admin',
    })
    return { user: toPublicUser(user) }
  })

  /**
   * 自助申请账号：只落一条待审核记录，账号还不能登录。
   * 管理员在服务端控制台通过后（/api/admin/registrations/:id/approve）才生效。
   */
  app.post('/api/auth/register', async request => {
    const active = await deps.users.list()
    if (active.length === 0) {
      throw new ApiError('AUTH_INVALID', '账号库还没有初始化，请先创建管理员', 409)
    }

    const pendingCount = (await deps.users.listPending()).length
    if (pendingCount >= MAX_PENDING) {
      throw new ApiError(
        'RATE_LIMITED',
        `待审核的申请已有 ${pendingCount} 条，请稍后再试或直接联系管理员`,
        429,
      )
    }

    const body = (request.body ?? {}) as RegisterBody
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    if (!USERNAME_PATTERN.test(username)) {
      throw new ApiError('AUTH_INVALID', '用户名需为 3–24 位字母、数字、下划线或汉字', 400)
    }
    if (password.length < PASSWORD_MIN) {
      throw new ApiError('AUTH_INVALID', `密码至少 ${PASSWORD_MIN} 位`, 400)
    }
    if (password.length > PASSWORD_MAX) {
      throw new ApiError('AUTH_INVALID', `密码不能超过 ${PASSWORD_MAX} 位`, 400)
    }
    if (displayName.length > DISPLAY_NAME_MAX) {
      throw new ApiError('AUTH_INVALID', `显示名不能超过 ${DISPLAY_NAME_MAX} 个字符`, 400)
    }

    try {
      const record = await deps.users.register({ username, displayName, password })
      // 审计用：只记用户名和来源，不记密码
      request.log.info(
        { username: record.username, ip: request.ip },
        '收到新的账号申请，等待管理员审核',
      )
      return { status: 'pending', username: record.username }
    } catch (error) {
      throw new ApiError('AUTH_INVALID', (error as Error).message, 409)
    }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const token = readSessionToken(request)
    deps.sessions.destroy(token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/auth/me', async request => {
    const auth = await resolveAuth(request, deps)
    if (!auth) {
      throw new ApiError('AUTH_REQUIRED', '请先登录')
    }
    return { user: auth }
  })

  /**
   * 自助修改显示名：登录用的用户名不动，只改对外显示的名称。
   * 名称在账号库里唯一（不区分大小写，待审核的申请也占名），重复会返回 409。
   */
  app.patch('/api/auth/me', async request => {
    const auth = requireAuth(request)
    const body = (request.body ?? {}) as { displayName?: unknown }
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''

    if (!displayName) throw new ApiError('AUTH_INVALID', '显示名不能为空', 400)
    if (displayName.length > DISPLAY_NAME_MAX) {
      throw new ApiError('AUTH_INVALID', `显示名不能超过 ${DISPLAY_NAME_MAX} 个字符`, 400)
    }

    let user
    try {
      user = await deps.users.setDisplayName(auth.userId, displayName)
    } catch (error) {
      // 重名等业务错误：409，前端直接展示 message
      throw new ApiError('AUTH_INVALID', (error as Error).message, 409)
    }
    if (!user) throw new ApiError('AUTH_INVALID', '账号不存在', 404)

    request.log.info({ userId: user.id, displayName: user.displayName }, '账号修改了显示名')
    return { user: toPublicUser(user) }
  })
}

/** 回环地址：桌面控制台和服务端在同一台机器上，这三种写法都是本机 */
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** 只在缓存“谁是管理员”，有效期 5 秒，避免每个请求都扫一遍账号库 */
const DESKTOP_ADMIN_TTL_MS = 5000
let desktopAdminPick: { userId: string; at: number } | null = null

/**
 * 桌面控制台的免登录身份：令牌只在「回环连接 + 头部令牌完全匹配」时生效，
 * 其余情况一律返回 undefined，让调用方回退到原来的 cookie 会话逻辑。
 * 账号库还没初始化（没有可用管理员）时同样返回 undefined，接口照常 401/403。
 */
async function resolveDesktopAuth(
  request: FastifyRequest,
  users: UserStore,
): Promise<AuthContext | undefined> {
  if (!config.desktopToken) return undefined
  if (!LOOPBACK_IPS.has(request.ip)) return undefined
  const token = request.headers['x-desktop-token']
  if (typeof token !== 'string' || token !== config.desktopToken) return undefined

  if (!desktopAdminPick || Date.now() - desktopAdminPick.at > DESKTOP_ADMIN_TTL_MS) {
    const admins = await users.list()
    const admin = admins.find(user => user.role === 'admin' && !user.disabled && !user.pending)
    // 未找到时不缓存，账号库刚初始化就能立刻认出来
    desktopAdminPick = admin ? { userId: admin.id, at: Date.now() } : null
  }
  if (!desktopAdminPick) return undefined

  // 缓存的只是 ID，账号本身每次都重新取：停用或删除后立刻失效，不用等缓存过期
  const user = await users.findById(desktopAdminPick.userId)
  if (!user || user.disabled || user.pending || user.role !== 'admin') {
    desktopAdminPick = null
    return undefined
  }

  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  }
}

function readSessionToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim()
  }
  const cookie = request.cookies?.[SESSION_COOKIE]
  return typeof cookie === 'string' ? cookie : undefined
}

/** 解析当前请求的登录身份，未登录返回 undefined。 */
export async function resolveAuth(
  request: FastifyRequest,
  deps: { users: UserStore; sessions: SessionStore },
): Promise<AuthContext | undefined> {
  // 桌面控制台优先：本机令牌命中就按管理员接入，没命中则完整回退到 cookie 会话
  const desktopAuth = await resolveDesktopAuth(request, deps.users)
  if (desktopAuth) return desktopAuth

  const token = readSessionToken(request)
  const session = deps.sessions.get(token)
  if (!session) return undefined

  const user = await deps.users.findById(session.userId)
  if (!user || user.disabled) return undefined

  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  }
}

/** 需要登录才能访问的守卫。 */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) {
    throw new ApiError('AUTH_REQUIRED', '请先登录')
  }
  return request.auth
}

/** 需要管理员权限的守卫。 */
export function requireAdmin(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request)
  if (auth.role !== 'admin') {
    throw new ApiError('AUTH_FORBIDDEN', '需要管理员权限', 403)
  }
  return auth
}

export function setAuthCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60,
  })
}
