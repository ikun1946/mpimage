import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ProjectAsset {
  id: string
  type: 'role' | 'scene' | 'prop'
  name: string
  fields: Array<{ label: string; value: string }>
  raw: string
  ratio: string
  styleId: string
  status: 'idle' | 'queued' | 'generating' | 'done' | 'error'
  prompt: string
  resultUrl: string
  width: number
  height: number
  error: string
  updatedAt: string
  /** 角色面部参考图：存储目录里的相对路径（参考图/<文件名>） */
  referencePath?: string
  /** 历史生成图（新→旧，最多 20 条） */
  history?: Array<{ url: string; w?: number; h?: number; at?: string }>
  /** 主要图片：批量下载与表格缩略图都用它 */
  primaryUrl?: string
}

export interface ProjectStyles {
  role: Array<{ id: string; name: string; description: string; updatedAt?: string }>
  scene: Array<{ id: string; name: string; description: string; updatedAt?: string }>
  prop: Array<{ id: string; name: string; description: string; updatedAt?: string }>
}

export interface Project {
  id: string
  /** 归属账号 id；历史遗留数据为 '' 时仅管理员/迁移前可见 */
  ownerId: string
  name: string
  fileName: string
  importedAt: string
  updatedAt: string
  assets: ProjectAsset[]
  styles: ProjectStyles
  defaultStyle: { role: string; scene: string; prop: string }
  bulkParams: { role: Record<string, string>; scene: Record<string, string>; prop: Record<string, string> }
}

export interface ProjectDatabase {
  projects: Project[]
  activeProjectId: string
}

const TYPES = ['role', 'scene', 'prop'] as const

export class ProjectStore {
  private readonly file: string
  private cache: ProjectDatabase | null = null
  private pending: Promise<ProjectDatabase> = Promise.resolve({ projects: [], activeProjectId: '' })

  constructor(file: string) {
    this.file = file
  }

