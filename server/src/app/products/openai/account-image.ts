/**
 * 把“账号池生图”适配成现有的 MagpieImageResult：
 * 模型解析 → 选账号 → 刷新令牌 → Codex 请求 → 失败换号重试。
 *
 * 对上层（api/images.ts）来说，它和 Magpie、自定义供应商没有区别：
 * 输入提示词/比例/参考图，输出 Buffer + token 估算。
 */
import { config } from '../../platform/config.js'
import { ApiError } from '../../platform/errors.js'
import {
  ACCOUNT_MODELS,
  type AccountModelSpec,
} from '../../control/accounts/account-types.js'
import type { GptAccountPool } from '../../control/accounts/account-pool.js'
import type { GptAccountStore } from '../../control/accounts/gpt-account-store.js'
import type { ReferenceImage, MagpieImageResult } from '../images/magpie.js'
import { ensureFreshAccount } from './chatgpt-auth.js'
import { CodexUpstreamError, requestCodexImage } from './chatgpt-codex.js'

export interface AccountImageDeps {
  store: GptAccountStore
  pool: GptAccountPool
}

export interface AccountImageParams {
  prompt: string
  ratioHint: string
  images: ReferenceImage[]
  timeoutMs: number
}

/** 只认 ACCOUNT_MODELS 里的 ID；其他一律返回 null，交给别的分支 */
export function resolveAccountModel(id: string): AccountModelSpec | null {
  return ACCOUNT_MODELS.find(spec => spec.id === id) ?? null
}

function mapUpstreamError(error: unknown): ApiError | null {
  if (!(error instanceof CodexUpstreamError)) return null
  switch (error.kind) {
    case 'policy':
      return new ApiError('CONTENT_POLICY', error.message || '内容未通过上游审核', 400)
    case 'timeout':
      return new ApiError('UPSTREAM_TIMEOUT', '生成超时，请稍后重试', 502)
    case 'bad-response':
      return new ApiError('UPSTREAM_BAD_RESPONSE', error.message || '上游没有返回可用图片', 502)
    default:
      return null
  }
}

export async function requestAccountImage(
  deps: AccountImageDeps,
  publicId: string,
  params: AccountImageParams,
): Promise<MagpieImageResult> {
  if (!config.gptAccounts.enabled) {
    throw new ApiError('MODEL_INVALID', '账号池生图已关闭', 400)
  }

  const spec = resolveAccountModel(publicId)
  if (!spec) {
    throw new ApiError('MODEL_INVALID', '这个生图模型当前不可用，请重新选择', 400)
  }
  if (!deps.store.availableModels().some(item => item.id === spec.id)) {
    throw new ApiError('ACCOUNT_POOL_EMPTY', '账号池里没有可用账号，请先在后台导入 GPT 账号', 503)
  }

  const maxAttempts = config.gptAccounts.maxAccountAttempts
  const exclude = new Set<string>()
  let lastError: unknown = null

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const lease = await deps.pool.acquire({
      filter: account =>
        account.source === 'codex' && (!spec.plans || spec.plans.includes(account.plan)),
      exclude,
      timeoutMs: config.gptAccounts.acquireTimeoutMs,
    })

    try {
      const account = await ensureFreshAccount(deps.store, lease.account)

      try {
        const result = await requestCodexImage({
          baseUrl: config.gptAccounts.baseUrl,
          accessToken: account.accessToken,
          prompt: params.prompt,
          ratioHint: params.ratioHint,
          images: params.images,
          timeoutMs: params.timeoutMs,
          codex: config.gptAccounts.codex,
        })
        deps.pool.markSuccess(account.id)
        return {
          buffer: result.buffer,
          model: publicId,
          tokens: result.tokens,
        }
      } catch (error) {
        lastError = error
        if (!(error instanceof CodexUpstreamError)) throw error

        const mapped = mapUpstreamError(error)
        if (mapped) throw mapped

        if (error.kind === 'auth') {
          deps.pool.markInvalid(account.id, error.message)
          exclude.add(account.id)
          continue
        }
        if (error.kind === 'rate') {
          deps.pool.markRateLimited(
            account.id,
            error.retryAfterMs ?? config.gptAccounts.cooldownMs.rateLimit,
            error.message,
          )
          exclude.add(account.id)
          continue
        }
        // server / network：短暂冷却后再换一个账号
        deps.pool.markServerError(
          account.id,
          error.message,
          config.gptAccounts.cooldownMs.server,
        )
        exclude.add(account.id)
      }
    } finally {
      lease.release()
    }
  }

  if (lastError instanceof CodexUpstreamError) {
    const mapped = mapUpstreamError(lastError)
    if (mapped) throw mapped
    throw new ApiError('UPSTREAM_ERROR', lastError.message || '账号生图失败', 502)
  }
  throw new ApiError('ACCOUNT_BUSY', '账号池试了几个账号都没成功，请稍后重试', 503)
}
