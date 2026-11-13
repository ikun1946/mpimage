/**
 * 账号来源适配：从远程 CLIProxyAPI（CPA）读取 auth 文件并解析成账号。
 *
 * CPA 的管理接口：
 * - GET {base}/v0/management/auth-files            → { files: [{ name, email }] }
 * - GET {base}/v0/management/auth-files/download   → 单个 auth JSON（?name=）
 * 认证：Authorization: Bearer <secret_key>
 *
 * 这里只负责协议与解析，入库由 GptAccountStore.importParsed 完成。
 */
import { ApiError } from '../../platform/errors.js'
import {
  parseAccountImport,
  type ParsedAccountEntry,
} from '../../control/accounts/import-parser.js'

const FETCH_TIMEOUT_MS = 30_000
const MAX_FILES = 50

export interface CpaRemoteFile {
  name: string
  email: string
}

export interface RemoteImportResult {
  entries: ParsedAccountEntry[]
  failures: Array<{ name: string; message: string }>
}

/** 远程地址必须是 http/https，且不允许带账号密码 */
export function normalizeRemoteBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiError('UPSTREAM_INVALID', '请填写服务器地址', 400)
  }
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ApiError('UPSTREAM_INVALID', '服务器地址必须是完整的 http/https 地址', 400)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError('UPSTREAM_INVALID', '服务器地址只支持 http 或 https', 400)
  }
  if (url.username || url.password) {
    throw new ApiError('UPSTREAM_INVALID', '服务器地址不能包含账号密码', 400)
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function requireSecret(raw: unknown, label: string): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) throw new ApiError('UPSTREAM_INVALID', `请填写${label}`, 400)
  if (value.length > 500) throw new ApiError('UPSTREAM_INVALID', `${label}过长`, 400)
  return value
}

function headers(secretKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${secretKey}`,
    Accept: 'application/json',
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
  failureLabel: string,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (error) {
    const name = (error as Error).name
    throw new ApiError(
      'UPSTREAM_UNREACHABLE',
      name === 'TimeoutError'
        ? `${failureLabel}超时，请检查服务器地址与网络`
        : `${failureLabel}失败：${(error as Error).message}`,
      502,
    )
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new ApiError(
      'UPSTREAM_ERROR',
      `${failureLabel}失败（HTTP ${response.status}）${text ? `：${text.slice(0, 160)}` : ''}`,
      502,
    )
  }

  try {
    return (await response.json()) as unknown
  } catch {
    throw new ApiError('UPSTREAM_BAD_RESPONSE', `${failureLabel}返回了无法解析的内容`, 502)
  }
}

/** 列出 CPA 服务器上的 auth 文件 */
export async function listCpaFiles(baseUrlRaw: unknown, secretKeyRaw: unknown): Promise<CpaRemoteFile[]> {
  const baseUrl = normalizeRemoteBaseUrl(baseUrlRaw)
  const secretKey = requireSecret(secretKeyRaw, '密钥')

  const payload = await fetchJson(
    `${baseUrl}/v0/management/auth-files`,
    { headers: headers(secretKey) },
    '读取远程账号列表',
  )

  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  const files = Array.isArray(record?.files) ? record.files : []
  const seen = new Set<string>()
  const items: CpaRemoteFile[] = []

  for (const value of files) {
    if (!value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!name || seen.has(name) || name.length > 200) continue
    seen.add(name)
    const email =
      typeof item.email === 'string'
        ? item.email.trim()
        : typeof item.account === 'string'
          ? item.account.trim()
          : ''
    items.push({ name, email })
  }

  return items
}

/** 下载并解析选中的 auth 文件；单个文件失败不影响其它文件 */
export async function fetchCpaEntries(
  baseUrlRaw: unknown,
  secretKeyRaw: unknown,
  namesRaw: unknown,
): Promise<RemoteImportResult> {
  const baseUrl = normalizeRemoteBaseUrl(baseUrlRaw)
  const secretKey = requireSecret(secretKeyRaw, '密钥')
  if (!Array.isArray(namesRaw)) {
    throw new ApiError('UPSTREAM_INVALID', '请先选择要导入的文件', 400)
  }

  const names = [...new Set(
    namesRaw
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map(item => item.trim()),
  )].slice(0, MAX_FILES)
  if (!names.length) {
    throw new ApiError('UPSTREAM_INVALID', '请先选择要导入的文件', 400)
  }

  const entries: ParsedAccountEntry[] = []
  const failures: Array<{ name: string; message: string }> = []

  for (const name of names) {
    try {
      const url = `${baseUrl}/v0/management/auth-files/download?name=${encodeURIComponent(name)}`
      const payload = await fetchJson(url, { headers: headers(secretKey) }, '下载账号文件')
      const parsed = parseAccountImport(JSON.stringify(payload), { defaultSource: 'codex' })
      if (!parsed.entries.length) {
        failures.push({
          name,
          message: parsed.invalid[0]?.reason || '文件里没有可用的 access_token',
        })
        continue
      }
      entries.push(...parsed.entries)
    } catch (error) {
      failures.push({
        name,
        message: error instanceof ApiError ? error.message : (error as Error).message,
      })
    }
  }

  return { entries, failures }
}
