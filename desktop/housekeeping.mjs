import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 启动时的清理：只在版本变化后跑一次。
 *
 * 覆盖安装后，上一版的安装包、分段下载缓存和 Chromium 缓存都没有用了，
 * 留着只会让数据目录越攒越大（一次安装包就有 75MB+）。
 * 账号、图片、生成记录、日志、settings 这些是用户数据，一律不碰。
 */

/** Chromium 自己的缓存目录：删掉会自动重建，不含登录态与用户数据 */
const CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'CachedData',
  'crashDumps',
  'Crashpad',
]

const MARKER_FILE = '.housekeeping.json'

function dirStats(dir) {
  let bytes = 0
  let files = 0
  const walk = target => {
    let entries
    try {
      entries = readdirSync(target, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(target, entry.name)
      try {
        if (entry.isDirectory()) {
          walk(full)
        } else {
          bytes += statSync(full).size
          files += 1
        }
      } catch {
        // 单个文件读不到就跳过，不影响整体清理
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

/**
 * @param {string} dataRoot 数据根（安装版是 %APPDATA%\huajing，便携版是 exe 旁的 huajing-data）
 * @param {(message: string) => void} log
 */
export function runHousekeeping(dataRoot, log = () => {}) {
  try {
    const version = app.getVersion()
    const markerPath = join(dataRoot, MARKER_FILE)

    let marker = null
    try {
      marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    } catch {
      marker = null
    }
    if (marker && marker.version === version) return { skipped: true }

    let bytes = 0
    let files = 0

    // 1. 上一版下载的安装包、.part、分段目录与 meta
    const updates = join(dataRoot, 'updates')
    if (existsSync(updates)) {
      const stat = dirStats(updates)
      bytes += stat.bytes
      files += stat.files
      try {
        rmSync(updates, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch {
        // 正在被安装器占用时删不掉，下次启动还会再试
      }
      try {
        mkdirSync(updates, { recursive: true })
      } catch {}
    }

    // 2. Chromium 缓存
    for (const name of CACHE_DIRS) {
      const dir = join(dataRoot, name)
      if (!existsSync(dir)) continue
      const stat = dirStats(dir)
      bytes += stat.bytes
      files += stat.files
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 })
      } catch {
        // 被占用就留着，下次启动再说
      }
    }

    try {
      writeFileSync(markerPath, JSON.stringify({ version, at: Date.now(), bytes, files }), 'utf8')
    } catch {}

    if (files > 0) {
      log(`清理旧安装包与缓存：${files} 个文件，释放 ${(bytes / 1024 / 1024).toFixed(1)} MB`)
    }
    return { bytes, files, version }
  } catch (error) {
    log(`清理旧安装包与缓存失败：${error?.message || error}`)
    return { error: true }
  }
}
