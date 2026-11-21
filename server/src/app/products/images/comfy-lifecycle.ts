/**
 * ComfyUI 生命周期管理：按需启动、健康检查、空闲关闭。
 *
 * 边界：
 * - 只管理本机、且由本服务启动的 ComfyUI 进程；
 * - 远程地址只连接，永远不尝试启动或关闭；
 * - 用户自己启动的实例只连接，停止按钮只做「断开」，不发 kill；
 * - 启动成功以 /system_stats 实际可用为准，不以进程还存在为准。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { ApiError } from '../../platform/errors.js'
import {
  COMFY_DEFAULT_BASE_URL,
  COMFY_DEFAULT_LAUNCH,
  type ComfyConfig,
  type ComfyLaunchConfig,
} from '../../control/comfy-config.js'
import type { SettingsStore } from '../../control/settings-store.js'
import { detectComfyInstalls } from './comfy-detect.js'

export type ComfyState =
  | 'STOPPED'
  | 'STARTING'
  | 'CONNECTING'
  | 'READY'
  | 'BUSY'
  | 'STOPPING'
  | 'ERROR'

export interface ComfyQueueInfo {
  running: number
  pending: number
}

export interface ComfyStatus {
  state: ComfyState
  baseUrl: string
  local: boolean
  owned: boolean
  active: number
  queue: ComfyQueueInfo | null
  autoStart: boolean
  idleMinutes: number
  idleRemainingMs: number | null
  lastActivity: number | null
  error: string | null
  pid: number | null
  launch: ComfyLaunchConfig
}

const HEALTH_TIMEOUT_MS = 2500
const QUEUE_TIMEOUT_MS = 2500
const START_TIMEOUT_MS = 240_000
const START_POLL_MS = 1000
const STOP_GRACE_MS = 8000
const IDLE_TICK_MS = 20_000
const LOG_TAIL_LINES = 30

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

function portOf(baseUrl: string): number {
  try {
    const url = new URL(baseUrl)
    if (url.port) return Number(url.port)
    return url.protocol === 'https:' ? 443 : 8188
  } catch {
    return 8188
  }
}

/** 支持带引号的参数串，避免路径里有空格时被拆开 */
function splitArgs(raw: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? ''
    if (value) out.push(value)
  }
  return out
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some(arg => arg === flag || arg.startsWith(`${flag}=`))
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/')
}

function firstExisting(candidates: string[]): string {
  return candidates.find(candidate => candidate && existsSync(candidate)) ?? ''
}

interface LaunchSpec {
  python: string
  args: string[]
  cwd: string
  portable: boolean
}

/**
 * 从配置推断启动命令。
 * 优先用用户填的路径；没填时按常见布局找：
 *   Windows 便携包：<root>/python_embeded/python.exe + <root>/ComfyUI/main.py
 *   标准安装：<root>/venv/Scripts/python.exe + <root>/main.py
 */