  async read(): Promise<ProjectDatabase> {
    if (this.cache) return this.cache

    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<ProjectDatabase>
      this.cache = normalizeDatabase(parsed)
    } catch {
      this.cache = { projects: [], activeProjectId: '' }
    }
    return this.cache
  }

  /**
   * 写入磁盘。所有写操作排成一条链，避免并发时互相覆盖。
   * 这里刻意不做缓存替换式的原地修改，而是每次都基于最新状态重新构造，
   * 否则「旧对象被改、缓存被换」会让并发写入丢失数据。
   */
  private enqueueWrite(mutator: (current: ProjectDatabase) => ProjectDatabase): Promise<ProjectDatabase> {
    const run = async () => {
      const current = this.cache ?? { projects: [], activeProjectId: '' }
      const next = normalizeDatabase(mutator(current))
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

  async list(): Promise<Project[]> {
    return (await this.read()).projects
  }

  /** 列出某账号自己的项目（activeProjectId 也按账号区分）。 */
  async listForOwner(ownerId: string): Promise<{ projects: Project[]; activeProjectId: string }> {
    const database = await this.read()
    return {
      projects: database.projects.filter(project => (project.ownerId || '') === ownerId),
      activeProjectId: this.activeIdForOwner(database, ownerId),
    }
  }

  /** 取该账号的当前项目 id；未设置时回落到其第一个项目。 */
  activeIdForOwner(database: ProjectDatabase, ownerId: string): string {
    const own = database.projects.filter(project => (project.ownerId || '') === ownerId)
    const active = own.find(project => project.id === database.activeProjectId)
    return active?.id || own[0]?.id || ''
  }

  async find(id: string): Promise<Project | undefined> {
    return (await this.read()).projects.find(project => project.id === id)
  }

  /** 新建一个空项目，名称可自定义。 */
  async create(input: { name?: string; fileName?: string; ownerId?: string }): Promise<Project> {
    const now = new Date().toISOString()
    const project: Project = {
      id: randomUUID(),
      ownerId: input.ownerId || '',
      name: (input.name || input.fileName || '未命名项目').trim(),
      fileName: input.fileName || '',
      importedAt: now,
      updatedAt: now,
      assets: [],
      styles: { role: [], scene: [], prop: [] },
      defaultStyle: { role: '', scene: '', prop: '' },
      bulkParams: { role: {}, scene: {}, prop: {} },
    }

    const database = await this.enqueueWrite(current => ({
      projects: [...current.projects, project],
      activeProjectId: project.id,
    }))
    const created = database.projects.find(item => item.id === project.id)
    return created ?? project
  }

  async save(id: string, patch: Partial<Project>): Promise<Project | undefined> {
    const updatedAt = new Date().toISOString()
    let saved: Project | undefined

    await this.enqueueWrite(current => {
      const projects = current.projects.map(project =>
        project.id === id
          ? { ...project, ...patch, id: project.id, updatedAt }
          : project)
      saved = projects.find(item => item.id === id)
      return { projects, activeProjectId: current.activeProjectId }
    })

    return saved
  }

  async remove(id: string): Promise<boolean> {
    let removed = false
    await this.enqueueWrite(current => {
      const projects = current.projects.filter(project => {
        if (project.id !== id) return true
        removed = true
        return false
      })
      return {
        projects,
        activeProjectId: current.activeProjectId === id
          ? projects[0]?.id || ''
          : current.activeProjectId,
      }
    })
    return removed
  }

  async setActive(id: string): Promise<Project | undefined> {
    let active: Project | undefined
    await this.enqueueWrite(current => {
      active = current.projects.find(item => item.id === id)
      return { projects: current.projects, activeProjectId: active ? id : current.activeProjectId }
    })
    return active
  }
}

function normalizeDatabase(input: Partial<ProjectDatabase> | null | undefined): ProjectDatabase {
  const projects = Array.isArray(input?.projects) ? input.projects : []
  const normalized = projects
    .filter((project): project is Project => Boolean(project) && typeof project.id === 'string')
    .map(project => normalizeProject(project))

  const activeId = normalized.some(project => project.id === input?.activeProjectId)
    ? (input?.activeProjectId as string)
    : normalized[0]?.id || ''

  return { projects: normalized, activeProjectId: activeId }
}

function normalizeProject(input: Project): Project {
  const styles: ProjectStyles = { role: [], scene: [], prop: [] }
  for (const type of TYPES) {
    const list = Array.isArray(input.styles?.[type]) ? input.styles[type] : []
    styles[type] = list
      .filter((item): item is { id: string; name: string; description: string; updatedAt?: string } =>
        Boolean(item) && typeof item.id === 'string' && item.id.length > 0)
      .map(item => ({
        id: item.id,
        name: String(item.name || '未命名风格'),
        description: String(item.description || ''),
        updatedAt: item.updatedAt || '',
      }))
  }

  const defaultStyle = { role: '', scene: '', prop: '' }
  for (const type of TYPES) {
    const preferred = input.defaultStyle?.[type] ?? ''
    defaultStyle[type] = styles[type].some(item => item.id === preferred)
      ? preferred
      : styles[type][0]?.id || ''
  }

  const bulkParams: Project['bulkParams'] = { role: {}, scene: {}, prop: {} }
  for (const type of TYPES) {
    const item = input.bulkParams?.[type]
    bulkParams[type] = item && typeof item === 'object' ? { ...item } : {}
  }

  return {
    id: input.id,
    ownerId: String(input.ownerId || ''),
    name: String(input.name || input.fileName || '未命名项目'),
    fileName: String(input.fileName || ''),
    importedAt: String(input.importedAt || ''),
    updatedAt: String(input.updatedAt || ''),
    assets: Array.isArray(input.assets) ? input.assets : [],
    styles,
    defaultStyle,
    bulkParams,
  }
}
