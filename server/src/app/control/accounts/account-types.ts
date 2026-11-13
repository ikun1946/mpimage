/**
 * GPT 账号池的数据模型。
 *
 * 账号来自“导入 access_token”：默认只启用 Codex 通道，
 * 也就是 ChatGPT 桌面端/Codex CLI 使用的那套 /backend-api/codex/responses。
 * Web 账号可以导入并保存，但在补齐 Sentinel/PoW 之前不对外暴露模型。
 */

export type GptAccountStatus = 'unchecked' | 'active' | 'limited' | 'invalid' | 'disabled'

export type GptAccountSource = 'codex' | 'web'

export type GptPlan = 'free' | 'plus' | 'pro' | 'prolite' | 'team' | 'enterprise' | 'unknown'

export interface GptAccountRecord {
  id: string
  label: string
  email: string
  accessToken: string
  refreshToken: string
  idToken: string
  source: GptAccountSource
  plan: GptPlan
  status: GptAccountStatus
  enabled: boolean
  /** access_token 的过期时间（epoch ms）；解不出 exp 时为 null */
  expiresAt: number | null
  /** 该账号的并发上限，默认取全局配置 */
  maxConcurrency: number
  /** 冷却到什么时候（epoch ms），期间不参与调度 */
  cooldownUntil: number | null
  /** 最近一次失败原因（已经截断并脱敏，不含 token） */
  lastError: string | null
  lastErrorAt: number | null
  lastUsedAt: number | null
  lastCheckedAt: number | null
  lastRefreshAt: number | null
  createdAt: number
  updatedAt: number
}

/** 回给后台的脱敏视图：绝不包含 access_token / refresh_token */
export interface GptAccountPublic {
  id: string
  label: string
  email: string
  source: GptAccountSource
  plan: GptPlan
  status: GptAccountStatus
  enabled: boolean
  expiresAt: number | null
  maxConcurrency: number
  cooldownUntil: number | null
  lastError: string | null
  lastErrorAt: number | null
  lastUsedAt: number | null
  lastCheckedAt: number | null
  lastRefreshAt: number | null
  createdAt: number
  updatedAt: number
  /** token 指纹（sha256 前 8 位），只用于后台辨认，不能还原 token */
  tokenPreview: string
  hasRefreshToken: boolean
  /** 当前在途请求数，由账号池补充 */
  inflight: number
}

/** 客户端可见的账号模型 */
export interface AccountModelSpec {
  id: string
  label: string
  /** 需要的套餐；null 表示不限 */
  plans: GptPlan[] | null
}

/**
 * 只暴露 Codex 通道。模型 ID 用 g: 前缀，与自定义供应商的 p: 前缀互不冲突。
 * 套餐限定模型让管理员能把 Plus/Pro 账号分开给不同的人用。
 */
export const ACCOUNT_MODELS: AccountModelSpec[] = [
  { id: 'g:codex-gpt-image-2', label: 'Codex 生图 · 账号池', plans: null },
  { id: 'g:plus-codex-gpt-image-2', label: 'Codex 生图 · Plus', plans: ['plus'] },
  { id: 'g:team-codex-gpt-image-2', label: 'Codex 生图 · Team', plans: ['team', 'enterprise'] },
  { id: 'g:pro-codex-gpt-image-2', label: 'Codex 生图 · Pro', plans: ['pro', 'prolite'] },
]

const PLAN_ALIASES: Record<string, GptPlan> = {
  free: 'free',
  plus: 'plus',
  pro: 'pro',
  prolite: 'prolite',
  'pro-lite': 'prolite',
  pro_lite: 'prolite',
  team: 'team',
  business: 'team',
  enterprise: 'enterprise',
  edu: 'team',
}

export function normalizePlan(raw: unknown): GptPlan {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return PLAN_ALIASES[value] ?? 'unknown'
}
