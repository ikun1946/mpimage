import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import { config } from './platform/config.js'
import { ApiError } from './platform/errors.js'
import { SerialGate } from './platform/serial-gate.js'
import { SessionStore } from './platform/session.js'
import { isCountedTraffic } from './platform/traffic-scope.js'
import { PROJECT_ROOT, resolveProjectPath } from './platform/paths.js'
import { createLogSink } from './platform/logging.js'
import { registerStaticRoutes } from './platform/static.js'
import { registerAdminRoutes } from '../api/admin.js'
import { registerAuthRoutes, resolveAuth } from '../api/auth.js'
import { registerFeedbackRoutes } from '../api/feedback.js'
import { registerFileRoutes } from '../api/files.js'
import { registerUploadRoutes } from '../api/uploads.js'
import { registerHistoryRoutes } from '../api/history.js'
import { registerImageRoutes } from '../api/images.js'
import { registerPromptRoutes } from '../api/prompts.js'
import { registerMonitorRoutes } from '../api/monitor.js'
import { ConcurrencyStore } from './control/concurrency-store.js'
import { FeedbackStore } from '../services/feedback-store.js'
import { QuotaStore } from './control/quota-store.js'
import { RateLimiter } from './control/rate-limiter.js'
import { TrafficStore } from '../services/traffic-store.js'
import { registerMetaRoutes } from '../api/meta.js'
import { registerProjectRoutes } from '../api/projects.js'
import { registerStyleRoutes } from '../api/styles.js'
import { registerUpstreamRoutes } from '../api/upstream.js'
import { registerUpdateRoutes } from '../api/update.js'
import { registerGptAccountRoutes } from '../api/gpt-accounts.js'
import { ProjectStore } from './products/projects/project-store.js'
import { GptAccountStore } from './control/accounts/gpt-account-store.js'
import { GptAccountPool } from './control/accounts/account-pool.js'
import { LocalFileStorage } from '../services/storage.js'
import { SettingsStore } from './control/settings-store.js'
import { StyleLibraryStore } from './products/styles/style-library.js'
import { UpdateChecker } from '../services/update-checker.js'
import { UsageStore } from '../services/usage-store.js'
import { UserStore } from '../services/user-store.js'
import { RealtimeMonitor } from '../services/realtime-monitor.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** 本次请求是否被限流拒绝：onRequest 只标记，onResponse 统一记一次统计 */
    trafficRejected: boolean
    /** 进入 Fastify 的时间，用于实时监控的总耗时（含参数校验与排队） */
    receivedAt?: number
  }
}

export async function startServer(): Promise<void> {
const projectRoot = PROJECT_ROOT

/**
 * 环境变量里的路径：绝对路径直接用，相对路径按**项目根**解析。
 * 不能用 resolve(value)（相对进程 cwd）——桌面端从任意目录启动时，
 * 相对路径会落到不可预期的位置，甚至落进只读的安装目录。
 */
const resolvePath = resolveProjectPath

const storageDirectory = config.storageDir
  ? resolvePath(config.storageDir)
  : join(projectRoot, 'generated')
const userDatabasePath = config.userDatabasePath
  ? resolvePath(config.userDatabasePath)
  : join(projectRoot, 'users.json')
const usageDatabasePath = config.usageDatabasePath
  ? resolvePath(config.usageDatabasePath)
  : join(projectRoot, 'usage.json')
const projectDatabasePath = config.projectDatabasePath
  ? resolvePath(config.projectDatabasePath)
  : join(projectRoot, 'projects.json')
// 每个账号一份风格库，落在 styles/<userId>.json
const styleLibraryRoot = config.styleLibraryPath
  ? resolvePath(config.styleLibraryPath)
  : join(projectRoot, 'styles')
const webDirectory = config.webDistDir
  ? resolvePath(config.webDistDir)
  : join(projectRoot, 'web', 'dist')

await mkdir(storageDirectory, { recursive: true })

// 日志按天写入本地 logs/ 目录（YYYY-MM-DD.log），同时输出到控制台
const logsDirectory = config.logDir ? resolvePath(config.logDir) : join(projectRoot, 'logs')
await mkdir(logsDirectory, { recursive: true })
const logSink = createLogSink(logsDirectory)

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: undefined,
    stream: logSink.stream,
  },
  // 项目保存会带上整份资产表（几百项时可达数百 KB），
  // 128 KB 会被 Fastify 直接拒绝，导致项目存成空。
  bodyLimit: 8 * 1024 * 1024,
})

await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true)
      return
    }
    // 局域网工具：放行本机回环与私有网段来源，其余拒绝
    callback(null, isAllowedOrigin(origin))
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
})

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.local') ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
    )
  } catch {
    return false
  }
}

