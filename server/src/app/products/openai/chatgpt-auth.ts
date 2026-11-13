/**
 * GPT 账号的令牌生命周期：
 * - access_token 快过期时用 refresh_token 换新（同一账号严格单飞）
 * - 后台“测试账号”用 /backend-api/me 校验并补齐邮箱/套餐
 *
 * 刷新失败不直接把账号判死：网络抖动只记 lastError，
 * 只有上游明确返回 invalid_grant（400/401）才标记 invalid。
 */
import { config } from '../../platform/config.js'
import { sanitizeAccountError, describeAccountToken } from '../../control/accounts/gpt-account-store.js'
import type { GptAccountRecord } from '../../control/accounts/account-types.js'
import type { GptAccountStore } from '../../control/accounts/gpt-account-store.js'

const refreshInFlight = new Map<string, Promise<GptAccountRecord>>()

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  id_token?: unknown
  expires_in?: unknown
  error?: unknown
  error_description?: unknown
}

export interface RefreshOptions {
  oauthTokenUrl: string
  oauthClientId: string
  refreshSkewMs: number
}

function currentConfig(): RefreshOptions {
  return {
    oauthTokenUrl: config.gptAccounts.oauthTokenUrl,
    oauthClientId: config.gptAccounts.oauthClientId,
    refreshSkewMs: config.gptAccounts.refreshSkewMs,
  }
}

function needsRefresh(account: GptAccountRecord, skewMs: number): boolean {
  if (!account.refreshToken) return false
  if (account.expiresAt === null) return false
  return account.expiresAt - Date.now() <= skewMs
}

async function refreshOnce(
  store: GptAccountStore,
  accountId: string,
  options: RefreshOptions,
): Promise<GptAccountRecord> {
  const account = store.get(accountId)
  if (!account) throw new Error('账号已删除')
  if (!needsRefresh(account, options.refreshSkewMs)) return account

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
    client_id: options.oauthClientId,
  })

  let response: Response
  try {
    response = await fetch(options.oauthTokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    store.touch(accountId, {
      lastError: sanitizeAccountError(`刷新令牌失败：${(error as Error).message}`),
      lastErrorAt: Date.now(),
    })
    return account
  }

  const text = await response.text().catch(() => '')
  let payload: TokenResponse | null = null
  try {
    payload = text ? (JSON.parse(text) as TokenResponse) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    const detail =
      (typeof payload?.error_description === 'string' && payload.error_description) ||
      (typeof payload?.error === 'string' && payload.error) ||
      `HTTP ${response.status}`
    const fatal = response.status === 400 || response.status === 401
    const updated = store.touch(accountId, {
      ...(fatal ? { status: 'invalid' as const } : {}),
      lastError: sanitizeAccountError(`刷新令牌失败：${detail}`),
      lastErrorAt: Date.now(),
    })
    return updated ?? account
  }

  const accessToken =
    typeof payload?.access_token === 'string' ? payload.access_token.trim() : ''
  if (!accessToken) {
    const updated = store.touch(accountId, {
      lastError: '刷新令牌失败：上游没有返回 access_token',
      lastErrorAt: Date.now(),
    })
    return updated ?? account
  }

  const expiresIn = Number(payload?.expires_in)
  const now = Date.now()
  const described = describeAccountToken(accessToken)
  const updated = await store.touchAndSave(accountId, {
    accessToken,
    refreshToken:
      typeof payload?.refresh_token === 'string' && payload.refresh_token.trim()
        ? payload.refresh_token.trim()
        : account.refreshToken,
    idToken:
      typeof payload?.id_token === 'string' && payload.id_token.trim()
        ? payload.id_token.trim()
        : account.idToken,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? now + Math.round(expiresIn * 1000)
        : described.expiresAt,
    plan: described.plan !== 'unknown' ? described.plan : account.plan,
    email: account.email || described.email,
    status: 'active',
    lastRefreshAt: now,
    lastError: null,
    lastErrorAt: null,
  })
  return updated ?? account
}

/** 令牌快过期时刷新；同一账号的并发请求只发一次刷新 */
export async function ensureFreshAccount(
  store: GptAccountStore,
  account: GptAccountRecord,
  options: RefreshOptions = currentConfig(),
): Promise<GptAccountRecord> {
  if (!needsRefresh(account, options.refreshSkewMs)) return account

  const key = account.id
  const existing = refreshInFlight.get(key)
  if (existing) return existing

  const task = refreshOnce(store, account.id, options).finally(() => {
    refreshInFlight.delete(key)
  })
  refreshInFlight.set(key, task)
  return task
}

export interface ValidateResult {
  ok: boolean
  message: string
  email?: string
}

/** 用 /backend-api/me 校验账号；只改展示信息与状态，不抛异常 */
export async function validateAccount(
  store: GptAccountStore,
  account: GptAccountRecord,
  baseUrl = config.gptAccounts.baseUrl,
): Promise<ValidateResult> {
  let fresh: GptAccountRecord
  try {
    fresh = await ensureFreshAccount(store, account)
  } catch (error) {
    return { ok: false, message: sanitizeAccountError(error) }
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl}/backend-api/me`, {
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(12_000),
    })
  } catch (error) {
    const name = (error as Error).name
    const message = name === 'TimeoutError' ? '校验超时' : '无法连接 ChatGPT'
    store.touch(fresh.id, { lastError: message, lastErrorAt: Date.now() })
    return { ok: false, message }
  }

  if (response.status === 401 || response.status === 403) {
    store.touch(fresh.id, {
      status: 'invalid',
      lastError: `账号已失效（HTTP ${response.status}）`,
      lastErrorAt: Date.now(),
      lastCheckedAt: Date.now(),
    })
    return { ok: false, message: `账号已失效（HTTP ${response.status}）` }
  }

  if (!response.ok) {
    const message = `上游返回 HTTP ${response.status}`
    store.touch(fresh.id, { lastError: message, lastErrorAt: Date.now() })
    return { ok: false, message }
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  const described = describeAccountToken(fresh.accessToken)
  const email =
    (typeof payload?.email === 'string' && payload.email) || fresh.email || described.email
  const planRaw =
    payload?.plan_type ?? payload?.chatgpt_plan_type ?? (payload?.account as Record<string, unknown>)?.plan_type
  const plan = typeof planRaw === 'string' ? normalizePlanValue(planRaw) : described.plan
  const now = Date.now()
  store.touch(fresh.id, {
    status: 'active',
    email,
    plan: plan,
    lastCheckedAt: now,
    lastError: null,
    lastErrorAt: null,
  })
  await store.flush()
  return { ok: true, message: '账号可用', email }
}

function normalizePlanValue(raw: string) {
  const value = raw.trim().toLowerCase()
  if (value === 'plus') return 'plus' as const
  if (value === 'pro') return 'pro' as const
  if (value === 'prolite' || value === 'pro_lite' || value === 'pro-lite') return 'prolite' as const
  if (value === 'team' || value === 'business' || value === 'edu') return 'team' as const
  if (value === 'enterprise') return 'enterprise' as const
  if (value === 'free') return 'free' as const
  return 'unknown' as const
}
