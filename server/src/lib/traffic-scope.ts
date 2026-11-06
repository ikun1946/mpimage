/**
 * 流量统计口径：只统计客户端真实使用的业务接口。
 * 后台管理、健康探测、配置读取、登录态轮询都不计入，
 * 否则监控页的请求量会被轮询与探测流量淹没。
 */

/** 口径标识，写入 data/traffic.json，用于识别旧口径的累计数据 */
export const TRAFFIC_SCOPE_NAME = 'client-business-api'

/** 面向管理端展示的口径名称 */
export const TRAFFIC_SCOPE_LABEL = '客户端业务接口'

/** 口径切换备注：旧版本把后台查询与健康探测也算进了总量 */
export const TRAFFIC_SCOPE_NOTE = '此前累计含后台查询与健康探测'

export interface TrafficScope {
  /** 口径标识 */
  name: string
  /** 口径名称（管理端展示） */
  label: string
  /** 当前口径生效时间（ISO）；此前的累计仍保留，但含旧口径流量 */
  since: string
  /** 口径备注 */
  note: string
}

/**
 * 明确排除的路径：写出来是为了让口径可读，
 * 业务接口仍以白名单为准，未列出的接口一律不计。
 */
const EXCLUDED_EXACT: ReadonlySet<string> = new Set([
  '/api/health',
  '/api/config',
  '/api/shutdown',
])
const EXCLUDED_PREFIXES: readonly string[] = [
  // 管理端后台：监控、限流、并发、上游、用户与反馈管理
  '/api/admin/',
  // 版本检查由客户端后台轮询
  '/api/update/',
]

/** 计入统计的业务接口：路径正则 + 允许的方法 */
const COUNTED_ROUTES: ReadonlyArray<{ pattern: RegExp; methods: readonly string[] }> = [
  { pattern: /^\/api\/images$/, methods: ['POST'] },
  { pattern: /^\/api\/images\/jobs\/[^/]+$/, methods: ['GET'] },
  { pattern: /^\/api\/prompts\/(optimize|revise|face-design)$/, methods: ['POST'] },
  { pattern: /^\/api\/history$/, methods: ['GET'] },
  { pattern: /^\/api\/quota$/, methods: ['GET'] },
  { pattern: /^\/api\/projects(\/[^/]+(\/activate)?)?$/, methods: ['GET', 'POST', 'PATCH', 'DELETE'] },
  { pattern: /^\/api\/styles$/, methods: ['GET', 'PUT'] },
  // 上传参考图（uploads 路由实际挂在 /api/reference-images）
  { pattern: /^\/api\/reference-images$/, methods: ['POST'] },
  { pattern: /^\/api\/feedback$/, methods: ['POST'] },
  { pattern: /^\/api\/feedback\/mine$/, methods: ['GET'] },
  { pattern: /^\/api\/auth\/(login|setup|register|logout)$/, methods: ['POST'] },
  // 只有修改个人资料才算业务请求，GET /api/auth/me 与 GET /api/auth/status 都是登录态轮询
  { pattern: /^\/api\/auth\/me$/, methods: ['PATCH'] },
]

/** 取请求路径，忽略查询串与片段；代理转发的绝对 URL 也能解析 */
function pathnameOf(rawUrl: string): string {
  try {
    // 用固定基址解析，只为拿到 pathname
    return new URL(rawUrl, 'http://localhost').pathname
  } catch {
    return ''
  }
}

/**
 * 该请求是否计入流量统计。
 * 用于 onResponse：同一请求最多计一次，所以这里只做纯判定，不区分是否被限流。
 */
export function isCountedTraffic(method: string, rawUrl: string): boolean {
  const verb = method.toUpperCase()
  // 预检请求、以及非 /api/ 的静态资源都不属于业务请求
  if (verb === 'OPTIONS') return false
  const pathname = pathnameOf(rawUrl)
  if (!pathname.startsWith('/api/')) return false
  if (EXCLUDED_EXACT.has(pathname)) return false
  if (EXCLUDED_PREFIXES.some(prefix => pathname.startsWith(prefix))) return false

  return COUNTED_ROUTES.some(route => route.methods.includes(verb) && route.pattern.test(pathname))
}
