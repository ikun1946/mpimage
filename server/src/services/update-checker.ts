/**
 * 更新检查：把当前版本和发布源上的最新版本比一比。
 * 结果带缓存（成功 10 分钟、失败 60 秒），同一时刻只发一个请求——
 * 客户端会定时轮询，不缓存的话容易把 GitHub 打出限流。
 * 任何失败都不抛异常，把原因写进 error 返回，前端照常渲染。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

export interface UpdateStatus {
  currentVersion: string
  latestVersion: string | null
  hasUpdate: boolean
  releaseNotes: string
  pageUrl: string | null
  downloadUrl: string | null
  downloadName: string | null
  publishedAt: string | null
  checkedAt: string
  source: 'github' | 'custom' | 'none'
  disabled: boolean
  error: string | null
}

interface ReleaseInfo {
  version: string
  notes: string
  pageUrl: string | null
  downloadUrl: string | null
  downloadName: string | null
  publishedAt: string | null
  source: 'github' | 'custom'
}

const SUCCESS_TTL_MS = 10 * 60 * 1000
const FAILURE_TTL_MS = 60 * 1000
const REQUEST_TIMEOUT_MS = 8000
const NOTES_LIMIT = 4000
const USER_AGENT = 'mpimage-update-checker'

const currentVersion = normalizeVersion(config.appVersion || readPackageVersion() || '0.0.0')

/**
 * 源码运行时在 server/src/services，编译后在 server/dist/services，
 * 打包后的后端目录是 app-server/server/dist/services——统一向上找 server/package.json。
 */
function readPackageVersion(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [
    resolve(here, '..', '..', 'package.json'),
    resolve(here, '..', '..', '..', 'package.json'),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version.trim()
    } catch {
      // 这一层没有 package.json，继续往上找
    }
  }
  return null
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '')
}

/** 只认纯数字分段（1.0.2 / v1.0.2 / 1.0.2.0），其它一律视为无法比较 */
function parseVersion(value: string | null): number[] | null {
  if (!value) return null
  const text = normalizeVersion(value)
  if (!/^\d+(\.\d+)*$/.test(text)) return null
  return text.split('.').map(part => Number.parseInt(part, 10))
}

/** 缺位补 0 后逐段比较；任一侧版本非法时返回 null */
function compareVersions(latest: string | null, current: string): number | null {
  const left = parseVersion(latest)
  const right = parseVersion(current)
  if (!left || !right) return null
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b ? 1 : -1
  }
  return 0
}

function isNewer(latest: string | null, current: string): boolean {
  return compareVersions(latest, current) === 1
}

function textFrom(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function nullableTextFrom(value: unknown): string | null {
  const text = textFrom(value)
  return text || null
}

/** GitHub release 的资产：.exe 里优先名字含 Setup 的（安装包），其次 portable（免安装） */
function pickAsset(assets: unknown): { name: string; url: string } | null {
  if (!Array.isArray(assets)) return null
  const exes = assets
    .map(asset => {
      const record = (asset ?? {}) as { name?: unknown; browser_download_url?: unknown }
      const name = textFrom(record.name)
      const url = textFrom(record.browser_download_url)
      return name && url && name.toLowerCase().endsWith('.exe') ? { name, url } : null
    })
    .filter((asset): asset is { name: string; url: string } => asset !== null)
  const setup = exes.find(asset => asset.name.toLowerCase().includes('setup'))
  const portable = exes.find(asset => asset.name.toLowerCase().includes('portable'))
  return setup ?? portable ?? null
}

async function requestJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`更新源返回 ${response.status}`)
  return response.json()
}

/** 自定义更新源：约定返回 { version, notes?, downloadUrl?, pageUrl?, publishedAt? } */
async function fetchCustom(feedUrl: string): Promise<ReleaseInfo> {
  const payload = (await requestJson(feedUrl, {
    Accept: 'application/json',
    'User-Agent': `${USER_AGENT}/${currentVersion}`,
  })) as Record<string, unknown> | null
  const version = textFrom(payload?.version)
  if (!version) throw new Error('自定义更新源没有返回 version 字段')
  return {
    version: normalizeVersion(version),
    notes: textFrom(payload?.notes),
    pageUrl: nullableTextFrom(payload?.pageUrl),
    downloadUrl: nullableTextFrom(payload?.downloadUrl),
    downloadName: null,
    publishedAt: nullableTextFrom(payload?.publishedAt),
    source: 'custom',
  }
}

async function fetchGitHub(repo: string, token: string): Promise<ReleaseInfo> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `${USER_AGENT}/${currentVersion}`,
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const payload = (await requestJson(
    `https://api.github.com/repos/${repo}/releases/latest`,
    headers,
  )) as Record<string, unknown> | null

  const version = textFrom(payload?.tag_name) || textFrom(payload?.name)
  if (!version) throw new Error('GitHub 最新版本没有返回 tag_name')
  const asset = pickAsset(payload?.assets)
  return {
    version: normalizeVersion(version),
    notes: textFrom(payload?.body),
    pageUrl: nullableTextFrom(payload?.html_url),
    downloadUrl: asset?.url ?? null,
    downloadName: asset?.name ?? null,
    publishedAt: nullableTextFrom(payload?.published_at),
    source: 'github',
  }
}

/** 网络层的错误大多是英文，翻成能直接给用户看的说明 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return '请求更新源超时，请检查网络或代理'
  }
  const message = error.message
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return '无法解析更新源域名，请检查网络'
  if (/ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(message)) {
    return '无法连接更新源，请检查网络或代理'
  }
  return message
}

export class UpdateChecker {
  private cached: UpdateStatus | null = null
  private cachedAt = 0
  private inflight: Promise<UpdateStatus> | null = null

  async getStatus(force = false): Promise<UpdateStatus> {
    if (config.updateDisabled) {
      return {
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        releaseNotes: '',
        pageUrl: null,
        downloadUrl: null,
        downloadName: null,
        publishedAt: null,
        checkedAt: new Date().toISOString(),
        source: 'none',
        disabled: true,
        error: null,
      }
    }

    const ttl = this.cached?.error ? FAILURE_TTL_MS : SUCCESS_TTL_MS
    if (!force && this.cached && Date.now() - this.cachedAt < ttl) return this.cached
    if (this.inflight) return this.inflight

    this.inflight = this.refresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async refresh(): Promise<UpdateStatus> {
    const checkedAt = new Date().toISOString()
    const feedUrl = config.updateFeedUrl
    try {
      const info = feedUrl
        ? await fetchCustom(feedUrl)
        : await fetchGitHub(config.updateRepo, config.updateToken)
      const status: UpdateStatus = {
        currentVersion,
        latestVersion: info.version,
        hasUpdate: isNewer(info.version, currentVersion),
        releaseNotes: info.notes.slice(0, NOTES_LIMIT),
        pageUrl: info.pageUrl,
        downloadUrl: info.downloadUrl,
        downloadName: info.downloadName,
        publishedAt: info.publishedAt,
        checkedAt,
        source: info.source,
        disabled: false,
        error: null,
      }
      this.cached = status
      this.cachedAt = Date.now()
      return status
    } catch (error) {
      const status: UpdateStatus = {
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        releaseNotes: '',
        pageUrl: null,
        downloadUrl: null,
        downloadName: null,
        publishedAt: null,
        checkedAt,
        source: feedUrl ? 'custom' : 'github',
        disabled: false,
        error: `检查更新失败：${describeError(error)}`,
      }
      this.cached = status
      this.cachedAt = Date.now()
      return status
    }
  }
}
