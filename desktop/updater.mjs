import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, net, shell } from 'electron'
import { dataRoot } from './paths.mjs'
import { loadConfig } from './config.mjs'
import { serverOrigin } from './server.mjs'

/**
 * 主进程里的 `fetch` 是 Node 的 undici，只认 HTTP_PROXY 环境变量，
 * 不认 Windows 系统代理——在必须走代理的机器上会直接连不上 GitHub。
 * Electron 的 net.fetch 走 Chromium 网络栈，沿用系统代理与 PAC 设置。
 */
function httpFetch(url, init) {
  return net.fetch(url, init)
}

const UPDATES_DIR_NAME = 'updates'

const PROBE_BYTES = 1024 * 1024
const MIN_SEGMENT_BYTES = 1024 * 1024
const RESOLVE_TIMEOUT_MS = 15000
const PROBE_TIMEOUT_MS = 60000
// 一条连接 30 秒没有新字节就认定卡死；链路差但还活着的时候重试比干等更划算
const STALL_TIMEOUT_MS = 30000
const RETRY_DELAYS = [200, 600, 1500]
const MAX_REFRESH = 3
const AUTO_CONNECTIONS = 4
const AUTO_FAST_BYTES_PER_SECOND = 2.5 * 1024 * 1024
const AUTO_MIN_TOTAL_BYTES = 8 * 1024 * 1024
// 速度用 2 秒滚动窗口平滑：单块瞬时值抖动太大，直接显示会让窗口里的数字来回跳
const SPEED_WINDOW_MS = 2000
// 分段各自一个文件，续传时靠文件长度判断每段下到哪了，不依赖易失的内存状态
const SEGMENT_DIR_SUFFIX = '.segments'
const LAYOUT_FILE = 'layout.json'
const PROBE_FILE = 'probe.bin'

/**
 * 更新信息由主服务去 GitHub 查（服务端只读回环请求免登录），
 * 桌面端只负责展示与下载，安装包落在数据根的 updates/ 下，绝不写安装目录。
 */
export async function checkForUpdate() {
  try {
    const response = await fetch(`${serverOrigin()}/api/update/status?force=1`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    })

    if (response.status === 401 || response.status === 403) {
      return { error: '主服务要求登录后才能检查更新，请从桌面端启动服务后再试' }
    }
    if (!response.ok) {
      return { error: `检查更新失败（HTTP ${response.status}）` }
    }
    return await response.json()
  } catch (error) {
    return { error: `无法连接主服务：${error.message}` }
  }
}

function safeFileName(name) {
  const cleaned = String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim()
  return cleaned || 'huajing-update.exe'
}

/** 服务端没给名字就退回 URL 的最后一段；解码失败不能把整个下载拦下来 */
function fileNameFor(url, name) {
  if (name) return safeFileName(name)
  try {
    return safeFileName(decodeURIComponent(basename(new URL(url).pathname)))
  } catch {
    return 'huajing-update.exe'
  }
}

/**
 * 安装包、临时文件与复用记录的固定位置。
 * 同一个版本的资产名是稳定的，所以版本 → 路径是确定的；
 * 复用时还要对照 meta 里记的版本和大小。
 */
export function installerPaths({ url, name } = {}) {
  const dir = join(dataRoot(), UPDATES_DIR_NAME)
  const target = join(dir, fileNameFor(url, name))
  return {
    dir,
    target,
    part: `${target}.part`,
    segmentDir: `${target}${SEGMENT_DIR_SUFFIX}`,
    meta: `${target}.meta.json`,
  }
}

/**
 * 同一版本是否已经有可用的安装包：文件在、大小对得上、meta 记的版本一致才行。
 * 文件被删了或大小对不上都返回 null，交给上层重新下载。
 */
export async function findReadyInstaller({ url, name, version, expectedSize } = {}) {
  try {
    const { target, meta } = installerPaths({ url, name })
    const info = await stat(target)
    if (!info.isFile() || info.size <= 0) return null

    const record = JSON.parse(await readFile(meta, 'utf8'))
    if (!record || typeof record !== 'object') return null
    if (version && record.version !== version) return null
    if (Number.isSafeInteger(record.size) && record.size !== info.size) return null

    const expected = normalizeExpectedSize(expectedSize)
    if (expected !== null && expected !== info.size) return null

    return { file: target, size: info.size }
  } catch {
    return null
  }
}

