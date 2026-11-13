import type { FastifyInstance } from 'fastify'
import { ApiError } from '../app/platform/errors.js'
import { buildFileUrl } from '../utils/url.js'
import { detectImageType, readImageSize } from '../app/products/images/imaging.js'
import { REFERENCE_CATEGORY, type ImageStorage } from '../services/storage.js'
import { requireAuth } from './auth.js'

/** data URL：只接受位图格式，base64 主体允许换行（部分客户端会折行） */
const DATA_URL_PATTERN = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024
const MAX_NAME_LENGTH = 40

export function registerUploadRoutes(
  app: FastifyInstance,
  deps: { storage: ImageStorage },
): void {
  /**
   * 上传角色面部参考图。
   * 走 JSON + data URL：不必引入 multipart 依赖，前端 FileReader 也最直接。
   * 路由单独放宽 bodyLimit —— 全局是 8MB，而 data URL 会比原图大 1/3。
   */
  app.post(
    '/api/reference-images',
    { bodyLimit: 12 * 1024 * 1024 },
    async (request, reply) => {
      requireAuth(request)

      const body = (request.body ?? {}) as { name?: unknown; dataUrl?: unknown }
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME_LENGTH) : ''
      const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : ''
      const match = DATA_URL_PATTERN.exec(dataUrl)

      if (!match) {
        throw new ApiError('REFERENCE_INVALID', '参考图格式无效，仅支持 PNG / JPEG / WebP', 400)
      }

      const buffer = Buffer.from(match[1] ?? '', 'base64')
      if (!buffer.byteLength) {
        throw new ApiError('REFERENCE_INVALID', '参考图内容为空', 400)
      }
      if (buffer.byteLength > MAX_REFERENCE_BYTES) {
        throw new ApiError(
          'REFERENCE_TOO_LARGE',
          `参考图不能超过 ${Math.round(MAX_REFERENCE_BYTES / 1024 / 1024)} MB`,
          413,
        )
      }

      let type
      try {
        type = detectImageType(buffer)
      } catch {
        throw new ApiError('REFERENCE_INVALID', '参考图内容不是有效的图片', 400)
      }

      const size = readImageSize(buffer)
      const stored = await deps.storage.save(buffer, type.extension, {
        category: REFERENCE_CATEGORY,
        name: name ? `${name}-参考` : '角色参考',
        width: size?.width,
        height: size?.height,
      })

      reply.code(201)
      return {
        // 项目里只存相对路径，换机器/换域名都能用
        path: stored.relativePath,
        url: buildFileUrl(request, stored.relativePath),
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        bytes: stored.bytes,
      }
    },
  )
}