import type { FastifyInstance } from 'fastify'
import { config, findRatio } from '../config.js'
import { auditFailure, auditLog } from '../lib/audit.js'
import { ApiError } from '../lib/errors.js'
import { designFace, refineFaceField } from '../services/face-design.js'
import { optimizePrompt, revisePrompt } from '../services/prompt-optimizer.js'
import {
  MAX_REFERENCE_IMAGES,
  loadReferenceImages,
  loadStorageImages,
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
    const auth = requireAuth(request)
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

    const startedAt = Date.now()
    try {
      const result = await optimizePrompt(
        {
          baseUrl: await deps.settings.getBaseUrl(),
          model: await deps.settings.getTextModel(),
          timeoutMs: config.promptOptimizeTimeoutMs,
        },
        { prompt, ratioLabel, referenceCount, images },
      )
      auditLog(request.log, 'info', 'prompt.optimize', auth, '提示词优化完成', {
        mode: result.mode,
        model: result.model,
        inputLength: prompt.length,
        outputLength: result.prompt.length,
        outputPreview: result.prompt.slice(0, 120),
        references: images?.length ?? referenceCount ?? 0,
        lockedConstraints: result.lockedConstraints.length,
        restoredConstraints: result.restoredConstraints.length,
        tokens: result.tokens,
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      auditFailure(request.log, 'prompt.optimize', auth, startedAt, error, '提示词优化失败', {
        inputLength: prompt.length,
        references: images?.length ?? referenceCount ?? 0,
      })
      throw error
    }
  })

  // 改写已有提示词：用户说一句「把夜景改成清晨」，模型输出整条新提示词。
  // 可以顺带带上参考图与上一次的生成结果，让改动接得上画面现状。
  app.post('/api/prompts/revise', async request => {
    const auth = requireAuth(request)
    const body = (request.body ?? {}) as ReviseBody
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : ''

    if (!prompt) {
      throw new ApiError('INVALID_PROMPT', '当前没有可以改写的提示词')
    }
    if (!instruction) {
      throw new ApiError('INVALID_PROMPT', '先说说你想怎么改')
    }
    if (prompt.length > config.maxPromptLength) {
      throw new ApiError('PROMPT_TOO_LONG', `提示词不能超过 ${config.maxPromptLength} 个字符`)
    }
    if (instruction.length > MAX_REVISE_INSTRUCTION) {
      throw new ApiError('INVALID_PROMPT', `改写要求最多 ${MAX_REVISE_INSTRUCTION} 个字符`)
    }

    let ratioLabel: string | undefined
    if (body.ratio !== undefined) {
      const ratio = findRatio(body.ratio)
      if (!ratio) {
        throw new ApiError('RATIO_INVALID', '请选择有效的图片比例')
      }
      ratioLabel = ratio.label
    }

    const referencePaths = readPathList(body.referencePaths, '参考图')
    const contextPaths = readPathList(body.contextPaths, '图片')

    // 参考图只认「参考图/」，结果图可以是存储里任意类别；两类合计仍不超过上限
    const references = referencePaths.length ? await loadReferenceImages(referencePaths) : []
    const contexts = contextPaths.length ? await loadStorageImages(contextPaths) : []
    const images = [...references, ...contexts].slice(0, MAX_REFERENCE_IMAGES)
    const imageNotes = [
      ...references.map(
        () => '参考图：只沿用它被指派的部分（人物长相 / 服装 / 道具 / 场景 / 构图 / 材质 / 光），不要整张搬进新画面',
      ),
      ...contexts.map(
        () => '已生成的结果图：这是上一次出图的实际效果，用户要改的地方以它为准',
      ),
    ].slice(0, images.length)

    const startedAt = Date.now()
    try {
      const result = await revisePrompt(
        {
          baseUrl: await deps.settings.getBaseUrl(),
          model: await deps.settings.getTextModel(),
          timeoutMs: config.promptOptimizeTimeoutMs,
        },
        { prompt, instruction, ratioLabel, images, imageNotes },
      )
      auditLog(request.log, 'info', 'prompt.revise', auth, '提示词改写完成', {
        model: result.model,
        inputLength: prompt.length,
        instructionLength: instruction.length,
        instructionPreview: instruction.slice(0, 120),
        images: images.length,
        outputLength: result.prompt.length,
        outputPreview: result.prompt.slice(0, 120),
        tokens: result.tokens,
        durationMs: Date.now() - startedAt,
      })
      return { ...result, imageCount: images.length }
    } catch (error) {
      auditFailure(request.log, 'prompt.revise', auth, startedAt, error, '提示词改写失败', {
        inputLength: prompt.length,
        instructionLength: instruction.length,
        images: images.length,
      })
      throw error
    }
  })

  // 捏脸：一份角色设定 → 角色分析 + 素颜正脸定妆提示词 + 负面提示词
  app.post('/api/prompts/face-design', async request => {
    const auth = requireAuth(request)
    const body = (request.body ?? {}) as FaceDesignBody

    const params = {
      age: readText(body.age, 40, '年龄感'),
      gender: readText(body.gender, 20, '性别'),
      temperament: readText(body.temperament, 60, '气场'),
      identity: readText(body.identity, 60, '身份'),
      framing: readText(body.framing, 40, '画面类型'),
      background: readText(body.background, 40, '背景'),
      style: readText(body.style, 80, '风格'),
      extra: readText(body.extra, 600, '特殊诉求'),
      sourceText: readText(body.sourceText, 4000, '原始文本'),
    }

    const startedAt = Date.now()
    try {
      const result = await designFace(
        {
          baseUrl: await deps.settings.getBaseUrl(),
          model: await deps.settings.getTextModel(),
          timeoutMs: config.promptOptimizeTimeoutMs,
        },
        params,
      )
      auditLog(request.log, 'info', 'face.design', auth, '捏脸方案生成完成', {
        model: result.model,
        age: params.age,
        gender: params.gender,
        framing: params.framing,
        style: params.style,
        sourceTextLength: params.sourceText?.length ?? 0,
        extraLength: params.extra?.length ?? 0,
        analysisLength: result.analysis.length,
        promptLength: result.prompt.length,
        promptPreview: result.prompt.slice(0, 120),
        negativeLength: result.negativePrompt.length,
        tokens: result.tokens,
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      auditFailure(request.log, 'face.design', auth, startedAt, error, '捏脸方案生成失败', {
        gender: params.gender,
        framing: params.framing,
        style: params.style,
        sourceTextLength: params.sourceText?.length ?? 0,
      })
      throw error
    }
  })

  // 捏脸的定向修改：一次只改完整提示词或负面提示词中的一个字段
  app.post('/api/prompts/face-refine', async request => {
    const auth = requireAuth(request)
    const body = (request.body ?? {}) as FaceRefineBody

    const field =
      body.field === 'negative' ? 'negative' : body.field === 'prompt' ? 'prompt' : null
    if (!field) {
      throw new ApiError('INVALID_PROMPT', '只能修改完整提示词或负面提示词')
    }

    const value = readText(
      body.value,
      field === 'prompt' ? MAX_FACE_PROMPT_VALUE : MAX_FACE_NEGATIVE_VALUE,
      '当前内容',
    )
    const instruction = readText(body.instruction, 500, '修改要求')
    if (!value) throw new ApiError('INVALID_PROMPT', '这一栏还没有内容可以修改')
    if (!instruction) throw new ApiError('INVALID_PROMPT', '先说说想怎么改')

    const startedAt = Date.now()
    try {
      const result = await refineFaceField(
        {
          baseUrl: await deps.settings.getBaseUrl(),
          model: await deps.settings.getTextModel(),
          timeoutMs: config.promptOptimizeTimeoutMs,
        },
        {
          field,
          value,
          instruction,
          analysis: readText(body.analysis, 3000, '角色分析'),
          other: readText(body.other, MAX_FACE_PROMPT_VALUE, '另一个字段'),
        },
      )
      auditLog(request.log, 'info', 'face.refine', auth, '捏脸字段修改完成', {
        field,
        model: result.model,
        instructionLength: instruction.length,
        instructionPreview: instruction.slice(0, 120),
        inputLength: value.length,
        outputLength: result.value.length,
        outputPreview: result.value.slice(0, 120),
        tokens: result.tokens,
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      auditFailure(request.log, 'face.refine', auth, startedAt, error, '捏脸字段修改失败', {
        field,
        inputLength: value.length,
        instructionLength: instruction.length,
      })
      throw error
    }
  })
}

/** 改写要求最多这么长：再长就不是「改一句」而是重写整条，超出直接拦下 */
const MAX_REVISE_INSTRUCTION = 2000

/** 捏脸结果可以被用户手改，所以给得比生成时的 500–800 字宽一些 */
const MAX_FACE_PROMPT_VALUE = 6000
const MAX_FACE_NEGATIVE_VALUE = 3000

interface ReviseBody {
  prompt?: unknown
  instruction?: unknown
  ratio?: unknown
  /** 参考图：必须以「参考图/」开头 */
  referencePaths?: unknown
  /** 已生成结果图：存储目录里的任意类别路径 */
  contextPaths?: unknown
}

interface FaceDesignBody {
  age?: unknown
  gender?: unknown
  temperament?: unknown
  identity?: unknown
  framing?: unknown
  background?: unknown
  style?: unknown
  extra?: unknown
  /** 原始文本：人设 / 小说片段，给了就由模型先解析再设计 */
  sourceText?: unknown
}

interface FaceRefineBody {
  field?: unknown
  value?: unknown
  instruction?: unknown
  analysis?: unknown
  other?: unknown
}

/** 表单字段：非字符串按格式错误处理，超长直接拦下，避免把整段小说塞进提示词 */
function readText(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ApiError('INVALID_PROMPT', `${label}格式无效`)
  }
  const text = value.trim()
  if (text.length > max) {
    throw new ApiError('INVALID_PROMPT', `${label}最多 ${max} 个字符`)
  }
  return text
}

/** 读取一组图片路径；格式不对就按图片参数报错，不让空字符串混进加载阶段 */
function readPathList(value: unknown, noun: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new ApiError('REFERENCE_INVALID', `${noun}参数格式无效`, 400)
  }
  const paths: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ApiError('REFERENCE_INVALID', `${noun}地址无效`, 400)
    }
    const trimmed = item.trim()
    if (trimmed) paths.push(trimmed)
  }
  return paths
}
