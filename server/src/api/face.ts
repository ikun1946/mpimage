import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin, requireAuth } from './auth.js'
import { ApiError } from '../app/platform/errors.js'
import { buildFileUrl } from '../utils/url.js'
import { detectImageType, readImageSize } from '../app/products/images/imaging.js'
import { mimeForExtension, REFERENCE_CATEGORY, type ImageStorage } from '../services/storage.js'
import {
  FaceCatalogError,
  type FaceCatalog,
  type FaceCatalogStore,
} from '../app/products/face/catalog-store.js'
import {
  FaceSubmissionError,
  type FaceSubmission,
  type FaceSubmissionStore,
} from '../app/products/face/submission-store.js'

const DATA_URL_PATTERN = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024
const PENDING_REFERENCE_CATEGORY = '参考图-待审核'
const GENDER_AFFINITY_VALUES = new Set(['male', 'female', 'neutral'])

const text = (value: unknown, max = 600) =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

const textList = (value: unknown, max = 40) =>
  (Array.isArray(value) ? value : [])
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, max)

function sendCatalogError(reply: FastifyReply, error: unknown) {
  if (error instanceof FaceCatalogError) {
    return reply.code(error.status).send({
      error: error.message,
      code: error.status === 409 ? 'FACE_CATALOG_CONFLICT' : 'FACE_CATALOG_INVALID',
      details: error.details,
    })
  }
  throw error
}

function sendSubmissionError(reply: FastifyReply, error: unknown) {
  if (error instanceof FaceSubmissionError) {
    return reply.code(error.status).send({
      error: error.message,
      code: 'FACE_SUBMISSION_INVALID',
    })
  }
  throw error
}

function submissionView(request: FastifyRequest, item: FaceSubmission) {
  return {
    ...item,
    imageUrl: item.imagePath ? buildFileUrl(request, item.imagePath) : '',
  }
}

function normalizeImagePath(value: unknown): string {
  const path = text(value, 500)
  if (!path) return ''
  if (path.includes('..') || /^https?:\/\//i.test(path)) {
    throw new ApiError('REFERENCE_INVALID', '图片路径无效')
  }
  return path
}

function parseImageDataUrl(value: unknown): {
  buffer: Buffer
  extension: string
  width: number
  height: number
} {
  const dataUrl = typeof value === 'string' ? value : ''
  const match = DATA_URL_PATTERN.exec(dataUrl)
  if (!match) {
    throw new ApiError('REFERENCE_INVALID', '参考图格式无效，仅支持 PNG / JPEG / WebP', 400)
  }
  const buffer = Buffer.from(match[1] ?? '', 'base64')
  if (!buffer.byteLength) throw new ApiError('REFERENCE_INVALID', '参考图内容为空', 400)
  if (buffer.byteLength > MAX_REFERENCE_BYTES) {
    throw new ApiError('REFERENCE_TOO_LARGE', '参考图不能超过 8 MB', 413)
  }
  let type
  try {
    type = detectImageType(buffer)
  } catch {
    throw new ApiError('REFERENCE_INVALID', '参考图内容不是有效的图片', 400)
  }
  const size = readImageSize(buffer)
  return {
    buffer,
    extension: type.extension,
    width: size?.width ?? 0,
    height: size?.height ?? 0,
  }
}

async function savePendingImage(
  storage: ImageStorage,
  dataUrl: unknown,
  options: { userId: string; targetId: string; name: string },
) {
  const image = parseImageDataUrl(dataUrl)
  const stored = await storage.save(image.buffer, image.extension, {
    category: PENDING_REFERENCE_CATEGORY,
    name: `待审-${options.name || options.targetId}-${options.userId.slice(0, 8)}`,
    width: image.width,
    height: image.height,
  })
  return {
    imagePath: stored.relativePath,
    imageBytes: stored.bytes,
    imageWidth: image.width,
    imageHeight: image.height,
  }
}

async function publishSubmissionImage(
  storage: ImageStorage,
  imagePath: string,
  name: string,
): Promise<string> {
  if (!imagePath) return ''
  if (imagePath.startsWith(`${REFERENCE_CATEGORY}/`)) return imagePath
  let buffer: Buffer
  try {
    buffer = await storage.resolve(imagePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ApiError('IMAGE_INVALID', '待审核参考图不存在', 404)
    }
    throw error
  }
  const filename = imagePath.split('/').pop() || ''
  const dot = filename.lastIndexOf('.')
  const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
  if (!extension || !mimeForExtension(extension)) {
    throw new ApiError('IMAGE_UNSUPPORTED', '待审核参考图格式不受支持', 400)
  }
  const size = readImageSize(buffer)
  const stored = await storage.save(buffer, extension, {
    category: REFERENCE_CATEGORY,
    name: name || '社区参考图',
    width: size?.width,
    height: size?.height,
  })
  return stored.relativePath
}

