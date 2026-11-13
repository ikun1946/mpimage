/**
 * 账号调度：轮询选择、排除集、每账号并发上限与冷却。
 *
 * 只在进程内计数，和现有生图闸门一致；多进程部署需要外部租约存储（暂不支持）。
 */
import { ApiError } from '../../platform/errors.js'
import type { GptAccountRecord } from './account-types.js'
import type { GptAccountStore } from './gpt-account-store.js'
import { sanitizeAccountError } from './gpt-account-store.js'

export interface AcquireOptions {
  /** 额外过滤，例如套餐限定模型只挑 Plus 账号 */
  filter?: (account: GptAccountRecord) => boolean
  /** 本次请求里已经失败过的账号，不再重复选 */
  exclude?: Set<string>
  timeoutMs: number
}

export interface AccountLease {
  accountId: string
  account: GptAccountRecord
  release(): void
}

const RETRY_INTERVAL_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class GptAccountPool {
  private readonly inflight = new Map<string, number>()
  private cursor = 0

  constructor(private readonly store: GptAccountStore) {}

  countFor(accountId: string): number {
    return this.inflight.get(accountId) ?? 0
  }

  /** 后台列表用：一次拿到全部账号的在途数 */
  snapshotInflight(): Map<string, number> {
    return new Map(this.inflight)
  }

  async acquire(options: AcquireOptions): Promise<AccountLease> {
    const deadline = Date.now() + Math.max(1000, options.timeoutMs)

    while (true) {
      const accounts = this.store.listUsable()
      if (accounts.length) {
        for (let step = 0; step < accounts.length; step += 1) {
          const index = (this.cursor + step) % accounts.length
          const account = accounts[index]!
          if (options.exclude?.has(account.id)) continue
          if (options.filter && !options.filter(account)) continue
          if (this.countFor(account.id) >= account.maxConcurrency) continue

          this.inflight.set(account.id, this.countFor(account.id) + 1)
          this.cursor = (index + 1) % accounts.length
          let released = false

          return {
            accountId: account.id,
            account,
            release: () => {
              if (released) return
              released = true
              const left = this.countFor(account.id) - 1
              if (left > 0) this.inflight.set(account.id, left)
              else this.inflight.delete(account.id)
            },
          }
        }
      }

      if (Date.now() >= deadline) {
        throw new ApiError(
          'ACCOUNT_BUSY',
          '账号池忙（没有空闲账号），请稍后重试或增加账号',
          503,
        )
      }
      await sleep(RETRY_INTERVAL_MS)
    }
  }

  markSuccess(accountId: string): void {
    this.store.touch(accountId, {
      status: 'active',
      lastUsedAt: Date.now(),
      lastError: null,
      lastErrorAt: null,
    })
  }

  markRateLimited(accountId: string, cooldownMs: number, message: string): void {
    const now = Date.now()
    this.store.touch(accountId, {
      status: 'limited',
      cooldownUntil: now + Math.max(1000, cooldownMs),
      lastError: sanitizeAccountError(message),
      lastErrorAt: now,
    })
  }

  markInvalid(accountId: string, message: string): void {
    const now = Date.now()
    this.store.touch(accountId, {
      status: 'invalid',
      lastError: sanitizeAccountError(message),
      lastErrorAt: now,
    })
  }

  markServerError(accountId: string, message: string, cooldownMs: number): void {
    const now = Date.now()
    this.store.touch(accountId, {
      cooldownUntil: now + Math.max(1000, cooldownMs),
      lastError: sanitizeAccountError(message),
      lastErrorAt: now,
    })
  }

  markTransportBlocked(accountId: string, cooldownMs: number, message: string): void {
    const now = Date.now()
    this.store.touch(accountId, {
      status: 'limited',
      cooldownUntil: now + Math.max(1000, cooldownMs),
      lastError: sanitizeAccountError(message),
      lastErrorAt: now,
    })
  }
}
