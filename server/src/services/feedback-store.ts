/**
 * 意见反馈库：客户端提交 → 落 data/feedback.json → 管理员在后台标记处理。
 * 沿用 ProjectStore 的做法：写入先落 .tmp 再 rename 原子替换，写操作排成一条链，
 * 避免并发提交时互相覆盖。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type FeedbackCategory = 'bug' | 'suggestion' | 'other'
export type FeedbackStatus = 'new' | 'resolved'

export interface FeedbackEntry {
  id: string
  /** 提交者账号，管理员后台据此追溯到人 */
  userId: string
  username: string
  displayName: string
  category: FeedbackCategory
  content: string
  /** 反馈所在页面标识，客户端可不传 */
  page: string
  /** 客户端版本号，可不传 */
  appVersion: string
  createdAt: string
  status: FeedbackStatus
  /** 标记处理的时间；status 回到 new 时清空 */
  handledAt: string
  /** 最后标记处理的账号 id；status 回到 new 时清空 */
  handledBy: string
  /** 管理员回复；旧记录为空串 */
  reply: string
  /** 回复时间；清空回复时一并清空 */
  repliedAt: string
  /** 回复人账号 id；清空回复时一并清空 */
  repliedBy: string
}

export interface FeedbackDatabase {
  feedback: FeedbackEntry[]
}

export interface FeedbackInput {
  userId: string
  username: string
  displayName: string
  category: FeedbackCategory
  content: string
  page?: string
  appVersion?: string
}

export type FeedbackStatusFilter = 'all' | FeedbackStatus
export type FeedbackCategoryFilter = 'all' | FeedbackCategory

/** 列表筛选条件：状态、类型与关键词可任意组合。 */
export interface FeedbackListOptions {
  status?: FeedbackStatusFilter
  category?: FeedbackCategoryFilter
  /** 关键词，覆盖账号、昵称、正文、回复与页面 */
  q?: string
  limit?: number
}

/** 管理员对一条反馈的更新：状态必填，回复可选（缺省表示保留原回复）。 */
export interface FeedbackUpdate {
  status: FeedbackStatus
  reply?: string
}

/** 保留上限：超出后从最旧的开始丢，防止单文件无限增长（写入追加在尾部） */
const MAX_ENTRIES = 2000

const CATEGORIES: FeedbackCategory[] = ['bug', 'suggestion', 'other']

export class FeedbackStore {
  private readonly file: string
  private cache: FeedbackDatabase = { feedback: [] }
  private pending: Promise<FeedbackDatabase> = Promise.resolve({ feedback: [] })

