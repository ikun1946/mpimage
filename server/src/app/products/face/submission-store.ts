import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

export type FaceSubmissionKind = 'card' | 'reference'
export type FaceSubmissionStatus = 'pending' | 'approved' | 'rejected'

export interface FaceSubmissionActor {
  userId: string
  username: string
  displayName: string
}

export interface FaceSubmission {
  id: string
  kind: FaceSubmissionKind
  status: FaceSubmissionStatus
  userId: string
  username: string
  displayName: string
  category: string
  targetId: string
  card: Record<string, any> | null
  imagePath: string
  imageBytes: number
  imageWidth: number
  imageHeight: number
  submittedAt: string
  updatedAt: string
  reviewedAt: string
  reviewedBy: string
  reviewedByName: string
  reviewNote: string
  publishedAt: string
  publishedTargetId: string
  publishedPath: string
}

export interface SubmissionInput {
  kind: FaceSubmissionKind
  category: string
  targetId: string
  card?: Record<string, any> | null
  imagePath?: string
  imageBytes?: number
  imageWidth?: number
  imageHeight?: number
}

export class FaceSubmissionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'FaceSubmissionError'
  }
}

const MAX_PENDING_PER_USER = 20
const MAX_TEXT = 600

const nowIso = () => new Date().toISOString()
const clip = (value: unknown, max = MAX_TEXT) =>
  typeof value === 'string' ? value.slice(0, max) : ''

function normalize(input: unknown): FaceSubmission | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const source = input as Record<string, any>
  const kind = source.kind === 'reference' ? 'reference' : 'card'
  const status = source.status === 'approved' || source.status === 'rejected'
    ? source.status
    : 'pending'
  const targetId = clip(source.targetId, 100).trim()
  if (!targetId) return null
  const imagePath = clip(source.imagePath, 500).trim()
  return {
    id: clip(source.id, 100).trim() || randomUUID(),
    kind,
    status,
    userId: clip(source.userId, 100).trim(),
    username: clip(source.username, 100).trim(),
    displayName: clip(source.displayName, 100).trim(),
    category: clip(source.category, 80).trim(),
    targetId,
    card: source.card && typeof source.card === 'object' && !Array.isArray(source.card)
      ? source.card
      : null,
    imagePath: imagePath && !imagePath.includes('..') && !/^https?:\/\//i.test(imagePath)
      ? imagePath
      : '',
    imageBytes: Math.max(0, Number(source.imageBytes) || 0),
    imageWidth: Math.max(0, Number(source.imageWidth) || 0),
    imageHeight: Math.max(0, Number(source.imageHeight) || 0),
    submittedAt: clip(source.submittedAt, 50) || nowIso(),
    updatedAt: clip(source.updatedAt, 50) || nowIso(),
    reviewedAt: clip(source.reviewedAt, 50),
    reviewedBy: clip(source.reviewedBy, 100),
    reviewedByName: clip(source.reviewedByName, 100),
    reviewNote: clip(source.reviewNote, 500),
    publishedAt: clip(source.publishedAt, 50),
    publishedTargetId: clip(source.publishedTargetId, 100),
    publishedPath: clip(source.publishedPath, 500),
  }
}

