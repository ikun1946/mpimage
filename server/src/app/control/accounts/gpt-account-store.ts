/**
 * GPT 账号库：导入、去重、状态与脱敏都在这里。
 *
 * 文件里含 access_token / refresh_token，必须只落在服务端数据目录：
 * 默认 <项目根>/gpt-accounts.json，写入 0600（Windows 上由 ACL 兜底），
 * 原子替换避免半截文件；后台接口只返回脱敏视图。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  ACCOUNT_MODELS,
  normalizePlan,
  type AccountModelSpec,
  type GptAccountPublic,
  type GptAccountRecord,
  type GptAccountStatus,
  type GptPlan,
  type GptAccountSource,
} from './account-types.js'
import {
  decodeJwtPayload,
  parseAccountImport,
  tokenFingerprint,
  type ImportParseOptions,
  type ParsedAccountEntry,
} from './import-parser.js'

const FILE_VERSION = 1

interface StoreFile {
  version?: unknown
  accounts?: unknown
}

export interface ImportResult {
  imported: number
  updated: number
  skipped: number
  invalid: Array<{ line: string; reason: string }>
  accounts: GptAccountPublic[]
}

export interface GptAccountStoreOptions {
  defaultMaxConcurrency: number
  maxAccountsPerImport: number
  /** 总开关：关闭时不向客户端暴露任何账号模型，但后台仍可管理账号 */
  enabled?: () => boolean
}

const STATUSES: GptAccountStatus[] = ['unchecked', 'active', 'limited', 'invalid', 'disabled']
const SOURCES: GptAccountSource[] = ['codex', 'web']

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** 报错里可能带 token：统一截断并抹掉长串 base64/密钥 */
export function sanitizeAccountError(message: unknown): string {
  const text = message instanceof Error ? message.message : String(message ?? '')
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '***')
    .slice(0, 500)
}

export class GptAccountStore {
  private readonly file: string
  private readonly options: GptAccountStoreOptions
  private readonly accounts = new Map<string, GptAccountRecord>()
  private writeQueue: Promise<void> = Promise.resolve()
  private saveTimer: NodeJS.Timeout | null = null

  constructor(file: string, options: GptAccountStoreOptions) {
    this.file = file
    this.options = options
  }

  async init(): Promise<void> {
    this.accounts.clear()
    let raw = ''
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return
    }

    let parsed: StoreFile
    try {
      parsed = JSON.parse(raw) as StoreFile
    } catch {
      // 文件损坏时从空库启动，保留原文件供人工排查
      return
    }
    if (!parsed || !Array.isArray(parsed.accounts)) return