/** 发布源给出的字节数：只认正整数，0 或非法值都当成没给 */
function normalizeExpectedSize(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return null
  return value
}

class DownloadError extends Error {}

class RangeIgnoredError extends Error {}

/** 416 且这段还没下完：这段从头再来 */
class RangeRestartError extends Error {}

function abortError() {
  const error = new Error('下载已取消')
  error.name = 'AbortError'
  return error
}

function isJsonResponse(response) {
  return /application\/json/i.test(String(response.headers.get('content-type') || ''))
}

function rangeHeader(start, end) {
  return end >= 0 ? `bytes=${start}-${end}` : `bytes=${start}-`
}

/**
 * 从 content-range 里取这次响应实际开始的字节位置。
 * 206 必须说明自己是从哪一段开始的；对不上这个位置的数据不能接到当前进度后面。
 * 头缺失或看不懂一律返回 null，交给调用方走安全回退。
 */
function contentRangeStart(header) {
  const match = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(String(header || ''))
  return match ? Number(match[1]) : null
}

function combineSignals(signals) {
  const list = signals.filter(Boolean)
  if (!list.length) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)

  const controller = new AbortController()
  const onAbort = (event) => {
    controller.abort(event?.target?.reason)
  }
  for (const item of list) {
    if (item.aborted) {
      controller.abort(item.reason)
      return controller.signal
    }
    item.addEventListener('abort', onAbort, { once: true })
  }
  return controller.signal
}

async function sleep(ms, signal) {
  if (signal?.aborted) throw abortError()
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      rejectPromise(abortError())
    }
    const timer = setTimeout(() => {
      cleanup()
      resolvePromise()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function note(message) {
  console.warn(`[updater] ${message}`)
}

/**
 * 进度事件由调用方节流，这里每个 chunk 都发；速率用 2 秒滚动窗，
 * 单块瞬时值抖动太大，直接显示会让窗口里的数字来回跳。
 * 剩余时间算不出来时给 null，不编一个假的数字。
 */
function createProgress(onProgress) {
  const listener = typeof onProgress === 'function'
    ? (event) => { try { onProgress(event) } catch {} }
    : () => {}
  const state = { phase: 'resolve', received: 0, total: 0, connections: 1, mirror: false }
  let speed = 0
  let startedAt = Date.now()
  let window = [{ at: startedAt, received: 0 }]

  const eta = () => {
    if (!(state.total > 0) || !(speed > 0)) return null
    const remaining = state.total - state.received
    if (remaining <= 0) return 0
    return Math.round(remaining / speed)
  }

  const emit = () => {
    listener({ ...state, speed: Math.round(speed), etaSeconds: eta() })
  }

  const sample = () => {
    const now = Date.now()
    window.push({ at: now, received: state.received })
    while (window.length > 2 && now - window[0].at > SPEED_WINDOW_MS) window.shift()
    const oldest = window[0]
    const seconds = (now - oldest.at) / 1000
    if (seconds >= 0.2) {
      const instant = (state.received - oldest.received) / seconds
      // 回退重下时字节数会倒退，这一拍不动速度，等窗口重新攒样本
      if (instant >= 0) speed = speed > 0 ? speed * 0.7 + instant * 0.3 : instant
    } else {
      // 快链路上 1MB 探测不到 0.2 秒，滑窗还没有足够样本，先用本次累计均值顶上
      const elapsed = Math.max((now - startedAt) / 1000, 0.001)
      if (state.received > 0) speed = state.received / elapsed
    }
  }

  return {
    state,
    get received() {
      return state.received
    },
    set(patch) {
      Object.assign(state, patch)
      emit()
    },
    add(bytes) {
      state.received += bytes
      sample()
      emit()
    },
    /** 续传时把已下好的字节算进进度 */
    restore(received) {
      state.received = Math.max(0, received)
      startedAt = Date.now()
      window = [{ at: startedAt, received: state.received }]
      speed = 0
      emit()
    },
    /** 某段作废重来时把这部分字节从进度里扣掉 */
    subtract(bytes) {
      if (!(bytes > 0)) return
      state.received = Math.max(0, state.received - bytes)
      startedAt = Date.now()
      window = [{ at: startedAt, received: state.received }]
      speed = 0
      emit()
    },
    reset() {
      state.received = 0
      startedAt = Date.now()
      window = [{ at: startedAt, received: 0 }]
      speed = 0
      emit()
    },
  }
}

/**
 * 先 HEAD 拿跳转后的签名直链与长度；HEAD 被 CDN 拒绝或没有长度时，
 * 用 Range: bytes=0-0 的 GET 从 content-range 里取总大小。
 */
async function resolveDirectUrl(url, headers, signal) {
  let total = 0
  let direct = ''

  try {
    const response = await httpFetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers,
      signal: combineSignals([signal, AbortSignal.timeout(RESOLVE_TIMEOUT_MS)]),
    })
    if (response.ok && response.status !== 204) {
      total = Number(response.headers.get('content-length')) || 0
      direct = response.url || url
    }
  } catch (error) {
    if (signal?.aborted) throw abortError()
  }

  if (direct && total > 0) return { direct, total }

  let response
  try {
    response = await httpFetch(url, {
      redirect: 'follow',
      headers: { ...headers, range: 'bytes=0-0' },
      signal: combineSignals([signal, AbortSignal.timeout(RESOLVE_TIMEOUT_MS)]),
    })
  } catch (error) {
    if (signal?.aborted) throw abortError()
    throw new DownloadError(`无法连接下载地址：${error.message}`)
  }

  if (response.status === 403 || response.status === 410) {
    await response.body?.cancel().catch(() => {})
    throw new DownloadError('下载地址已过期，请重试')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new DownloadError(`下载地址不可用（HTTP ${response.status}）`)
  }
  if (isJsonResponse(response)) {
    await response.body?.cancel().catch(() => {})
    throw new DownloadError('下载地址返回的是接口数据而不是安装包')
  }

  const ranged = response.status === 206
  const match = /\/(\d+)\s*$/.exec(String(response.headers.get('content-range') || ''))
  total = match ? Number(match[1]) : ranged ? 0 : Number(response.headers.get('content-length')) || 0
  direct = response.url || url
  await response.body?.cancel().catch(() => {})

  return { direct, total }
}

