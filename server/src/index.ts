import { mkdir } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { config } from './config.js'
import { ApiError } from './lib/errors.js'
import { SerialGate } from './lib/serial-gate.js'
import { SessionStore } from './lib/session.js'
import { isCountedTraffic } from './lib/traffic-scope.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerAuthRoutes, resolveAuth } from './routes/auth.js'
import { registerFeedbackRoutes } from './routes/feedback.js'
import { registerFileRoutes } from './routes/files.js'
import { registerUploadRoutes } from './routes/uploads.js'
import { registerHistoryRoutes } from './routes/history.js'
import { registerImageRoutes } from './routes/images.js'
import { registerPromptRoutes } from './routes/prompts.js'
import { registerMonitorRoutes } from './routes/monitor.js'
import { ConcurrencyStore } from './services/concurrency-store.js'
import { FeedbackStore } from './services/feedback-store.js'
import { QuotaStore } from './services/quota-store.js'
import { RateLimiter } from './services/rate-limiter.js'
import { TrafficStore } from './services/traffic-store.js'
import { registerMetaRoutes } from './routes/meta.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerStyleRoutes } from './routes/styles.js'
import { registerUpstreamRoutes } from './routes/upstream.js'
import { registerUpdateRoutes } from './routes/update.js'
import { ProjectStore } from './services/project-store.js'
import { LocalFileStorage } from './services/storage.js'
import { SettingsStore } from './services/settings-store.js'
import { StyleLibraryStore } from './services/style-library.js'
import { UpdateChecker } from './services/update-checker.js'
import { UsageStore } from './services/usage-store.js'
import { UserStore } from './services/user-store.js'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..', '..')

declare module 'fastify' {
  interface FastifyRequest {
    /** 本次请求是否被限流拒绝：onRequest 只标记，onResponse 统一记一次统计 */
    trafficRejected: boolean
  }
}

/**
 * 环境变量里的路径：绝对路径直接用，相对路径按**项目根**解析。
 * 不能用 resolve(value)（相对进程 cwd）——桌面端从任意目录启动时，
 * 相对路径会落到不可预期的位置，甚至落进只读的安装目录。
 */
function resolvePath(value: string): string {
  return isAbsolute(value) ? value : resolve(projectRoot, value)
}

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
const today = () => new Date().toISOString().slice(0, 10)
let logFilePath = join(logsDirectory, `${today()}.log`)
let logFileStream = createWriteStream(logFilePath, { flags: 'a' })

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: undefined,
    stream: {
      write(line: string) {
        process.stdout.write(line)
        // 跨天时切到新文件
        const nextPath = join(logsDirectory, `${today()}.log`)
        if (nextPath !== logFilePath) {
          logFilePath = nextPath
          logFileStream.end()
          logFileStream = createWriteStream(nextPath, { flags: 'a' })
        }
        logFileStream.write(line)
      },
    },
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
const processStartedAt = Date.now()

// 每个请求：限流 → 解析登录身份；统计只在 onResponse 写一次
app.addHook('onRequest', async request => {
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
let logStreamClosed = false
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
    await app.close()
  } catch {}
  // 兜底：onClose 没跑到（例如 listen 之前就退出）时也要关掉日志流
  await closeLogStream()
  process.exit(0)
}

function closeLogStream(): Promise<void> {
  if (logStreamClosed) return Promise.resolve()
  logStreamClosed = true
  return new Promise<void>(resolveClose => {
    try {
      logFileStream.end(resolveClose)
    } catch {
      resolveClose()
    }
  })
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown(signal) })
}

registerMetaRoutes(app, { concurrency: () => gate.limitCount, settings })
registerAuthRoutes(app, { users, sessions })
registerAdminRoutes(app, { users, usage, quotas })
registerImageRoutes(app, { storage, gate, usage, quotas, settings })
registerPromptRoutes(app, { settings })
registerFileRoutes(app, { storage })
registerUploadRoutes(app, { storage })
registerStyleRoutes(app, { library: styleLibrary })
registerProjectRoutes(app, { projects })
registerHistoryRoutes(app, { usage, quotas })
registerMonitorRoutes(app, { traffic, rateLimiter, processStartedAt, gate, concurrency })
registerFeedbackRoutes(app, { feedback })
registerUpstreamRoutes(app, { settings })
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

let staticRegistered = false
try {
  // 单张工作台已合并进批量页，不再有 index.html，检查入口改为 batch.html
  await access(join(webDirectory, 'batch.html'))
  await app.register(fastifyStatic, {
    root: webDirectory,
    prefix: '/',
    decorateReply: false,
    index: ['index.html'],
  })
  staticRegistered = true

  // 单张工作台已合并进批量工作台的「自由创作」，老地址一律跳批量页
  app.get('/batch', async (_request, reply) => reply.redirect('/batch.html'))
  app.get('/studio', async (_request, reply) => reply.redirect('/batch.html'))
  app.get('/index.html', async (_request, reply) => reply.redirect('/batch.html'))
  app.get('/login', async (_request, reply) => reply.redirect('/login.html'))
  app.get('/admin', async (_request, reply) => reply.redirect('/admin.html'))
} catch (error) {
  app.log.warn(`未找到前端构建产物 ${webDirectory}，仅提供 API：${(error as Error).message}`)
}

if (!staticRegistered) {
  app.get('/', async (_request, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8')
    return reply.send('<h1>画境后端</h1><p>前端请访问 Vite 开发服务，或先执行 npm run build。</p>')
  })
} else {
  // 根路径即批量工作台（唯一客户端）
  app.get('/', async (_request, reply) => reply.redirect('/batch.html'))
}

// Fastify 关闭时同步关掉日志流，保证最后几行不丢（addHook 必须在 listen 之前注册）
app.addHook('onClose', async () => {
  await closeLogStream()
})

await app.listen({ host: config.host, port: config.port })

app.log.info(`Magpie 图片 API: ${await settings.getBaseUrl()}/v1/images/generations`)
app.log.info(`模型: ${settings.getModel()}`)
app.log.info(`存储目录: ${storageDirectory}`)
app.log.info(`风格库目录: ${styleLibraryRoot}`)
app.log.info(`账号库文件: ${userDatabasePath}`)
app.log.info(`用量统计文件: ${usageDatabasePath}`)