  constructor(dataDir: string) {
    this.file = join(dataDir, 'feedback.json')
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      this.cache = normalizeDatabase(JSON.parse(raw) as Partial<FeedbackDatabase>)
    } catch {
      // 首次运行没有文件，或文件损坏：回落到空库，不阻断服务启动
      this.cache = { feedback: [] }
    }
  }

  private enqueueWrite(mutator: (current: FeedbackDatabase) => FeedbackDatabase): Promise<FeedbackDatabase> {
    const run = async () => {
      const next = normalizeDatabase(mutator(this.cache))
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
      await rename(temp, this.file)
      this.cache = next
      return next
    }
    this.pending = this.pending.then(run, run)
    return this.pending
  }

  /** 新增一条反馈，状态固定为 new。 */
  async add(input: FeedbackInput): Promise<FeedbackEntry> {
    const entry: FeedbackEntry = {
      id: randomUUID(),
      userId: input.userId,
      username: input.username,
      displayName: input.displayName,
      category: input.category,
      content: input.content,
      page: input.page ?? '',
      appVersion: input.appVersion ?? '',
      createdAt: new Date().toISOString(),
      status: 'new',
      handledAt: '',
      handledBy: '',
      reply: '',
      repliedAt: '',
      repliedBy: '',
    }

    const database = await this.enqueueWrite(current => ({
      feedback: [...current.feedback, entry],
    }))
    return database.feedback.find(item => item.id === entry.id) ?? entry
  }

  /**
   * 按时间倒序返回；status/category 传 all 表示不筛选，q 为空表示不按关键词过滤。
   * limit 取库容量即「全部」。
   */
  async list(options: FeedbackListOptions = {}): Promise<FeedbackEntry[]> {
    const status = options.status ?? 'all'
    const category = options.category ?? 'all'
    const keyword = (options.q ?? '').trim().toLowerCase()
    const limit = clampLimit(options.limit)
    // 写入追加在尾部，倒序即「最新在前」；同毫秒写入也保持后写在前
    const ordered = [...this.cache.feedback].reverse()
    let filtered = ordered
    if (status !== 'all') filtered = filtered.filter(entry => entry.status === status)
    if (category !== 'all') filtered = filtered.filter(entry => entry.category === category)
    if (keyword) filtered = filtered.filter(entry => matchesKeyword(entry, keyword))
    return filtered.slice(0, limit)
  }

  /**
   * 管理员更新：状态必填，回复可选。
   * 回复缺省表示保留；空串清空回复及其时间与处理人；非空回复记录回复时间与处理人。
   * 退回 new 只清 handledAt/handledBy，回复内容保留。
   * 找不到返回 undefined（路由据此回 404）。
   */
  async update(id: string, change: FeedbackUpdate, adminId: string): Promise<FeedbackEntry | undefined> {
    let updated: FeedbackEntry | undefined
    await this.enqueueWrite(current => ({
      feedback: current.feedback.map(entry => {
        if (entry.id !== id) return entry
        let next: FeedbackEntry = { ...entry, status: change.status }
        if (change.status === 'resolved') {
          // 已经处理过就保留原来的处理时间，避免只是补一条回复就把处理时间刷新掉
          if (entry.status !== 'resolved' || !entry.handledAt) {
            next.handledAt = new Date().toISOString()
            next.handledBy = adminId
          }
        } else {
          next.handledAt = ''
          next.handledBy = ''
        }
        if (change.reply !== undefined) {
          const text = change.reply.trim()
          if (text) {
            next.reply = text
            next.repliedAt = new Date().toISOString()
            next.repliedBy = adminId
          } else {
            next.reply = ''
            next.repliedAt = ''
            next.repliedBy = ''
          }
        }
        updated = next
        return next
      }),
    }))
    return updated
  }

  /** 全库计数（不受筛选条件影响），后台据此显示三个筛选页签的数量。 */
  counts(): { all: number; new: number; resolved: number } {
    let pending = 0
    for (const entry of this.cache.feedback) {
      if (entry.status === 'new') pending += 1
    }
    return {
      all: this.cache.feedback.length,
      new: pending,
      resolved: this.cache.feedback.length - pending,
    }
  }
}

function clampLimit(value: number | undefined): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return MAX_ENTRIES
  return Math.min(parsed, MAX_ENTRIES)
}

/** 读盘数据不可信：逐条校验字段、白名单化枚举，并裁到保留上限。 */
function normalizeDatabase(input: Partial<FeedbackDatabase> | null | undefined): FeedbackDatabase {
  const raw = Array.isArray(input?.feedback) ? input.feedback : []
  const feedback = raw
    .filter((entry): entry is FeedbackEntry => Boolean(entry) && typeof entry.id === 'string' && entry.id.length > 0)
    .map(entry => normalizeEntry(entry))

  return {
    feedback: feedback.length > MAX_ENTRIES ? feedback.slice(feedback.length - MAX_ENTRIES) : feedback,
  }
}

function normalizeEntry(entry: FeedbackEntry): FeedbackEntry {
  return {
    id: entry.id,
    userId: String(entry.userId || ''),
    username: String(entry.username || ''),
    displayName: String(entry.displayName || ''),
    category: CATEGORIES.includes(entry.category) ? entry.category : 'other',
    content: String(entry.content || ''),
    page: String(entry.page || ''),
    appVersion: String(entry.appVersion || ''),
    createdAt: String(entry.createdAt || ''),
    status: entry.status === 'resolved' ? 'resolved' : 'new',
    handledAt: String(entry.handledAt || ''),
    handledBy: String(entry.handledBy || ''),
    reply: String(entry.reply || ''),
    repliedAt: String(entry.repliedAt || ''),
    repliedBy: String(entry.repliedBy || ''),
  }
}

/** 关键词匹配账号、昵称、正文、回复与页面；各字段之间不跨字段命中。 */
function matchesKeyword(entry: FeedbackEntry, keyword: string): boolean {
  const fields = [
    entry.userId,
    entry.username,
    entry.displayName,
    entry.content,
    entry.reply,
    entry.page,
  ]
  return fields.some(field => field.toLowerCase().includes(keyword))
}
