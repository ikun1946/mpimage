import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { config, findImageModel, findRatio } from '../config.js'
import { ApiError } from '../lib/errors.js'
import type { SerialGate } from '../lib/serial-gate.js'
import { auditFailure, auditLog } from '../lib/audit.js'
import { buildFileUrl } from '../lib/url.js'
import { requestImage, requestImageEdit } from '../services/magpie.js'
import { ImageModelCatalog } from '../services/image-model-catalog.js'
import { detectImageType, readImageSize } from '../services/imaging.js'
import { MAX_REFERENCE_IMAGES, loadReferenceImages } from '../services/reference-images.js'
import { REFERENCE_CATEGORY, type ImageStorage } from '../services/storage.js'
import type { QuotaStore } from '../services/quota-store.js'
import type { SettingsStore } from '../services/settings-store.js'
import type { UsageStore } from '../services/usage-store.js'
import { requireAuth } from './auth.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 生图任务状态：刷新页面后可用 jobId 重新接回结果 */
interface GenerationJob {
  userId: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  finishedAt?: number
  result?: {
    id: string
    imageUrl: string
    model: string
    mimeType: string
    bytes: number
    width: number
    height: number
    ratio: string
    tokens: { input: number; output: number | null; total: number | null; source: string }
  }
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
}

