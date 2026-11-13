import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { config, findImageModel, findRatio } from '../app/platform/config.js'
import { ApiError } from '../app/platform/errors.js'
import type { SerialGate } from '../app/platform/serial-gate.js'
import { auditFailure, auditLog } from '../app/platform/audit.js'
import { buildFileUrl } from '../utils/url.js'
import { requestImage, requestImageEdit } from '../app/products/images/magpie.js'
import { listClientImageModels, resolveCustomProviderModel } from '../app/control/client-models.js'
import { requestAccountImage, resolveAccountModel } from '../app/products/openai/account-image.js'
import type { GptAccountPool } from '../app/control/accounts/account-pool.js'
import type { GptAccountStore } from '../app/control/accounts/gpt-account-store.js'
import { detectImageType, readImageSize } from '../app/products/images/imaging.js'
import { generateImageTitle } from '../app/products/images/image-title.js'
import { MAX_REFERENCE_IMAGES, loadReferenceImages } from '../app/products/images/reference-images.js'
import { REFERENCE_CATEGORY, type ImageStorage } from '../services/storage.js'
import type { QuotaStore } from '../app/control/quota-store.js'
import type { SettingsStore } from '../app/control/settings-store.js'
import type { UsageStore } from '../services/usage-store.js'
import { requireAuth } from './auth.js'
import { isLoopbackAddress } from './update.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 一张生成好的图片（自由创作一次可生成 1-4 张） */
interface GeneratedImageInfo {
  id: string
  imageUrl: string
  /** 服务端按提示词生成的短名（拼图卡片左下角） */
  name: string
  model: string
  mimeType: string
  bytes: number
  width: number
  height: number
  ratio: string
  tokens: { input: number; output: number | null; total: number | null; source: string }
}

/** 生图任务状态：刷新页面后可用 jobId 重新接回结果 */
interface GenerationJob {
  userId: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  finishedAt?: number
  /** 多张生成时的进度，客户端据此显示「第 2/4 张」 */
  progress?: { done: number; total: number }
  /** 第一张，兼容只认 result 的旧客户端 */
  result?: GeneratedImageInfo
  /** 本次任务生成的全部图片（1-4 张） */
  results?: GeneratedImageInfo[]
  error?: { message: string; code: string }
}

interface GenerateBody {
  prompt?: unknown
  ratio?: unknown
  /** 资产类型，决定子文件夹 */
  category?: unknown
  /** 资产名称，用作文件名主体 */
  name?: unknown
  /** 来源标记，用于统计 */
  source?: unknown
  /** 客户端生成的任务 id，刷新后据此恢复；不传则服务端生成 */
  jobId?: unknown
  /** 角色面部参考图：存储目录里的相对路径，必须以「参考图/」开头 */
  referencePath?: unknown
  /** 自由创作的多张参考图：同上规则的路径数组，会与 referencePath 合并 */
  referencePaths?: unknown
  /** 客户端选中的生图模型；不传则用服务端当前配置的模型 */
  model?: unknown
  /** 起标题用的原始画面描述（不含风格前缀）；不传则退回 prompt */
  titlePrompt?: unknown
  /** 一次生成的张数，1-4，默认 1 */
  count?: unknown
}

/** 自由创作一次最多生成的张数 */
const MAX_IMAGES_PER_REQUEST = 4

/** 张数只认 1-4 的整数，其余一律按 1 张处理 */
function normalizeImageCount(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_IMAGES_PER_REQUEST, Math.max(1, Math.trunc(value)))
}

