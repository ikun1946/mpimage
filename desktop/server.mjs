import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { app } from 'electron'

/**
 * 主服务（server/dist/index.js）的生命周期归桌面端所有。
 * 以前这段逻辑挂在控制台子进程上：桌面端起控制台 → 控制台起服务，
 * 多一层进程、多一个端口、也多一处失败点，现在由这里直管。
 */
let paths = null
let settings = {}
let port = 8787
let origin = 'http://127.0.0.1:8787'
let writeLog = () => {}

let child = null
let running = false
let startedAt = null
let adopted = false

/** 每次启动换一个：只有本进程知道，服务端的 /api/shutdown 靠它验身 */
const SHUTDOWN_TOKEN = randomBytes(24).toString('hex')
/** 桌面控制台免登录调管理接口的凭据；同样每次启动换一个，只注入给本机服务 */
const DESKTOP_TOKEN = randomBytes(24).toString('hex')

const START_TIMEOUT_MS = 20000
const STOP_TIMEOUT_MS = 4000

export function initServer(options) {
  if (typeof options?.log === 'function') writeLog = options.log
  paths = { root: options.root, data: options.data, logDir: options.logDir }
  settings = options.config || {}
  port = Number(settings.PORT) || 8787
  origin = `http://127.0.0.1:${port}`
}

function serverEntry() {
  return join(paths.root, 'server', 'dist', 'index.js')
}

/** 与 config.env 的 PORT 保持一致：换个端口时更新检查、健康探活不能还指着 8787 */
export function serverOrigin() {
  return origin
}

/**
 * 数据目录全部指向数据根：安装目录只读，账号、图片、日志都必须落在用户数据里。
 * settings 放最后覆盖，这样 config.env 里显式改过的值优先。
 */
function serverEnv() {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    APP_VERSION: app.getVersion(),
    STORAGE_DIR: join(paths.data, 'generated'),
    STYLE_LIBRARY_PATH: join(paths.data, 'styles'),
    USER_DATABASE_PATH: join(paths.data, 'users.json'),
    USAGE_DATABASE_PATH: join(paths.data, 'usage.json'),
    PROJECT_DATABASE_PATH: join(paths.data, 'projects.json'),
    DATA_DIR: join(paths.data, 'data'),
    LOG_DIR: paths.logDir,
    WEB_DIST_DIR: join(paths.root, 'web', 'dist'),
    SHUTDOWN_TOKEN,
    DESKTOP_TOKEN,
    ...settings,
    PORT: String(port),
  }
}

/** 桌面控制台调管理接口时带上的凭据（服务端只认回环 + 这个值） */
export function desktopToken() {
  return DESKTOP_TOKEN
}

/** undici 把连接拒绝包在 cause / AggregateError 里，逐层找一下 ECONNREFUSED */
function isRefused(error) {
  const causes = [error, error?.cause, ...(Array.isArray(error?.cause?.errors) ? error.cause.errors : [])]
  return causes.some(item => item?.code === 'ECONNREFUSED')
}

/** ours：本应用已在跑；other：端口被别的程序占着；free：没人监听 */
async function probeApp() {
  try {
    const response = await fetch(`${origin}/api/auth/status`, { signal: AbortSignal.timeout(1500) })
    const payload = await response.json().catch(() => null)
    return payload && typeof payload.needsSetup === 'boolean' ? 'ours' : 'other'
  } catch (error) {
    return isRefused(error) ? 'free' : 'other'
  }
}

async function portOpen(timeoutMs = 800) {
  try {
    await fetch(`${origin}/api/auth/status`, { signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch (error) {
    return !isRefused(error)
  }
}

async function waitForPortClosed(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!(await portOpen())) return true
    if (Date.now() >= deadline) return false
    await delay(200)
  }
}

export async function waitForServer(timeoutMs = 0) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    if ((await probeApp()) === 'ours') return true
    if (Date.now() >= deadline) return false
    await delay(300)
  }
}

