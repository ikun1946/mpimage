/**
 * 账号导入解析：把后台粘贴的文本/JSON 统一成 ParsedAccountEntry。
 *
 * 兼容的常见格式：
 * - 每行一个 access_token（也支持 `email----token`、`email token`）
 * - 单条 JSON：{ access_token, refresh_token?, email?, plan?, type? }
 * - Codex CLI 的 auth.json：{ tokens: { access_token, refresh_token, id_token }, ... }
 * - 数组 / { accounts: [...] } / { tokens: [...] } / { access_tokens: [...] }
 * - JSONL：每行一个 JSON 对象
 *
 * 纯函数，不读写文件，方便单测。
 */
import { createHash } from 'node:crypto'
import {
  normalizePlan,
  type GptAccountSource,
  type GptPlan,
} from './account-types.js'

export interface ParsedAccountEntry {
  accessToken: string
  refreshToken: string
  idToken: string
  email: string
  label: string
  source: GptAccountSource
  plan: GptPlan
  expiresAt: number | null
}

export interface ImportParseResult {
  entries: ParsedAccountEntry[]
  invalid: Array<{ line: string; reason: string }>
}

export interface ImportParseOptions {
  /** 文本里没写类型时按哪种账号处理；默认 codex（当前唯一可用的通道） */
  defaultSource?: GptAccountSource
}

/** 后台辨认账号用的指纹，不可还原 token */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const normalized = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const parsed: unknown = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function pickString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function parseExpiresAt(value: unknown, jwtPayload: Record<string, unknown> | null): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 10 位数按秒，13 位数按毫秒
    return value < 100_000_000_000 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value.trim())
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber < 100_000_000_000 ? Math.round(asNumber * 1000) : Math.round(asNumber)
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  const exp = jwtPayload?.exp
  if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
    return Math.round(exp * 1000)
  }
  return null
}

function planFromJwt(payload: Record<string, unknown> | null): GptPlan {
  if (!payload) return 'unknown'
  const authClaim = asRecord(payload['https://api.openai.com/auth'])
  const plan =
    authClaim?.chatgpt_plan_type ??
    authClaim?.plan_type ??
    payload.chatgpt_plan_type ??
    payload.plan_type
  return normalizePlan(plan)
}

function emailFromJwt(payload: Record<string, unknown> | null): string {
  if (!payload) return ''
  const profileClaim = asRecord(payload['https://api.openai.com/profile'])
  const email = profileClaim?.email ?? payload.email
  return typeof email === 'string' ? email.trim() : ''
}

function sourceFromText(value: string): GptAccountSource | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'codex') return 'codex'
  if (normalized === 'web' || normalized === 'oauth' || normalized === 'oauth_login') return 'web'
  return null
}

/**
 * 把一条 JSON 对象转成账号；不是账号对象时返回 null。
 * `fromCodexAuthFile` 表示这是 Codex CLI 的 auth.json（tokens 是对象而不是数组）。
 */
function entryFromRecord(
  record: Record<string, unknown>,
  fallbackSource: GptAccountSource,
  fromCodexAuthFile = false,
): ParsedAccountEntry | null {
  const accessToken = pickString(record, [
    'access_token',
    'accessToken',
    'token',
    'bearer',
    'access_token_value',
  ])
  if (!accessToken) return null

  const payload = decodeJwtPayload(accessToken)
  const declaredSource = sourceFromText(
    pickString(record, ['type', 'source_type', 'sourceType', 'source', 'account_type']),
  )

  const plan = normalizePlan(
    pickString(record, ['plan', 'plan_type', 'planType', 'chatgpt_plan_type']) ||
      planFromJwt(payload),
  )
  const email =
    pickString(record, ['email', 'mail', 'account_email']) || emailFromJwt(payload)
  const label = pickString(record, ['label', 'name', 'remark', 'display_name']) || email

  return {
    accessToken,
    refreshToken: pickString(record, ['refresh_token', 'refreshToken']),
    idToken: pickString(record, ['id_token', 'idToken']),
    email,
    label: label || '',
    source: declaredSource ?? (fromCodexAuthFile ? 'codex' : fallbackSource),
    plan: plan === 'unknown' ? planFromJwt(payload) : plan,
    expiresAt: parseExpiresAt(
      record.expires_at ?? record.expiresAt ?? record.expired ?? record.exp,
      payload,
    ),
  }
}

