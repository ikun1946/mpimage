/**
 * 捏脸卡片目录：服务端是唯一可写的目录来源。
 *
 * 首次启动用 server/assets/face/catalog-seed.json 播种；之后管理员在
 * 桌面控制台的「捏脸卡片」窗口里修改，保存到 data/face-cards.json。
 * 每次保存前先做结构校验，并保留最近 5 份备份，避免改坏后只能重装。
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface CatalogIssue {
  path: string
  message: string
}

export interface FaceCatalog {
  schemaVersion: number
  revision: number
  updatedAt: string
  version?: string
  generated_from?: string
  total: number
  groups: Array<Record<string, any>>
  categories: Array<Record<string, any>>
  conflict_rules: Array<Record<string, any>>
  compatible_notes?: unknown
  visual_styles: Array<Record<string, any>>
  negatives: Array<Record<string, any>>
  negative_triggers?: unknown
  presets: Array<Record<string, any>>
  references: Record<string, string>
}

export interface FaceCatalogMeta {
  revision: number
  updatedAt: string
  total: number
  categories: number
  presets: number
  references: number
}

export class FaceCatalogError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: CatalogIssue[] = [],
  ) {
    super(message)
    this.name = 'FaceCatalogError'
  }
}

const KEEP_BACKUPS = 5
const MAX_TEXT = 4000
const GENDER_AFFINITY_VALUES = new Set(['male', 'female', 'neutral'])

const asObject = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null

const text = (value: unknown, max = MAX_TEXT): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

const truthyArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function normalizedGenderAffinity(value: unknown, issuePath: string, issues: CatalogIssue[]): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? [value]
      : []
  const labels: string[] = []
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const label = raw.trim().toLowerCase()
    if (!GENDER_AFFINITY_VALUES.has(label)) {
      issues.push({
        path: issuePath,
        message: `性别适配只能是 male / female / neutral，收到：${raw}`,
      })
      continue
    }
    if (!labels.includes(label)) labels.push(label)
  }
  return labels.length ? labels : ['neutral']
}

/** 公开目录不返回隐藏项；管理员目录保留全部。 */
function visibleCatalog(catalog: FaceCatalog): FaceCatalog {
  const visibleIds = new Set<string>()
  const categories: Array<Record<string, any>> = catalog.categories
    .filter(category => category.visible !== false)
    .map(category => {
      const items = truthyArray(category.items)
        .map(item => asObject(item))
        .filter((item): item is Record<string, any> => Boolean(item))
        .filter(item => item.visible !== false)
      for (const item of items) {
        if (typeof item.id === 'string') visibleIds.add(item.id)
      }
      return { ...category, items }
    })
    .filter(category => category.items.length > 0)

  const groups = catalog.groups
    .filter(group => group.visible !== false)
    .map(group => ({
      ...group,
      categories: truthyArray(group.categories).filter(key =>
        categories.some(category => category.key === key),
      ),
    }))
    .filter(group => group.categories.length > 0)

  const presets = catalog.presets
    .filter(preset => preset.visible !== false)
    .map(preset => {
      const selections: Record<string, string[]> = {}
      for (const [category, ids] of Object.entries(asObject(preset.selections) || {})) {
        const kept = truthyArray(ids).filter(
          (id): id is string => typeof id === 'string' && visibleIds.has(id),
        )
        if (kept.length) selections[category] = kept
      }
      return { ...preset, selections }
    })

  const references = Object.fromEntries(
    Object.entries(catalog.references).filter(([id]) => visibleIds.has(id)),
  )

  return {
    ...catalog,
    groups,
    categories,
    presets,
    references,
    total: categories.reduce((sum, category) => sum + category.items.length, 0),
  }
}

/**
 * 严格校验并归一化目录。返回值是规范化后的目录，调用方负责写盘。
 * 错误路径带 categories[3].items[2] 这种位置，桌面编辑器可以直接定位。
 */
