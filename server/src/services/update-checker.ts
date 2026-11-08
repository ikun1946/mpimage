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
  /**
   * GitHub 资产 API 直链（Accept: application/octet-stream）。
   * 走 github.com/…/releases/download 的普通链接在部分代理上会 504，
   * 这个接口会 302 到签名 CDN，能绕开那种代理故障。
   */
  downloadApiUrl: string | null
  downloadName: string | null
  /** 安装包字节数：GitHub 取资产 size，自定义源可显式给出；拿不到就是 null */
  downloadSize: number | null
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
  downloadApiUrl: string | null
  downloadName: string | null
  downloadSize: number | null
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

/** 字节数只认非负整数：数字或纯数字字符串，其余（小数、负数、null、布尔）一律当成“没给” */
function normalizeSize(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^\d+$/.test(text)) return null
    const size = Number.parseInt(text, 10)
    return Number.isSafeInteger(size) ? size : null
  }
  return null
}

/** GitHub release 的资产：.exe 里优先名字含 Setup 的（安装包），其次 portable（免安装） */
function pickAsset(assets: unknown): { name: string; url: string; apiUrl: string | null; size: number | null } | null {
  if (!Array.isArray(assets)) return null
  const exes = assets
    .map(asset => {
      const record = (asset ?? {}) as { name?: unknown; browser_download_url?: unknown; url?: unknown; size?: unknown }
      const name = textFrom(record.name)
      const url = textFrom(record.browser_download_url)
      // asset.url 是 API 形态（…/releases/assets/<id>），只认 api.github.com 的
      const apiUrl = textFrom(record.url)
      return name && url && name.toLowerCase().endsWith('.exe')
        ? {
          name,
          url,
          apiUrl: apiUrl && apiUrl.startsWith('https://api.github.com/') ? apiUrl : null,
          size: normalizeSize(record.size),
        }
        : null
    })
    .filter((asset): asset is { name: string; url: string; apiUrl: string | null; size: number | null } => asset !== null)
  const setup = exes.find(asset => asset.name.toLowerCase().includes('setup'))
  const portable = exes.find(asset => asset.name.toLowerCase().includes('portable'))
  return setup ?? portable ?? null
}

class UpdateSourceError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`更新源返回 ${status}`)
    this.status = status
  }
}

async function requestJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new UpdateSourceError(response.status)
  return response.json()
}

/** 自定义更新源：约定返回 { version, notes?, downloadUrl?, pageUrl?, publishedAt?, downloadSize? } */
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
    downloadApiUrl: nullableTextFrom(payload?.downloadApiUrl),
    downloadSize: normalizeSize(payload?.downloadSize),
    publishedAt: nullableTextFrom(payload?.publishedAt),
    source: 'custom',
  }
}

async function fetchGitHubApi(repo: string, token: string): Promise<ReleaseInfo> {
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
    downloadApiUrl: asset?.apiUrl ?? null,
    downloadName: asset?.name ?? null,
    downloadSize: asset?.size ?? null,
    publishedAt: nullableTextFrom(payload?.published_at),
    source: 'github',
  }
}

/** 从发布页的资产片段里取下载链接；不经过 API，不受匿名额度限制 */
function parseWebAssets(html: string): Array<Record<string, unknown>> {
  const seen = new Set<string>()
  const assets: Array<Record<string, unknown>> = []
  const pattern = /href="(\/[^"\s]*\/releases\/download\/[^"\s]+)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const href = match[1]
    if (!href) continue
    let name = ''
    try {
      name = decodeURIComponent(href.split('/').pop() || '')
    } catch {
      name = href.split('/').pop() || ''
    }
    if (!name || seen.has(name)) continue
    seen.add(name)
    assets.push({ name, browser_download_url: `https://github.com${href}`, size: null })
  }
  return assets
}

/** 发布页不给字节数，HEAD 一次拿 content-length；拿不到就留空，下载器自己会处理 */
async function headSize(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': `${USER_AGENT}/${currentVersion}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    return normalizeSize(response.headers.get('content-length'))
  } catch {
    return null
  }
}

/**
 * API 限流时的回退：GitHub 的匿名 API 每小时只有 60 次（按出口 IP 共用），
 * 而发布页与资产片段是普通网页，不受这个额度限制。
 * 302 的 Location 直接给出最新 tag；资产列表在 expanded_assets 片段里。
 */
async function fetchGitHubWeb(repo: string): Promise<ReleaseInfo> {
  const headers: Record<string, string> = {
    Accept: 'text/html,application/xhtml+xml',
    'User-Agent': `${USER_AGENT}/${currentVersion}`,
  }

  const latest = await fetch(`https://github.com/${repo}/releases/latest`, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const location = latest.headers.get('location') || ''
  let tag = /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1] || ''
  if (!tag && latest.ok) {
    const html = await latest.text()
    tag = /\/releases\/tag\/([^"?#/]+)/.exec(html)?.[1] || ''
  }
  tag = decodeURIComponent(tag)
  if (!tag) throw new Error('GitHub 发布页没有给出最新版本')

  const assetsResponse = await fetch(
    `https://github.com/${repo}/releases/expanded_assets/${encodeURIComponent(tag)}`,
    { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  )
  const assetsHtml = assetsResponse.ok ? await assetsResponse.text() : ''
  const asset = pickAsset(parseWebAssets(assetsHtml))
  if (!asset) throw new Error('GitHub 发布页没有找到安装包')

  return {
    version: normalizeVersion(tag),
    notes: '',
    pageUrl: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    downloadUrl: asset.url,
    downloadApiUrl: asset.apiUrl ?? null,
    downloadName: asset.name,
    downloadSize: asset.size ?? (await headSize(asset.url)),
    publishedAt: null,
    source: 'github',
  }
}

async function fetchGitHub(repo: string, token: string): Promise<ReleaseInfo> {
  try {
    return await fetchGitHubApi(repo, token)
  } catch (error) {
    // 403/429 是匿名 API 限流；网络层失败也值得换发布页再试一次
    const status = error instanceof UpdateSourceError ? error.status : 0
    const networkFailure =
      error instanceof TypeError ||
      (error instanceof Error && /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED/i.test(error.message))
    if (status !== 403 && status !== 429 && !networkFailure) throw error

    try {
      return await fetchGitHubWeb(repo)
    } catch {
      if (status === 403 || status === 429) {
        throw new Error('GitHub API 限流（匿名每小时 60 次），发布页回退也没有成功，请稍后重试')
      }
      throw error
    }
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
        downloadApiUrl: null,
        downloadName: null,
        downloadSize: null,
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
        downloadApiUrl: info.downloadApiUrl,
        downloadName: info.downloadName,
        downloadSize: info.downloadSize,
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
        downloadApiUrl: null,
        downloadName: null,
        downloadSize: null,
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
