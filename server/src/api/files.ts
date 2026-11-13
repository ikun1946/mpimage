import type { FastifyInstance, FastifyReply } from 'fastify'
import { ApiError } from '../app/platform/errors.js'
import { mimeForExtension, type ImageStorage } from '../services/storage.js'

const ID_PATTERN = /^[0-9a-f-]{36}$/i

export function registerFileRoutes(app: FastifyInstance, deps: { storage: ImageStorage }): void {
  // 两种形式都支持：
  //   /api/files/<uuid>.png          旧版 UUID 文件名
  //   /api/files/<类别>/<文件名>.png  新版按资产分类的可读文件名
  app.get('/api/files/*', async (request, reply) => {
    const raw = (request.params as { '*': string })['*'] ?? ''
    const relativePath = decodeURIComponent(raw).replace(/^\/+/, '')

    if (!relativePath || relativePath.includes('..')) {
      throw new ApiError('INVALID_PROMPT', '无效的图片地址')
    }

    const segments = relativePath.split('/').filter(Boolean)
    if (segments.length === 0 || segments.length > 2) {
      throw new ApiError('INVALID_PROMPT', '无效的图片地址')
    }

    const filename = segments[segments.length - 1] as string
    const dot = filename.lastIndexOf('.')
    if (dot <= 0) {
      throw new ApiError('INVALID_PROMPT', '无效的图片地址')
    }

    const extension = filename.slice(dot + 1).toLowerCase()

    const mimeType = mimeForExtension(extension)
    if (!mimeType) {
      throw new ApiError('IMAGE_UNSUPPORTED', '不支持的图片格式', 404)
    }

    if (segments.length === 1) {
      // 旧版单段路径：必须是 UUID
      const id = filename.slice(0, dot)
      if (!ID_PATTERN.test(id)) {
        throw new ApiError('INVALID_PROMPT', '无效的图片地址')
      }
      return sendImage(reply, deps, id, extension, mimeType)
    }

    // 新版两段路径：类别目录 + 可读文件名
    const category = segments[0]
    if (!category || category.length > 40) {
      throw new ApiError('INVALID_PROMPT', '无效的图片地址')
    }

    return sendImage(reply, deps, `${category}/${filename}`, extension, mimeType)
  })
}

async function sendImage(
  reply: FastifyReply,
  deps: { storage: ImageStorage },
  relativePath: string,
  extension: string,
  mimeType: string,
) {
  try {
    const image = relativePath.includes('/')
      ? await deps.storage.resolve(relativePath)
      : await deps.storage.read(relativePath.slice(0, -extension.length - 1), extension)
    return reply
      .header('Content-Type', mimeType)
      .header('Content-Length', image.byteLength)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .send(image)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ApiError('IMAGE_INVALID', '图片不存在', 404)
    }
    throw error
  }
}