await app.register(cookie, { secret: config.sessionSecret || randomBytes(32).toString('hex') })

// 允许 DELETE 等请求带 application/json 但空 body
app.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (_request, body, done) => {
    const text = (body as string).trim()
    if (!text) return done(null, {})
    try {
      done(null, JSON.parse(text))
    } catch (error) {
      done(error as Error, undefined)
    }
  },
)

const storage = new LocalFileStorage(storageDirectory)
await storage.init()
const styleLibrary = new StyleLibraryStore(styleLibraryRoot)
const projects = new ProjectStore(projectDatabasePath)
const users = new UserStore(userDatabasePath)
const usage = new UsageStore(usageDatabasePath)
// 运行期数据目录：流量、限流、额度、登录会话都放这里
const dataDir = config.dataDir ? resolvePath(config.dataDir) : join(projectRoot, 'data')
// 会话落盘：重启服务、停用后再启动都保持登录状态
const sessions = new SessionStore(
  config.sessionSecret || randomBytes(32).toString('hex'),
  join(dataDir, 'sessions.json'),
)
await sessions.init()
// 并发上限：control 面板写的 concurrency.json 优先，其次 IMAGE_CONCURRENCY
const concurrency = new ConcurrencyStore(dataDir, config.imageConcurrency)
await concurrency.init()
const gate = new SerialGate(concurrency.get())

// 后台保存的上游地址（settings.json）优先于 MAGPIE_BASE_URL，改完即时生效
const settings = new SettingsStore(dataDir)
await settings.init()
// 版本检查：进程内缓存，桌面端轮询也不会反复打发布源
const updateChecker = new UpdateChecker()

// 流量统计、每客户端限流与进程启动时刻（控制台监控用）
const traffic = new TrafficStore(dataDir)
const rateLimiter = new RateLimiter(dataDir)
const quotas = new QuotaStore(dataDir)
// 意见反馈：客户端提交落 data/feedback.json，管理员在后台页查看并标记处理
const feedback = new FeedbackStore(dataDir)
await traffic.init()
await rateLimiter.init()
await quotas.init()
await feedback.init()

// GPT 账号池：导入的 access_token 只落在服务端文件里，
// 生图时按账号额度走 Codex 通道；GPT_ACCOUNTS_ENABLED=0 可整体关闭。
const gptAccountsFile = config.gptAccounts.file
  ? resolvePath(config.gptAccounts.file)
  : join(projectRoot, 'gpt-accounts.json')
const gptAccounts = new GptAccountStore(gptAccountsFile, {
  defaultMaxConcurrency: config.gptAccounts.defaultMaxConcurrency,
  maxAccountsPerImport: config.gptAccounts.maxAccountsPerImport,
  enabled: () => config.gptAccounts.enabled,
})
await gptAccounts.init()
const gptPool = new GptAccountPool(gptAccounts)
const processStartedAt = Date.now()
const realtimeMonitor = new RealtimeMonitor()

// 每个请求：限流 → 解析登录身份；统计只在 onResponse 写一次
app.addHook('onRequest', async request => {
  request.receivedAt = Date.now()
  const retryAfterSec = rateLimiter.tryAccept(request.ip)
  // 这里只标记结果：限流的请求同样是"一次请求"，交给 onResponse 统一记账，
  // 否则 429 会在 onRequest 与 onResponse 各记一次。
  request.trafficRejected = retryAfterSec !== null
  if (retryAfterSec !== null) {
    throw new ApiError('RATE_LIMITED', `请求过于频繁，请 ${retryAfterSec} 秒后重试`, 429)
  }
  request.auth = await resolveAuth(request, { users, sessions })
})

app.addHook('onResponse', async (request, reply) => {
  // 只统计客户端业务接口：健康探测、配置读取、后台管理与静态资源都不计入
  if (!isCountedTraffic(request.method, request.raw.url || '')) return
  const bytesIn = Number(request.headers['content-length'] || 0)
  traffic.record(
    request.ip,
    bytesIn,
    Number(reply.getHeader('content-length') || 0),
    request.trafficRejected === true,
  )
})

// 流量数据定期落盘，进程退出时也会补写
setInterval(() => { traffic.flushIfDirty().catch(() => {}) }, 10_000)

/* 优雅退出：桌面端会发 SIGTERM 或带令牌的 POST /api/shutdown，
   这里统一成一次收尾——补写流量数据 → 关闭 Fastify（触发 onClose 关日志流）→ 退出。
   只注册一次，重复信号直接忽略，避免重复收尾把日志截断。 */