export function normalizeFaceCatalog(input: unknown): {
  catalog: FaceCatalog
  issues: CatalogIssue[]
} {
  const issues: CatalogIssue[] = []
  const source = asObject(input)
  if (!source) {
    return {
      catalog: emptyCatalog(),
      issues: [{ path: '', message: '目录必须是一个 JSON 对象' }],
    }
  }

  const groups = truthyArray(source.groups).map((raw, groupIndex) => {
    const group = asObject(raw) || {}
    if (typeof group.key !== 'string' || !group.key.trim()) {
      issues.push({ path: `groups[${groupIndex}].key`, message: '分组 key 不能为空' })
    }
    return {
      ...group,
      key: text(group.key, 80).trim(),
      title_zh: text(group.title_zh, 120),
      title_en: text(group.title_en, 120),
      blurb: text(group.blurb, 500),
      visible: group.visible !== false,
      categories: truthyArray(group.categories).filter(
        (key): key is string => typeof key === 'string' && Boolean(key),
      ),
    }
  })

  const itemIds = new Map<string, { category: string; item: Record<string, any> }>()
  const categoryKeys = new Set<string>()
  const categories = truthyArray(source.categories).map((raw, categoryIndex) => {
    const category = asObject(raw) || {}
    const key = text(category.key, 80).trim()
    if (!key) issues.push({ path: `categories[${categoryIndex}].key`, message: '维度 key 不能为空' })
    if (categoryKeys.has(key)) {
      issues.push({ path: `categories[${categoryIndex}].key`, message: `维度 key 重复：${key}` })
    }
    categoryKeys.add(key)
    const items = truthyArray(category.items).map((rawItem, itemIndex) => {
      const item = asObject(rawItem) || {}
      const id = text(item.id, 100).trim()
      if (!id) {
        issues.push({
          path: `categories[${categoryIndex}].items[${itemIndex}].id`,
          message: '卡片 ID 不能为空',
        })
      }
      if (itemIds.has(id)) {
        issues.push({
          path: `categories[${categoryIndex}].items[${itemIndex}].id`,
          message: `卡片 ID 重复：${id}`,
        })
      }
      const normalized = {
        ...item,
        id,
        category: key,
        name_zh: text(item.name_zh, 120),
        name_en: text(item.name_en, 160),
        definition: text(item.definition, 800),
        prompt_zh: text(item.prompt_zh, MAX_TEXT),
        prompt_en: text(item.prompt_en, MAX_TEXT),
        aliases: truthyArray(item.aliases).filter(value => typeof value === 'string').slice(0, 40),
        mood_tags: truthyArray(item.mood_tags).filter(value => typeof value === 'string').slice(0, 40),
        visual_features: truthyArray(item.visual_features)
          .filter(value => typeof value === 'string')
          .slice(0, 40),
        compatibility: truthyArray(item.compatibility)
          .filter(value => typeof value === 'string')
          .slice(0, 60),
        conflicts: truthyArray(item.conflicts)
          .filter(value => typeof value === 'string')
          .slice(0, 60),
        gender_affinity: normalizedGenderAffinity(
          item.gender_affinity,
          `categories[${categoryIndex}].items[${itemIndex}].gender_affinity`,
          issues,
        ),
        sort_order: Number.isFinite(Number(item.sort_order)) ? Number(item.sort_order) : 9999,
        visible: item.visible !== false,
        is_custom: item.is_custom === true,
      }
      if (id) itemIds.set(id, { category: key, item: normalized })
      return normalized
    })
    return {
      ...category,
      key,
      group: text(category.group, 80),
      title_zh: text(category.title_zh, 120),
      title_en: text(category.title_en, 120),
      blurb: text(category.blurb, 500),
      select_mode: category.select_mode === 'multi' ? 'multi' : 'single',
      max_select: Math.max(1, Math.min(100, Math.floor(Number(category.max_select) || 1))),
      strength_supported: category.strength_supported === true,
      visible: category.visible !== false,
      items,
      count: items.length,
    }
  })

  for (const [groupIndex, group] of groups.entries()) {
    for (const key of group.categories) {
      if (!categoryKeys.has(key)) {
        issues.push({
          path: `groups[${groupIndex}].categories`,
          message: `分组引用了不存在的维度：${key}`,
        })
      }
    }
  }

  const references: Record<string, string> = {}
  for (const [id, value] of Object.entries(asObject(source.references) || {})) {
    if (typeof value !== 'string' || !value.trim()) continue
    const path = value.trim()
    if (!itemIds.has(id)) {
      issues.push({ path: `references.${id}`, message: '参考图对应的卡片不存在' })
      continue
    }
    if (/^https?:\/\//i.test(path) || path.includes('..')) {
      issues.push({ path: `references.${id}`, message: '参考图只能是服务端相对路径' })
      continue
    }
    if (!path.startsWith('/face-assets/') && !path.startsWith('参考图/')) {
      issues.push({ path: `references.${id}`, message: '参考图路径必须以 /face-assets/ 或 参考图/ 开头' })
      continue
    }
    references[id] = path
  }

  const presets = truthyArray(source.presets).map((raw, presetIndex) => {
    const preset = asObject(raw) || {}
    const id = text(preset.id, 100).trim()
    if (!id) issues.push({ path: `presets[${presetIndex}].id`, message: '预设 ID 不能为空' })
    const selections: Record<string, string[]> = {}
    for (const [category, ids] of Object.entries(asObject(preset.selections) || {})) {
      if (!categoryKeys.has(category)) {
        issues.push({ path: `presets[${presetIndex}].selections.${category}`, message: '预设引用了不存在的维度' })
        continue
      }
      const kept = truthyArray(ids).filter(
        (value): value is string => typeof value === 'string' && itemIds.has(value),
      )
      if (kept.length !== truthyArray(ids).length) {
        issues.push({ path: `presets[${presetIndex}].selections.${category}`, message: '预设引用了不存在的卡片' })
      }
      if (kept.length) selections[category] = kept
    }
    return {
      ...preset,
      id,
      name: text(preset.name, 80),
      note: text(preset.note, 500),
      visible: preset.visible !== false,
      selections,
    }
  })

  const conflictRules = truthyArray(source.conflict_rules).map((raw, index) => {
    const rule = asObject(raw) || {}
    const left = text(rule.left, 100)
    const right = text(rule.right, 100)
    const leftCategory = text(rule.left_category, 80)
    const rightCategory = text(rule.right_category, 80)
    if (!itemIds.get(left) || itemIds.get(left)?.category !== leftCategory) {
      issues.push({ path: `conflict_rules[${index}].left`, message: '冲突规则左侧卡片不存在' })
    }
    if (!itemIds.get(right) || itemIds.get(right)?.category !== rightCategory) {
      issues.push({ path: `conflict_rules[${index}].right`, message: '冲突规则右侧卡片不存在' })
    }
    return { ...rule, left, right, left_category: leftCategory, right_category: rightCategory }
  })

  const total = categories.reduce((sum, category) => sum + category.items.length, 0)
  const catalog: FaceCatalog = {
    schemaVersion: 2,
    revision: Number.isFinite(Number(source.revision)) ? Math.max(0, Math.floor(Number(source.revision))) : 0,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
    version: text(source.version, 80) || undefined,
    generated_from: text(source.generated_from, 200) || undefined,
    total,
    groups,
    categories,
    conflict_rules: conflictRules,
    compatible_notes: source.compatible_notes,
    visual_styles: truthyArray(source.visual_styles).map(raw => asObject(raw) || {}),
    negatives: truthyArray(source.negatives).map(raw => asObject(raw) || {}),
    negative_triggers: source.negative_triggers,
    presets,
    references,
  }
  return { catalog, issues }
}