/** 前 1MB 既用来量吞吐，也直接当作文件开头写盘，单流时不必重下 */
async function probeRange({ url, headers, handle, signal, progress }) {
  const started = Date.now()
  const response = await httpFetch(url, {
    redirect: 'follow',
    headers: { ...headers, range: `bytes=0-${PROBE_BYTES - 1}` },
    signal: combineSignals([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
  })

  if (response.status === 403 || response.status === 410) {
    await response.body?.cancel().catch(() => {})
    throw new DownloadError('下载地址已过期，请重试')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new DownloadError(`下载失败（HTTP ${response.status}）`)
  }

  const match = /\/(\d+)\s*$/.exec(String(response.headers.get('content-range') || ''))
  const total = match ? Number(match[1]) : 0

  if (response.status !== 206) {
    // 服务端不认 Range：这份响应其实是整份文件的开头，不能拿半截当续传起点
    await response.body?.cancel().catch(() => {})
    return { ranged: false, bytes: 0, speed: 0, total: total || Number(response.headers.get('content-length')) || 0 }
  }

  // 探测要的就是文件开头：206 说不清自己从哪开始，这份数据不能写进分段
  if (contentRangeStart(response.headers.get('content-range')) !== 0) {
    await response.body?.cancel().catch(() => {})
    return { ranged: false, bytes: 0, speed: 0, total }
  }

  let written = 0
  const reader = response.body.getReader()
  try {
    while (written < PROBE_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      const take = Math.min(value.byteLength, PROBE_BYTES - written)
      await handle.write(value, 0, take, written)
      written += take
      progress.add(take)
      if (take < value.byteLength) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  const seconds = Math.max((Date.now() - started) / 1000, 0.001)
  return { ranged: true, bytes: written, speed: written / seconds, total }
}

function pickConnections({ setting, speed, total, start, ranged }) {
  if (!ranged || !total) return 1
  const remaining = total - start
  if (remaining <= 0) return 1
  const maxBySize = Math.max(1, Math.floor(remaining / MIN_SEGMENT_BYTES))

  if (setting === '1') return 1
  if (setting === '2' || setting === '4' || setting === '6') {
    return Math.min(Number(setting), maxBySize)
  }
  if (speed > 0 && speed < AUTO_FAST_BYTES_PER_SECOND && total > AUTO_MIN_TOTAL_BYTES) {
    return Math.min(AUTO_CONNECTIONS, maxBySize)
  }
  return 1
}

/** 把总长平均切成 count 段；最后一段吃掉余数 */
function planRanges(total, count) {
  const size = Math.max(1, Math.ceil(total / count))
  const ranges = []
  for (let start = 0; start < total; start += size) {
    ranges.push({ start, end: Math.min(total - 1, start + size - 1) })
  }
  return ranges
}

async function fileSize(file) {
  try {
    const info = await stat(file)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

async function readLayout(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, LAYOUT_FILE), 'utf8'))
    if (!parsed || !Number.isSafeInteger(parsed.total) || parsed.total <= 0) return null
    if (!Number.isSafeInteger(parsed.count) || parsed.count <= 0) return null
    return { total: parsed.total, count: parsed.count }
  } catch {
    return null
  }
}

/** 布局文件先写临时文件再改名：写一半被读到会算出错的分段 */
async function writeLayout(dir, layout) {
  const file = join(dir, LAYOUT_FILE)
  const temp = `${file}.tmp`
  await writeFile(temp, JSON.stringify(layout), 'utf8')
  await rename(temp, file)
}

/** 分段文件已存在就接着写，不存在才新建；续传时绝不能把它截断 */
async function openSegmentFile(file) {
  try {
    return await open(file, 'r+')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return await open(file, 'w')
  }
}

async function copyFileRange(source, target, offset, length) {
  if (length <= 0) return
  const input = await open(source, 'r')
  const output = await open(target, 'w')
  try {
    const buffer = Buffer.alloc(Math.min(Math.max(length, 1), 1024 * 1024))
    let copied = 0
    while (copied < length) {
      const want = Math.min(buffer.length, length - copied)
      const { bytesRead } = await input.read(buffer, 0, want, offset + copied)
      if (!bytesRead) break
      await output.write(buffer, 0, bytesRead)
      copied += bytesRead
    }
  } finally {
    await input.close().catch(() => {})
    await output.close().catch(() => {})
  }
}

/**
 * 下载一段。段内用 Range 从已下好的位置续传：
 * - 206：正常续传；
 * - 200：服务端不认 Range。整份单流时安全地从头写，多段时交给调用方回退成单流；
 * - 416：这段已经下完就收工，否则这段从头再来。
 */
async function downloadSegment({
  file, start, end, wholeFile, headers, urlRef, refresh, generation,
  progress, signal, stopSignal, segment,
}) {
  let position = start + segment.bytes
  let attempts = 0
  let refreshes = 0
  const handle = await openSegmentFile(file)

  /** 这段已有的数据作废：退回段首重新下，不把错位的数据留在文件里 */
  const resetSegment = async () => {
    progress.subtract(segment.bytes)
    await handle.truncate(0)
    segment.bytes = 0
    position = start
  }

  try {
    while (true) {
      if (signal?.aborted) throw abortError()
      if (stopSignal?.aborted) throw new DownloadError('并发分片已中止')

      const controller = new AbortController()
      let stall = null
      const touch = () => {
        if (stall) clearTimeout(stall)
        stall = setTimeout(() => controller.abort(new Error('stall')), STALL_TIMEOUT_MS)
      }
      touch()
      const startedGeneration = generation()

      try {
        const response = await httpFetch(urlRef(), {
          redirect: 'follow',
          headers: { ...headers, range: rangeHeader(position, end) },
          signal: combineSignals([signal, stopSignal, controller.signal]),
        })

        if (response.status === 403 || response.status === 410) {
          await response.body?.cancel().catch(() => {})
          throw new DownloadError('下载地址已过期，请重试')
        }
        if (response.status === 416) {
          await response.body?.cancel().catch(() => {})
          if (end >= 0 && position > end) return position
          // 服务端给不出这一段：从这段开头重来
          await resetSegment()
          throw new RangeRestartError()
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw new DownloadError(`下载失败（HTTP ${response.status}）`)
        }
        if (isJsonResponse(response)) {
          await response.body?.cancel().catch(() => {})
          throw new DownloadError('下载地址返回的是接口数据而不是安装包')
        }
        if (response.status === 206) {
          // 206 必须说明这次响应是从哪开始的：对不上当前位置就不能把数据接上去
          if (contentRangeStart(response.headers.get('content-range')) !== position) {
            await response.body?.cancel().catch(() => {})
            await resetSegment()
            throw new RangeRestartError()
          }
        } else if (!wholeFile) {
          // 分段请求拿到整份文件时不能按偏移写，交给调用方回退成单流
          await response.body?.cancel().catch(() => {})
          throw new RangeIgnoredError()
        } else {
          // 整份单流：服务端不认 Range，给回来的就是完整文件，从头安全地写
          await resetSegment()
          position = 0
        }

        const reader = response.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            touch()
            const limit = end >= 0 ? end - position + 1 : value.byteLength
            const take = Math.min(value.byteLength, limit)
            if (take <= 0) break
            await handle.write(value, 0, take, position - start)
            position += take
            segment.bytes = position - start
            progress.add(take)
            if (take < value.byteLength) break
          }
        } catch (error) {
          await reader.cancel().catch(() => {})
          throw error
        }

        if (end >= 0 && position < end + 1) throw new DownloadError('网络连接提前断开')
        return position
      } catch (error) {
        if (signal?.aborted) throw abortError()
        if (error instanceof RangeIgnoredError) throw error
        if (error instanceof RangeRestartError) {
          attempts += 1
          if (attempts > RETRY_DELAYS.length) {
            throw new DownloadError('下载地址无法续传（HTTP 416 或返回位置不符）')
          }
          await sleep(RETRY_DELAYS[attempts - 1], signal)
          continue
        }
        if (error instanceof DownloadError && error.message.includes('过期')) {
          // 并发段同时收到 403 时，先换过链的直接用新地址重试，不必再 HEAD 一次
          if (generation() !== startedGeneration) continue
          refreshes += 1
          if (refreshes > MAX_REFRESH) throw error
          await refresh()
          continue
        }

        attempts += 1
        if (attempts > RETRY_DELAYS.length) {
          throw new DownloadError(`网络中断，已重试 ${RETRY_DELAYS.length} 次`)
        }
        await sleep(RETRY_DELAYS[attempts - 1], signal)
      } finally {
        if (stall) clearTimeout(stall)
      }
    }
  } finally {
    try { await handle.close() } catch {}
  }
}

