/**
 * 每账号的每日生图额度。
 * dailyLimit = 0 表示不限额；>0 表示当天最多生成这么多张。
 * 配置持久化到 data/quotas.json。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface QuotaEntry {
  /** 每日最多生成张数；0 = 不限额 */
  dailyLimit: number
  updatedAt: string
}

interface QuotaDatabase {
  quotas: Record<string, QuotaEntry>
}

export class QuotaStore {
  private readonly file: string
  private db: QuotaDatabase = { quotas: {} }
  private pending: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.file = join(dataDir, 'quotas.json')
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<QuotaDatabase>
      if (parsed && typeof parsed.quotas === 'object' && parsed.quotas) {
        this.db = { quotas: parsed.quotas }
      }
    } catch {
      // 首次运行没有配置文件
    }
  }

  /** 取某账号的额度配置，未配置视为不限额。 */
  get(userId: string): QuotaEntry {
    return this.db.quotas[userId] || { dailyLimit: 0, updatedAt: '' }
  }

  list(): Record<string, QuotaEntry> {
    return { ...this.db.quotas }
  }

  /** 设置额度。dailyLimit <= 0 视为取消限额。 */
  async set(userId: string, dailyLimit: number): Promise<QuotaEntry> {
    const limit = Math.max(0, Math.floor(Number(dailyLimit) || 0))
    const entry: QuotaEntry = { dailyLimit: limit, updatedAt: new Date().toISOString() }

    const run = async () => {
      if (limit > 0) this.db.quotas[userId] = entry
      else delete this.db.quotas[userId]
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(temp, JSON.stringify(this.db, null, 2), 'utf8')
      await rename(temp, this.file)
    }
    this.pending = this.pending.then(run, run)
    await this.pending
    return entry
  }
}
