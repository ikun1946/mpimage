const STORAGE_KEY = 'huajing.faceStudio.v1'
const storageKey = () => `${STORAGE_KEY}.${window.__FACE_USER_ID__ || 'guest'}`

const uid = (prefix = 'scheme') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`

function nowIso() {
  return new Date().toISOString()
}

function shuffled(list, random = Math.random) {
  const copy = [...list]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[copy[index], copy[swap]] = [copy[swap], copy[index]]
  }
  return copy
}

const GENDER_WEIGHTS = {
  male: 6,
  female: 6,
  neutral: 2.5,
}
const RANDOM_GENDER_SCOPES = new Set(['any', 'mixed', 'same-only'])
const DEFAULT_RANDOM_GENDER_SCOPE = 'mixed'

/** 主发型结构互斥组：随机时只选一个分类和一张主卡，避免男发、女发、盘发、编发同时出现。 */
const RANDOM_PRIMARY_GROUPS = [[
  'hair_cut',
  'hair_style',
  'updo',
  'braid',
  'ancient_bun',
  'hair_male_modern',
  'hair_female_short',
  'hair_curl_form',
  'hair_braid_cultural',
  'hair_updo_detail',
  'hair_history',
]]

function randomGenderTarget(gender) {
  if (gender === '男性呈现') return 'male'
  if (gender === '女性呈现') return 'female'
  if (gender === '中性呈现') return 'neutral'
  return ''
}

function normalizeRandomGenderScope(value) {
  return RANDOM_GENDER_SCOPES.has(value) ? value : DEFAULT_RANDOM_GENDER_SCOPE
}

function itemGenderLabels(item) {
  return Array.isArray(item.gender_affinity) && item.gender_affinity.length
    ? item.gender_affinity
    : ['neutral']
}

function itemMatchesGender(item, target) {
  return Boolean(target) && itemGenderLabels(item).includes(target)
}

function itemIsNeutral(item) {
  return itemGenderLabels(item).includes('neutral')
}

/**
 * 只保留当前范围允许的卡片。“仅同性”在没有同性卡时退回该维度的中性卡，
 * 避免大量维度因为缺少性别专属卡而整组留空。
 */
function scopedGenderPool(pool, target, scope) {
  if (!target || scope === 'any') return pool
  const sameGender = pool.filter((item) => itemMatchesGender(item, target))
  if (scope === 'same-only') {
    return sameGender.length ? sameGender : pool.filter(itemIsNeutral)
  }
  return pool.filter((item) => itemMatchesGender(item, target) || itemIsNeutral(item))
}

function itemGenderWeight(item, target, scope) {
  if (!target || scope === 'any') return 1
  if (itemMatchesGender(item, target)) return GENDER_WEIGHTS[target]
  if (scope === 'mixed' && itemIsNeutral(item)) return GENDER_WEIGHTS.neutral
  return 0
}

function categoryGenderWeight(category, target, scope) {
  if (!target || scope === 'any') return 1
  const pool = (category.items || []).filter(item => item.visible !== false)
  const scoped = scopedGenderPool(pool, target, scope)
  if (!scoped.length) return 0
  if (scope === 'same-only') {
    return scoped.some((item) => itemMatchesGender(item, target)) ? GENDER_WEIGHTS[target] : 0.35
  }
  return Math.max(...scoped.map((item) => itemGenderWeight(item, target, scope)))
}

function weightedShuffle(list, weightOf, random = Math.random) {
  const pool = [...list]
  const result = []
  while (pool.length) {
    const weights = pool.map((item) => Math.max(0, Number(weightOf(item)) || 0))
    const total = weights.reduce((sum, value) => sum + value, 0)
    if (total <= 0) {
      result.push(...shuffled(pool, random))
      break
    }
    let cursor = random() * total
    let index = weights.length - 1
    for (let pos = 0; pos < weights.length; pos += 1) {
      cursor -= weights[pos]
      if (cursor <= 0) {
        index = pos
        break
      }
    }
    result.push(pool[index])
    pool.splice(index, 1)
  }
  return result
}

export class Store {
  constructor(data) {
    this.data = data
    this.listeners = new Set()
    this.state = this.load() || this.fresh()
    this.applyCustomItems()
    this.ensureValid()
  }

  fresh() {
    const defaults = this.data.negatives.filter((n) => n.default).map((n) => n.id)
    const scheme = this.blankScheme(defaults)
    return {
      version: 1,
      schemes: [scheme],
      activeId: scheme.id,
      favorites: [],
      recents: [],
      customItems: [],
      referenceOverrides: {},
      ui: {
        lang: 'zh',
        length: 'full',
        shot: 'portrait',
        category: 'face_shape',
        randomGenderScope: DEFAULT_RANDOM_GENDER_SCOPE,
      },
    }
  }

  blankScheme(defaults = []) {
    return {
      id: uid(),
      name: '未命名角色',
      visualStyle: 'guoman_3d',
      gender: '女性呈现',
      age: '青年',
      role: '',
      selections: {},
      strengths: {},
      negatives: [...defaults],
      customNotes: '',
      manual: { full: null, negative: null },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
  }

  load() {
    try {
      const raw = localStorage.getItem(storageKey())
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (!parsed || !Array.isArray(parsed.schemes) || !parsed.schemes.length) return null
      return parsed
    } catch {
      return null
    }
  }

  ensureValid() {
    const known = new Set(this.data.categories.map((c) => c.key))
    const idsByCat = new Map(this.data.categories.map((c) => [c.key, new Set(c.items.map((i) => i.id))]))
    this.state.schemes = this.state.schemes.filter((s) => s && s.id)
    if (!this.state.schemes.length) this.state = this.fresh()
    this.state.referenceOverrides =
      this.state.referenceOverrides && typeof this.state.referenceOverrides === 'object'
        ? Object.fromEntries(
            Object.entries(this.state.referenceOverrides).filter(
              ([id, value]) => typeof id === 'string' && typeof value === 'string' && value,
            ),
          )
        : {}
    this.state.schemes.forEach((s) => {
      s.selections = s.selections || {}
      s.strengths = s.strengths || {}
      s.negatives = s.negatives || []
      s.manual = s.manual || { full: null, negative: null }
      for (const key of Object.keys(s.selections)) {
        if (!known.has(key)) delete s.selections[key]
        else s.selections[key] = s.selections[key].filter((id) => idsByCat.get(key)?.has(id))
        if (s.selections[key] && !s.selections[key].length) delete s.selections[key]
      }
    })
    if (!this.state.schemes.some((s) => s.id === this.state.activeId)) {
      this.state.activeId = this.state.schemes[0].id
    }
    const previousUi = this.state.ui || {}
    const explicitScope = RANDOM_GENDER_SCOPES.has(previousUi.randomGenderScope)
    const legacyScope = previousUi.randomGenderAware === false
      ? 'any'
      : previousUi.randomGenderAware === true
        ? 'mixed'
        : ''
    this.state.ui = Object.assign({
      lang: 'zh',
      length: 'full',
      shot: 'portrait',
      category: 'face_shape',
      randomGenderScope: DEFAULT_RANDOM_GENDER_SCOPE,
    }, previousUi)
    this.state.ui.randomGenderScope = explicitScope
      ? this.state.ui.randomGenderScope
      : normalizeRandomGenderScope(legacyScope)
    delete this.state.ui.randomGenderAware
  }

  applyCustomItems() {
    const custom = Array.isArray(this.state.customItems) ? this.state.customItems : []
    this.state.customItems = custom
    for (const item of custom) {
      const cat = this.data.categories.find((c) => c.key === item.category)
      if (!cat || cat.items.some((i) => i.id === item.id)) continue
      cat.items.push({
        ...item,
        select_mode: cat.select_mode,
        max_select: cat.max_select,
        strength_supported: false,
        reference_image: item.reference_image || '',
        reference_status: item.reference_status || 'pending',
        reference_source: item.reference_source,
      })
    }
  }

  get scheme() {
    return this.state.schemes.find((s) => s.id === this.state.activeId) || this.state.schemes[0]
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit() {
    for (const fn of this.listeners) fn(this.state)
  }

  save() {
    try {
      const copy = {
        ...this.state,
        schemes: this.state.schemes.map((s) => ({ ...s, manual: { ...s.manual } })),
      }
      localStorage.setItem(storageKey(), JSON.stringify(copy))
      return true
    } catch {
      return false
    }
  }

  commit() {
    this.scheme.updatedAt = nowIso()
    const ok = this.save()
    this.emit()
    return ok
  }

  setUi(patch) {
    const next = { ...patch }
    if ('randomGenderScope' in next) {
      next.randomGenderScope = normalizeRandomGenderScope(next.randomGenderScope)
    }
    Object.assign(this.state.ui, next)
    this.save()
  }

  setSchemeField(field, value) {
    this.scheme[field] = value
    this.scheme.manual = { ...this.scheme.manual }
    this.commit()
  }

  selectScheme(id) {
    this.state.activeId = id
    this.commit()
  }

  createScheme(name = '未命名角色') {
    const defaults = this.data.negatives.filter((n) => n.default).map((n) => n.id)
    const scheme = { ...this.blankScheme(defaults), name }
    this.state.schemes.push(scheme)
    this.state.activeId = scheme.id
    this.commit()
    return scheme
  }

  /** 保留当前方案名称与 ID，只把内容和参数恢复到初始空白状态。 */
  resetScheme() {
    const defaults = this.data.negatives.filter((n) => n.default).map((n) => n.id)
    const blank = this.blankScheme(defaults)
    const scheme = this.scheme
    scheme.visualStyle = blank.visualStyle
    scheme.gender = blank.gender
    scheme.age = blank.age
    scheme.role = blank.role
    scheme.selections = {}
    scheme.strengths = {}
    scheme.negatives = blank.negatives
    scheme.customNotes = blank.customNotes
    scheme.manual = { full: null, negative: null }
    this.commit()
    return scheme
  }

  /** 按维度的单选/多选规则生成一套完整随机角色，并消除已知冲突。 */
  randomizeScheme(random = Math.random) {
    const scheme = this.scheme
    const selectedScope = normalizeRandomGenderScope(this.state.ui.randomGenderScope)
    const genderScope = scheme.gender === '中性呈现' ? 'mixed' : selectedScope
    const genderTarget = genderScope === 'any' ? '' : randomGenderTarget(scheme.gender)
    const selections = {}
    const strengths = {}
    const primaryKeys = new Set(RANDOM_PRIMARY_GROUPS.flat())
    const pickItems = (category, exactOne = false) => {
      const pool = (category.items || []).filter((item) => item.visible !== false)
      const scoped = scopedGenderPool(pool, genderTarget, genderScope)
      if (!scoped.length) return []
      const max = exactOne
        ? 1
        : category.select_mode === 'multi'
          ? Math.min(Number(category.max_select) || 1, 2, scoped.length)
          : 1
      const count = exactOne ? 1 : 1 + Math.floor(random() * Math.max(1, max))
      const ranked = genderTarget
        ? weightedShuffle(scoped, (item) => itemGenderWeight(item, genderTarget, genderScope), random)
        : shuffled(scoped, random)
      return ranked.slice(0, Math.min(count, scoped.length))
    }
    const applyPicked = (category, picked) => {
      if (!picked.length) return
      selections[category.key] = picked.map((item) => item.id)
      if (category.strength_supported) {
        strengths[category.key] = {}
        for (const item of picked) {
          strengths[category.key][item.id] = 2 + Math.floor(random() * 3)
        }
      }
    }

    for (const category of this.data.categories) {
      if (primaryKeys.has(category.key)) continue
      applyPicked(category, pickItems(category))
    }

    for (const group of RANDOM_PRIMARY_GROUPS) {
      const available = group
        .map(key => this.data.categories.find(category => category.key === key))
        .filter(category => category && (category.items || []).some(item => item.visible !== false))
      if (!available.length) continue
      const ranked = genderTarget
        ? weightedShuffle(available, (category) => categoryGenderWeight(category, genderTarget, genderScope), random)
        : shuffled(available, random)
      const category = ranked[0]
      if (!category || categoryGenderWeight(category, genderTarget, genderScope) <= 0) continue
      applyPicked(category, pickItems(category, true))
    }

    for (let guard = 0; guard < 100; guard += 1) {
      const rule = (this.data.conflict_rules || []).find((entry) => {
        const left = selections[entry.left_category] || []
        const right = selections[entry.right_category] || []
        return left.includes(entry.left) && right.includes(entry.right)
      })
      if (!rule) break
      const leftPrimary = primaryKeys.has(rule.left_category)
      const rightPrimary = primaryKeys.has(rule.right_category)
      const dropLeft = leftPrimary && !rightPrimary
        ? false
        : !leftPrimary && rightPrimary
          ? true
          : random() < 0.5
      const category = dropLeft ? rule.left_category : rule.right_category
      const id = dropLeft ? rule.left : rule.right
      selections[category] = (selections[category] || []).filter((value) => value !== id)
      if (!selections[category].length) delete selections[category]
      if (strengths[category]) {
        delete strengths[category][id]
        if (!Object.keys(strengths[category]).length) delete strengths[category]
      }
    }

    scheme.selections = selections
    scheme.strengths = strengths
    scheme.negatives = this.data.negatives.filter((item) => item.default).map((item) => item.id)
    scheme.manual = { full: null, negative: null }
    this.commit()
    return scheme
  }

  duplicateScheme() {
    const src = this.scheme
    const copy = JSON.parse(JSON.stringify(src))
    copy.id = uid()
    copy.name = `${src.name} 副本`
    copy.createdAt = nowIso()
    copy.updatedAt = nowIso()
    this.state.schemes.push(copy)
    this.state.activeId = copy.id
    this.commit()
    return copy
  }

  deleteScheme(id = this.state.activeId) {
    if (this.state.schemes.length <= 1) return false
    this.state.schemes = this.state.schemes.filter((s) => s.id !== id)
    if (this.state.activeId === id) this.state.activeId = this.state.schemes[0].id
    this.commit()
    return true
  }

  renameScheme(name) {
    const next = (name || '').trim() || '未命名角色'
    this.scheme.name = next.slice(0, 40)
    this.commit()
    return this.scheme.name
  }

  importScheme(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('文件内容不是有效的方案 JSON')
    const base = this.blankScheme()
    const scheme = {
      ...base,
      ...raw,
      id: uid(),
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : '导入的方案',
      selections: raw.selections && typeof raw.selections === 'object' ? raw.selections : {},
      strengths: raw.strengths && typeof raw.strengths === 'object' ? raw.strengths : {},
      negatives: Array.isArray(raw.negatives) ? raw.negatives.filter((id) => this.data.negatives.some((n) => n.id === id)) : [],
      manual: { full: null, negative: null },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    const known = new Map(this.data.categories.map((c) => [c.key, c]))
    for (const [cat, ids] of Object.entries(scheme.selections)) {
      if (!known.has(cat) || !Array.isArray(ids)) {
        delete scheme.selections[cat]
        continue
      }
      const valid = new Set(known.get(cat).items.map((i) => i.id))
      scheme.selections[cat] = ids.filter((id) => valid.has(id))
    }
    this.state.schemes.push(scheme)
    this.state.activeId = scheme.id
    this.commit()
    return scheme
  }

  toggleItem(categoryKey, itemId) {
    const cat = this.data.categories.find((c) => c.key === categoryKey)
    if (!cat) return { changed: false, notice: '' }
    const current = this.scheme.selections[categoryKey] || []
    const item = cat.items.find((i) => i.id === itemId)
    if (!item) return { changed: false, notice: '' }
    let next
    let notice = ''
    if (current.includes(itemId)) {
      next = current.filter((id) => id !== itemId)
    } else if (cat.select_mode === 'single') {
      const previous = current[0] ? cat.items.find((i) => i.id === current[0]) : null
      next = [itemId]
      if (previous) {
        notice = `已用「${item.name_zh}」替换「${previous.name_zh}」`
        if (this.scheme.strengths[categoryKey]) delete this.scheme.strengths[categoryKey][previous.id]
      }
    } else {
      if (current.length >= cat.max_select) {
        return { changed: false, notice: `「${cat.title_zh}」最多选 ${cat.max_select} 个，先取消一个再选` }
      }
      next = [...current, itemId]
    }
    this.scheme.selections[categoryKey] = next
    if (!next.length) delete this.scheme.selections[categoryKey]
    if (!this.scheme.strengths[categoryKey]) this.scheme.strengths[categoryKey] = {}
    if (next.includes(itemId)) this.scheme.strengths[categoryKey][itemId] = this.scheme.strengths[categoryKey][itemId] || 3
    else delete this.scheme.strengths[categoryKey][itemId]
    this.touchRecent(itemId)
    this.commit()
    return { changed: true, notice, added: next.includes(itemId) }
  }

  removeItem(categoryKey, itemId) {
    const current = this.scheme.selections[categoryKey] || []
    if (!current.includes(itemId)) return
    const next = current.filter((id) => id !== itemId)
    if (next.length) this.scheme.selections[categoryKey] = next
    else delete this.scheme.selections[categoryKey]
    if (this.scheme.strengths[categoryKey]) delete this.scheme.strengths[categoryKey][itemId]
    this.commit()
  }

  clearCategory(categoryKey) {
    delete this.scheme.selections[categoryKey]
    delete this.scheme.strengths[categoryKey]
    this.commit()
  }

  setStrength(categoryKey, itemId, value) {
    if (!this.scheme.strengths[categoryKey]) this.scheme.strengths[categoryKey] = {}
    this.scheme.strengths[categoryKey][itemId] = Number(value)
    this.commit()
  }

  toggleNegative(id) {
    const list = new Set(this.scheme.negatives || [])
    if (list.has(id)) list.delete(id)
    else list.add(id)
    this.scheme.negatives = [...list]
    this.commit()
  }

  setManual(tab, text) {
    this.scheme.manual[tab] = text
    this.save()
  }

  setReferenceOverride(id, path) {
    if (!id || typeof path !== 'string' || !path) return
    this.state.referenceOverrides = { ...(this.state.referenceOverrides || {}), [id]: path }
    this.commit()
  }

  clearReferenceOverride(id) {
    if (!this.state.referenceOverrides?.[id]) return
    const next = { ...this.state.referenceOverrides }
    delete next[id]
    this.state.referenceOverrides = next
    this.commit()
  }

  restoreManual(tab) {
    this.scheme.manual[tab] = null
    this.commit()
  }

  toggleFavorite(itemId) {
    const set = new Set(this.state.favorites)
    if (set.has(itemId)) set.delete(itemId)
    else set.add(itemId)
    this.state.favorites = [...set]
    this.save()
    this.emit()
    return set.has(itemId)
  }

  addCustomItem({ category, name_zh, name_en, definition, prompt_zh }) {
    const cat = this.data.categories.find((c) => c.key === category)
    if (!cat) throw new Error('未知维度')
    const id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`
    const name = name_zh.trim().slice(0, 24)
    const item = {
      id,
      category,
      name_zh: name,
      name_en: (name_en || '').trim().slice(0, 48) || `Custom ${name}`,
      aliases: [],
      definition: definition.trim().slice(0, 120),
      visual_features: definition.split(/[，、]/).map((s) => s.trim()).filter(Boolean),
      prompt_zh: (prompt_zh || definition).trim().slice(0, 160),
      prompt_en: (name_en ? `${name_en.trim()}.` : `Custom feature: ${name}.`),
      mood_tags: ['自定义'],
      select_mode: cat.select_mode,
      max_select: cat.max_select,
      strength_supported: false,
      compatibility: [],
      conflicts: [],
      gender_affinity: ['neutral'],
      reference_image: '',
      reference_status: 'pending',
      sort_order: 9999,
      is_custom: true,
      source_section: 'custom',
    }
    this.state.customItems.push(item)
    cat.items.push(item)
    this.commit()
    return item
  }

  removeCustomItem(id) {
    const item = this.state.customItems.find((i) => i.id === id)
    if (!item) return
    this.state.customItems = this.state.customItems.filter((i) => i.id !== id)
    const cat = this.data.categories.find((c) => c.key === item.category)
    if (cat) cat.items = cat.items.filter((i) => i.id !== id)
    for (const scheme of this.state.schemes) {
      if (item.category && scheme.selections[item.category]) {
        scheme.selections[item.category] = scheme.selections[item.category].filter((x) => x !== id)
        if (!scheme.selections[item.category].length) delete scheme.selections[item.category]
      }
      if (scheme.strengths?.[item.category]) delete scheme.strengths[item.category][id]
    }
    this.commit()
  }

  touchRecent(itemId) {
    const list = this.state.recents.filter((r) => r.id !== itemId)
    list.unshift({ id: itemId, at: Date.now() })
    this.state.recents = list.slice(0, 30)
  }

  resetForTest(scheme) {
    this.state.schemes = [scheme]
    this.state.activeId = scheme.id
  }
}

export { STORAGE_KEY, storageKey }
