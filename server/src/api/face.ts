import type { FastifyInstance, FastifyReply } from 'fastify'
import { requireAdmin, requireAuth } from './auth.js'
import {
  FaceCatalogError,
  type FaceCatalogStore,
} from '../app/products/face/catalog-store.js'

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

export function registerFaceRoutes(
  app: FastifyInstance,
  deps: { store: FaceCatalogStore },
): void {
  app.get('/api/face/catalog', async request => {
    requireAuth(request)
    return { catalog: deps.store.getPublic(), meta: deps.store.getMeta() }
  })

  app.get('/api/face/catalog/meta', async request => {
    requireAuth(request)
    return { meta: deps.store.getMeta() }
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