let shuttingDown = false
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  try {
    app.log.info({ reason }, '收到退出信号，开始关闭')
  } catch {}
  try {
    await traffic.flushIfDirty()
  } catch {}
  try {
    await gptAccounts.flush()
  } catch {}
  try {
    await app.close()
  } catch {}
  // 兜底：onClose 没跑到（例如 listen 之前就退出）时也要关掉日志流
  await closeLogStream()
  process.exit(0)
}

function closeLogStream(): Promise<void> {
  return logSink.close()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown(signal) })
}

registerMetaRoutes(app, {
  concurrency: () => gate.limitCount,
  settings,
  accounts: gptAccounts,
})
registerAuthRoutes(app, { users, sessions })
registerAdminRoutes(app, { users, usage, quotas })
registerImageRoutes(app, {
  storage,
  gate,
  usage,
  quotas,
  settings,
  accounts: { store: gptAccounts, pool: gptPool },
  monitor: realtimeMonitor,
})
registerPromptRoutes(app, { settings })
registerFileRoutes(app, { storage })
registerUploadRoutes(app, { storage })
registerStyleRoutes(app, { library: styleLibrary })
registerProjectRoutes(app, { projects })
registerHistoryRoutes(app, { usage, quotas })
registerMonitorRoutes(app, {
  traffic,
  rateLimiter,
  processStartedAt,
  gate,
  concurrency,
  monitor: realtimeMonitor,
  accounts: { store: gptAccounts, pool: gptPool },
})
registerFeedbackRoutes(app, { feedback })
registerUpstreamRoutes(app, { settings, accounts: gptAccounts })
registerGptAccountRoutes(app, { store: gptAccounts, pool: gptPool })
registerUpdateRoutes(app, { checker: updateChecker })

/* 优雅退出入口：只在注入了 SHUTDOWN_TOKEN 时开放，且必须带同一个 token 头。
   桌面端和控制台用它在退出前让服务补写数据、关掉日志流——Windows 上
   child.kill() 是强杀，收不到 SIGTERM，只能走这个接口。
   自定义请求头会触发 CORS 预检，跨站页面拿不到它，也就打不到这个口子。 */
if (config.shutdownToken) {
  app.post('/api/shutdown', async (request, reply) => {
    const token = request.headers['x-shutdown-token']
    if (typeof token !== 'string' || token !== config.shutdownToken) {
      throw new ApiError('AUTH_FORBIDDEN', '无权关闭服务', 403)
    }
    await reply.send({ ok: true })
    setTimeout(() => { void shutdown('http') }, 50)
  })
}

app.get('/api/queue', async () => ({
  busy: gate.isBusy,
  active: gate.activeCount,
  limit: gate.limitCount,
  waiting: gate.queueLength,
}))

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ApiError) {
    return reply
      .status(error.statusCode)
      .send({ error: error.message, code: error.code })
  }

  if ((error as { statusCode?: number }).statusCode === 429) {
    return reply.status(429).send({ error: '请求过于频繁，请稍后重试', code: 'RATE_LIMITED' })
  }

  // Fastify 自身的客户端错误（400/404 等）保留原状态码
  const statusCode = (error as { statusCode?: number }).statusCode
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return reply
      .status(statusCode)
      .send({ error: (error as Error).message || '请求有误', code: 'BAD_REQUEST' })
  }

  request.log.error(error)
  return reply
    .status(500)
    .send({ error: '服务内部错误，请查看后端日志', code: 'INTERNAL_ERROR' })
})

await registerStaticRoutes(app, webDirectory)

// Fastify 关闭时同步关掉日志流，保证最后几行不丢（addHook 必须在 listen 之前注册）
app.addHook('onClose', async () => {
  await closeLogStream()
})

await app.listen({ host: config.host, port: config.port })

// 局域网排查第一条线索：监听地址决定别人能不能连，回环时直接点出来
app.log.info(`监听地址: ${config.host}:${config.port}`)
if (config.host === '127.0.0.1' || config.host === 'localhost' || config.host === '::1') {
  app.log.warn('当前只监听本机回环，局域网设备无法访问；需要共享时把 HOST 改成 0.0.0.0 再重启')
}

app.log.info(`Magpie 图片 API: ${await settings.getBaseUrl()}/v1/images/generations`)
app.log.info(`模型: ${settings.getImageModel()}`)
app.log.info(`存储目录: ${storageDirectory}`)
app.log.info(`风格库目录: ${styleLibraryRoot}`)
app.log.info(`账号库文件: ${userDatabasePath}`)
app.log.info(`用量统计文件: ${usageDatabasePath}`)
}
