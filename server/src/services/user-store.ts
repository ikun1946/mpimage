import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hashPassword, verifyPassword } from '../utils/password.js'

export interface UserRecord {
  id: string
  username: string
  displayName: string
  passwordSalt: string
  passwordHash: string
  role: 'admin' | 'user'
  disabled: boolean
  /** 自助申请账号，等待管理员审核。审核通过后才置为 false 并可登录 */
  pending: boolean
  createdAt: string
  lastLoginAt: string
}

export interface PublicUser {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'user'
  disabled: boolean
  pending: boolean
  createdAt: string
  lastLoginAt: string
}

export interface UserDatabase {
  users: UserRecord[]
}

/** 登录结果：区分「密码不对」与「还在等审核」，前者不泄露账号状态 */
export type AuthResult =
  | { ok: true; user: UserRecord }
  | { ok: false; reason: 'invalid' | 'pending' }

export function toPublicUser(record: UserRecord): PublicUser {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    role: record.role,
    disabled: record.disabled,
    pending: record.pending === true,
    createdAt: record.createdAt,
    lastLoginAt: record.lastLoginAt,
  }
}

class DisplayNameTakenError extends Error {
  constructor() {
    super('这个名称已被使用，换一个试试')
    this.name = 'DisplayNameTakenError'
  }
}

export class UserStore {
  private readonly file: string
  private cache: UserDatabase | null = null

  constructor(file: string) {
    this.file = file
  }