function emptyCatalog(): FaceCatalog {
  return {
    schemaVersion: 2,
    revision: 0,
    updatedAt: new Date().toISOString(),
    total: 0,
    groups: [],
    categories: [],
    conflict_rules: [],
    visual_styles: [],
    negatives: [],
    presets: [],
    references: {},
  }
}

/**
 * v1 目录没有性别适配字段。升级时只给缺失字段补种子标签，
 * 管理员已经保存过的标签和自定义卡片保持原样。
 */
function migrateGenderAffinity(raw: Record<string, any>, seed: Record<string, any>): boolean {
  let changed = Number(raw.schemaVersion || 1) < 2
  raw.schemaVersion = 2
  const seedItems = new Map<string, Record<string, any>>()
  for (const category of truthyArray(seed.categories)) {
    for (const item of truthyArray(asObject(category)?.items)) {
      const object = asObject(item)
      if (object && typeof object.id === 'string') seedItems.set(object.id, object)
    }
  }
  for (const category of truthyArray(raw.categories)) {
    for (const item of truthyArray(asObject(category)?.items)) {
      const object = asObject(item)
      if (!object || typeof object.id !== 'string' || object.gender_affinity !== undefined) continue
      const seeded = seedItems.get(object.id)
      if (!seeded?.gender_affinity) continue
      object.gender_affinity = JSON.parse(JSON.stringify(seeded.gender_affinity))
      changed = true
    }
  }
  return changed
}

/**
 * 新版种子新增分类或卡片时，把缺失内容补进管理员目录。
 * 已有分类、卡片、显隐和自定义修改全部原样保留，只追加种子里有而目录里没有的项。
 */