export function registerImageRoutes(
  app: FastifyInstance,
  deps: {
    storage: ImageStorage
    gate: SerialGate
    usage: UsageStore
    quotas: QuotaStore
    settings: SettingsStore
    /** GPT 账号池（可选）：导入账号后客户端会出现 g: 前缀的模型 */
    accounts?: { store: GptAccountStore; pool: GptAccountPool }
  },
): void {
  /**
   * 生图任务表（内存）。作用：页面刷新会中断浏览器请求，但服务端仍在生成；
   * 客户端凭 jobId 回来查询即可拿到结果，避免「刷新后进度归零、图也丢了」。
   * 只保留最近 30 分钟、最多 100 条，按账号隔离查询。
   */
  const jobs = new Map<string, GenerationJob>()
  const JOB_TTL_MS = 30 * 60 * 1000
  const JOB_LIMIT = 100

  /**
   * 每个账号在途的生图请求数（已通过额度检查、还没写入 usage 的数量）。
   * 并行生成时用「今日已用 + 在途」判断额度，避免多张同时通过检查导致超发。
   */
  const inflight = new Map<string, number>()

  /** 在途名额 +N / -N（一次生成多张就占多张），返还在 finally 里做，失败也不会漏掉。 */
  function holdSlot(userId: string, count = 1): void {
    inflight.set(userId, (inflight.get(userId) ?? 0) + count)
  }

  function releaseSlot(userId: string, count = 1): void {
    const left = (inflight.get(userId) ?? count) - count
    if (left > 0) inflight.set(userId, left)
    else inflight.delete(userId)
  }

  function pruneJobs(): void {
    const now = Date.now()
    for (const [id, job] of jobs) {
      if (job.status !== 'running' && now - (job.finishedAt ?? job.startedAt) > JOB_TTL_MS) {
        jobs.delete(id)
      }
    }
    while (jobs.size > JOB_LIMIT) {
      const oldest = jobs.keys().next().value
      if (oldest === undefined) break
      jobs.delete(oldest)
    }
  }

  // 主进程用来判断「现在有没有在生图」：自动更新只在空闲时安装。
  // 回环请求免登录（桌面控制台与主服务同机），局域网访问仍需登录。
  app.get('/api/system/activity', async request => {
    if (!isLoopbackAddress(request.ip)) requireAuth(request)
    pruneJobs()
    let generating = 0
    for (const job of jobs.values()) {
      if (job.status === 'running') generating += 1
    }
    return { generating, active: generating > 0, checkedAt: Date.now() }
  })

  // 查询任务状态（只能查自己的任务）
  app.get('/api/images/jobs/:id', async request => {
    const auth = requireAuth(request)
    const rawId = (request.params as { id?: string }).id ?? ''
    if (!UUID_PATTERN.test(rawId)) {
      throw new ApiError('INVALID_PROMPT', '无效的任务 ID', 400)
    }
    const job = jobs.get(rawId)
    if (!job || job.userId !== auth.userId) {
      throw new ApiError('IMAGE_INVALID', '找不到该生成任务（可能已过期）', 404)
    }
    return {
      jobId: rawId,
      status: job.status,
      startedAt: new Date(job.startedAt).toISOString(),
      elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
      progress: job.progress ?? null,
      result: job.result ?? null,
      results: job.results ?? (job.result ? [job.result] : []),
      error: job.error ?? null,
    }
  })

  app.post('/api/images', async (request, reply) => {
    const auth = requireAuth(request)
    const body = (request.body ?? {}) as GenerateBody
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''

    if (!prompt) {
      throw new ApiError('INVALID_PROMPT', '请输入图片提示词')
    }

    if (prompt.length > config.maxPromptLength) {
      throw new ApiError(
        'PROMPT_TOO_LONG',
        `提示词不能超过 ${config.maxPromptLength} 个字符`,
      )
    }

    const ratio = findRatio(body.ratio)
    if (!ratio) {
      throw new ApiError('RATIO_INVALID', '请选择有效的图片比例')
    }

    // 客户端只能选服务端开启的模型（含自定义供应商）；不传就跟随服务端当前配置
    const clientModels = await listClientImageModels(deps.settings, deps.accounts?.store)
    const knownModelIds = clientModels.models.map(model => model.id)
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : ''
    if (requestedModel && !knownModelIds.includes(requestedModel)) {
      throw new ApiError('MODEL_INVALID', '这个生图模型当前不可用，请重新选择')
    }
    const configuredModel = deps.settings.getImageModel()
    const selectedModel =
      requestedModel ||
      (knownModelIds.includes(configuredModel) ? configuredModel : knownModelIds[0] || configuredModel)

    // 参考图：只接受上传接口产出的「参考图/」路径，防止拿任意文件当输入。
    // 单张 referencePath 是角色资产等老调用；referencePaths 是自由创作的多图直传，
    // 两者合并去重后一起送上游，顺序为「先 referencePath，再 referencePaths」。
    if (body.referencePaths !== undefined && !Array.isArray(body.referencePaths)) {
      throw new ApiError('REFERENCE_INVALID', '参考图参数格式无效', 400)
    }

    const requestedPaths: string[] = []
    if (typeof body.referencePath === 'string') requestedPaths.push(body.referencePath.trim())
    if (Array.isArray(body.referencePaths)) {
      for (const item of body.referencePaths) {
        if (typeof item !== 'string') {
          throw new ApiError('REFERENCE_INVALID', '参考图地址无效', 400)
        }
        requestedPaths.push(item.trim())
      }
    }

    const referencePaths = [...new Set(requestedPaths.filter(Boolean))]
    if (referencePaths.length > MAX_REFERENCE_IMAGES) {
      throw new ApiError('REFERENCE_INVALID', `参考图最多 ${MAX_REFERENCE_IMAGES} 张`, 400)
    }
    for (const path of referencePaths) {
      if (
        !path.startsWith(`${REFERENCE_CATEGORY}/`) ||
        path.length > 300 ||
        path.includes('..')
      ) {
        throw new ApiError('REFERENCE_INVALID', '参考图地址无效', 400)
      }
    }

    // 任务 id：客户端可预先提供（刷新后靠它回来取结果），否则服务端生成
    const jobId =
      typeof body.jobId === 'string' && UUID_PATTERN.test(body.jobId)
        ? body.jobId
        : randomUUID()

    pruneJobs()
    // 一次生成几张：1-4，默认 1。在途名额与额度都按张数计。
    const imageCount = normalizeImageCount(body.count)
    const job: GenerationJob = {
      userId: auth.userId,
      status: 'running',
      startedAt: Date.now(),
      progress: { done: 0, total: imageCount },
    }
    jobs.set(jobId, job)

    // 每日额度：0 表示不限额
    const quota = deps.quotas.get(auth.userId)
    if (quota.dailyLimit > 0) {
      const usedToday = await deps.usage.countToday(auth.userId)
      const pending = inflight.get(auth.userId) ?? 0
      const used = usedToday + pending
      if (used + imageCount > quota.dailyLimit) {
        const remaining = Math.max(0, quota.dailyLimit - used)
        auditLog(request.log, 'warn', 'image.generate.rejected', auth, '生图被每日额度拦截', {
          source: typeof body.source === 'string' ? body.source : 'studio',
          ratio: ratio.id,
          usedToday,
          pending,
          dailyLimit: quota.dailyLimit,
          requested: imageCount,
          promptLength: prompt.length,
          promptPreview: prompt.slice(0, 160),
        })
        throw new ApiError(
          'QUOTA_EXCEEDED',
          remaining > 0
            ? `今日额度只剩 ${remaining} 张，无法一次生成 ${imageCount} 张，请减少张数或明天再来`
            : `今日生图额度已用完（${used}/${quota.dailyLimit} 张${pending ? `，其中 ${pending} 张正在生成` : ''}），明天再来或联系管理员调整额度`,
          429,
        )
      }
    }

    // 预约在途名额（按张数）：并行请求按「已用 + 在途」判断，不会同时超发
    holdSlot(auth.userId, imageCount)

    const category = typeof body.category === 'string' ? body.category : '未分类'
    const assetName = typeof body.name === 'string' ? body.name : ''
    const source =
      body.source === 'batch' || body.source === 'free' || body.source === 'face'
        ? body.source
        : 'studio'

    // 拼图卡片名：和生图并行跑，图出来时标题通常已经好了，不额外等待。
    // 只有自由创作需要；失败时退回提示词短句，绝不阻塞生图。
    const titleTask = (async () => {
      if (source !== 'free') return ''
      try {
        const titleSource =
          typeof body.titlePrompt === 'string' && body.titlePrompt.trim()
            ? body.titlePrompt.trim()
            : prompt
        return await generateImageTitle(
          {
            baseUrl: await deps.settings.getBaseUrl(),
            model: await deps.settings.getTitleModel(),
          },
          titleSource,
        )
      } catch {
        return ''
      }
    })()

    // 生图闸门：最多同时放行 IMAGE_CONCURRENCY 个请求打向 Magpie
    const startedAt = Date.now()
    auditLog(request.log, 'info', 'image.generate.start', auth, '开始生图', {
      jobId,
      source,
      category,
      name: assetName,
      ratio: ratio.id,
      references: referencePaths.length,
      promptLength: prompt.length,
      promptPreview: prompt.slice(0, 160),
    })
    // 生图超时按提示词长度放宽：120 秒起步，约每 8 个字加 1 秒，最多到 IMAGE_TIMEOUT_MS。
    // 长提示词本身出图更慢，别让本服务先于上游掐断请求。
    const promptChars = [...prompt].length
    const promptTimeoutMs = Math.min(
      config.requestTimeoutMs,
      120_000 + Math.min(180_000, promptChars * 120),
    )

    try {
    // 参考图与上游配置对本次任务的所有图片都一致，只读一次
    const references = await loadReferenceImages(referencePaths)
    // 每次生图都重读上游地址：后台改完立即生效，无需重启服务
    // 账号池模型：用导入账号的额度走 Codex 通道
    const accountTarget = deps.accounts ? resolveAccountModel(selectedModel) : null
    // 自定义供应商：换成它自己的地址、密钥与上游模型名；否则走 Magpie
    const customModel = accountTarget ? null : resolveCustomProviderModel(deps.settings, selectedModel)
    const upstreamOptions = customModel
      ? {
          baseUrl: customModel.provider.baseUrl,
          model: customModel.model.id,
          apiKey: customModel.provider.apiKey || undefined,
          timeoutMs: promptTimeoutMs,
        }
      : {
          baseUrl: await deps.settings.getBaseUrl(),
          // 客户端选了就用客户端的，否则每次重读服务端配置（后台改完立即生效）
          model: selectedModel,
          timeoutMs: promptTimeoutMs,
        }

    /**
     * 一次生成 1-4 张。每张单独进生图闸门（并发由服务端配置决定，串行时就是逐张出图），
     * 每完成一张更新任务进度；个别失败不拖累其他张，全部失败才算这次任务失败。
     */
    const settled = await Promise.allSettled(
      Array.from({ length: imageCount }, async () => {
        try {
          const upstream = await deps.gate.run(async () => {
            if (accountTarget && deps.accounts) {
              return requestAccountImage(deps.accounts, selectedModel, {
                prompt,
                ratioHint: ratio.promptHint,
                images: references,
                timeoutMs: promptTimeoutMs,
              })
            }
            return references.length
              ? await requestImageEdit(
                upstreamOptions,
                { prompt, ratioHint: ratio.promptHint, images: references },
              )
              : await requestImage(
                upstreamOptions,
                { prompt, ratioHint: ratio.promptHint },
              )
          })

          let type
          try {
            type = detectImageType(upstream.buffer)
          } catch {
            throw new ApiError('IMAGE_UNSUPPORTED', '上游返回了不支持的图片格式', 502)
          }

          const size = readImageSize(upstream.buffer)
          // 上游按画幅输出的原生尺寸已足够准确，直接交付原图，不做缩放
          const stored = await deps.storage.save(upstream.buffer, type.extension, {
            category: typeof body.category === 'string' ? body.category : undefined,
            name: typeof body.name === 'string' ? body.name : undefined,
            width: size?.width,
            height: size?.height,
          })

          return {
            stored,
            model: upstream.model,
            mimeType: type.mimeType,
            size,
            tokens: upstream.tokens,
          }
        } finally {
          // 成功或失败都算「这一张结束了」，进度才不会卡在同一格
          const done = Math.min(imageCount, (job.progress?.done ?? 0) + 1)
          job.progress = { done, total: imageCount }
        }
      }),
    )

    const generatedList = settled.flatMap(item =>
      item.status === 'fulfilled' ? [item.value] : [],
    )
    if (!generatedList.length) {
      const failure = settled.find(item => item.status === 'rejected')
      throw failure && failure.status === 'rejected'
        ? failure.reason
        : new Error('生成失败')
    }
    const failedCount = imageCount - generatedList.length
    if (failedCount > 0) {
      auditLog(request.log, 'warn', 'image.generate.partial', auth, '部分图片生成失败', {
        jobId,
        source,
        category,
        ratio: ratio.id,
        requested: imageCount,
        succeeded: generatedList.length,
        failed: failedCount,
      })
    }

    // 标题已在生图期间并行生成；模型失败时 generateImageTitle 自己会兜底
    const displayName = (await titleTask) || assetName

    const payloads: GeneratedImageInfo[] = []
    for (const generated of generatedList) {
      const width = generated.size?.width ?? ratio.nativeWidth
      const height = generated.size?.height ?? ratio.nativeHeight

      // 记录每一张的生图归属与详情，供生成记录与管理端统计
      await deps.usage.record({
        userId: auth.userId,
        username: auth.username,
        displayName: auth.displayName,
        source,
        category,
        name: displayName,
        ratio: ratio.id,
        model: generated.model,
        width,
        height,
        bytes: generated.stored.bytes,
        prompt,
        durationMs: Date.now() - startedAt,
        relativePath: generated.stored.relativePath,
        // 同一任务里的几张图共用一个批次号，单图视图按它成摞
        batchId: jobId,
        tokensInput: generated.tokens.inputTokens,
        tokensOutput: generated.tokens.outputTokens,
        tokensSource: generated.tokens.source,
      })

      // 审计：谁、什么时候、生成了什么、花了多少
      auditLog(request.log, 'info', 'image.generate', auth, '生图成功', {
        jobId,
        source,
        category,
        name: displayName,
        ratio: ratio.id,
        model: generated.model,
        references: referencePaths.length,
        promptLength: prompt.length,
        promptPreview: prompt.slice(0, 160),
        durationMs: Date.now() - startedAt,
        imageId: generated.stored.id,
        relativePath: generated.stored.relativePath,
        bytes: generated.stored.bytes,
        width,
        height,
        batchSize: imageCount,
        tokens: {
          input: generated.tokens.inputTokens,
          output: generated.tokens.outputTokens,
          total: generated.tokens.totalTokens,
          source: generated.tokens.source,
        },
      })

      payloads.push({
        id: generated.stored.id,
        imageUrl: buildFileUrl(request, generated.stored.relativePath),
        name: displayName,
        model: generated.model,
        mimeType: generated.mimeType,
        bytes: generated.stored.bytes,
        width,
        height,
        ratio: ratio.id,
        tokens: {
          input: generated.tokens.inputTokens,
          output: generated.tokens.outputTokens,
          total: generated.tokens.totalTokens,
          source: generated.tokens.source,
        },
      })
    }

    // 记入任务表：页面若已刷新，凭 jobId 回来就能取到这几张结果
    job.status = 'done'
    job.finishedAt = Date.now()
    job.results = payloads
    // 旧客户端只认 result，用第一张兜底
    job.result = payloads[0]

    // 顶层仍然展开第一张（imageUrl/width/height），老客户端不改也能用
    return reply.send({
      ...payloads[0],
      images: payloads,
      failed: failedCount,
      requested: imageCount,
      jobId,
    })
    } catch (error) {
      auditFailure(request.log, 'image.generate', auth, startedAt, error, '生图失败', {
        jobId,
        source,
        category,
        name: assetName,
        ratio: ratio.id,
        references: referencePaths.length,
        promptLength: prompt.length,
        promptPreview: prompt.slice(0, 160),
      })
      // 失败也要落到任务表，避免刷新后一直显示「生成中」
      job.status = 'error'
      job.finishedAt = Date.now()
      job.error = {
        message: error instanceof ApiError ? error.message : '生成失败',
        code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
      }
      throw error
    } finally {
      // 成功/失败都归还在途名额（按张数），额度判断才能保持准确
      releaseSlot(auth.userId, imageCount)
    }
  })
}
