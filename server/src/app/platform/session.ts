import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface Session {
  token: string
  userId: string
  expiresAt: number
}

interface SessionFile {
  version: 1
  sessions: Session[]
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 会话表。
 *
 * 令牌会落盘（默认 <dataDir>/sessions.json），所以重启服务、停用后再启动
 * 都不会丢掉登录状态；只有主动退出登录、账号被停用/删除，或超过 7 天有效期
 * 才会失效。落盘失败不影响本次登录，内存里的会话仍然可用。
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly secret: string
  private readonly file: string
  /** 串行化写盘：连续登录/退出时不会出现两个写操作互相覆盖 */
  private writes: Promise<void> = Promise.resolve()

  constructor(secret: string, file = '') {
    this.secret = secret
    this.file = file
  }

  /** 读取上次落盘的会话，跳过过期与格式不完整的条目。 */
  async init(): Promise<void> {
    if (!this.file) return

    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<SessionFile>
      const now = Date.now()
      for (const item of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
        if (!item || typeof item.token !== 'string' || typeof item.userId !== 'string') continue
        if (typeof item.expiresAt !== 'number' || item.expiresAt <= now) continue
        this.sessions.set(item.token, { token: item.token, userId: item.userId, expiresAt: item.expiresAt })
      }
    } catch {
      // 没有会话文件或文件损坏：从空会话表开始，重新登录一次即可
    }
  }

  create(userId: string): Session {
    const token = randomBytes(32).toString('hex')
    const session: Session = {
      token,
      userId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    }
    this.sessions.set(token, session)
    this.prune()
    this.persist()
    return session
  }

  get(token: string | undefined): Session | undefined {
    if (!token) return undefined
    const session = this.sessions.get(token)
    if (!session) return undefined
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token)
      this.persist()
      return undefined
    }
    return session
  }

  destroy(token: string | undefined): void {
    if (!token || !this.sessions.delete(token)) return
    this.persist()
  }

  destroyByUser(userId: string): void {
    let removed = false
    for (const [token, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(token)
        removed = true
      }
    }
    if (removed) this.persist()
  }

  /** 校验 cookie 签名，防止伪造。 */
  verifySignature(raw: string, signature: string): boolean {
    const expected = createHmac('sha256', this.secret).update(raw).digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  sign(raw: string): string {
    return createHmac('sha256', this.secret).update(raw).digest('hex')
  }

  private prune(): void {
    const now = Date.now()
    for (const [token, session] of this.sessions) {
      if (session.expiresAt < now) this.sessions.delete(token)
    }
  }

  private persist(): void {
    if (!this.file) return

    const payload: SessionFile = { version: 1, sessions: [...this.sessions.values()] }
    const text = JSON.stringify(payload, null, 2)
    const file = this.file
    this.writes = this.writes
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        const temp = `${file}.tmp`
        await writeFile(temp, text, 'utf8')
        await rename(temp, file)
      })
      .catch(() => {
        // 只影响「重启后是否还记得登录」，不能因此打断当前请求
      })
  }
}

export const SESSION_COOKIE = 'huajing_session'