function normalizeSubmittedCard(value: unknown, categoryKey: string, category: Record<string, any>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('FACE_SUBMISSION_INVALID', '卡片内容不能为空')
  }
  const source = value as Record<string, any>
  const id = text(source.id, 100)
  if (!/^[A-Za-z0-9_-]{3,100}$/.test(id)) {
    throw new ApiError('FACE_SUBMISSION_INVALID', '卡片 ID 只能包含字母、数字、下划线和短横线')
  }
  const nameZh = text(source.name_zh, 120)
  if (!nameZh) throw new ApiError('FACE_SUBMISSION_INVALID', '中文名称不能为空')
  const genderAffinity = textList(source.gender_affinity, 3)
    .map(label => label.toLowerCase())
    .filter(label => GENDER_AFFINITY_VALUES.has(label))
  return {
    ...source,
    id,
    category: categoryKey,
    name_zh: nameZh,
    name_en: text(source.name_en, 160),
    definition: text(source.definition, 800),
    prompt_zh: text(source.prompt_zh, 4000),
    prompt_en: text(source.prompt_en, 4000),
    aliases: textList(source.aliases),
    mood_tags: textList(source.mood_tags).length ? textList(source.mood_tags) : ['社区'],
    visual_features: textList(source.visual_features),
    compatibility: textList(source.compatibility, 60),
    conflicts: textList(source.conflicts, 60),
    gender_affinity: genderAffinity.length ? [...new Set(genderAffinity)] : ['neutral'],
    select_mode: category.select_mode,
    max_select: category.max_select,
    strength_supported: false,
    sort_order: Number.isFinite(Number(source.sort_order)) ? Number(source.sort_order) : 9999,
    visible: true,
    is_custom: true,
    source_section: 'community',
    reference_image: '',
    reference_status: 'pending',
  }
}

function findCatalogItem(catalog: FaceCatalog, targetId: string) {
  for (const category of catalog.categories) {
    const items = Array.isArray(category.items)
      ? category.items as Array<Record<string, any>>
      : []
    const item = items.find(entry => entry.id === targetId)
    if (item) return { category, item }
  }
  return null
}

function findSubmissionOrThrow(submissions: FaceSubmissionStore, id: string): FaceSubmission {
  const item = submissions.get(id)
  if (!item) throw new FaceSubmissionError('提交记录不存在', 404)
  return item
}