async function resolveLaunchSpec(config: ComfyConfig): Promise<LaunchSpec> {
  const launch = config.launch
  let root = launch.installDir.trim()
  let entryInput = launch.entryScript.trim()
  let pythonInput = launch.pythonPath.trim()
  if (!root && !entryInput) {
    // 用户还没配过：先在常见位置找一遍，找到就直接用，不必先打开控制台
    const detected = (await detectComfyInstalls())[0]
    if (detected) {
      root = detected.installDir
      entryInput = detected.entryScript
      pythonInput = pythonInput || detected.pythonPath
    }
  }
  if (!root && !entryInput) {
    throw new ApiError(
      'COMFY_NOT_CONFIGURED',
      'ComfyUI 没有运行，也没有找到安装目录。请在控制台点「自动检测安装位置」，或手动填写安装目录。',
      400,
    )
  }

  const entry = entryInput
    ? isAbsolute(entryInput)
      ? entryInput
      : join(root, entryInput)
    : firstExisting([
        join(root, 'ComfyUI', 'main.py'),
        join(root, 'main.py'),
      ])
  if (!entry) {
    throw new ApiError(
      'COMFY_NOT_CONFIGURED',
      `在 ${root || '(未填写安装目录)'} 下找不到 ComfyUI/main.py，请在控制台填写入口脚本。`,
      400,
    )
  }
  if (!existsSync(entry)) {
    throw new ApiError('COMFY_NOT_CONFIGURED', `找不到 ComfyUI 入口脚本：${entry}`, 400)
  }

  const portable = /python_embeded/i.test(pythonInput) || (!pythonInput && /python_embeded/i.test(firstExisting([
    join(root, 'python_embeded', 'python.exe'),
  ])))
  const python = pythonInput
    ? isAbsolute(pythonInput) ||
      (!pythonInput.includes('/') && !pythonInput.includes('\\'))
      ? pythonInput
      : join(root, pythonInput)
    : firstExisting([
        join(root, 'python_embeded', 'python.exe'),
        join(root, 'venv', 'Scripts', 'python.exe'),
        join(root, '.venv', 'Scripts', 'python.exe'),
        join(root, 'venv', 'bin', 'python'),
        join(root, '.venv', 'bin', 'python'),
      ])
  if (!python) {
    throw new ApiError(
      'COMFY_NOT_CONFIGURED',
      `在 ${root} 下找不到 Python 环境，请在控制台填写 Python 可执行文件路径（例如 python_embeded\\python.exe）。`,
      400,
    )
  }
  if ((isAbsolute(python) || python.includes('/') || python.includes('\\')) && !existsSync(python)) {
    throw new ApiError('COMFY_NOT_CONFIGURED', `找不到 Python 可执行文件：${python}`, 400)
  }

  const extra = splitArgs(launch.extraArgs)
  const port = portOf(config.baseUrl)
  const args: string[] = []
  if (portable) args.push('-s')
  args.push(entry, ...extra)
  if (portable && !hasFlag(extra, '--windows-standalone-build')) {
    args.push('--windows-standalone-build')
  }
  if (!hasFlag(extra, '--port')) args.push('--port', String(port))
  if (!hasFlag(extra, '--listen')) args.push('--listen', '127.0.0.1')

  const cwd = root || dirname(entry)
  return { python, args, cwd, portable }
}

export class ComfyLifecycle {
  private settings: SettingsStore | null = null
  private log: (message: string, meta?: Record<string, unknown>) => void = () => {}
  private state: Exclude<ComfyState, 'BUSY'> = 'STOPPED'
  private child: ChildProcess | null = null
  private owned = false
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private active = 0
  private lastActivity = 0
  private lastQueueBusyAt = 0
  private error: string | null = null
  private logTail: string[] = []
  private ticker: NodeJS.Timeout | null = null
  private ticking = false
  private lastBaseUrl = ''
  /** 当前由本服务启动的实例对应的地址；换地址时要先收掉旧进程 */
  private runningBaseUrl = ''
  /** 服务退出中：禁止任何请求再拉起 ComfyUI，否则退出后会留下孤儿进程 */
  private shuttingDown = false

  init(settings: SettingsStore, log?: (message: string, meta?: Record<string, unknown>) => void): void {
    this.settings = settings
    if (log) this.log = log
    this.lastBaseUrl = settings.getComfyConfig().baseUrl
    if (!this.ticker) {
      this.ticker = setInterval(() => { void this.tick() }, IDLE_TICK_MS)
      this.ticker.unref?.()
    }
  }

  private config(): ComfyConfig {
    if (!this.settings) throw new ApiError('COMFY_UNAVAILABLE', 'ComfyUI 管理器尚未初始化', 500)
    return this.settings.getComfyConfig()
  }

  private touch(): void {
    this.lastActivity = Date.now()
  }