    for (const item of parsed.accounts) {
      const record = this.normalizeRecord(item)
      if (record) this.accounts.set(record.id, record)
    }
  }

  private normalizeRecord(value: unknown): GptAccountRecord | null {
    if (!value || typeof value !== 'object') return null
    const source = value as Record<string, unknown>
    const accessToken = asString(source.accessToken).trim()
    if (!accessToken) return null

    const id = asString(source.id).trim() || `gpt_${tokenFingerprint(accessToken).slice(0, 12)}`
    const status = STATUSES.includes(source.status as GptAccountStatus)
      ? (source.status as GptAccountStatus)
      : 'unchecked'
    const accountSource = SOURCES.includes(source.source as GptAccountSource)
      ? (source.source as GptAccountSource)
      : 'codex'
    const maxConcurrencyRaw = Number(source.maxConcurrency)
    const maxConcurrency = Number.isFinite(maxConcurrencyRaw) && maxConcurrencyRaw > 0
      ? Math.min(10, Math.max(1, Math.round(maxConcurrencyRaw)))
      : this.options.defaultMaxConcurrency

    const now = Date.now()
    return {
      id,
      label: asString(source.label).slice(0, 80),
      email: asString(source.email).slice(0, 160),
      accessToken,
      refreshToken: asString(source.refreshToken),
      idToken: asString(source.idToken),
      source: accountSource,
      plan: normalizePlan(source.plan),
      status,
      enabled: source.enabled !== false,
      expiresAt: asTimestamp(source.expiresAt),
      maxConcurrency,
      cooldownUntil: asTimestamp(source.cooldownUntil),
      lastError: typeof source.lastError === 'string' ? source.lastError.slice(0, 500) : null,
      lastErrorAt: asTimestamp(source.lastErrorAt),
      lastUsedAt: asTimestamp(source.lastUsedAt),
      lastCheckedAt: asTimestamp(source.lastCheckedAt),
      lastRefreshAt: asTimestamp(source.lastRefreshAt),
      createdAt: asTimestamp(source.createdAt) ?? now,
      updatedAt: asTimestamp(source.updatedAt) ?? now,
    }
  }

  list(): GptAccountRecord[] {
    return [...this.accounts.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): GptAccountRecord | undefined {
    return this.accounts.get(id)
  }

  /** 脱敏视图：不含任何 token */
  toPublic(record: GptAccountRecord): GptAccountPublic {
    return {
      id: record.id,
      label: record.label,
      email: record.email,
      source: record.source,
      plan: record.plan,
      status: record.status,
      enabled: record.enabled,
      expiresAt: record.expiresAt,
      maxConcurrency: record.maxConcurrency,
      cooldownUntil: record.cooldownUntil,
      lastError: record.lastError,
      lastErrorAt: record.lastErrorAt,
      lastUsedAt: record.lastUsedAt,
      lastCheckedAt: record.lastCheckedAt,
      lastRefreshAt: record.lastRefreshAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      tokenPreview: `sha256:${tokenFingerprint(record.accessToken).slice(0, 8)}`,
      hasRefreshToken: Boolean(record.refreshToken),
      inflight: 0,
    }
  }

  listPublic(): GptAccountPublic[] {
    return this.list().map(record => this.toPublic(record))
  }

  /** 可用账号：启用、未被判无效、不在冷却中 */
  listUsable(now = Date.now()): GptAccountRecord[] {
    return this.list().filter(
      account =>
        account.enabled &&
        account.status !== 'disabled' &&
        account.status !== 'invalid' &&
        (account.cooldownUntil === null || account.cooldownUntil <= now),
    )
  }

  /**
   * 当前对客户端暴露的账号模型。
   * 只有存在可用的 Codex 账号时才出现；套餐模型再按 plan 过滤。
   */
  availableModels(now = Date.now()): AccountModelSpec[] {
    if (this.options.enabled && !this.options.enabled()) return []
    const usable = this.listUsable(now).filter(account => account.source === 'codex')
    if (!usable.length) return []
    return ACCOUNT_MODELS.filter(spec => {
      if (!spec.plans) return true
      return usable.some(account => spec.plans!.includes(account.plan))
    })
  }

  countForModel(spec: AccountModelSpec, now = Date.now()): number {
    return this.listUsable(now).filter(
      account =>
        account.source === 'codex' &&
        (!spec.plans || spec.plans.includes(account.plan)),
    ).length
  }

  hasModel(id: string, now = Date.now()): boolean {
    return this.availableModels(now).some(spec => spec.id === id)
  }

  private entryToRecord(entry: ParsedAccountEntry): GptAccountRecord {
    const now = Date.now()
    return {
      id: `gpt_${tokenFingerprint(entry.accessToken).slice(0, 12)}`,
      label: entry.label || entry.email || '',
      email: entry.email,
      accessToken: entry.accessToken,
      refreshToken: entry.refreshToken,
      idToken: entry.idToken,
      source: entry.source,
      plan: entry.plan,
      status: 'unchecked',
      enabled: true,
      expiresAt: entry.expiresAt,
      maxConcurrency: this.options.defaultMaxConcurrency,
      cooldownUntil: null,
      lastError: null,
      lastErrorAt: null,
      lastUsedAt: null,
      lastCheckedAt: null,
      lastRefreshAt: null,
      createdAt: now,
      updatedAt: now,
    }
  }

  private applyEntry(record: GptAccountRecord, entry: ParsedAccountEntry): boolean {
    let changed = false
    const set = <K extends keyof GptAccountRecord>(key: K, value: GptAccountRecord[K]) => {
      if (record[key] !== value) {
        record[key] = value
        changed = true
      }
    }
    set('accessToken', entry.accessToken)
    if (entry.refreshToken) set('refreshToken', entry.refreshToken)
    if (entry.idToken) set('idToken', entry.idToken)
    if (entry.email) set('email', entry.email)
    if (entry.label) set('label', entry.label)
    set('source', entry.source)
    if (entry.plan !== 'unknown') set('plan', entry.plan)
    set('expiresAt', entry.expiresAt ?? record.expiresAt)
    if (changed) {
      set('status', 'unchecked')
      set('cooldownUntil', null)
      set('lastError', null)
      set('lastErrorAt', null)
      set('updatedAt', Date.now())
    }
    return changed
  }

  /** 已经解析好的账号直接入库：文本导入与远程导入共用 */
  async importParsed(
    parsedEntries: ParsedAccountEntry[],
    parsedInvalid: Array<{ line: string; reason: string }> = [],
  ): Promise<ImportResult> {
    let entries = parsedEntries
    const invalid = [...parsedInvalid]
    if (entries.length > this.options.maxAccountsPerImport) {
      const dropped = entries.length - this.options.maxAccountsPerImport
      entries = entries.slice(0, this.options.maxAccountsPerImport)
      invalid.push({
        line: '(批量导入)',
        reason: `一次最多导入 ${this.options.maxAccountsPerImport} 个账号，已忽略 ${dropped} 个`,
      })
    }

    let imported = 0
    let updated = 0
    let skipped = 0

    for (const entry of entries) {
      const id = `gpt_${tokenFingerprint(entry.accessToken).slice(0, 12)}`
      const existing = this.accounts.get(id)
      if (!existing) {
        this.accounts.set(id, this.entryToRecord(entry))
        imported += 1
        continue
      }
      if (this.applyEntry(existing, entry)) updated += 1
      else skipped += 1
    }

    if (imported || updated) await this.save()
    return {
      imported,
      updated,
      skipped,
      invalid,
      accounts: this.listPublic(),
    }
  }

  async importText(
    text: string,
    options: ImportParseOptions = {},
  ): Promise<ImportResult> {
    const parsed = parseAccountImport(text, options)
    return this.importParsed(parsed.entries, parsed.invalid)
  }

  /** 后台可改的字段：显示名、启用状态、并发上限 */
  async updateSettings(
    id: string,
    patch: { label?: string; enabled?: boolean; maxConcurrency?: number },
  ): Promise<GptAccountPublic | null> {
    const record = this.accounts.get(id)
    if (!record) return null

    if (typeof patch.label === 'string') record.label = patch.label.trim().slice(0, 80)
    if (typeof patch.enabled === 'boolean') {
      record.enabled = patch.enabled
      record.status = patch.enabled ? (record.status === 'disabled' ? 'unchecked' : record.status) : 'disabled'
    }
    if (typeof patch.maxConcurrency === 'number' && Number.isFinite(patch.maxConcurrency)) {
      record.maxConcurrency = Math.min(10, Math.max(1, Math.round(patch.maxConcurrency)))
    }
    record.updatedAt = Date.now()
    await this.save()
    return this.toPublic(record)
  }

  async remove(ids: string[]): Promise<number> {
    let removed = 0
    for (const id of ids) {
      if (this.accounts.delete(id)) removed += 1
    }
    if (removed) await this.save()
    return removed
  }

  async clearCooldown(ids: string[]): Promise<number> {
    let cleared = 0
    for (const id of ids) {
      const record = this.accounts.get(id)
      if (!record) continue
      if (record.cooldownUntil !== null) {
        record.cooldownUntil = null
        record.updatedAt = Date.now()
        cleared += 1
      }
      if (record.status === 'limited') {
        record.status = 'active'
        record.updatedAt = Date.now()
      }
    }
    if (cleared) await this.save()
    return cleared
  }

  /** 账号池在请求前后更新状态；不等待落盘，短时间多次更新合并成一次写 */
  touch(
    id: string,
    patch: Partial<Pick<
      GptAccountRecord,
      | 'status'
      | 'cooldownUntil'
      | 'lastError'
      | 'lastErrorAt'
      | 'lastUsedAt'
      | 'lastCheckedAt'
      | 'lastRefreshAt'
      | 'accessToken'
      | 'refreshToken'
      | 'idToken'
      | 'expiresAt'
      | 'plan'
      | 'email'
    >>,
  ): GptAccountRecord | null {
    const record = this.accounts.get(id)
    if (!record) return null
    Object.assign(record, patch)
    record.updatedAt = Date.now()
    this.scheduleSave()
    return record
  }

  /** 同步 token 变化后立即落盘（刷新令牌时用） */
  async touchAndSave(id: string, patch: Parameters<GptAccountStore['touch']>[1]): Promise<GptAccountRecord | null> {
    const record = this.touch(id, patch)
    if (record) await this.save()
    return record
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, 800)
    this.saveTimer.unref?.()
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.save()
  }

  private async save(): Promise<void> {
    const snapshot = JSON.stringify(
      {
        version: FILE_VERSION,
        accounts: this.list(),
      },
      null,
      2,
    )
    const file = this.file
    const task = this.writeQueue.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, file)
    })
    this.writeQueue = task.catch(() => undefined)
    await task
  }
}

/** 从 token 里解出账号标识/邮箱/套餐，供“测试账号”接口补齐展示 */
export function describeAccountToken(token: string): {
  email: string
  plan: GptPlan
  expiresAt: number | null
} {
  const payload = decodeJwtPayload(token)
  const profile = payload?.['https://api.openai.com/profile']
  const auth = payload?.['https://api.openai.com/auth']
  const profileRecord =
    profile && typeof profile === 'object' ? (profile as Record<string, unknown>) : null
  const authRecord = auth && typeof auth === 'object' ? (auth as Record<string, unknown>) : null
  const email = typeof profileRecord?.email === 'string'
    ? profileRecord.email
    : typeof payload?.email === 'string'
      ? payload.email
      : ''
  const plan = normalizePlan(
    authRecord?.chatgpt_plan_type ?? payload?.chatgpt_plan_type ?? payload?.plan_type,
  )
  const exp = typeof payload?.exp === 'number' ? Math.round(payload.exp * 1000) : null
  return { email, plan, expiresAt: exp }
}