function mergeSeedAdditions(raw: Record<string, any>, seed: Record<string, any>): boolean {
  let changed = false
  if (!Array.isArray(raw.groups)) {
    raw.groups = []
    changed = true
  }
  if (!Array.isArray(raw.categories)) {
    raw.categories = []
    changed = true
  }
  if (!Array.isArray(raw.conflict_rules)) {
    raw.conflict_rules = []
    changed = true
  }

  const rawCategories = raw.categories as Array<Record<string, any>>
  const rawGroups = raw.groups as Array<Record<string, any>>
  const rawCategoryMap = new Map<string, Record<string, any>>()
  const rawItemCategories = new Map<string, string>()
  for (const category of rawCategories) {
    const object = asObject(category)
    if (!object || typeof object.key !== 'string') continue
    rawCategoryMap.set(object.key, object)
    for (const item of truthyArray(object.items)) {
      const itemObject = asObject(item)
      if (itemObject && typeof itemObject.id === 'string') {
        rawItemCategories.set(itemObject.id, object.key)
      }
    }
  }

  const seedCategories = new Map<string, Record<string, any>>()
  for (const category of truthyArray(seed.categories)) {
    const object = asObject(category)
    if (object && typeof object.key === 'string') seedCategories.set(object.key, object)
  }

  for (const seedGroup of truthyArray(seed.groups)) {
    const groupObject = asObject(seedGroup)
    if (!groupObject || typeof groupObject.key !== 'string') continue
    let group: Record<string, any> | undefined = rawGroups.find(
      entry => asObject(entry)?.key === groupObject.key,
    )
    if (!group) {
      const created: Record<string, any> = JSON.parse(JSON.stringify(groupObject))
      rawGroups.push(created)
      group = created
      changed = true
    }
    if (!Array.isArray(group.categories)) {
      group.categories = []
      changed = true
    }

    const seedKeys = truthyArray(groupObject.categories)
      .filter((key): key is string => typeof key === 'string')
    for (const [index, key] of seedKeys.entries()) {
      const seedCategory = seedCategories.get(key)
      if (!seedCategory) continue
      if (!rawCategoryMap.has(key)) {
        const category = JSON.parse(JSON.stringify(seedCategory))
        rawCategories.push(category)
        rawCategoryMap.set(key, category)
        changed = true
      }
      if (!group.categories.includes(key)) {
        let insertAt = group.categories.length
        for (const nextKey of seedKeys.slice(index + 1)) {
          const nextIndex = group.categories.indexOf(nextKey)
          if (nextIndex >= 0) {
            insertAt = nextIndex
            break
          }
        }
        group.categories.splice(insertAt, 0, key)
        changed = true
      }
    }
  }

  for (const [key, seedCategory] of seedCategories) {
    const category = rawCategoryMap.get(key)
    if (!category) continue
    if (!Array.isArray(category.items)) {
      category.items = []
      changed = true
    }
    const items = category.items as Array<Record<string, any>>
    const localIds = new Set(
      items.map(item => asObject(item)?.id).filter((id): id is string => typeof id === 'string'),
    )
    for (const seedItem of truthyArray(seedCategory.items)) {
      const seedObject = asObject(seedItem)
      if (!seedObject || typeof seedObject.id !== 'string') continue
      if (localIds.has(seedObject.id)) continue
      const otherCategory = rawItemCategories.get(seedObject.id)
      if (otherCategory && otherCategory !== key) {
        throw new FaceCatalogError(
          `目录升级时发现卡片 ID 冲突：${seedObject.id}`,
          500,
          [{ path: `categories.${key}.items`, message: `ID 已存在于 ${otherCategory}` }],
        )
      }
      items.push(JSON.parse(JSON.stringify(seedObject)))
      rawItemCategories.set(seedObject.id, key)
      localIds.add(seedObject.id)
      changed = true
    }
    category.count = items.length
  }

  const ruleKeys = new Set<string>()
  for (const rule of truthyArray(raw.conflict_rules)) {
    const object = asObject(rule)
    if (!object) continue
    ruleKeys.add([
      object.left_category,
      object.left,
      object.right_category,
      object.right,
    ].join('|'))
  }
  for (const seedRule of truthyArray(seed.conflict_rules)) {
    const object = asObject(seedRule)
    if (!object) continue
    const key = [
      object.left_category,
      object.left,
      object.right_category,
      object.right,
    ].join('|')
    if (ruleKeys.has(key)) continue
    raw.conflict_rules.push(JSON.parse(JSON.stringify(object)))
    ruleKeys.add(key)
    changed = true
  }

  if (changed) {
    if (typeof seed.version === 'string' && seed.version) raw.version = seed.version
    if (typeof seed.generated_from === 'string' && seed.generated_from) {
      raw.generated_from = seed.generated_from
    }
  }
  return changed
}