export function registerImageRoutes(
  app: FastifyInstance,
  deps: {
    storage: ImageStorage
    gate: SerialGate
    usage: UsageStore
    quotas: QuotaStore
    settings: SettingsStore
  },
): void {
  /**
   * 生图任务表（内存）。作用：页面刷新会中断浏览器请求，但服务端仍在生成；
   * 客户端凭 jobId 回来查询即可拿到结果，避免「刷新后进度归零、图也丢了」。
   * 只保留最近 30 分钟、最多 100 条，按账号隔离查询。
   */
  const imageModelCatalog = new ImageModelCatalog()
  const jobs = new Map<string, GenerationJob>()
  const JOB_TTL_MS = 30 * 60 * 1000
  const JOB_LIMIT = 100

  /**
   * 每个账号在途的生图请求数（已通过额度检查、还没写入 usage 的数量）。
   * 并行生成时用「今日已用 + 在途」判断额度，避免多张同时通过检查导致超发。
   */
  const inflight = new Map<string, number>()

  /** 在途名额 +1 / -1，返还在 finally 里做，失败也不会漏掉。 */
  function holdSlot(userId: string): void {
    inflight.set(userId, (inflight.get(userId) ?? 0) + 1)
  }

  function releaseSlot(userId: string): void {
    const left = (inflight.get(userId) ?? 1) - 1
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
      result: job.result ?? null,
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

    // 客户端只能选服务端开启的模型；不传就跟随服务端当前配置
    const catalog = await imageModelCatalog.list(await deps.settings.getBaseUrl())
    const catalogIds = catalog.map(model => model.id)
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : ''
    if (requestedModel) {
      const enabledModels = deps.settings.getEnabledImageModels(catalogIds)
      const known = catalogIds.includes(requestedModel) || Boolean(findImageModel(requestedModel))
      if (!known || !enabledModels.includes(requestedModel)) {
        throw new ApiError('MODEL_INVALID', '这个生图模型当前不可用，请重新选择')
      }
    }

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
    const job: GenerationJob = { userId: auth.userId, status: 'running', startedAt: Date.now() }
    jobs.set(jobId, job)

    // 每日额度：0 表示不限额
    const quota = deps.quotas.get(auth.userId)
    if (quota.dailyLimit > 0) {
      const usedToday = await deps.usage.countToday(auth.userId)
      const pending = inflight.get(auth.userId) ?? 0
      const used = usedToday + pending
      if (used >= quota.dailyLimit) {
        auditLog(request.log, 'warn', 'image.generate.rejected', auth, '生图被每日额度拦截', {
          source: typeof body.source === 'string' ? body.source : 'studio',
          ratio: ratio.id,
          usedToday,
          pending,
          dailyLimit: quota.dailyLimit,
          promptLength: prompt.length,
          promptPreview: prompt.slice(0, 160),
        })
        throw new ApiError(
          'QUOTA_EXCEEDED',
          `今日生图额度已用完（${used}/${quota.dailyLimit} 张${pending ? `，其中 ${pending} 张正在生成` : ''}），明天再来或联系管理员调整额度`,
          429,
        )
      }
    }

    // 预约一个在途名额：并行请求按「已用 + 在途」判断，不会同时超发
    holdSlot(auth.userId)

    const category = typeof body.category === 'string' ? body.category : '未分类'
    const assetName = typeof body.name === 'string' ? body.name : ''
    const source =
      body.source === 'batch' || body.source === 'free' || body.source === 'face'
        ? body.source
        : 'studio'

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
    try {
    const generated = await deps.gate.run(async () => {
      const references = await loadReferenceImages(referencePaths)
      // 每次生图都重读上游地址：后台改完立即生效，无需重启服务
      const upstreamOptions = {
        baseUrl: await deps.settings.getBaseUrl(),
        // 客户端选了就用客户端的，否则每次重读服务端配置（后台改完立即生效）
        model: requestedModel || deps.settings.getClientImageModel(catalogIds),
        timeoutMs: config.requestTimeoutMs,
      }
      const upstream = references.length
        ? await requestImageEdit(
          upstreamOptions,
          { prompt, ratioHint: ratio.promptHint, images: references },
        )
        : await requestImage(
          upstreamOptions,
          { prompt, ratioHint: ratio.promptHint },
        )

      let type
      try {
        type = detectImageType(upstream.buffer)
      } catch {
        throw new ApiError('IMAGE_UNSUPPORTED', 'Magpie 返回了不支持的图片格式', 502)
      }

      const size = readImageSize(upstream.buffer)
      // 上游按画幅输出的原生尺寸已足够准确，直接交付原图，不做缩放
      const stored = await deps.storage.save(upstream.buffer, type.extension, {
        category: typeof body.category === 'string' ? body.category : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
        width: size?.width,
        height: size?.height,
      })

      return { stored, model: upstream.model, mimeType: type.mimeType, size, tokens: upstream.tokens }
    })

    const width = generated.size?.width ?? ratio.nativeWidth
    const height = generated.size?.height ?? ratio.nativeHeight

    // 记录本次生图归属与详情，供生成记录与管理端统计
    await deps.usage.record({
      userId: auth.userId,
      username: auth.username,
      displayName: auth.displayName,
      source,
      category,
      name: assetName,
      ratio: ratio.id,
      model: generated.model,
      width,
      height,
      bytes: generated.stored.bytes,
      prompt,
      durationMs: Date.now() - startedAt,
      relativePath: generated.stored.relativePath,
      tokensInput: generated.tokens.inputTokens,
      tokensOutput: generated.tokens.outputTokens,
      tokensSource: generated.tokens.source,
    })

    // 审计：谁、什么时候、生成了什么、花了多少
    auditLog(request.log, 'info', 'image.generate', auth, '生图成功', {
      jobId,
      source,
      category,
      name: assetName,
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
      tokens: {
        input: generated.tokens.inputTokens,
        output: generated.tokens.outputTokens,
        total: generated.tokens.totalTokens,
        source: generated.tokens.source,
      },
    })

    const payload = {
      id: generated.stored.id,
      imageUrl: buildFileUrl(request, generated.stored.relativePath),
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
    }

    // 记入任务表：页面若已刷新，凭 jobId 回来就能取到这份结果
    job.status = 'done'
    job.finishedAt = Date.now()
    job.result = { ...payload, tokens: { ...payload.tokens, source: payload.tokens.source } }

    return reply.send({ ...payload, jobId })
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
      // 成功/失败都归还在途名额，额度判断才能保持准确
      releaseSlot(auth.userId)
    }
  })
}