export function registerFaceRoutes(
  app: FastifyInstance,
  deps: {
    store: FaceCatalogStore
    submissions: FaceSubmissionStore
    storage: ImageStorage
  },
): void {
  app.get('/api/face/catalog', async request => {
    requireAuth(request)
    return { catalog: deps.store.getPublic(), meta: deps.store.getMeta() }
  })

  app.get('/api/face/catalog/meta', async request => {
    requireAuth(request)
    return { meta: deps.store.getMeta() }
  })

  app.get('/api/face/submissions/mine', async request => {
    const auth = requireAuth(request)
    return {
      submissions: deps.submissions.listMine(auth.userId).map(item => submissionView(request, item)),
    }
  })

  app.post(
    '/api/face/submissions',
    { bodyLimit: 12 * 1024 * 1024 },
    async (request, reply) => {
      const auth = requireAuth(request)
      const body = (request.body ?? {}) as Record<string, unknown>
      const kind = body.kind === 'reference' ? 'reference' : 'card'
      const catalog = deps.store.getPublic()
      try {
        let card: Record<string, any> | null = null
        let categoryKey = text(body.category, 80)
        let targetId = text(body.targetId, 100)

        if (kind === 'card') {
          const rawCard = body.card && typeof body.card === 'object' && !Array.isArray(body.card)
            ? body.card as Record<string, any>
            : null
          categoryKey = text(rawCard?.category, 80) || categoryKey
        }

        const category = catalog.categories.find(entry => entry.key === categoryKey)
        if (!category) throw new ApiError('FACE_SUBMISSION_INVALID', '分类不存在', 404)
        if (kind === 'card') {
          card = normalizeSubmittedCard(body.card, categoryKey, category)
          categoryKey = card.category
          targetId = card.id
        }
        if (kind === 'reference') {
          const found = findCatalogItem(catalog, targetId)
          if (!found) throw new ApiError('FACE_SUBMISSION_INVALID', '目标卡片不存在', 404)
          categoryKey = found.category.key
        }

        const image: {
          imagePath?: string
          imageBytes?: number
          imageWidth?: number
          imageHeight?: number
        } = body.removeImage === true
          ? { imagePath: '', imageBytes: 0, imageWidth: 0, imageHeight: 0 }
          : body.dataUrl
          ? await savePendingImage(deps.storage, body.dataUrl, {
              userId: auth.userId,
              targetId: card?.name_zh || targetId,
              name: card?.name_zh || targetId,
            })
          : {}
        const submission = await deps.submissions.upsert(auth, {
          kind,
          category: categoryKey,
          targetId,
          card,
          ...image,
        })
        request.log.info(
          {
            actor: auth.userId,
            submission: submission.id,
            kind,
            targetId,
            hasImage: Boolean(image.imagePath),
          },
          '收到捏脸内容审核提交',
        )
        reply.code(201)
        return { submission: submissionView(request, submission) }
      } catch (error) {
        return sendSubmissionError(reply, error)
      }
    },
  )

  app.post('/api/face/submissions/:id/resubmit', async (request, reply) => {
    const auth = requireAuth(request)
    try {
      const item = await deps.submissions.resubmit(
        (request.params as { id: string }).id,
        auth.userId,
      )
      return { submission: submissionView(request, item) }
    } catch (error) {
      return sendSubmissionError(reply, error)
    }
  })

  app.delete('/api/face/submissions/:id', async (request, reply) => {
    const auth = requireAuth(request)
    try {
      await deps.submissions.remove((request.params as { id: string }).id, auth.userId)
      return { ok: true }
    } catch (error) {
      return sendSubmissionError(reply, error)
    }
  })

  app.get('/api/admin/face/submissions', async request => {
    requireAdmin(request)
    const status = text((request.query as Record<string, unknown>)?.status, 20) || 'all'
    return {
      submissions: deps.submissions.list(status).map(item => submissionView(request, item)),
    }
  })

  app.patch(
    '/api/admin/face/submissions/:id',
    { bodyLimit: 12 * 1024 * 1024 },
    async (request, reply) => {
      requireAdmin(request)
      const body = (request.body ?? {}) as Record<string, unknown>
      try {
        const current = findSubmissionOrThrow(
          deps.submissions,
          (request.params as { id: string }).id,
        )
        if (current.status !== 'pending') {
          throw new FaceSubmissionError('只有待审核内容可以修改', 409)
        }
        let category = text(body.category, 80) || current.category
        let targetId = text(body.targetId, 100) || current.targetId
        let card = current.card
        if (body.card !== undefined) {
          const catalog = deps.store.getAdmin()
          const categoryEntry = catalog.categories.find(entry => entry.key === category)
          if (!categoryEntry) throw new ApiError('FACE_SUBMISSION_INVALID', '分类不存在', 404)
          card = normalizeSubmittedCard(body.card, category, categoryEntry)
          category = card.category
          targetId = card.id
        } else if (current.kind === 'reference' && body.targetId !== undefined) {
          const found = findCatalogItem(deps.store.getAdmin(), targetId)
          if (!found) throw new ApiError('FACE_SUBMISSION_INVALID', '目标卡片不存在', 404)
          category = found.category.key
        }
        const image: {
          imagePath?: string
          imageBytes?: number
          imageWidth?: number
          imageHeight?: number
        } = body.dataUrl
          ? await savePendingImage(deps.storage, body.dataUrl, {
              userId: current.userId,
              targetId: card?.name_zh || targetId,
              name: card?.name_zh || targetId,
            })
          : {}
        if (body.imagePath !== undefined && !body.dataUrl) {
          image.imagePath = normalizeImagePath(body.imagePath)
        }
        const item = await deps.submissions.updateDraft(current.id, {
          category,
          targetId,
          card,
          reviewNote: body.reviewNote !== undefined ? text(body.reviewNote, 500) : undefined,
          ...image,
        })
        return { submission: submissionView(request, item) }
      } catch (error) {
        return sendSubmissionError(reply, error)
      }
    },
  )

  app.post('/api/admin/face/submissions/:id/reject', async (request, reply) => {
    const admin = requireAdmin(request)
    const body = (request.body ?? {}) as Record<string, unknown>
    try {
      const item = await deps.submissions.reject(
        (request.params as { id: string }).id,
        admin,
        text(body.note, 500),
      )
      request.log.info(
        { actor: admin.userId, submission: item.id, targetId: item.targetId },
        '驳回了捏脸内容提交',
      )
      return { submission: submissionView(request, item) }
    } catch (error) {
      return sendSubmissionError(reply, error)
    }
  })

  app.post('/api/admin/face/submissions/:id/approve', async (request, reply) => {
    const admin = requireAdmin(request)
    try {
      const submission = findSubmissionOrThrow(
        deps.submissions,
        (request.params as { id: string }).id,
      )
      if (submission.status !== 'pending') {
        throw new FaceSubmissionError('只有待审核内容可以发布', 409)
      }
      const catalog = deps.store.getAdmin()
      let publishedPath = ''
      let publishedTargetId = submission.targetId

      if (submission.kind === 'card') {
        const category = catalog.categories.find(entry => entry.key === submission.category)
        if (!category) throw new ApiError('FACE_SUBMISSION_INVALID', '分类不存在', 404)
        const card = normalizeSubmittedCard(submission.card, submission.category, category)
        publishedTargetId = card.id
        if (findCatalogItem(catalog, card.id)) {
          throw new ApiError('FACE_SUBMISSION_INVALID', `卡片 ID 已存在：${card.id}`, 409)
        }
        const categoryItems = Array.isArray(category.items)
          ? category.items as Array<Record<string, any>>
          : []
        const duplicateName = categoryItems.some(
          item => text(item.name_zh, 120).toLocaleLowerCase() === card.name_zh.toLocaleLowerCase(),
        )
        if (duplicateName) {
          throw new ApiError('FACE_SUBMISSION_INVALID', `分类中已有同名卡片：${card.name_zh}`, 409)
        }
        if (submission.imagePath) {
          publishedPath = await publishSubmissionImage(
            deps.storage,
            submission.imagePath,
            card.name_zh,
          )
          catalog.references[card.id] = publishedPath
          card.reference_image = publishedPath
          card.reference_status = 'ready'
        }
        category.items.push(card)
        category.count = category.items.length
      } else {
        const found = findCatalogItem(catalog, submission.targetId)
        if (!found) {
          throw new ApiError('FACE_SUBMISSION_INVALID', '目标卡片已不存在', 404)
        }
        if (!submission.imagePath) {
          throw new ApiError('FACE_SUBMISSION_INVALID', '参考图提交缺少图片', 422)
        }
        publishedPath = await publishSubmissionImage(
          deps.storage,
          submission.imagePath,
          found.item.name_zh || submission.targetId,
        )
        catalog.references[submission.targetId] = publishedPath
        found.item.reference_image = publishedPath
        found.item.reference_status = 'ready'
      }

      const saved = await deps.store.save(catalog, catalog.revision)
      const item = await deps.submissions.markApproved(
        submission.id,
        admin,
        publishedPath,
        publishedTargetId,
      )
      request.log.info(
        {
          actor: admin.userId,
          submission: item.id,
          kind: item.kind,
          targetId: publishedTargetId,
          revision: saved.revision,
        },
        '发布了社区捏脸内容',
      )
      return {
        submission: submissionView(request, item),
        catalog: saved,
        meta: deps.store.getMeta(),
      }
    } catch (error) {
      return error instanceof FaceCatalogError
        ? sendCatalogError(reply, error)
        : sendSubmissionError(reply, error)
    }
  })

  app.get('/api/admin/face/catalog', async request => {
    requireAdmin(request)
    return { catalog: deps.store.getAdmin(), meta: deps.store.getMeta() }
  })

  app.put(
    '/api/admin/face/catalog',
    { bodyLimit: 12 * 1024 * 1024 },
    async (request, reply) => {
      const admin = requireAdmin(request)
      const body = (request.body ?? {}) as { catalog?: unknown; baseRevision?: unknown }
      const baseRevision = Number.isFinite(Number(body.baseRevision))
        ? Math.floor(Number(body.baseRevision))
        : undefined
      try {
        const catalog = await deps.store.save(body.catalog, baseRevision)
        request.log.info(
          {
            actor: admin.userId,
            actorName: admin.username,
            revision: catalog.revision,
            cards: catalog.total,
            presets: catalog.presets.length,
          },
          '保存了捏脸卡片目录',
        )
        return { catalog, meta: deps.store.getMeta() }
      } catch (error) {
        return sendCatalogError(reply, error)
      }
    },
  )

  app.post('/api/admin/face/catalog/reset', async (request, reply) => {
    const admin = requireAdmin(request)
    try {
      const catalog = await deps.store.reset()
      request.log.info(
        { actor: admin.userId, actorName: admin.username, revision: catalog.revision },
        '恢复了捏脸卡片默认目录',
      )
      return { catalog, meta: deps.store.getMeta() }
    } catch (error) {
      return sendCatalogError(reply, error)
    }
  })

  app.post('/api/admin/face/catalog/restore', async (request, reply) => {
    const admin = requireAdmin(request)
    try {
      const catalog = await deps.store.restoreLast()
      request.log.info(
        { actor: admin.userId, actorName: admin.username, revision: catalog.revision },
        '恢复了捏脸卡片上一版目录',
      )
      return { catalog, meta: deps.store.getMeta() }
    } catch (error) {
      return sendCatalogError(reply, error)
    }
  })
}