export class FaceSubmissionStore {
  private readonly file: string
  private submissions: FaceSubmission[] = []
  private pending: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string) {
    this.file = join(dataDir, 'face-submissions.json')
  }

  async init(): Promise<void> {
    if (!existsSync(this.file)) return
    const raw = JSON.parse(await readFile(this.file, 'utf8'))
    const list = Array.isArray(raw?.submissions) ? raw.submissions : []
    this.submissions = list.map(normalize).filter(Boolean) as FaceSubmission[]
  }

  list(status = 'all'): FaceSubmission[] {
    return this.submissions
      .filter(item => status === 'all' || item.status === status)
      .sort((left, right) => {
        if (left.status === 'pending' && right.status !== 'pending') return -1
        if (left.status !== 'pending' && right.status === 'pending') return 1
        return right.updatedAt.localeCompare(left.updatedAt)
      })
      .map(item => JSON.parse(JSON.stringify(item)) as FaceSubmission)
  }

  listMine(userId: string): FaceSubmission[] {
    return this.list('all')
      .filter(item => item.userId === userId)
      .map(item => ({
        ...item,
        reviewedBy: '',
        reviewedByName: '',
      }))
  }

  get(id: string): FaceSubmission | null {
    const found = this.submissions.find(item => item.id === id)
    return found ? JSON.parse(JSON.stringify(found)) as FaceSubmission : null
  }

  async upsert(actor: FaceSubmissionActor, input: SubmissionInput): Promise<FaceSubmission> {
    const id = clip(input.targetId, 100).trim()
    if (!id) throw new FaceSubmissionError('目标卡片 ID 不能为空')
    const kind: FaceSubmissionKind = input.kind === 'reference' ? 'reference' : 'card'
    const category = clip(input.category, 80).trim()
    if (!category) throw new FaceSubmissionError('分类不能为空')

    const existing = this.submissions.find(item =>
      item.userId === actor.userId
      && item.kind === kind
      && item.targetId === id
      && item.status !== 'approved',
    )
    const pendingForUser = this.submissions.filter(item =>
      item.userId === actor.userId && item.status === 'pending',
    ).length
    if (!existing && pendingForUser >= MAX_PENDING_PER_USER) {
      throw new FaceSubmissionError(`待审核内容最多 ${MAX_PENDING_PER_USER} 条，请等待现有内容处理`, 429)
    }

    const target = existing || {
      id: randomUUID(),
      kind,
      status: 'pending' as const,
      userId: actor.userId,
      username: actor.username,
      displayName: actor.displayName,
      category,
      targetId: id,
      card: null,
      imagePath: '',
      imageBytes: 0,
      imageWidth: 0,
      imageHeight: 0,
      submittedAt: nowIso(),
      updatedAt: nowIso(),
      reviewedAt: '',
      reviewedBy: '',
      reviewedByName: '',
      reviewNote: '',
      publishedAt: '',
      publishedTargetId: '',
      publishedPath: '',
    }

    Object.assign(target, {
      status: 'pending',
      displayName: actor.displayName || actor.username,
      username: actor.username,
      category,
      card: input.card ?? target.card,
      imagePath: input.imagePath ?? target.imagePath,
      imageBytes: input.imageBytes ?? target.imageBytes,
      imageWidth: input.imageWidth ?? target.imageWidth,
      imageHeight: input.imageHeight ?? target.imageHeight,
      updatedAt: nowIso(),
      reviewedAt: '',
      reviewedBy: '',
      reviewedByName: '',
      reviewNote: '',
      publishedAt: '',
      publishedTargetId: '',
      publishedPath: '',
    })
    if (!existing) this.submissions.push(target)
    await this.write()
    return this.get(target.id)!
  }

  async updateDraft(
    id: string,
    patch: {
      category?: string
      targetId?: string
      card?: Record<string, any> | null
      imagePath?: string
      imageBytes?: number
      imageWidth?: number
      imageHeight?: number
      reviewNote?: string
    },
  ): Promise<FaceSubmission> {
    const item = this.require(id)
    if (item.status !== 'pending') throw new FaceSubmissionError('只有待审核内容可以修改', 409)
    const nextCategory = patch.category !== undefined
      ? clip(patch.category, 80).trim()
      : item.category
    if (!nextCategory) throw new FaceSubmissionError('分类不能为空')
    const nextTargetId = patch.targetId !== undefined
      ? clip(patch.targetId, 100).trim()
      : item.targetId
    if (!nextTargetId) throw new FaceSubmissionError('目标卡片 ID 不能为空')
    const duplicate = this.submissions.find(other =>
      other.id !== id
      && other.userId === item.userId
      && other.kind === item.kind
      && other.targetId === nextTargetId
      && other.status !== 'approved',
    )
    if (duplicate) {
      throw new FaceSubmissionError('同一用户、同一类型和目标只能保留一条未通过记录', 409)
    }
    const nextImagePath = patch.imagePath !== undefined
      ? clip(patch.imagePath, 500).trim()
      : item.imagePath
    if (nextImagePath.includes('..') || /^https?:\/\//i.test(nextImagePath)) {
      throw new FaceSubmissionError('图片路径无效')
    }
    item.category = nextCategory
    item.targetId = nextTargetId
    if (patch.card !== undefined) item.card = patch.card
    if (patch.imagePath !== undefined) item.imagePath = nextImagePath
    if (patch.imageBytes !== undefined) item.imageBytes = Math.max(0, Number(patch.imageBytes) || 0)
    if (patch.imageWidth !== undefined) item.imageWidth = Math.max(0, Number(patch.imageWidth) || 0)
    if (patch.imageHeight !== undefined) item.imageHeight = Math.max(0, Number(patch.imageHeight) || 0)
    if (patch.reviewNote !== undefined) item.reviewNote = clip(patch.reviewNote, 500)
    item.updatedAt = nowIso()
    await this.write()
    return this.get(id)!
  }

  async resubmit(id: string, userId: string): Promise<FaceSubmission> {
    const item = this.require(id)
    if (item.userId !== userId) throw new FaceSubmissionError('只能重新提交自己的内容', 403)
    if (item.status !== 'rejected') throw new FaceSubmissionError('只有未通过的内容可以重新提交', 409)
    item.status = 'pending'
    item.updatedAt = nowIso()
    item.reviewedAt = ''
    item.reviewedBy = ''
    item.reviewedByName = ''
    item.reviewNote = ''
    await this.write()
    return this.get(id)!
  }

  async remove(id: string, userId: string): Promise<void> {
    const item = this.require(id)
    if (item.userId !== userId) throw new FaceSubmissionError('只能清理自己的提交', 403)
    if (item.status === 'approved') throw new FaceSubmissionError('已发布内容不能通过个人提交删除', 409)
    this.submissions = this.submissions.filter(entry => entry.id !== id)
    await this.write()
  }

  async reject(id: string, actor: FaceSubmissionActor, note: string): Promise<FaceSubmission> {
    const item = this.require(id)
    if (item.status !== 'pending') throw new FaceSubmissionError('只有待审核内容可以驳回', 409)
    const reason = clip(note, 500).trim()
    if (!reason) throw new FaceSubmissionError('请填写驳回原因')
    item.status = 'rejected'
    item.reviewedAt = nowIso()
    item.reviewedBy = actor.userId
    item.reviewedByName = actor.displayName || actor.username
    item.reviewNote = reason
    item.updatedAt = item.reviewedAt
    await this.write()
    return this.get(id)!
  }

  async markApproved(
    id: string,
    actor: FaceSubmissionActor,
    publishedPath = '',
    publishedTargetId = '',
  ): Promise<FaceSubmission> {
    const item = this.require(id)
    if (item.status !== 'pending') throw new FaceSubmissionError('只有待审核内容可以发布', 409)
    item.status = 'approved'
    item.reviewedAt = nowIso()
    item.reviewedBy = actor.userId
    item.reviewedByName = actor.displayName || actor.username
    item.publishedAt = item.reviewedAt
    item.publishedTargetId = clip(publishedTargetId, 100)
    item.publishedPath = clip(publishedPath, 500)
    item.updatedAt = item.reviewedAt
    await this.write()
    return this.get(id)!
  }

  private require(id: string): FaceSubmission {
    const item = this.submissions.find(entry => entry.id === id)
    if (!item) throw new FaceSubmissionError('提交记录不存在', 404)
    return item
  }

  private async write(): Promise<void> {
    const run = async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(
        temp,
        `${JSON.stringify({ version: 1, submissions: this.submissions }, null, 2)}\n`,
        'utf8',
      )
      await rename(temp, this.file)
    }
    this.pending = this.pending.then(run, run)
    await this.pending
  }
}