/** 各段按顺序拼成一个完整文件；拼完才算数，中途失败不会留下半个安装包 */
async function assembleSegments(segmentDir, segments, part) {
  const output = await open(part, 'w')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    for (const segment of segments) {
      const input = await open(join(segmentDir, `${segment.index}.bin`), 'r')
      try {
        let position = 0
        while (true) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, position)
          if (!bytesRead) break
          await output.write(buffer, 0, bytesRead)
          position += bytesRead
        }
      } finally {
        await input.close().catch(() => {})
      }
    }
  } finally {
    await output.close().catch(() => {})
  }
}

async function renameIntoPlace(part, target) {
  try {
    await rm(target, { force: true })
    await rename(part, target)
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
    await rm(target, { force: true })
    await rename(part, target)
  }
}

/** 下载成功后记一笔“这个文件是哪个版本、多大”，复用时照着核对 */
async function writeInstallerMeta(metaPath, { version, size }) {
  const record = {
    version: String(version || ''),
    size,
    updatedAt: new Date().toISOString(),
  }
  const temp = `${metaPath}.tmp`
  await writeFile(temp, JSON.stringify(record), 'utf8')
  await rename(temp, metaPath)
}

/**
 * 下载安装包：解析签名直链 → 1MB 吞吐探测 → 按配置决定 1 段或 N 段并发。
 * 每段单独一个文件，续传时靠文件长度知道每段下到哪了：
 * 已经下完的段直接跳过，服务端支持 Range 时从已有字节接着下。
 * 全部字节到位并核对过大小后才拼成 .part 再改名，中途失败不影响下次续传。
 */