  async read(): Promise<UserDatabase> {
    if (this.cache) return this.cache

    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<UserDatabase>
      this.cache = {
        users: Array.isArray(parsed.users)
          ? parsed.users
              .filter(user => user && typeof user.id === 'string')
              // 旧数据没有 pending 字段：一律视为已通过审核
              .map(user => ({ ...user, pending: user.pending === true }))
          : [],
      }
    } catch {
      this.cache = { users: [] }
    }
    return this.cache
  }

  async write(database: UserDatabase): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(database, null, 2), 'utf8')
    await rename(temp, this.file)
    this.cache = database
  }

  /** 已通过审核的账号（待审核的申请不算账号） */
  async list(): Promise<UserRecord[]> {
    return (await this.read()).users.filter(user => !user.pending)
  }

  /** 待审核的自助申请，最新的在前 */
  async listPending(): Promise<UserRecord[]> {
    return (await this.read())
      .users.filter(user => user.pending)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** 查全库（含待审核），用户名唯一性判断与登录都要用 */
  async listAll(): Promise<UserRecord[]> {
    return (await this.read()).users
  }

  async findByUsername(username: string): Promise<UserRecord | undefined> {
    const normalized = username.trim().toLowerCase()
    return (await this.read()).users.find(user => user.username.toLowerCase() === normalized)
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    return (await this.read()).users.find(user => user.id === id)
  }

  /**
   * 管理员读取「账号库里的任意账号」：查询必须同时给出操作者 ID，
   * 并且操作者本身要是未停用的管理员，否则返回 undefined。
   *
   * 本项目的管理模型是「管理员管理整个账号库」，所以作用对象不能绑到调用者自身；
   * 把「操作者必须是管理员」这条校验下沉到数据层，任何调用点都没法只拿请求里的
   * 记录 ID 直接查库——越权的那一步在数据层就被拒绝。
   */
  async findByIdForActor(id: string, actorId: string): Promise<UserRecord | undefined> {
    const database = await this.read()
    const actor = database.users.find(
      user => user.id === actorId && user.role === 'admin' && !user.disabled && !user.pending,
    )
    if (!actor) return undefined
    return database.users.find(user => user.id === id)
  }

  /** 管理员创建账号。用户名唯一。 */
  async create(input: {
    username: string
    displayName: string
    password: string
    role: 'admin' | 'user'
  }): Promise<UserRecord> {
    const database = await this.read()
    const username = input.username.trim()

    if (!username) throw new Error('用户名不能为空')
    if (database.users.some(user => user.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('用户名已存在')
    }
    if (input.displayName.trim()) {
      this.assertDisplayNameFree(database, input.displayName, '')
    }

    const { salt, hash } = await hashPassword(input.password)
    const record: UserRecord = {
      id: randomUUID(),
      username,
      displayName: input.displayName.trim() || username,
      passwordSalt: salt,
      passwordHash: hash,
      role: input.role,
      disabled: false,
      pending: false,
      createdAt: new Date().toISOString(),
      lastLoginAt: '',
    }

    database.users.push(record)
    await this.write(database)
    return record
  }

  /**
   * 自助申请账号：落一条 pending 记录，登录接口会拒绝，直到管理员审核通过。
   * 返回值不对外暴露哈希等字段。
   */
  async register(input: {
    username: string
    displayName: string
    password: string
  }): Promise<UserRecord> {
    const database = await this.read()
    const username = input.username.trim()

    if (!username) throw new Error('用户名不能为空')
    if (database.users.some(user => user.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('这个用户名已被使用，换一个试试')
    }
    if (input.displayName.trim()) {
      this.assertDisplayNameFree(database, input.displayName, '')
    }

    const { salt, hash } = await hashPassword(input.password)
    const record: UserRecord = {
      id: randomUUID(),
      username,
      displayName: input.displayName.trim() || username,
      passwordSalt: salt,
      passwordHash: hash,
      role: 'user',
      disabled: false,
      pending: true,
      createdAt: new Date().toISOString(),
      lastLoginAt: '',
    }

    database.users.push(record)
    await this.write(database)
    return record
  }

  /** 审核通过：清掉 pending，账号立即可登录 */
  async approve(id: string): Promise<UserRecord | undefined> {
    const database = await this.read()
    const record = database.users.find(user => user.id === id)
    if (!record || !record.pending) return undefined
    record.pending = false
    await this.write(database)
    return record
  }

  /** 拒绝申请：直接删除这条待审核记录 */
  async reject(id: string): Promise<UserRecord | undefined> {
    const database = await this.read()
    const index = database.users.findIndex(user => user.id === id && user.pending)
    if (index < 0) return undefined
    const [record] = database.users.splice(index, 1)
    await this.write(database)
    return record
  }

  async setDisabled(id: string, disabled: boolean): Promise<UserRecord | undefined> {
    const database = await this.read()
    const record = database.users.find(user => user.id === id)
    if (!record) return undefined
    record.disabled = disabled
    await this.write(database)
    return record
  }

  async setPassword(id: string, password: string): Promise<UserRecord | undefined> {
    const database = await this.read()
    const record = database.users.find(user => user.id === id)
    if (!record) return undefined
    const { salt, hash } = await hashPassword(password)
    record.passwordSalt = salt
    record.passwordHash = hash
    await this.write(database)
    return record
  }

  /** 显示名唯一：去掉首尾空格后大小写不敏感地比对，pending 的申请也占名 */
  private assertDisplayNameFree(
    database: UserDatabase,
    displayName: string,
    exceptId: string,
  ): void {
    const target = displayName.trim().toLowerCase()
    if (!target) return
    const taken = database.users.some(
      user => user.id !== exceptId && user.displayName.trim().toLowerCase() === target,
    )
    if (taken) throw new DisplayNameTakenError()
  }

  async setDisplayName(id: string, displayName: string): Promise<UserRecord | undefined> {
    const database = await this.read()
    const record = database.users.find(user => user.id === id)
    if (!record) return undefined

    const next = displayName.trim() || record.username
    this.assertDisplayNameFree(database, next, record.id)
    record.displayName = next
    await this.write(database)
    return record
  }

  async remove(id: string): Promise<boolean> {
    const database = await this.read()
    const index = database.users.findIndex(user => user.id === id)
    if (index < 0) return false
    database.users.splice(index, 1)
    await this.write(database)
    return true
  }

  async authenticate(username: string, password: string): Promise<AuthResult> {
    const record = await this.findByUsername(username)
    if (!record) {
      // 即便用户不存在也做一次哈希运算，避免用耗时差异探测用户名是否存在
      await verifyPassword(password, { salt: 'x', hash: 'x' })
      return { ok: false, reason: 'invalid' }
    }

    const ok = await verifyPassword(password, {
      salt: record.passwordSalt,
      hash: record.passwordHash,
    })
    // 密码对不上时一律按「用户名或密码不正确」处理，不透露账号是否存在
    if (!ok) return { ok: false, reason: 'invalid' }
    // 密码正确才说明是自己人，这时告知「还在等审核」不会泄露信息
    if (record.pending) return { ok: false, reason: 'pending' }
    if (record.disabled) return { ok: false, reason: 'invalid' }

    record.lastLoginAt = new Date().toISOString()
    await this.write(await this.read())
    return { ok: true, user: record }
  }
}