export function serverState() {
  return { running, pid: child?.pid ?? null, startedAt, adopted }
}

/**
 * 探测 → 接管或拉起。
 * 已经在跑（比如上次异常退出留下的服务）就直接复用，服务里的数据不会丢；
 * 端口被别的程序占着则抛中文错误，交给主进程弹窗，别让用户对着空窗口猜。
 */
export async function startServer({ timeoutMs = START_TIMEOUT_MS } = {}) {
  if (!paths) throw new Error('server 模块尚未初始化')

  if (child && (await portOpen())) {
    running = true
    startedAt = startedAt || new Date().toISOString()
    return { adopted: false, running: true }
  }

  if (child && !(await portOpen())) {
    try { child.kill() } catch {}
    child = null
    running = false
    await delay(300)
  }

  const probe = await probeApp()

  if (probe === 'ours') {
    adopted = true
    running = true
    startedAt = startedAt || new Date().toISOString()
    writeLog('主服务已在运行，桌面端直接接管')
    return { adopted: true, running: true }
  }

  if (probe === 'other') {
    throw new Error(`端口 ${port} 已被其他程序占用，请先关掉它再启动画境`)
  }

  const entry = serverEntry()
  if (!existsSync(entry)) {
    throw new Error(`后端未编译：找不到 ${entry}，请先运行 npm run build:server`)
  }

  const proc = spawn(process.execPath, [entry], {
    cwd: join(paths.root, 'server'),
    env: serverEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  child = proc
  adopted = false
  running = true
  startedAt = new Date().toISOString()

  proc.stdout.on('data', chunk => writeLog(`[server] ${String(chunk).trimEnd()}`))
  proc.stderr.on('data', chunk => writeLog(`[server:err] ${String(chunk).trimEnd()}`))
  proc.on('exit', (code, signal) => {
    writeLog(`主服务进程退出 code=${code} signal=${signal}`)
    if (child === proc) {
      child = null
      running = false
      startedAt = null
    }
  })
  proc.on('error', error => writeLog(`主服务进程出错：${error.message}`))

  writeLog(`主服务已启动 pid=${proc.pid} port=${port}`)

  if (!(await waitForServer(timeoutMs))) {
    try { proc.kill() } catch {}
    throw new Error(`主服务没有在 ${Math.round(timeoutMs / 1000)} 秒内就绪，端口 ${port} 可能被占用或被防火墙拦截`)
  }

  return { adopted: false, running: true }
}

/**
 * 先请求优雅退出（Windows 上 child.kill() 是强杀，收不到 SIGTERM，服务来不及补写数据），
 * 端口迟迟不释放再 kill，最后 taskkill 连子进程树一起收掉。
 */
export async function stopServer() {
  if (!paths) return false

  const proc = child
  try {
    await fetch(`${origin}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-shutdown-token': SHUTDOWN_TOKEN },
      signal: AbortSignal.timeout(3000),
    })
  } catch (error) {
    writeLog(`请求主服务退出失败：${error.message}`)
  }

  if (await waitForPortClosed(STOP_TIMEOUT_MS)) {
    running = false
    startedAt = null
    return true
  }

  if (proc) {
    writeLog(`主服务未响应退出请求，强制结束 pid=${proc.pid}`)
    try { proc.kill() } catch {}
    if (await waitForPortClosed(STOP_TIMEOUT_MS)) {
      running = false
      startedAt = null
      return true
    }
    try {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    } catch (error) {
      writeLog(`taskkill 失败：${error.message}`)
    }
    if (await waitForPortClosed(2000)) {
      running = false
      startedAt = null
      return true
    }
  } else if (adopted) {
    writeLog('该服务不是由桌面端启动的，没有进程可结束')
  }

  writeLog(`主服务未能停止，端口 ${port} 仍在监听`)
  return false
}

export async function restartServer(options = {}) {
  await stopServer()
  await delay(400)
  return startServer(options)
}