function collectJson(value: unknown, fallbackSource: GptAccountSource, result: ImportParseResult): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJson(item, fallbackSource, result)
    return
  }

  const record = asRecord(value)
  if (!record) {
    if (typeof value === 'string' && looksLikeToken(value)) {
      const entry = entryFromRecord({ access_token: value.trim() }, fallbackSource)
      if (entry) result.entries.push(entry)
      else result.invalid.push({ line: value.slice(0, 40), reason: 'token 格式不正确' })
    }
    return
  }

  // Codex CLI auth.json：{ tokens: { access_token, ... } }
  const tokensValue = record.tokens
  const tokensRecord = asRecord(tokensValue)
  if (tokensRecord) {
    const merged: Record<string, unknown> = {
      ...tokensRecord,
      email: tokensRecord.email ?? record.email,
      label: tokensRecord.label ?? record.label,
      plan: tokensRecord.plan ?? record.plan ?? record.plan_type,
      expires_at: tokensRecord.expires_at ?? record.expires_at,
      type: tokensRecord.type ?? record.type,
    }
    const entry = entryFromRecord(merged, fallbackSource, true)
    if (entry) result.entries.push(entry)
    else result.invalid.push({ line: 'auth.json', reason: 'tokens 里没有 access_token' })
    return
  }

  if (Array.isArray(record.accounts)) {
    collectJson(record.accounts, fallbackSource, result)
    return
  }
  if (Array.isArray(record.tokens)) {
    collectJson(record.tokens, fallbackSource, result)
    return
  }
  if (Array.isArray(record.access_tokens)) {
    collectJson(record.access_tokens, fallbackSource, result)
    return
  }

  const entry = entryFromRecord(record, fallbackSource)
  if (entry) result.entries.push(entry)
  else result.invalid.push({ line: JSON.stringify(record).slice(0, 60), reason: '缺少 access_token' })
}

export function looksLikeToken(value: string): boolean {
  const token = value.trim()
  return token.length >= 20 && !/\s/.test(token)
}

function pushLine(
  line: string,
  fallbackSource: GptAccountSource,
  result: ImportParseResult,
): void {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return

  // email----token / email token
  const dashed = trimmed.split('----')
  if (dashed.length >= 2) {
    const token = dashed[dashed.length - 1]!.trim()
    const email = dashed[0]!.trim()
    if (looksLikeToken(token)) {
      const entry = entryFromRecord({ access_token: token, email }, fallbackSource)
      if (entry) {
        result.entries.push(entry)
        return
      }
    }
    result.invalid.push({ line: trimmed.slice(0, 40), reason: '无法识别这一行' })
    return
  }

  const parts = trimmed.split(/\s+/)
  if (parts.length === 2 && parts[0]!.includes('@') && looksLikeToken(parts[1]!)) {
    const entry = entryFromRecord(
      { access_token: parts[1]!, email: parts[0]! },
      fallbackSource,
    )
    if (entry) {
      result.entries.push(entry)
      return
    }
  }

  if (looksLikeToken(trimmed)) {
    const entry = entryFromRecord({ access_token: trimmed }, fallbackSource)
    if (entry) {
      result.entries.push(entry)
      return
    }
  }

  result.invalid.push({ line: trimmed.slice(0, 40), reason: '不是有效的 token 或 JSON' })
}

/** 同一份文本里重复的 token 只保留一条（后面的覆盖前面的元数据） */
function dedupe(entries: ParsedAccountEntry[]): ParsedAccountEntry[] {
  const byToken = new Map<string, ParsedAccountEntry>()
  for (const entry of entries) byToken.set(entry.accessToken, entry)
  return [...byToken.values()]
}

export function parseAccountImport(
  text: string,
  options: ImportParseOptions = {},
): ImportParseResult {
  const fallbackSource = options.defaultSource ?? 'codex'
  const result: ImportParseResult = { entries: [], invalid: [] }
  const source = String(text ?? '').replace(/^﻿/, '')
  const trimmed = source.trim()
  if (!trimmed) return result

  // 先按整段 JSON 解析；失败再按行处理（JSONL / 逐行 token）
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      collectJson(parsed, fallbackSource, result)
      result.entries = dedupe(result.entries)
      return result
    } catch {
      // 继续走按行解析
    }
  }

  for (const line of source.split(/\r?\n/)) {
    const trimmedLine = line.trim()
    if (!trimmedLine) continue
    if ((trimmedLine.startsWith('{') || trimmedLine.startsWith('[')) && trimmedLine.length > 2) {
      try {
        collectJson(JSON.parse(trimmedLine), fallbackSource, result)
        continue
      } catch {
        // 落到普通行解析，给出明确的无效原因
      }
    }
    pushLine(trimmedLine, fallbackSource, result)
  }

  result.entries = dedupe(result.entries)
  return result
}
