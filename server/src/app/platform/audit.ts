import type { FastifyBaseLogger } from 'fastify'

/** 记录谁在什么时候做了什么、花了多少、拿到什么 */
export interface AuditActor {
  userId: string
  username: string
  displayName: string
}

type AuditLevel = 'info' | 'warn' | 'error'

/**
 * 业务审计日志：沿用 Fastify 的 pino 通道，落进当日 logs/YYYY-MM-DD.log。
 * 统一带 audit / at / userId / username / displayName 四个字段，
 * 方便按 `audit` 过滤，也能直接看懂是谁、什么时候。
 */
export function auditLog(
  log: FastifyBaseLogger,
  level: AuditLevel,
  action: string,
  actor: AuditActor,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  // 方法要从 log 上取下来再 bind：pino 的 info/warn 依赖 this 上的 msgPrefix，
  // 直接 log[level](...) 调用会把 this 丢掉，日志反而变成一次运行时异常
  const write = log[level].bind(log) as (obj: Record<string, unknown>, msg: string) => void
  write(
    {
      audit: action,
      at: new Date().toISOString(),
      userId: actor.userId,
      username: actor.username,
      displayName: actor.displayName,
      ...fields,
    },
    message,
  )
}

/** 失败也走同一套字段，errorCode / errorMessage 放在末尾，便于扫日志 */
export function auditFailure(
  log: FastifyBaseLogger,
  action: string,
  actor: AuditActor,
  startedAt: number,
  error: unknown,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const isApi = Boolean(error) && typeof error === 'object' && 'code' in (error as object)
  auditLog(
    log,
    isApi ? 'warn' : 'error',
    action,
    actor,
    message,
    {
      ...fields,
      durationMs: Date.now() - startedAt,
      errorCode: isApi ? String((error as { code?: unknown }).code) : 'INTERNAL_ERROR',
      errorMessage: error instanceof Error ? error.message : String(error),
    },
  )
}