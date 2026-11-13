import type { FastifyInstance } from 'fastify'
import { ApiError } from '../app/platform/errors.js'
import { requireAuth } from './auth.js'
import type { StyleLibrary, StyleLibraryStore } from '../app/products/styles/style-library.js'

interface StyleBody {
  styles?: unknown
  defaultStyle?: unknown
}

export function registerStyleRoutes(app: FastifyInstance, deps: { library: StyleLibraryStore }): void {
  // 风格库按登录账号隔离：各账号读写自己的那份
  app.get('/api/styles', async request => {
    const auth = requireAuth(request)
    return deps.library.read(auth.userId)
  })

  app.put('/api/styles', async (request) => {
    const auth = requireAuth(request)
    const body = (request.body ?? {}) as StyleBody
    if (!body || typeof body !== 'object') {
      throw new ApiError('INVALID_STYLES', '风格数据格式无效')
    }

    const incoming = body as Partial<StyleLibrary>
    if (!incoming.styles || typeof incoming.styles !== 'object') {
      throw new ApiError('INVALID_STYLES', '风格数据格式无效')
    }

    const saved = await deps.library.write(auth.userId, incoming as StyleLibrary)
    return saved
  })
}
