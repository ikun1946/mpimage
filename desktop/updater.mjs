import { mkdir, open, rename, rm, unlink } from 'node:fs/promises'
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

class DownloadError extends Error {}

class RangeIgnoredError extends Error {}

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
 * 进度事件由调用方节流，这里每个 chunk 都发；速率用 2 秒滑窗，
 * 单块瞬时值抖动太大，直接显示会让窗口里的数字来回跳。
 */
function createProgress(onProgress) {
  const listener = typeof onProgress === 'function'
    ? (event) => { try { onProgress(event) } catch {} }
    : () => {}
  const state = { phase: 'resolve', received: 0, total: 0, connections: 1, mirror: false }
  let speed = 0
  let startedAt = Date.now()
  let window = [{ at: startedAt, received: 0 }]

  const emit = () => {
    listener({ ...state, speed: Math.round(speed) })
  }

  const sample = () => {
    const now = Date.now()
    window.push({ at: now, received: state.received })
    while (window.length > 2 && now - window[0].at > 2000) window.shift()
    const oldest = window[0]
    const seconds = (now - oldest.at) / 1000
    if (seconds >= 0.2) {
      const instant = (state.received - oldest.received) / seconds
      speed = speed > 0 ? speed * 0.7 + instant * 0.3 : instant
    } else {
      // 快链路上 1MB 探测不到 0.2 秒，滑窗还没有足够样本，先用本次累计均值顶上
      const elapsed = Math.max((now - startedAt) / 1000, 0.001)
      if (state.received > 0) speed = state.received / elapsed
    }
  }

  return {
    state,
    set(patch) {
      Object.assign(state, patch)
      emit()
    },
    add(bytes) {
      state.received += bytes
      sample()
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

async function downloadLinear({ handle, start, end, headers, urlRef, refresh, generation, progress, signal }) {
  if (end >= 0 && start > end) return start

  let position = start
  let attempts = 0
  let refreshes = 0

  while (true) {
    if (signal?.aborted) throw abortError()

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
        signal: combineSignals([signal, controller.signal]),
      })

      if (response.status === 403 || response.status === 410) {
        await response.body?.cancel().catch(() => {})
        throw new DownloadError('下载地址已过期，请重试')
      }
      if (response.status === 416) {
        await response.body?.cancel().catch(() => {})
        if (end >= 0 && position > end) return position
        throw new DownloadError('下载地址无法续传（HTTP 416）')
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new DownloadError(`下载失败（HTTP ${response.status}）`)
      }
      if (isJsonResponse(response)) {
        await response.body?.cancel().catch(() => {})
        throw new DownloadError('下载地址返回的是接口数据而不是安装包')
      }

      if (response.status !== 206 && position > 0) {
        // 服务端这次不认 Range，给的是整份文件：已写的作废，从这份响应重新写
        await handle.truncate(0)
        progress.reset()
        position = 0
      }

      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          touch()
          await handle.write(value, 0, value.byteLength, position)
          position += value.byteLength
          progress.add(value.byteLength)
        }
      } catch (error) {
        await reader.cancel().catch(() => {})
        throw error
      }

      if (end >= 0 && position < end + 1) throw new DownloadError('网络连接提前断开')
      return position
    } catch (error) {
      if (signal?.aborted) throw abortError()

      if (error instanceof DownloadError && error.message.includes('过期')) {
        // 并发段同时收到 403 时，先换过链的直接用新地址重试，不必再 HEAD 一次
        if (generation() !== startedGeneration) continue
        refreshes += 1
        if (refreshes > MAX_REFRESH) throw error
        await refresh()
        continue
      }
      if (error instanceof DownloadError && error.message.includes('HTTP 416')) throw error

      attempts += 1
      if (attempts > RETRY_DELAYS.length) {
        throw new DownloadError(`网络中断，已重试 ${RETRY_DELAYS.length} 次`)
      }
      await sleep(RETRY_DELAYS[attempts - 1], signal)
    } finally {
      if (stall) clearTimeout(stall)
    }
  }
}

async function downloadSegment({ handle, start, end, headers, urlRef, refresh, generation, progress, signal, stopSignal }) {
  let position = start
  let attempts = 0
  let refreshes = 0

  while (position <= end) {
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
        headers: { ...headers, range: `bytes=${position}-${end}` },
        signal: combineSignals([signal, stopSignal, controller.signal]),
      })

      if (response.status === 403 || response.status === 410) {
        await response.body?.cancel().catch(() => {})
        throw new DownloadError('下载地址已过期，请重试')
      }
      if (response.status === 200) {
        // 分段请求拿到整份文件时不能按偏移写，交给调用方回退成单流
        await response.body?.cancel().catch(() => {})
        throw new RangeIgnoredError()
      }
      if (response.status !== 206) {
        await response.body?.cancel().catch(() => {})
        throw new DownloadError(`下载失败（HTTP ${response.status}）`)
      }

      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          touch()
          const take = Math.min(value.byteLength, end - position + 1)
          await handle.write(value, 0, take, position)
          position += take
          progress.add(take)
          if (take < value.byteLength) {
            await reader.cancel().catch(() => {})
            break
          }
        }
      } catch (error) {
        await reader.cancel().catch(() => {})
        throw error
      }

      if (position <= end) throw new DownloadError('分片连接提前断开')
      return position
    } catch (error) {
      if (signal?.aborted) throw abortError()
      if (stopSignal?.aborted) throw new DownloadError('并发分片已中止')
      if (error instanceof RangeIgnoredError) throw error

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

  return position
}