export class FaceCatalogStore {
  private readonly file: string
  private readonly seedFile: string
  private readonly backupDir: string
  private catalog: FaceCatalog = emptyCatalog()
  private pending: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string, seedFile: string) {
    this.file = join(dataDir, 'face-cards.json')
    this.backupDir = join(dataDir, 'face-card-backups')
    this.seedFile = seedFile
  }

  async init(): Promise<void> {
    if (!existsSync(this.seedFile)) {
      throw new FaceCatalogError(`缺少捏脸种子目录：${this.seedFile}`, 503)
    }
    const seed = JSON.parse(await readFile(this.seedFile, 'utf8'))
    const normalizedSeed = normalizeFaceCatalog(seed)
    if (normalizedSeed.issues.length) {
      throw new FaceCatalogError('捏脸种子目录校验失败', 500, normalizedSeed.issues)
    }
    if (existsSync(this.file)) {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      const merged = mergeSeedAdditions(raw, seed)
      const migrated = migrateGenderAffinity(raw, seed) || merged
      const { catalog, issues } = normalizeFaceCatalog(raw)
      if (issues.length) {
        throw new FaceCatalogError('data/face-cards.json 校验失败', 500, issues)
      }
      if (migrated) {
        this.catalog = {
          ...catalog,
          revision: catalog.revision + 1,
          updatedAt: new Date().toISOString(),
        }
        await this.write(this.catalog, true)
      } else {
        this.catalog = catalog
      }
      return
    }
    this.catalog = { ...normalizedSeed.catalog, revision: 1, updatedAt: new Date().toISOString() }
    await this.write(this.catalog)
  }

  getAdmin(): FaceCatalog {
    return JSON.parse(JSON.stringify(this.catalog)) as FaceCatalog
  }

  getPublic(): FaceCatalog {
    return visibleCatalog(JSON.parse(JSON.stringify(this.catalog)) as FaceCatalog)
  }

  getMeta(): FaceCatalogMeta {
    return {
      revision: this.catalog.revision,
      updatedAt: this.catalog.updatedAt,
      total: this.catalog.total,
      categories: this.catalog.categories.length,
      presets: this.catalog.presets.length,
      references: Object.keys(this.catalog.references).length,
    }
  }

  async save(input: unknown, baseRevision?: number): Promise<FaceCatalog> {
    const { catalog, issues } = normalizeFaceCatalog(input)
    if (issues.length) {
      throw new FaceCatalogError('捏脸目录校验失败', 422, issues)
    }
    if (baseRevision !== undefined && baseRevision !== this.catalog.revision) {
      throw new FaceCatalogError(
        `目录已被另一端修改（当前 revision ${this.catalog.revision}），请先重新加载`,
        409,
      )
    }
    const next: FaceCatalog = {
      ...catalog,
      revision: this.catalog.revision + 1,
      updatedAt: new Date().toISOString(),
    }
    await this.write(next, true)
    this.catalog = next
    return this.getAdmin()
  }

  async reset(): Promise<FaceCatalog> {
    const seed = JSON.parse(await readFile(this.seedFile, 'utf8'))
    return this.save({ ...seed, revision: this.catalog.revision }, this.catalog.revision)
  }

  async restoreLast(): Promise<FaceCatalog> {
    const backups = await this.listBackups()
    if (!backups.length) throw new FaceCatalogError('还没有可恢复的备份', 404)
    const latest = backups[0]
    if (!latest) throw new FaceCatalogError('还没有可恢复的备份', 404)
    const raw = JSON.parse(await readFile(join(this.backupDir, latest), 'utf8'))
    return this.save({ ...raw, revision: this.catalog.revision }, this.catalog.revision)
  }

  private async listBackups(): Promise<string[]> {
    try {
      return (await readdir(this.backupDir))
        .filter(name => name.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a))
    } catch {
      return []
    }
  }

  private async write(next: FaceCatalog, backup = false): Promise<void> {
    const run = async () => {
      await mkdir(dirname(this.file), { recursive: true })
      if (backup && existsSync(this.file)) {
        await mkdir(this.backupDir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        await copyFile(this.file, join(this.backupDir, `face-cards-${stamp}-r${this.catalog.revision}.json`))
        const backups = await this.listBackups()
        for (const name of backups.slice(KEEP_BACKUPS)) {
          await unlink(join(this.backupDir, name)).catch(() => {})
        }
      }
      const temp = `${this.file}.tmp`
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await rename(temp, this.file)
    }
    this.pending = this.pending.then(run, run)
    await this.pending
  }
}