export async function downloadInstaller({ url, name, onProgress, signal, expectedSize, version } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('下载地址无效')
  if (signal?.aborted) throw abortError()

  let settings
  try {
    settings = loadConfig(dataRoot())
  } catch (error) {
    throw new DownloadError(`读取下载配置失败：${error.message}`)
  }
  const mirrorPrefix = String(settings.UPDATE_DOWNLOAD_MIRROR || '').trim().replace(/\/+$/, '')
  const connectionSetting = String(settings.UPDATE_DOWNLOAD_CONNECTIONS || 'auto').trim().toLowerCase()
  const sourceUrl = mirrorPrefix ? `${mirrorPrefix}/${url}` : url
  const expected = normalizeExpectedSize(expectedSize)

  const { dir, target, part, segmentDir, meta } = installerPaths({ url, name })

  const progress = createProgress(onProgress)
  progress.set({ mirror: Boolean(mirrorPrefix) })

  const headers = {
    // GitHub 的asset 接口要 octet-stream 才回二进制，否则给的是 JSON 元数据
    accept: 'application/octet-stream',
    'user-agent': `mpimage-desktop/${app.getVersion()}`,
  }

  try {
    await mkdir(dir, { recursive: true })

    progress.set({ phase: 'resolve' })
    const resolved = await resolveDirectUrl(sourceUrl, headers, signal)

    let directUrl = resolved.direct
    let refreshing = null
    // 每换一次直链就加一：并发段靠它判断「别人已经换过链」，避免同时 403 时反复 HEAD
    let generation = 0
    const urlRef = () => directUrl
    const currentGeneration = () => generation
    const refresh = () => {
      if (!refreshing) {
        refreshing = resolveDirectUrl(sourceUrl, headers, signal)
          .then((next) => { directUrl = next.direct; generation += 1 })
          .finally(() => { refreshing = null })
      }
      return refreshing
    }

    let total = resolved.total
    progress.set({ total })

    const explicitCount = ['1', '2', '4', '6'].includes(connectionSetting)
      ? Number(connectionSetting)
      : 0

    // 续传的前提：上次的布局还在、总大小没变、用户也没改连接数
    let layout = await readLayout(segmentDir)
    if (layout) {
      // 服务端这次没报长度，就用上次记下的；两边对不上说明源文件变了，只能重来
      const known = total || layout.total
      if (known !== layout.total) layout = null
      else total = known
    }
    if (layout && explicitCount && explicitCount !== layout.count) layout = null

    let segments = []

    if (layout && total > 0) {
      // 接着上次下：每段的文件长度就是这段已经下好的字节
      const ranges = planRanges(total, layout.count)
      for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index]
        const length = range.end - range.start + 1
        const bytes = Math.min(await fileSize(join(segmentDir, `${index}.bin`)), length)
        segments.push({ index, start: range.start, end: range.end, bytes, done: bytes >= length })
      }
      progress.restore(segments.reduce((sum, item) => sum + item.bytes, 0))
      progress.set({ total, connections: segments.length })
    } else {
      // 全新下载：先把上次的半成品清掉
      await rm(segmentDir, { recursive: true, force: true })
      await mkdir(segmentDir, { recursive: true })

      const probeFile = join(segmentDir, PROBE_FILE)
      const probeHandle = await open(probeFile, 'w')
      let probe
      try {
        probe = await probeRange({ url: directUrl, headers, handle: probeHandle, signal, progress })
      } catch (error) {
        if (signal?.aborted) throw abortError()
        if (error instanceof DownloadError && error.message.includes('过期')) {
          await refresh()
          probe = await probeRange({ url: directUrl, headers, handle: probeHandle, signal, progress })
        } else {
          // 探测失败不等于下载失败：退回整份单流
          note(`吞吐探测失败，回退单流下载：${error.message}`)
          probe = { ranged: false, bytes: 0, speed: 0, total: 0 }
        }
      } finally {
        await probeHandle.close().catch(() => {})
      }

      total = total || probe.total || 0
      progress.set({ total })

      const count = pickConnections({
        setting: connectionSetting, speed: probe.speed, total, start: 0, ranged: probe.ranged,
      })
      const ranges = total > 0 ? planRanges(total, count) : [{ start: 0, end: -1 }]
      segments = ranges.map((range, index) => ({
        index, start: range.start, end: range.end, bytes: 0, done: false,
      }))

      // 探测时读到的前 1MB 就是文件开头，留在第 0 段里不用重下
      progress.reset()
      if (probe.ranged && probe.bytes > 0 && segments[0].end >= 0) {
        const keep = Math.min(probe.bytes, segments[0].end - segments[0].start + 1)
        await copyFileRange(probeFile, join(segmentDir, '0.bin'), 0, keep)
        segments[0].bytes = keep
        progress.add(keep)
      }
      await rm(probeFile, { force: true })
      await writeLayout(segmentDir, { total, count: segments.length })
    }

    progress.set({ phase: 'download' })

    const runSegments = async (list) => {
      const group = new AbortController()
      const tasks = list.map((segment) => {
        if (segment.done) return Promise.resolve()
        return downloadSegment({
          file: join(segmentDir, `${segment.index}.bin`),
          start: segment.start,
          end: segment.end,
          wholeFile: list.length === 1,
          headers,
          urlRef,
          refresh,
          generation: currentGeneration,
          progress,
          signal,
          stopSignal: group.signal,
          segment,
        }).catch((error) => {
          // 一段彻底失败就没必要让其余段继续烧带宽；已经下好的字节留着，下次接着下
          group.abort()
          throw error
        })
      })
      const results = await Promise.allSettled(tasks)
      if (signal?.aborted) throw abortError()
      const reasons = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason)
      if (!reasons.length) return
      const root = reasons.find(reason =>
        !(reason instanceof DownloadError && reason.message.includes('并发分片已中止')))
      throw root || reasons[0]
    }

    try {
      await runSegments(segments)
    } catch (error) {
      if (!(error instanceof RangeIgnoredError)) throw error
      // 服务端不认 Range：退回整份单流，从头安全地下一遍
      note('服务端不支持 Range 续传，回退为整份单流下载')
      await rm(segmentDir, { recursive: true, force: true })
      await mkdir(segmentDir, { recursive: true })
      segments = [{
        index: 0, start: 0, end: total > 0 ? total - 1 : -1, bytes: 0, done: false,
      }]
      await writeLayout(segmentDir, { total, count: 1 })
      progress.reset()
      await runSegments(segments)
    }

    await assembleSegments(segmentDir, segments, part)

    const info = await stat(part)
    if (total > 0 && info.size !== total) {
      throw new DownloadError(`下载大小与预期不符（${info.size}/${total} 字节）`)
    }
    if (expected !== null && info.size !== expected) {
      throw new DownloadError(`下载大小与发布信息不符（${info.size}/${expected} 字节）`)
    }

    await renameIntoPlace(part, target)
    await rm(segmentDir, { recursive: true, force: true })
    try {
      await writeInstallerMeta(meta, { version, size: info.size })
    } catch (error) {
      // 复用记录写不进去不影响本次下载，只是下次会重新下一遍
      note(`复用记录写入失败：${error.message}`)
    }

    progress.set({ phase: 'done', received: info.size, total: info.size })
    return { file: target, size: info.size, connections: segments.length }
  } catch (error) {
    if (signal?.aborted) throw abortError()
    if (error?.name === 'AbortError') throw abortError()
    if (error instanceof DownloadError) throw error

    const reason = String(error?.message || error || '').trim() || '未知错误'
    throw new DownloadError(`下载安装包失败：${reason}`, { cause: error })
  }
}

export async function launchInstaller(file) {
  const message = await shell.openPath(file)
  if (message) throw new Error(`无法打开安装包：${message}`)
}