async function runSegments({ handle, count, start, total, headers, urlRef, refresh, generation, progress, signal }) {
  const remaining = total - start
  const per = Math.floor(remaining / count)
  const ranges = []
  let offset = start
  for (let index = 0; index < count - 1; index += 1) {
    ranges.push({ start: offset, end: offset + per - 1 })
    offset += per
  }
  ranges.push({ start: offset, end: total - 1 })

  const group = new AbortController()
  const tasks = ranges.map((range) => downloadSegment({
    handle,
    start: range.start,
    end: range.end,
    headers,
    urlRef,
    refresh,
    generation,
    progress,
    signal,
    stopSignal: group.signal,
  }).catch((error) => {
    // 一段彻底失败就没必要让其余段继续烧带宽
    group.abort()
    throw error
  }))

  const results = await Promise.allSettled(tasks)
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) throw failed.reason
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

/**
 * 下载安装包：解析签名直链 → 1MB 吞吐探测 → 按配置决定 1 段或 N 段并发。
 * 先写 .part 再改名，取消或失败都会删掉 .part，避免留下看似完整的半截安装包。
 */
export async function downloadInstaller({ url, name, onProgress, signal } = {}) {
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

  const dir = join(dataRoot(), UPDATES_DIR_NAME)
  const target = join(dir, fileNameFor(url, name))
  const part = `${target}.part`

  const progress = createProgress(onProgress)
  progress.set({ mirror: Boolean(mirrorPrefix) })

  const headers = {
    // GitHub 的 asset 接口要 octet-stream 才回二进制，否则给的是 JSON 元数据
    accept: 'application/octet-stream',
    'user-agent': `huajing-desktop/${app.getVersion()}`,
  }

  let handle = null
  let connections = 1

  try {
    await mkdir(dir, { recursive: true })

    progress.set({ phase: 'resolve' })
    const resolved = await resolveDirectUrl(sourceUrl, headers, signal)
    const knownTotal = resolved.total
    progress.set({ total: knownTotal })

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

    handle = await open(part, 'w')

    progress.set({ phase: 'probe' })
    let probe
    try {
      probe = await probeRange({ url: directUrl, headers, handle, signal, progress })
    } catch (error) {
      if (signal?.aborted) throw abortError()
      if (error instanceof DownloadError && error.message.includes('过期')) {
        await refresh()
        probe = await probeRange({ url: directUrl, headers, handle, signal, progress })
      } else {
        // 探测失败不等于下载失败：退回整份单流
        note(`吞吐探测失败，回退单流下载：${error.message}`)
        probe = { ranged: false, bytes: 0, speed: 0, total: 0 }
      }
    }

    const total = knownTotal || probe.total || 0
    progress.set({ total })

    // 总大小未知或服务端不认 Range 时，探测写下的字节不能当成文件开头
    if (!probe.ranged || !total || probe.bytes === 0) {
      await handle.truncate(0)
      progress.reset()
    }

    const start = probe.ranged && total ? probe.bytes : 0
    connections = pickConnections({ setting: connectionSetting, speed: probe.speed, total, start, ranged: probe.ranged })

    progress.set({ phase: 'download', connections })

    if (connections > 1) {
      try {
        await runSegments({
          handle,
          count: connections,
          start,
          total,
          headers,
          urlRef,
          refresh,
          generation: currentGeneration,
          progress,
          signal,
        })
      } catch (error) {
        if (signal?.aborted) throw abortError()
        note(`并发分段下载失败，回退整份下载：${error.message}`)
        await handle.truncate(0)
        progress.reset()
        connections = 1
        progress.set({ connections, phase: 'download' })
        await downloadLinear({
          handle,
          start: 0,
          end: total ? total - 1 : -1,
          headers,
          urlRef,
          refresh,
          generation: currentGeneration,
          progress,
          signal,
        })
      }
    } else {
      await downloadLinear({
        handle,
        start,
        end: total ? total - 1 : -1,
        headers,
        urlRef,
        refresh,
        generation: currentGeneration,
        progress,
        signal,
      })
    }

    const stats = await handle.stat()
    if (total > 0 && Math.abs(stats.size - total) / total > 0.01) {
      throw new DownloadError(`下载大小不符（期望 ${total} 字节，实际 ${stats.size} 字节）`)
    }

    await handle.close()
    handle = null
    await renameIntoPlace(part, target)

    progress.set({ phase: 'done', received: stats.size, total: total || stats.size, connections })
    return { file: target, size: stats.size, connections }
  } catch (error) {
    if (handle) {
      try { await handle.close() } catch {}
      handle = null
    }
    try { await unlink(part) } catch {}

    if (signal?.aborted) throw abortError()
    if (error?.name === 'AbortError') throw abortError()
    if (error instanceof DownloadError) throw error

    const reason = String(error?.message || error || '').trim() || '未知错误'
    throw new DownloadError(`下载安装包失败：${reason}`)
  }
}

export async function launchInstaller(file) {
  const message = await shell.openPath(file)
  if (message) throw new Error(`无法打开安装包：${message}`)
}