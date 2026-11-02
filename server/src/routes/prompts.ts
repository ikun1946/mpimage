import type { FastifyInstance } from 'fastify'
import { config, findRatio } from '../config.js'
import { ApiError } from '../lib/errors.js'
import { optimizePrompt } from '../services/prompt-optimizer.js'
import {
  MAX_REFERENCE_IMAGES,
  loadReferenceImages,
  type ReferenceImage,
} from '../services/reference-images.js'
import type { SettingsStore } from '../services/settings-store.js'
import { requireAuth } from './auth.js'

interface OptimizeBody {
  prompt?: unknown
  ratio?: unknown
  referenceCount?: unknown
  /** 本次一起送模型的参考图：存储目录相对路径，必须以「参考图/」开头 */
  referencePaths?: unknown
}

export function registerPromptRoutes(
  app: FastifyInstance,
  deps: { settings: SettingsStore },
): void {
  app.post('/api/prompts/optimize', async request => {
    requireAuth(request)
    const body = (request.body ?? {}) as OptimizeBody
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''

    if (!prompt) {
      throw new ApiError('INVALID_PROMPT', '请输入你想优化的画面描述')
    }

    if (prompt.length > config.maxPromptLength) {
      throw new ApiError(
        'PROMPT_TOO_LONG',
        `提示词不能超过 ${config.maxPromptLength} 个字符`,
      )
    }

    // 画幅只影响构图措辞，前端没选时按不传处理
    let ratioLabel: string | undefined
    if (body.ratio !== undefined) {
      const ratio = findRatio(body.ratio)
      if (!ratio) {
        throw new ApiError('RATIO_INVALID', '请选择有效的图片比例')
      }
      ratioLabel = ratio.label
    }

    // 参考图：优先按路径实际加载，张数以真正读到的图片为准；
    // 老客户端只传 referenceCount（不上图），继续按原来的方式处理。
    let referenceCount: number | undefined
    let images: ReferenceImage[] | undefined
    if (body.referencePaths !== undefined) {
      if (!Array.isArray(body.referencePaths)) {
        throw new ApiError('REFERENCE_INVALID', '参考图参数格式无效', 400)
      }
      const referencePaths: string[] = []
      for (const item of body.referencePaths) {
        if (typeof item !== 'string') {
          throw new ApiError('REFERENCE_INVALID', '参考图地址无效', 400)
        }
        referencePaths.push(item.trim())
      }
      images = await loadReferenceImages(referencePaths)
      referenceCount = images.length
    } else if (body.referenceCount !== undefined) {
      const count = body.referenceCount
      if (
        typeof count !== 'number' ||
        !Number.isInteger(count) ||
        count < 0 ||
        count > MAX_REFERENCE_IMAGES
      ) {
        throw new ApiError('REFERENCE_INVALID', '参考图数量无效', 400)
      }
      referenceCount = count
    }

    return optimizePrompt(
      {
        baseUrl: await deps.settings.getBaseUrl(),
        model: await deps.settings.getTextModel(),
        timeoutMs: config.promptOptimizeTimeoutMs,
      },
      { prompt, ratioLabel, referenceCount, images },
    )
  })
}
