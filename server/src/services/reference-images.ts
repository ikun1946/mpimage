import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { ApiError } from '../lib/errors.js'
import type { ImageType } from './imaging.js'
import { detectImageType } from './imaging.js'
import type { ReferenceImage } from './magpie.js'
import { REFERENCE_CATEGORY, mimeForExtension } from './storage.js'

export type { ReferenceImage }

/** 一次最多送上游几张参考图，与生图接口保持一致 */
export const MAX_REFERENCE_IMAGES = 6

/** 单张参考图上限，与上传接口的 data URL 校验一致 */
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024

/** 存储里的相对路径长度上限，挡住异常长的输入 */
const MAX_REFERENCE_PATH_LENGTH = 300

const here = dirname(fileURLToPath(import.meta.url))
/**
 * 与 index.ts 一致：相对路径按项目根解析，留空用 <项目根>/generated。
 * 本文件在 src/services 与 dist/services 下都是三层到项目根。
 */
const projectRoot = resolve(here, '..', '..', '..')

function storageRoot(): string {
  const configured = config.storageDir
  if (!configured) return join(projectRoot, 'generated')
  return isAbsolute(configured) ? configured : resolve(projectRoot, configured)
}

/**
 * 读取并校验一批参考图。
 * 规则与生图路由、上传接口完全一致：只认存储目录下「参考图/」开头的路径，
 * 去重后最多 6 张，单张 ≤8MB，只收 PNG/JPEG/WebP（扩展名与文件头必须一致）。
 * 这里再挡一次目录穿越，避免拿存储目录里的其它文件当参考图。
 */
export async function loadReferenceImages(paths: string[]): Promise<ReferenceImage[]> {
  const unique = [...new Set(paths.filter(Boolean))]
  if (unique.length > MAX_REFERENCE_IMAGES) {
    throw new ApiError('REFERENCE_INVALID', `参考图最多 ${MAX_REFERENCE_IMAGES} 张`, 400)
  }

  const root = resolve(storageRoot())
  const images: ReferenceImage[] = []
  for (const path of unique) {
    images.push(await loadOne(path, root))
  }
  return images
}

async function loadOne(relativePath: string, root: string): Promise<ReferenceImage> {
  if (
    !relativePath.startsWith(`${REFERENCE_CATEGORY}/`) ||
    relativePath.length > MAX_REFERENCE_PATH_LENGTH ||
    relativePath.includes('..')
  ) {
    throw new ApiError('REFERENCE_INVALID', '参考图地址无效', 400)
  }

  const target = resolve(root, relativePath)
  // 解析后必须仍在存储目录内，符号链接与编码技巧都在这里拦下
  if (!target.startsWith(root + sep)) {
    throw new ApiError('REFERENCE_INVALID', '参考图地址无效', 400)
  }

  let buffer: Buffer
  try {
    buffer = await readFile(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EISDIR') {
      throw new ApiError('REFERENCE_INVALID', '参考图不存在，请重新上传', 400)
    }
    throw error
  }

  if (buffer.byteLength > MAX_REFERENCE_BYTES) {
    throw new ApiError(
      'REFERENCE_TOO_LARGE',
      `参考图不能超过 ${Math.round(MAX_REFERENCE_BYTES / 1024 / 1024)} MB`,
      413,
    )
  }

  const extensionMime = mimeForExtension(relativePath.split('.').pop() ?? '')
  if (!extensionMime) {
    throw new ApiError('REFERENCE_INVALID', '参考图格式无效，仅支持 PNG / JPEG / WebP', 400)
  }

  let type: ImageType
  try {
    type = detectImageType(buffer)
  } catch {
    throw new ApiError('REFERENCE_INVALID', '参考图不是有效图片，请重新上传', 400)
  }

  // 扩展名与文件头不一致说明内容是改过名的其它文件，不能当参考图用
  if (type.mimeType !== extensionMime) {
    throw new ApiError('REFERENCE_INVALID', '参考图内容与扩展名不一致，请重新上传', 400)
  }

  return {
    buffer,
    mimeType: type.mimeType,
    filename: basename(relativePath),
  }
}
