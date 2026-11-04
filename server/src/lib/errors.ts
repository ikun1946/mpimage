export type ApiErrorCode =
  | 'INVALID_PROMPT'
  | 'PROMPT_TOO_LONG'
  | 'RATIO_INVALID'
  | 'RESOLUTION_INVALID'
  | 'INVALID_STYLES'
  | 'FEEDBACK_INVALID'
  | 'PROJECT_NOT_FOUND'
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'AUTH_FORBIDDEN'
  | 'AUTH_PENDING'
  | 'UPSTREAM_UNREACHABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_BAD_RESPONSE'
  | 'UPSTREAM_TRUNCATED'
  | 'UPSTREAM_INVALID'
  | 'VISION_UNSUPPORTED'
  | 'IMAGE_INVALID'
  | 'IMAGE_UNSUPPORTED'
  | 'IMAGE_REFERENCE_MISSING'
  | 'REFERENCE_INVALID'
  | 'REFERENCE_TOO_LARGE'
  | 'CONCURRENCY_INVALID'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'INTERNAL_ERROR'

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly statusCode: number

  constructor(code: ApiErrorCode, message: string, statusCode?: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.statusCode = statusCode ?? defaultStatusFor(code)
  }
}

/** 各错误码的默认 HTTP 状态码。认证类用 401/403，前端据此跳转登录页。 */
function defaultStatusFor(code: ApiErrorCode): number {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 401
    case 'AUTH_INVALID':
      return 401
    case 'AUTH_FORBIDDEN':
      return 403
    case 'AUTH_PENDING':
      return 403
    case 'REFERENCE_TOO_LARGE':
      return 413
    case 'UPSTREAM_INVALID':
      return 400
    default:
      return 400
  }
}
