import { config } from '../app/platform/config.js'

/**
 * 依据请求 Host 构建图片文件的绝对地址。
 * 优先使用 PUBLIC_BASE_URL；否则按请求 Host 推断，
 * 因此前端部署在任何端口（含 Vite 代理、局域网直连）都能正确取图。
 */
export function buildFileUrl(
  request: { headers: Record<string, unknown>; protocol?: string },
  relativePath: string,
): string {
  if (!relativePath) return ''

  const encoded = relativePath.split('/').map(encodeURIComponent).join('/')
  const configured = config.publicBaseUrl
  if (configured) return `${configured}/api/files/${encoded}`

  const host = (request.headers['x-forwarded-host'] as string) || (request.headers.host as string)
  const protocol =
    (request.headers['x-forwarded-proto'] as string) ||
    request.protocol ||
    'http'

  if (!host) return `/api/files/${encoded}`
  return `${protocol}://${host}/api/files/${encoded}`
}
