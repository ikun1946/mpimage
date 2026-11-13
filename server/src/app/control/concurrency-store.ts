/**
 * 生图并发上限的持久化（<dataDir>/concurrency.json）。
 * 控制台修改后立即生效并落盘，服务重启后沿用；文件不存在时才用
 * IMAGE_CONCURRENCY 环境变量 / 默认值。
 *
 * 语义：0 表示不限制，正整数 N 表示同时最多 N 个生图请求。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 并发未配置或配置非法时的默认值 */
const DEFAULT_CONCURRENCY = 5

/**
 * 规范化生图并发：只接受 0..Number.MAX_SAFE_INTEGER 的安全整数。
 * 负数、小数、NaN、非数字（含 null/undefined/布尔/空串）一律回退到 fallback。
 */
export function normalizeConcurrency(value: unknown, fallback = DEFAULT_CONCURRENCY): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isSafeInteger(numeric) || numeric < 0) return fallback
  return numeric
}

/** 旧名称保留，避免既有调用方断裂；语义与 normalizeConcurrency 相同 */
export const clampConcurrency = normalizeConcurrency

export class ConcurrencyStore {
  private readonly file: string
  private limit: number

  constructor(dataDir: string, fallback: number) {
    this.file = join(dataDir, 'concurrency.json')
    this.limit = normalizeConcurrency(fallback)
  }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { limit?: unknown }
      this.limit = normalizeConcurrency(parsed?.limit)
    } catch {
      // 没有文件或文件损坏：沿用环境变量 / 默认值
    }
  }

  get(): number {
    return this.limit
  }

  async set(limit: number): Promise<number> {
    this.limit = normalizeConcurrency(limit)
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(
      temp,
      JSON.stringify({ limit: this.limit, updatedAt: new Date().toISOString() }, null, 2),
      'utf8',
    )
    await rename(temp, this.file)
    return this.limit
  }
}
