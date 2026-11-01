import { createWriteStream, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, shell } from 'electron'
import { dataRoot } from './paths.mjs'
import { serverOrigin } from './server.mjs'

const UPDATES_DIR_NAME = 'updates'

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
 * 先写 .part 再改名：下载中断时不会留下一个看起来像安装包的半截文件。
 */
export async function downloadInstaller({ url, name, onProgress } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('下载地址无效')

  const dir = join(dataRoot(), UPDATES_DIR_NAME)
  const target = join(dir, fileNameFor(url, name))
  const part = `${target}.part`

  let received = 0
  let total = 0
  let body = null

  try {
    const response = await fetch(url, {
      // GitHub 的 asset 接口要 octet-stream 才回二进制，否则给的是 JSON 元数据
      headers: { accept: 'application/octet-stream', 'user-agent': `huajing-desktop/${app.getVersion()}` },
      signal: AbortSignal.timeout(10 * 60 * 1000),
    })
    if (!response.ok || !response.body) {
      throw new Error(`下载失败（HTTP ${response.status}）`)
    }

    const contentType = String(response.headers.get('content-type') || '')
    if (/application\/json/i.test(contentType)) {
      throw new Error('下载地址返回的是接口数据而不是安装包')
    }

    total = Number(response.headers.get('content-length')) || 0
    mkdirSync(dir, { recursive: true })

    const stream = Readable.fromWeb(response.body)
    body = stream
    // 用一个直通的 Transform 数进度：直接给 stream 挂 data 监听会把它切到 flowing 模式
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        if (typeof onProgress === 'function') onProgress(received, total)
        callback(null, chunk)
      },
    })

    await pipeline(stream, counter, createWriteStream(part))

    try {
      unlinkSync(target)
    } catch {}
    renameSyncCompat(part, target)
    return target
  } catch (error) {
    try { unlinkSync(part) } catch {}
    if (error?.code === 'ABORT_ERR' || error?.name === 'TimeoutError') {
      throw new Error('下载安装包超时，请稍后重试')
    }
    throw new Error(`下载安装包失败：${error.message}`)
  } finally {
    body?.destroy()
  }
}

/** Windows 上目标已存在时 rename 会失败，调用前已删过；这里只做一次兜底重试 */
function renameSyncCompat(from, to) {
  try {
    renameSync(from, to)
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
    try { unlinkSync(to) } catch {}
    renameSync(from, to)
  }
}

export async function launchInstaller(file) {
  const message = await shell.openPath(file)
  if (message) throw new Error(`无法打开安装包：${message}`)
}