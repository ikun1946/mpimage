import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface UsageEntry {
  id: string
  /** 账号 id；匿名或未知来源记为 '' */
  userId: string
  username: string
  displayName: string
  /** 单张或批量 */
  source: 'studio' | 'batch' | 'free' | 'face'
  category: string
  name: string
  ratio: string
  /** 实际使用的生图模型；老记录没有这个字段 */
  model?: string
  width: number
  height: number
  bytes: number
  /** 提示词全文，供生成记录回看 */
  prompt: string
  /** 生图耗时（毫秒），从请求进入后端到上游返回并落盘 */
  durationMs: number
  /** 图片在存储目录内的相对路径，如 角色/苏晚棠-1086x1448.png */
  relativePath: string
  /** 同一次生图任务的批次号；老记录没有这个字段 */
  batchId?: string
  /** 提示词消耗 token（上游返回真实值或本地估算） */
  tokensInput: number
  /** 生成消耗 token；上游未提供时为 null */
  tokensOutput: number | null
  /** token 数据来源：upstream 真实 / estimated 估算 */
  tokensSource: 'upstream' | 'estimated'
  createdAt: string
}

export interface UsageDatabase {
  entries: UsageEntry[]
}

export class UsageStore {
  private readonly file: string
  private cache: UsageDatabase | null = null
  private pending: Promise<void> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  async read(): Promise<UsageDatabase> {
    if (this.cache) return this.cache

    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<UsageDatabase>
      this.cache = {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      }
    } catch {
      this.cache = { entries: [] }
    }
    return this.cache
  }

  async write(database: UsageDatabase): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(database, null, 2), 'utf8')
    await rename(temp, this.file)
    this.cache = database
  }

  /** 记录一次生图。串行化写入，避免并发丢数据。 */
  async record(entry: Omit<UsageEntry, 'id' | 'createdAt'>): Promise<UsageEntry> {
    let created: UsageEntry | undefined
    this.pending = this.pending.then(async () => {
      const database = await this.read()
      created = {
        ...entry,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      }
      database.entries.push(created)
      await this.write(database)
    })
    await this.pending
    return created as UsageEntry
  }

  /** 统计某账号「今天」已生成张数（按本地日期 00:00 起算）。 */
  async countToday(userId: string): Promise<number> {
    const now = new Date()
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const entries = (await this.read()).entries
    return entries.filter(entry => {
      if (entry.userId !== userId) return false
      const time = new Date(entry.createdAt).getTime()
      return Number.isFinite(time) && time >= dayStart
    }).length
  }

  /** 按账号读取生图记录，最新在前。 */
  async entriesForUser(userId: string): Promise<UsageEntry[]> {
    const entries = (await this.read()).entries
    return entries
      .filter(entry => entry.userId === userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  async entries(): Promise<UsageEntry[]> {
    return (await this.read()).entries
  }
}