  private appendLog(chunk: Buffer | string): void {
    const text = String(chunk)
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      this.logTail.push(trimmed.slice(0, 400))
      if (this.logTail.length > LOG_TAIL_LINES) this.logTail.shift()
    }
  }

  private tailText(): string {
    return this.logTail.length ? `\n最近日志：\n${this.logTail.slice(-8).join('\n')}` : ''
  }

  private async probe(baseUrl: string): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/system_stats`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      })
      return response.ok
    } catch {
      return false
    }
  }

  private async fetchQueue(baseUrl: string): Promise<ComfyQueueInfo | null> {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/queue`, {
        signal: AbortSignal.timeout(QUEUE_TIMEOUT_MS),
      })
      if (!response.ok) return null
      const payload = (await response.json()) as {
        queue_running?: unknown
        queue_pending?: unknown
      }
      return {
        running: Array.isArray(payload.queue_running) ? payload.queue_running.length : 0,
        pending: Array.isArray(payload.queue_pending) ? payload.queue_pending.length : 0,
      }
    } catch {
      return null
    }
  }

  private async startInternal(config: ComfyConfig): Promise<void> {
    const spec = await resolveLaunchSpec(config)
    this.state = 'STARTING'
    this.error = null
    this.logTail = []
    this.log('ComfyUI 正在启动', { python: spec.python, cwd: spec.cwd })

    let child: ChildProcess
    try {
      child = spawn(spec.python, spec.args, {
        cwd: spec.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // 输出接的是管道：不显式指定 UTF-8 时，中文 Windows 上 Python 会按 GBK 写日志，
          // ComfyUI 日志里的 ⚠ 之类字符直接抛 UnicodeEncodeError 把进程带崩
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
      })
    } catch (error) {
      throw new ApiError(
        'COMFY_START_FAILED',
        `无法启动 ComfyUI：${(error as Error).message}`,
        502,
      )
    }

    this.child = child
    this.owned = true
    this.runningBaseUrl = config.baseUrl
    child.stdout?.on('data', chunk => this.appendLog(chunk))
    child.stderr?.on('data', chunk => this.appendLog(chunk))

    let exited = false
    let exitDetail = ''
    child.once('error', error => {
      exited = true
      exitDetail = error.message
    })
    child.once('exit', (code, signal) => {
      exited = true
      exitDetail = `进程退出 code=${code ?? '?'}${signal ? ` signal=${signal}` : ''}`
      if (this.child !== child) return
      this.child = null
      this.owned = false
      this.runningBaseUrl = ''
      if (this.state !== 'STOPPING') {
        this.state = 'STOPPED'
        this.error = `ComfyUI 进程已退出（${exitDetail}）${this.tailText()}`
      }
    })

    this.state = 'CONNECTING'
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (exited || !this.child) {
        this.owned = false
        throw new ApiError(
          'COMFY_START_FAILED',
          `ComfyUI 启动失败：${exitDetail || this.error || '进程提前退出'}${this.tailText()}`,
          502,
        )
      }
      if (await this.probe(config.baseUrl)) {
        this.state = 'READY'
        this.error = null
        this.touch()
        this.log('ComfyUI 已就绪', { pid: child.pid })
        return
      }
      await sleep(START_POLL_MS)
    }

    throw new ApiError(
      'COMFY_START_TIMEOUT',
      `ComfyUI 在 ${Math.round(START_TIMEOUT_MS / 1000)} 秒内没有就绪。请检查启动参数、端口是否被占用，以及显卡驱动是否正常。${this.tailText()}`,
      504,
    )
  }

  private async cleanupAfterStartFailure(): Promise<void> {
    const child = this.child
    this.child = null
    this.owned = false
    this.runningBaseUrl = ''
    if (child && child.exitCode === null) {
      try { child.kill() } catch {}
      await this.waitExit(child, 3000)
      if (child.exitCode === null) this.forceKill(child.pid)
    }
  }

  /**
   * 确保服务可用。多个并发请求共享同一个启动过程。
   * manual=true 时即使关闭了自动启动，也允许手动拉起。
   */
  async ensureReady(options: { manual?: boolean } = {}): Promise<string> {
    if (this.shuttingDown) {
      throw new ApiError('COMFY_UNAVAILABLE', '服务正在退出，ComfyUI 不会再启动', 503)
    }
    const config = this.config()
    const baseUrl = config.baseUrl

    if (this.stopPromise) await this.stopPromise

    if (this.startPromise) {
      await this.startPromise
      this.touch()
      return baseUrl
    }

    // 先同步占住启动过程：并发请求只能有一个进入探测/启动，
    // 其余请求在这里等同一个 Promise，不会各自 spawn 一个进程。
    const pending = this.ensureReadyInner(config, options).finally(() => {
      if (this.startPromise === pending) this.startPromise = null
    })
    this.startPromise = pending
    await pending
    this.touch()
    return baseUrl
  }

  private async ensureReadyInner(
    config: ComfyConfig,
    options: { manual?: boolean },
  ): Promise<void> {
    const baseUrl = config.baseUrl

    // 地址改了：旧地址上是本服务启动的实例，先收掉，避免两个实例同时占着显存
    if (this.owned && this.child && this.runningBaseUrl && this.runningBaseUrl !== baseUrl) {
      await this.stopInternal(true)
      this.state = 'STOPPED'
    }

    // 只要还握着自己启动的进程，就先探一次再决定：
    // 状态可能是 ERROR（探测超时，进程其实还在），此时直接 spawn 会撞端口并丢掉旧进程句柄
    if (this.child && this.owned) {
      if (await this.probe(baseUrl)) {
        this.state = 'READY'
        this.error = null
        this.touch()
        return
      }
      this.state = 'ERROR'
      this.error = 'ComfyUI API 无响应，正在重新连接'
      await this.stopInternal(true)
    } else if (this.state === 'READY') {
      // 复用的外部实例：探测交给下面的通用探测
      this.state = 'STOPPED'
    }

    // 已经在运行（包括用户手动启动的）就直接复用，绝不重复启动
    if (await this.probe(baseUrl)) {
      if (!this.child) {
        this.owned = false
        this.runningBaseUrl = ''
      }
      this.state = 'READY'
      this.error = null
      this.touch()
      return
    }

    if (!isLoopback(baseUrl)) {
      throw new ApiError(
        'COMFY_UNREACHABLE',
        `无法连接远程 ComfyUI：${baseUrl}。远程地址只做连接，不会在本地启动服务。`,
        502,
      )
    }
    if (!config.launch.autoStart && !options.manual) {
      throw new ApiError(
        'COMFY_STOPPED',
        'ComfyUI 没有运行。可以打开「自动启动」，或在控制台点击「启动 ComfyUI」。',
        400,
      )
    }

    try {
      await this.startInternal(config)
    } catch (error) {
      this.state = 'ERROR'
      this.error = (error as Error).message
      await this.cleanupAfterStartFailure()
      throw error
    }
    this.touch()
  }

  /** 生图请求的活动计数：计数期间不触发空闲关闭 */
  async track<T>(task: () => Promise<T>): Promise<T> {
    this.active += 1
    this.touch()
    try {
      return await task()
    } finally {
      this.active = Math.max(0, this.active - 1)
      this.touch()
    }
  }

  private waitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null) return Promise.resolve(true)
    return new Promise(resolve => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(false)
      }, timeoutMs)
      child.once('exit', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private forceKill(pid: number | undefined): void {
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
      } else {
        process.kill(-pid, 'SIGKILL')
      }
    } catch {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
  }

  private async stopInternal(fromError = false): Promise<void> {
    const child = this.child
    // 用户自己启动的实例：只断开，不发 kill
    if (!this.owned || !child) {
      this.child = null
      this.owned = false
      if (!fromError) this.state = 'STOPPED'
      return
    }

    this.state = 'STOPPING'
    this.log('ComfyUI 正在关闭', { pid: child.pid })
    try { child.kill() } catch {}
    const exited = await this.waitExit(child, STOP_GRACE_MS)
    if (!exited) {
      this.forceKill(child.pid)
      await this.waitExit(child, 5000)
    }
    this.child = null
    this.owned = false
    this.runningBaseUrl = ''
    if (!fromError) {
      this.state = 'STOPPED'
      this.error = null
    }
    this.lastQueueBusyAt = 0
    this.log('ComfyUI 已关闭')
  }

  /** 手动或空闲关闭；外部实例只断开连接 */
  async stop(): Promise<ComfyStatus> {
    if (this.stopPromise) {
      await this.stopPromise
      return this.status()
    }
    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = null
    })
    await this.stopPromise
    return this.status()
  }

  async start(): Promise<ComfyStatus> {
    await this.ensureReady({ manual: true })
    return this.status()
  }

  async reconnect(): Promise<ComfyStatus> {
    const config = this.config()
    if (this.state === 'READY' && (await this.probe(config.baseUrl))) {
      return this.status()
    }
    await this.ensureReady({ manual: true })
    return this.status()
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.settings) return
    this.ticking = true
    try {
      const config = this.settings.getComfyConfig()
      if (!config.launch.idleMinutes || !this.owned || this.state !== 'READY' || this.active > 0) {
        return
      }
      const idleMs = config.launch.idleMinutes * 60_000
      const since = Math.max(this.lastActivity, this.lastQueueBusyAt)
      if (since && Date.now() - since < idleMs) return

      const queue = await this.fetchQueue(config.baseUrl)
      if (!queue) return
      if (queue.running > 0 || queue.pending > 0) {
        this.lastQueueBusyAt = Date.now()
        return
      }
      if (this.active > 0) return

      this.log('ComfyUI 空闲达到设定时间，自动关闭', { idleMinutes: config.launch.idleMinutes })
      // 走 stop()：登记 stopPromise，紧接着到来的生图请求会等这次关闭结束再启动，
      // 避免「旧进程还在退出、新进程已经 spawn」抢同一个端口
      this.stopPromise = this.stopInternal().finally(() => {
        this.stopPromise = null
      })
      await this.stopPromise
    } finally {
      this.ticking = false
    }
  }

  /** 立即跑一次空闲检查（管理台/测试用，避免等下一个 20 秒周期） */
  async checkIdleNow(): Promise<void> {
    await this.tick()
  }

  onConfigChanged(): void {
    if (!this.settings) return
    const config = this.settings.getComfyConfig()
    if (this.lastBaseUrl && this.lastBaseUrl !== config.baseUrl && this.owned && this.active === 0) {
      void this.stopInternal()
    }
    this.lastBaseUrl = config.baseUrl
  }

  async status(): Promise<ComfyStatus> {
    const fallback: ComfyConfig = {
      baseUrl: COMFY_DEFAULT_BASE_URL,
      workflows: [],
      launch: { ...COMFY_DEFAULT_LAUNCH },
    }
    const config = this.settings ? this.settings.getComfyConfig() : fallback

    // 自己启动的实例：READY 和 ERROR 都探测一次。
    // 单次 2.5 秒超时可能只是 ComfyUI 在切模型，不能把 ERROR 钉死——
    // 否则 tick 的空闲关闭（只处理 READY）会永久失效，进程一直占着显存。
    if (this.child && this.owned && (this.state === 'READY' || this.state === 'ERROR')) {
      if (await this.probe(config.baseUrl)) {
        this.state = 'READY'
        this.error = null
      } else {
        this.state = 'ERROR'
        this.error = 'ComfyUI API 无响应'
      }
    } else if (this.state === 'READY' && !(await this.probe(config.baseUrl))) {
      this.state = 'STOPPED'
      this.error = 'ComfyUI 已停止响应'
    }

    const queue = this.state === 'READY' ? await this.fetchQueue(config.baseUrl) : null
    if (queue && queue.running + queue.pending > 0) this.lastQueueBusyAt = Date.now()

    const idleMs = config.launch.idleMinutes * 60_000
    const idleSince = Math.max(this.lastActivity, this.lastQueueBusyAt)
    return {
      state: this.active > 0 && this.state === 'READY' ? 'BUSY' : this.state,
      baseUrl: config.baseUrl,
      local: isLoopback(config.baseUrl),
      owned: this.owned,
      active: this.active,
      queue,
      autoStart: config.launch.autoStart,
      idleMinutes: config.launch.idleMinutes,
      idleRemainingMs:
        this.owned && config.launch.idleMinutes && idleSince
          ? Math.max(0, idleMs - (Date.now() - idleSince))
          : null,
      lastActivity: this.lastActivity || null,
      error: this.error,
      pid: this.child?.pid ?? null,
      launch: config.launch,
    }
  }

  /** 服务进程退出时调用：只关闭自己启动的实例 */
  async shutdown(): Promise<void> {
    // 先关闸：退出流程里 app.close() 还会等在途请求，
    // 排队中的生图请求如果这时再 ensureReady，会重新拉起一个没人管的 ComfyUI
    this.shuttingDown = true
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    if (this.startPromise) await this.startPromise.catch(() => {})
    if (this.owned) await this.stopInternal()
  }
}

export const comfyLifecycle = new ComfyLifecycle()

/** 启动时接入设置存储；不在这里探测或启动 ComfyUI */
export function initComfyLifecycle(
  settings: SettingsStore,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): void {
  comfyLifecycle.init(settings, log)
}
