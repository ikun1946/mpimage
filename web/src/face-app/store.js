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
      ui: { lang: 'zh', length: 'full', shot: 'portrait', category: 'face_shape' },
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
    this.state.ui = Object.assign({ lang: 'zh', length: 'full', shot: 'portrait', category: 'face_shape' }, this.state.ui)
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
    Object.assign(this.state.ui, patch)
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
    const pick = (list) => list[Math.floor(random() * list.length)]
    const selections = {}
    const strengths = {}

    for (const category of this.data.categories) {
      const pool = (category.items || []).filter((item) => item.visible !== false)
      if (!pool.length) continue
      const max = category.select_mode === 'multi'
        ? Math.min(Number(category.max_select) || 1, 2, pool.length)
        : 1
      const count = 1 + Math.floor(random() * Math.max(1, max))
      const picked = shuffled(pool, random).slice(0, Math.min(count, pool.length))
      selections[category.key] = picked.map((item) => item.id)
      if (category.strength_supported) {
        strengths[category.key] = {}
        for (const item of picked) {
          strengths[category.key][item.id] = 2 + Math.floor(random() * 3)
        }
      }
    }

    for (let guard = 0; guard < 100; guard += 1) {
      const rule = (this.data.conflict_rules || []).find((entry) => {
        const left = selections[entry.left_category] || []
        const right = selections[entry.right_category] || []
        return left.includes(entry.left) && right.includes(entry.right)
      })
      if (!rule) break
      const dropLeft = random() < 0.5
      const category = dropLeft ? rule.left_category : rule.right_category
      const id = dropLeft ? rule.left : rule.right
      selections[category] = (selections[category] || []).filter((value) => value !== id)
      if (!selections[category].length) delete selections[category]
      if (strengths[category]) {
        delete strengths[category][id]
        if (!Object.keys(strengths[category]).length) delete strengths[category]
      }
    }

    const scheme = this.scheme
    const style = this.data.visual_styles?.length ? pick(this.data.visual_styles) : null
    scheme.visualStyle = style?.id || scheme.visualStyle
    scheme.gender = pick(['女性呈现', '男性呈现', '中性呈现'])
    scheme.age = pick(['青年', '成年', '中年'])
    scheme.role = ''
    scheme.selections = selections
    scheme.strengths = strengths
    scheme.negatives = this.data.negatives.filter((item) => item.default).map((item) => item.id)
    scheme.customNotes = ''
    scheme.manual = { full: null, negative: null }
    if (!scheme.name || scheme.name === '未命名角色' || scheme.name.startsWith('随机角色')) {
      scheme.name = '随机角色'
    }
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
