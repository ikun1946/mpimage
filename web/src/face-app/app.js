import { Store } from './store.js'
import { createCompiler, searchItems } from './prompt.js'
import { fetchFaceCatalog, fetchFaceCatalogMeta, uploadReferenceImage } from '../lib/api.js'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`
const esc = (str = '') => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const debounce = (fn, ms = 220) => {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

let data
let compiler
let store
let manifest = {}
let catalogRevision = 0
let categories = []
let categoryMap = new Map()
let itemMap = new Map()

const view = {
  tab: 'full',
  query: '',
  mood: '',
  quick: '',
  mobileGroup: 'face',
  expanded: new Set(),
  compiled: null,
  searchResults: [],
  searchFocus: 0,
  overlay: '',
  confirmClose: null,
}

let toastTimer = 0
function toast(message) {
  const el = $('#toast')
  el.textContent = message
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400)
}

async function boot() {
  try {
    const result = await fetchFaceCatalog()
    data = result?.catalog
    if (!data || !Array.isArray(data.categories)) {
      throw new Error('服务端没有返回有效的捏脸卡片目录')
    }
    manifest = data.references || {}
    catalogRevision = Number(result?.meta?.revision ?? data.revision) || 0
  } catch (err) {
    showBootError(err)
    return
  }
  store = new Store(data)
  rebuildCompiler()
  view.mobileGroup = currentCategory().group

  fillStyleSelect()
  bind()
  renderAll()
  document.body.classList.remove('is-booting')
  window.__faceStudio = {
    data,
    store,
    compiler,
    view,
    catalogRevision: () => catalogRevision,
    refreshCatalog,
    effectiveReference,
    faceReferenceUrl,
  }
  window.dispatchEvent(new CustomEvent('face-ready'))
  setInterval(() => {
    if (document.visibilityState === 'visible') void refreshCatalog()
  }, 45_000)
  window.addEventListener('focus', () => { void refreshCatalog() })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshCatalog()
  })
}

function showBootError(error) {
  document.body.classList.remove('is-booting')
  document.body.innerHTML = `<div style="min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--paper);color:var(--ink);font-family:var(--font-body)">
    <div style="width:min(520px,100%);padding:28px;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface-raised);box-shadow:var(--shadow);line-height:1.8">
      <h1 style="margin:0 0 8px;font-family:var(--font-display);font-size:24px">捏脸工作台没能打开</h1>
      <p style="margin:0 0 18px;color:var(--ink-soft);font-size:13px">${esc(error?.message || error || '未知错误')}</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button type="button" onclick="location.reload()" style="height:38px;padding:0 16px;border:0;border-radius:10px;background:var(--moss);color:var(--on-moss);cursor:pointer">重试</button>
        <a href="/batch.html" style="display:inline-flex;height:38px;align-items:center;padding:0 16px;border:1px solid var(--line);border-radius:10px;color:var(--ink-soft);text-decoration:none">返回创作台</a>
      </div>
    </div>
  </div>`
}

function rebuildCompiler() {
  compiler = createCompiler(data)
  categories = data.categories
  categoryMap = compiler.categoryMap
  itemMap = compiler.itemMap
}

/** 内置图是 /face-assets/...，管理员上传图是 参考图/...；统一转成可访问地址。 */
function faceReferenceUrl(path) {
  if (!path) return ''
  if (path.startsWith('/')) return path
  return `/api/files/${path.split('/').map(encodeURIComponent).join('/')}`
}

function effectiveReference(id) {
  return store?.state?.referenceOverrides?.[id] || manifest[id] || ''
}

function effectiveReferenceMap() {
  const overrides = store?.state?.referenceOverrides || {}
  return { ...manifest, ...overrides }
}

async function refreshCatalog() {
  try {
    const meta = await fetchFaceCatalogMeta()
    const nextRevision = Number(meta?.meta?.revision) || 0
    if (!nextRevision || nextRevision === catalogRevision) return
    const result = await fetchFaceCatalog()
    if (!result?.catalog) return
    data = result.catalog
    manifest = data.references || {}
    catalogRevision = nextRevision
    rebuildCompiler()
    if (store) {
      store.data = data
      store.applyCustomItems()
      store.ensureValid()
    }
    renderAll()
    toast('捏脸卡片已更新')
  } catch {
    // 离线或暂时读不到目录时保留当前页面，下次聚焦再试
  }
}

/* ---------------------------------------------------------------- render */
function fillStyleSelect() {
  $('#visual-style').innerHTML = data.visual_styles.map((s) => `<option value="${esc(s.id)}">${esc(s.name_zh)}</option>`).join('')
}

function renderAll() {
  syncSchemeFields()
  renderNav()
  renderStageHead()
  renderCards()
  renderPanel()
  renderFooter()
}

function syncSchemeFields() {
  const scheme = store.scheme
  if (document.activeElement !== $('#scheme-name')) $('#scheme-name').value = scheme.name
  $('#visual-style').value = scheme.visualStyle
  if (document.activeElement !== $('#role')) $('#role').value = scheme.role || ''
  if (document.activeElement !== $('#custom-notes')) $('#custom-notes').value = scheme.customNotes || ''
  $('#gender').value = scheme.gender || ''
  $('#age').value = scheme.age || ''
}

function renderNav() {
  const scheme = store.scheme
  const activeGroup = view.mobileGroup || currentCategory().group
  const headers = data.groups.map((group) => `<button class="nav-group-head ${group.key === activeGroup ? 'is-current' : ''}" type="button" data-group-head="${group.key}" aria-expanded="${group.key === activeGroup}">
    <span>${esc(group.title_zh)}</span><em>${group.categories.length}</em>${icon('chevron')}
  </button>`).join('')
  const group = data.groups.find((g) => g.key === activeGroup) || data.groups[0]
  const items = group.categories.map((key) => {
      const cat = categoryMap.get(key)
      if (!cat) return ''
      const count = (scheme.selections[key] || []).length
      const active = view.quick === '' && store.state.ui.category === key
      return `<button class="nav-item ${active ? 'is-active' : ''} ${count ? 'is-done' : ''}" type="button" data-cat="${key}">
        <span class="nav-name">${esc(cat.title_zh)}</span>
        <span class="nav-count">${count || '·'}</span>
      </button>`
    }).join('')
  $('#nav').innerHTML = `<div class="nav-groups">${headers}</div><div class="nav-items">${items}</div>`
  renderMobileGroups(activeGroup)
}

function renderMobileGroups(activeGroup) {
  const labels = { face: '面部', eyes: '眼睛', hair: '发型', makeup: '妆容' }
  $('#mobile-groups').innerHTML = data.groups.map((group) => `<button class="mobile-group ${group.key === activeGroup ? 'is-active' : ''}" type="button" data-group="${group.key}">${labels[group.key] || group.title_zh}</button>`).join('')
}

function currentCategory() {
  return categoryMap.get(store.state.ui.category) || categories[0]
}

function renderStageHead() {
  if (view.quick) {
    const isFav = view.quick === 'favorites'
    $('#crumb-group').textContent = '跨维度'
    $('#crumb-count').textContent = `${isFav ? '收藏' : '最近使用'} · ${quickItems().length} 个特征`
    $('#cat-title').textContent = isFav ? '收藏的特征' : '最近使用'
    $('#cat-blurb').textContent = isFav ? '常用的特征放在一起，点选即可加入当前方案。' : '最近点选过的特征，方便反复调整。'
    $('#cat-mode').textContent = '跨维度'
    $('#clear-category').hidden = true
  } else {
    const cat = currentCategory()
    const group = data.groups.find((g) => g.key === cat.group)
    $('#crumb-group').textContent = group?.title_zh || ''
    $('#crumb-count').textContent = `${group?.categories.length || 0} 个维度`
    $('#cat-title').textContent = cat.title_zh
    $('#cat-blurb').textContent = cat.blurb
    $('#cat-mode').textContent = cat.select_mode === 'single' ? '单选' : `多选 · 最多 ${cat.max_select} 个`
    $('#clear-category').hidden = false
  }
  $('#panel-toggle-count').textContent = countSelections(store.scheme)
  renderMoodRow()
}

function renderMoodRow() {
  const row = $('#mood-row')
  if (view.quick) {
    row.innerHTML = ''
    return
  }
  const cat = currentCategory()
  const freq = new Map()
  for (const item of cat.items) {
    for (const tag of item.mood_tags || []) freq.set(tag, (freq.get(tag) || 0) + 1)
  }
  const tags = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12)
  row.innerHTML = tags.map(([tag]) => `<button class="mood-chip ${view.mood === tag ? 'is-active' : ''}" type="button" data-mood="${esc(tag)}">${esc(tag)}</button>`).join('')
}

function quickItems() {
  const ids = view.quick === 'favorites' ? store.state.favorites : store.state.recents.map((r) => r.id)
  return ids.map((id) => {
    const item = itemMap.get(id)
    if (!item) return null
    return { item, cat: categoryMap.get(item.category) }
  }).filter(Boolean)
}

function filteredCards() {
  const scheme = store.scheme
  const q = view.query.trim().toLowerCase()
  let list
  if (view.quick) {
    list = quickItems()
  } else {
    const cat = currentCategory()
    list = cat.items.map((item) => ({ item, cat }))
  }
  if (view.mood && !view.quick) list = list.filter(({ item }) => (item.mood_tags || []).includes(view.mood))
  if (q) {
    list = list.filter(({ item, cat }) => {
      const hay = [item.name_zh, item.name_en, ...(item.aliases || []), ...(item.mood_tags || []), cat.title_zh].join(' ').toLowerCase()
      return q.split(/\s+/).every((t) => hay.includes(t))
    })
  }
  return list.map((entry) => ({ ...entry, selected: (scheme.selections[entry.item.category] || []).includes(entry.item.id) }))
}

function renderCards() {
  const list = filteredCards()
  const grid = $('#cards')
  $('#empty').hidden = list.length !== 0
  grid.innerHTML = list.map(({ item, cat, selected }) => cardMarkup(item, cat, selected, Boolean(view.quick))).join('')
    + (view.quick ? '' : `<button class="custom-card" type="button" data-custom-add="${currentCategory().key}">
        <span class="custom-plus">${icon('plus')}</span>
        <strong>新增自定义特征</strong>
        <small>给「${esc(currentCategory().title_zh)}」补充一条自己的选项</small>
      </button>`)
  $$('input[type="range"]', grid).forEach(updateRangeFill)
}

function cardMarkup(item, cat, selected, showCat) {
  const open = view.expanded.has(item.id)
  const image = effectiveReference(item.id)
  const customRef = Boolean(store.state.referenceOverrides?.[item.id])
  const strength = Number(store.scheme.strengths?.[item.category]?.[item.id] || 3)
  const fav = store.state.favorites.includes(item.id)
  const tags = (item.mood_tags || []).slice(0, 3)
  const thumb = image
    ? `<div class="thumb-empty">${icon('image')}<span>待补参考图</span><em>${esc(cat.title_en)}</em></div>
       <img src="${esc(faceReferenceUrl(image))}" alt="${esc(item.name_zh)}参考图" loading="lazy" decoding="async" onerror="this.classList.add('is-broken')">`
    : `<div class="thumb-empty">${icon('image')}<span>待补参考图</span><em>${esc(cat.title_en)}</em></div>`
  return `<article class="card ${image ? '' : 'no-ref'} ${selected ? 'is-selected' : ''} ${open ? 'is-open' : ''}" data-cat="${item.category}" data-id="${item.id}" tabindex="0" role="button" aria-pressed="${selected}" aria-label="${esc(item.name_zh)}，${selected ? '已选' : '未选'}">
    <div class="thumb">
      ${thumb}
      ${customRef ? `<span class="ref-custom-badge">自定义图</span>` : ''}
      <span class="picked-badge">${icon('check')}已选</span>
      <button class="fav-btn ${fav ? 'is-fav' : ''}" type="button" data-fav="${item.id}" aria-label="${fav ? '取消收藏' : '收藏'}${esc(item.name_zh)}" title="${fav ? '取消收藏' : '收藏'}">${icon('star')}</button>
    </div>
    <div class="card-body">
      <div class="card-title"><h3>${esc(item.name_zh)}</h3><em>${esc(item.name_en)}</em></div>
      <p class="card-def">${esc(item.definition)}</p>
      <div class="tag-row">
        ${showCat ? `<span class="tag tag-cat">${esc(cat.title_zh)}</span>` : ''}
        ${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
      </div>
    </div>
    <button class="card-more" type="button" data-more="${item.id}">${open ? '收起' : '详情'}${icon('chevron')}</button>
    ${open ? `<div class="card-detail">
      <ul class="feature-list">${(item.visual_features || []).slice(0, 4).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      <p class="detail-prompt">${esc(item.prompt_zh)}</p>
      <div class="ref-upload">
        <div class="ref-upload-head"><strong>参考图</strong><span>${image ? (customRef ? '当前：自定义上传' : '当前：内置图') : '当前：待补'}</span></div>
        <div class="ref-upload-actions">
          <button class="btn ghost" type="button" data-upload-ref="${item.id}">${icon('upload')}${image ? '更换图片' : '上传图片'}</button>
          ${customRef ? `<button class="text-btn" type="button" data-reset-ref="${item.id}">恢复默认</button>` : ''}
        </div>
        <input type="file" accept="image/png,image/jpeg,image/webp" data-ref-file="${item.id}" hidden>
        <small>JPG / PNG / WebP，自动压缩到 1400px 内。</small>
      </div>
      ${item.strength_supported ? `<div class="strength">
        <div class="strength-head"><span>强度</span><b data-strength-label="${item.id}">${strength} / 5</b></div>
        <input type="range" min="1" max="5" step="1" value="${strength}" data-strength="${item.id}" data-cat="${item.category}" aria-label="${esc(item.name_zh)}强度">
        <div class="strength-marks"><span>极轻微</span><span>适中</span><span>强烈</span></div>
      </div>` : ''}
      ${item.is_custom ? `<button class="text-btn danger custom-del" type="button" data-del-custom="${item.id}">删除这个自定义项</button>` : ''}
    </div>` : ''}
  </article>`
}

function updateRangeFill(input) {
  const value = Number(input.value)
  input.style.setProperty('--fill', `${((value - 1) / 4) * 100}%`)
}

function countSelections(scheme) {
  return Object.values(scheme.selections || {}).reduce((n, list) => n + (list?.length || 0), 0)
}

function currentCompiled() {
  const ui = store.state.ui
  return compiler.compile(store.scheme, { lang: ui.lang, length: ui.length, shot: ui.shot })
}

function renderPanel() {
  const ui = store.state.ui
  const compiled = currentCompiled()
  view.compiled = compiled

  $$('.tab').forEach((tab) => {
    const active = tab.dataset.tab === view.tab
    tab.classList.toggle('is-active', active)
    tab.setAttribute('aria-selected', String(active))
  })
  $$('#modes .seg').forEach((seg) => {
    $$('button', seg).forEach((btn) => btn.classList.toggle('is-active', btn.dataset.val === ui[seg.dataset.group]))
  })

  const conflictBox = $('#conflict-box')
  if (compiled.conflicts.length) {
    conflictBox.hidden = false
    conflictBox.innerHTML = compiled.conflicts.map((c) => `<div class="conflict-item">
      ${icon('spark')}
      <p>${esc(c.message)}</p>
      <button type="button" data-remove-cat="${c.right.cat}" data-remove-id="${c.right.id}">移除</button>
    </div>`).join('')
  } else {
    conflictBox.hidden = true
    conflictBox.innerHTML = ''
  }

  const showFull = view.tab === 'full'
  const showNegative = view.tab === 'negative'
  $('#editor-full').hidden = !showFull
  $('#editor-negative').hidden = !showNegative
  $('#structure').hidden = view.tab !== 'structure'
  $('#refs').hidden = view.tab !== 'refs'

  if (showFull) {
    const area = $('#prompt-full')
    area.value = compiled.full
    $('#manual-full').hidden = true
    $('#char-count').textContent = `${area.value.length} 字`
    $('#neg-count').hidden = true
  }
  if (showNegative) {
    const area = $('#prompt-negative')
    const autoNegative = ui.lang === 'en' ? compiled.negativeEn : compiled.negative
    area.value = autoNegative
    $('#manual-negative').hidden = true
    $('#neg-count').hidden = false
    $('#neg-count').textContent = `${(area.value || '').split(/[，,]/).filter((s) => s.trim()).length} 项`
    $('#char-count').textContent = `${area.value.length} 字`
  }
  if (view.tab === 'structure') renderStructure(compiled)
  if (view.tab === 'refs') renderRefs()

  $('#panel-toggle-count').textContent = compiled.count
  updateHandoffState()
}

function updateHandoffState() {
  const button = $('#handoff-btn')
  if (!button) return
  button.disabled = !(view.compiled?.count > 0) || !currentFullText().trim()
}

function renderStructure(compiled) {
  const scheme = store.scheme
  const blocks = compiled.structured.map((group) => `<div class="struct-group">
    <h4>${esc(group.title)}</h4>
    ${group.rows.map((row) => `<div class="struct-row"><span class="s-label">${esc(row.label)}</span><span class="s-value ${row.empty ? 'is-empty' : ''}">${row.empty ? '未选择' : esc(row.value)}</span></div>`).join('')}
  </div>`).join('')
  const negs = (scheme.negatives || []).map((id) => data.negatives.find((n) => n.id === id)).filter(Boolean)
  const extra = `<div class="struct-group">
    <h4>角色信息</h4>
    <div class="struct-row"><span class="s-label">性别呈现</span><span class="s-value">${esc(scheme.gender || '未指定')}</span></div>
    <div class="struct-row"><span class="s-label">年龄段</span><span class="s-value">${esc(scheme.age || '未指定')}</span></div>
    <div class="struct-row"><span class="s-label">角色定位</span><span class="s-value ${scheme.role ? '' : 'is-empty'}">${esc(scheme.role || '未填写')}</span></div>
    <div class="struct-row"><span class="s-label">补充描述</span><span class="s-value ${scheme.customNotes ? '' : 'is-empty'}">${esc(scheme.customNotes || '未填写')}</span></div>
  </div>
  <div class="struct-group">
    <h4>负向约束</h4>
    <div class="struct-row"><span class="s-label">已启用</span><span class="s-value ${negs.length ? '' : 'is-empty'}">${negs.length ? negs.map((n) => esc(n.name_zh)).join('、') : '无'}</span></div>
    <div class="struct-row"><span class="s-label">自动追加</span><span class="s-value">${esc(compiled.negative || '无')}</span></div>
  </div>`
  $('#structure').innerHTML = blocks + extra
}

function renderRefs() {
  const scheme = store.scheme
  const picked = []
  for (const [catKey, ids] of Object.entries(scheme.selections)) {
    const cat = categoryMap.get(catKey)
    for (const id of ids) {
      const item = itemMap.get(id)
      if (item) picked.push({ item, cat })
    }
  }
  const note = `<p class="refs-note">参考图只解释该类型的结构差异，不代表最终角色必须复制示例人物的身份或无关特征。</p>`
  if (!picked.length) {
    $('#refs').innerHTML = `${note}<div class="refs-empty">还没有已选特征。选好之后，这里会汇总对应的参考图。</div>`
    return
  }
  $('#refs').innerHTML = `${note}<div class="refs-grid">${picked.map(({ item, cat }) => {
    const image = effectiveReference(item.id)
    return `<div class="ref-card">
      <div class="ref-thumb">${image ? `<img src="${esc(faceReferenceUrl(image))}" alt="${esc(item.name_zh)}参考图" loading="lazy">` : `<span>待补</span>`}</div>
      <p>${esc(item.name_zh)}<br><small>${esc(cat.title_zh)}</small></p>
    </div>`
  }).join('')}</div>`
}

function renderFooter() {
  const scheme = store.scheme
  const total = countSelections(scheme)
  const picked = []
  for (const ids of Object.values(scheme.selections)) {
    for (const id of ids) {
      const item = itemMap.get(id)
      if (item) picked.push(item.name_zh)
    }
  }
  $('#selection-summary').textContent = total ? `已选 ${total} 项 · ${picked.slice(0, 4).join(' / ')}${picked.length > 4 ? ' …' : ''}` : '尚未选择，可从左侧任一维度开始'
  $('#coverage').textContent = `参考图 ${Object.keys(effectiveReferenceMap()).length} / ${data.total + (store.state.customItems?.length || 0)}`
}

/* ---------------------------------------------------------------- actions */
function selectCategory(key) {
  const cat = categoryMap.get(key)
  if (cat) view.mobileGroup = cat.group
  store.state.ui.category = key
  store.setUi({ category: key })
  view.quick = ''
  view.query = ''
  view.mood = ''
  $('#side-search-input').value = ''
  $$('.quick-chip').forEach((c) => c.classList.remove('is-active'))
  renderStageHead()
  renderCards()
  renderNav()
  $('.cards-wrap').scrollTop = 0
}

function toggleItem(catKey, id) {
  const result = store.toggleItem(catKey, id)
  if (result.notice) toast(result.notice)
  renderNav()
  renderCards()
  renderPanel()
  renderFooter()
  renderStageHead()
}

function jumpTo(item) {
  closeOverlays()
  view.mobileGroup = categoryMap.get(item.category)?.group || view.mobileGroup
  store.state.ui.category = item.category
  store.setUi({ category: item.category })
  view.quick = ''
  view.query = ''
  view.mood = ''
  $('#side-search-input').value = ''
  $$('.quick-chip').forEach((c) => c.classList.remove('is-active'))
  view.expanded.add(item.id)
  renderAll()
  requestAnimationFrame(() => {
    const card = document.querySelector(`.card[data-id="${item.id}"]`)
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' })
      card.classList.add('is-flash')
      setTimeout(() => card.classList.remove('is-flash'), 1200)
    }
  })
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片读取失败，请换一张试试'))
    }
    image.src = url
  })
}

async function prepareReferenceImage(file) {
  const allowed = ['image/png', 'image/jpeg', 'image/webp']
  if (!allowed.includes(file.type)) throw new Error('只支持 JPG、PNG 或 WebP 图片')
  if (file.size > 15 * 1024 * 1024) throw new Error('图片不能超过 15MB')

  let source
  if ('createImageBitmap' in window) {
    try {
      source = await createImageBitmap(file)
    } catch {
      source = null
    }
  }
  if (!source) source = await loadImageFile(file)

  const width = source.width || source.naturalWidth
  const height = source.height || source.naturalHeight
  const scale = Math.min(1, 1400 / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  source.close?.()

  let dataUrl = canvas.toDataURL('image/webp', 0.9)
  if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/jpeg', 0.9)
  return dataUrl
}

function faceUploadName(id) {
  const user = String(window.__FACE_USER_ID__ || 'guest').replace(/[^a-z0-9]/gi, '').slice(0, 8)
  const base = `face-${id}`.replace(/[^a-z0-9_-]/gi, '-').slice(0, 26)
  return `${base}-${user}-${Date.now().toString(36).slice(-6)}`.slice(0, 40)
}

async function uploadReference(id, file) {
  const card = document.querySelector(`.card[data-id="${id}"]`)
  const button = card?.querySelector(`[data-upload-ref="${id}"]`)
  const original = button?.innerHTML
  if (button) {
    button.disabled = true
    button.textContent = '上传中…'
  }
  try {
    const dataUrl = await prepareReferenceImage(file)
    const result = await uploadReferenceImage({ name: faceUploadName(id), dataUrl })
    if (!result?.path) throw new Error('上传成功但没有返回文件路径')
    store.setReferenceOverride(id, result.path)
    renderAll()
    toast('参考图已更新')
  } catch (err) {
    toast(err.message || '上传失败')
    if (button) {
      button.disabled = false
      button.innerHTML = original
    }
  }
}

function resetReference(id) {
  confirmModal('恢复默认参考图？', '会删除当前账号上传的覆盖图，恢复服务端内置参考图。', '恢复').then((ok) => {
    if (!ok) return
    store.clearReferenceOverride(id)
    renderAll()
    toast('已恢复默认参考图')
  })
}

async function copyText(text, label = '已复制') {
  if (!text) return toast('当前没有可复制的内容')
  try {
    await navigator.clipboard.writeText(text)
    toast(label)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      toast(label)
    } catch {
      toast('复制失败，请手动选择文本')
    }
    ta.remove()
  }
}

function currentFullText() {
  return view.compiled?.full || ''
}

function currentNegativeText() {
  const auto = store.state.ui.lang === 'en' ? view.compiled?.negativeEn : view.compiled?.negative
  return auto || ''
}

function handoffToFree() {
  if (!(view.compiled?.count > 0)) {
    toast('先选至少一个面部特征')
    return
  }
  const nameInput = $('#scheme-name')
  if (nameInput?.value.trim()) store.renameScheme(nameInput.value.trim())
  store.save()
  const prompt = currentFullText().trim()
  if (!prompt) {
    toast('当前没有可带入的提示词')
    return
  }
  const userId = String(window.__FACE_USER_ID__ || '')
  if (!userId) {
    toast('登录状态异常，请刷新后重试')
    return
  }
  try {
    localStorage.setItem(
      `huajing.faceStudio.handoff.v1.${userId}`,
      JSON.stringify({
        version: 1,
        prompt,
        negative: currentNegativeText().trim(),
        schemeName: store.scheme.name,
        createdAt: new Date().toISOString(),
      }),
    )
  } catch {
    toast('浏览器存储已满，请先复制提示词再手动粘贴', true)
    return
  }
  window.location.href = '/batch.html?from=face'
}

function structureText() {
  const rows = []
  for (const group of view.compiled?.structured || []) {
    rows.push(`【${group.title}】`)
    for (const row of group.rows) rows.push(`${row.label}：${row.empty ? '未选择' : row.value}`)
  }
  return rows.join('\n')
}

function download(filename, content, type = 'text/plain') {
  const blob = new Blob([content], { type: `${type};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

function markdownExport() {
  const scheme = store.scheme
  const style = data.visual_styles.find((s) => s.id === scheme.visualStyle)
  const compiled = currentCompiled()
  const rows = compiled.structured
    .map((group) => group.rows.map((row) => `| ${group.title} | ${row.label} | ${row.empty ? '—' : row.value} |`).join('\n'))
    .join('\n')
  return `# ${scheme.name}

> 视觉风格：${style?.name_zh || ''} ｜ 性别呈现：${scheme.gender || '未指定'} ｜ 年龄段：${scheme.age || '未指定'} ｜ 角色定位：${scheme.role || '未填写'}
> 导出时间：${new Date().toLocaleString('zh-CN')}

## 完整提示词

\`\`\`text
${currentFullText()}
\`\`\`

## 负向提示词

\`\`\`text
${currentNegativeText()}
\`\`\`

## 结构化设定

| 模块 | 维度 | 选择 |
| --- | --- | --- |
${rows}

## 补充描述

${scheme.customNotes || '—'}
`
}

function jsonExport() {
  const scheme = store.scheme
  const compiled = currentCompiled()
  const style = data.visual_styles.find((s) => s.id === scheme.visualStyle)
  const selections = {}
  for (const [catKey, ids] of Object.entries(scheme.selections)) {
    selections[catKey] = ids.map((id) => {
      const item = itemMap.get(id)
      return { id, name_zh: item?.name_zh, name_en: item?.name_en, strength: scheme.strengths?.[catKey]?.[id] || 3 }
    })
  }
  return JSON.stringify({
    app: '面容工坊 · AI 角色面部设计工作台',
    version: '1.0',
    exportedAt: new Date().toISOString(),
    scheme: { ...scheme, manual: { full: null, negative: null } },
    resolved: {
      visualStyle: style ? { id: style.id, name_zh: style.name_zh, name_en: style.name_en } : null,
      selections,
      prompt: { zh: compiled.zh, en: compiled.en, negative_zh: compiled.negative, negative_en: compiled.negativeEn },
      conflicts: compiled.conflicts.map((c) => c.message),
    },
  }, null, 2)
}

/* ---------------------------------------------------------------- overlays */
function openModal(html) {
  view.confirmClose = null
  $('#modal').innerHTML = html
  $('#modal-overlay').hidden = false
  view.overlay = 'modal'
}

function closeOverlays() {
  $('#search-overlay').hidden = true
  $('#modal-overlay').hidden = true
  view.overlay = ''
}

function confirmModal(title, message, okLabel = '确认') {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      view.confirmClose = null
      closeOverlays()
      resolve(value)
    }
    openModal(`<div class="modal-head">
      <div><h2>${esc(title)}</h2><p class="modal-sub">${esc(message)}</p></div>
      <button class="icon-btn" data-modal-close type="button" aria-label="关闭">${icon('close')}</button>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" data-modal-close type="button">取消</button>
      <button class="btn gold" data-confirm type="button">${esc(okLabel)}</button>
    </div>`)
    view.confirmClose = () => done(false)
    $('#modal [data-confirm]').onclick = () => done(true)
    $$('#modal [data-modal-close]').forEach((btn) => { btn.onclick = () => done(false) })
  })
}

function openPresets() {
  const cards = data.presets.map((preset) => `<button class="preset-card" type="button" data-preset="${preset.id}">
    <strong>${esc(preset.name)}</strong>
    <span>${esc(preset.note)}</span>
    <em>${Object.values(preset.selections).reduce((n, ids) => n + ids.length, 0)} 项设定</em>
  </button>`).join('')
  openModal(`<div class="modal-head">
    <div><h2>预设方案</h2><p class="modal-sub">预设只是起点，载入后所有字段都可以继续改。</p></div>
    <button class="icon-btn" data-modal-close type="button" aria-label="关闭">${icon('close')}</button>
  </div>
  <div class="modal-grid">${cards}</div>`)
  $$('#modal [data-modal-close]').forEach((btn) => { btn.onclick = closeOverlays })
  $$('#modal [data-preset]').forEach((btn) => {
    btn.onclick = async () => {
      const preset = data.presets.find((p) => p.id === btn.dataset.preset)
      if (!preset) return
      const had = countSelections(store.scheme)
      closeOverlays()
      if (had) {
        const ok = await confirmModal('覆盖当前选择？', `载入「${preset.name}」会替换当前已选的 ${had} 项特征。`, '载入并覆盖')
        if (!ok) return
      }
      applyPreset(preset)
    }
  })
}

function applyPreset(preset) {
  const scheme = store.scheme
  scheme.selections = JSON.parse(JSON.stringify(preset.selections))
  scheme.strengths = {}
  scheme.manual = { full: null, negative: null }
  if (!scheme.name || scheme.name === '未命名角色') scheme.name = preset.name
  store.state.ui.category = Object.keys(preset.selections)[0] || 'face_shape'
  store.setUi({ category: store.state.ui.category })
  store.commit()
  view.quick = ''
  view.mood = ''
  view.query = ''
  $('#side-search-input').value = ''
  syncSchemeFields()
  renderAll()
  toast(`已载入「${preset.name}」`)
}

function openCustomModal(catKey) {
  const cat = categoryMap.get(catKey)
  if (!cat) return
  openModal(`<div class="modal-head">
    <div><h2>新增自定义特征</h2><p class="modal-sub">补充到「${esc(cat.title_zh)}」。它会保存在本地，并参与提示词生成。</p></div>
    <button class="icon-btn" data-modal-close type="button" aria-label="关闭">${icon('close')}</button>
  </div>
  <div class="form-grid">
    <label>中文名称<input id="custom-name" maxlength="24" placeholder="例如：左眼下方小泪痣"></label>
    <label>英文名称<input id="custom-en" maxlength="48" placeholder="可选"></label>
    <label class="full">一句话解释<textarea id="custom-def" rows="2" maxlength="120" placeholder="它在画面上具体表现成什么样"></textarea></label>
    <label class="full">提示词片段<textarea id="custom-prompt" rows="2" maxlength="160" placeholder="留空则使用上面的解释"></textarea></label>
  </div>
  <div class="modal-actions">
    <button class="btn ghost" data-modal-close type="button">取消</button>
    <button class="btn gold" data-save-custom type="button">添加并选中</button>
  </div>`)
  $$('#modal [data-modal-close]').forEach((btn) => { btn.onclick = closeOverlays })
  $('#custom-name').focus()
  $('#modal [data-save-custom]').onclick = () => {
    const name = $('#custom-name').value.trim()
    if (!name) {
      toast('先给这个特征起个名字')
      $('#custom-name').focus()
      return
    }
    const definition = $('#custom-def').value.trim() || name
    const item = store.addCustomItem({
      category: catKey,
      name_zh: name,
      name_en: $('#custom-en').value,
      definition,
      prompt_zh: $('#custom-prompt').value,
    })
    closeOverlays()
    rebuildCompiler()
    view.expanded.add(item.id)
    const result = store.toggleItem(catKey, item.id)
    renderAll()
    toast(result.notice || `已添加「${item.name_zh}」`)
  }
}

function openSearch() {
  $('#search-overlay').hidden = false
  view.overlay = 'search'
  const input = $('#global-search-input')
  input.value = ''
  view.searchResults = []
  view.searchFocus = 0
  renderSearch('')
  setTimeout(() => input.focus(), 30)
}

function renderSearch(query) {
  const body = $('#search-results')
  const q = query.trim()
  if (!q) {
    const suggestions = ['桃花眼', '空气刘海', '冰蓝', '冷白', '大波浪', '高盘发', '水光唇', '剑眉']
    const recents = store.state.recents.slice(0, 6).map((r) => itemMap.get(r.id)).filter(Boolean)
    body.innerHTML = `<div class="search-group-label">试试这些</div>
      <div class="mood-row" style="padding:0 8px 12px">${suggestions.map((s) => `<button class="mood-chip" type="button" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      ${recents.length ? `<div class="search-group-label">最近使用</div>${recents.map((item) => searchRow(item)).join('')}` : ''}`
    return
  }
  const results = searchItems(data, q)
  view.searchResults = results
  view.searchFocus = 0
  if (!results.length) {
    body.innerHTML = `<div class="empty" style="padding:40px 10px">${icon('search')}<h3>没有找到「${esc(q)}」</h3><p>试试中文名、英文名或别名，例如「鹅蛋脸」「fox eyes」。</p></div>`
    return
  }
  let lastGroup = ''
  body.innerHTML = results.slice(0, 40).map(({ item, cat }, idx) => {
    const header = cat.group !== lastGroup ? `<div class="search-group-label">${esc(data.groups.find((g) => g.key === cat.group)?.title_zh || '')}</div>` : ''
    lastGroup = cat.group
    return header + searchRow(item, cat, idx === 0)
  }).join('')
}

function searchRow(item, cat = categoryMap.get(item.category), focused = false) {
  const picked = (store.scheme.selections[item.category] || []).includes(item.id)
  return `<button class="search-row ${picked ? 'is-picked' : ''} ${focused ? 'is-focus' : ''}" type="button" data-jump="${item.id}">
    <span><span class="s-name">${esc(item.name_zh)}</span><span class="s-en"> · ${esc(item.name_en)}</span></span>
    <span class="s-cat">${esc(cat?.title_zh || '')}</span>
  </button>`
}

function moveSearchFocus(delta) {
  if (!view.searchResults.length) return
  view.searchFocus = Math.max(0, Math.min(view.searchResults.length - 1, view.searchFocus + delta))
  $$('#search-results .search-row').forEach((row, i) => row.classList.toggle('is-focus', i === view.searchFocus))
  const row = $$('#search-results .search-row')[view.searchFocus]
  if (row) row.scrollIntoView({ block: 'nearest' })
}

/* ---------------------------------------------------------------- events */
function bind() {
  $('#nav').addEventListener('click', (e) => {
    const head = e.target.closest('[data-group-head]')
    if (head) {
      const group = data.groups.find((g) => g.key === head.dataset.groupHead)
      if (group && currentCategory().group !== group.key) selectCategory(group.categories[0])
      return
    }
    const btn = e.target.closest('[data-cat]')
    if (btn) selectCategory(btn.dataset.cat)
  })

  $('#mobile-groups').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-group]')
    if (!btn) return
    const group = data.groups.find((g) => g.key === btn.dataset.group)
    if (!group) return
    view.mobileGroup = group.key
    const current = currentCategory()
    if (current.group !== group.key) selectCategory(group.categories[0])
    else renderNav()
    $('#nav').scrollLeft = 0
  })

  $('#mood-row').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-mood]')
    if (!chip) return
    view.mood = view.mood === chip.dataset.mood ? '' : chip.dataset.mood
    renderMoodRow()
    renderCards()
  })

  $('#cards').addEventListener('click', (e) => {
    if (e.target.matches('input[type="file"]')) {
      e.stopPropagation()
      return
    }
    const add = e.target.closest('[data-custom-add]')
    if (add) {
      openCustomModal(add.dataset.customAdd)
      return
    }
    const del = e.target.closest('[data-del-custom]')
    if (del) {
      e.stopPropagation()
      const item = itemMap.get(del.dataset.delCustom)
      if (!item) return
      confirmModal('删除这个自定义项？', `「${item.name_zh}」会从当前方案和本地数据库中移除。`, '删除').then(async (ok) => {
        if (!ok) return
        store.clearReferenceOverride(item.id)
        store.removeCustomItem(item.id)
        rebuildCompiler()
        renderAll()
        toast('已删除自定义项')
      })
      return
    }
    const upload = e.target.closest('[data-upload-ref]')
    if (upload) {
      e.stopPropagation()
      const input = document.querySelector(`[data-ref-file="${upload.dataset.uploadRef}"]`)
      if (input) {
        input.addEventListener('click', (event) => event.stopPropagation(), { once: true })
        input.click()
      }
      return
    }
    const reset = e.target.closest('[data-reset-ref]')
    if (reset) {
      e.stopPropagation()
      resetReference(reset.dataset.resetRef)
      return
    }
    const fav = e.target.closest('[data-fav]')
    if (fav) {
      e.stopPropagation()
      const on = store.toggleFavorite(fav.dataset.fav)
      fav.classList.toggle('is-fav', on)
      toast(on ? '已加入收藏' : '已取消收藏')
      if (view.quick === 'favorites') renderCards()
      return
    }
    const more = e.target.closest('[data-more]')
    if (more) {
      e.stopPropagation()
      const id = more.dataset.more
      if (view.expanded.has(id)) view.expanded.delete(id)
      else view.expanded.add(id)
      renderCards()
      return
    }
    if (e.target.closest('.card-detail')) return
    const card = e.target.closest('.card')
    if (card) toggleItem(card.dataset.cat, card.dataset.id)
  })

  $('#cards').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const card = e.target.closest('.card')
    if (!card || e.target.closest('button')) return
    e.preventDefault()
    toggleItem(card.dataset.cat, card.dataset.id)
  })

  $('#cards').addEventListener('input', (e) => {
    if (!e.target.matches('[data-strength]')) return
    updateRangeFill(e.target)
    const label = document.querySelector(`[data-strength-label="${e.target.dataset.strength}"]`)
    if (label) label.textContent = `${e.target.value} / 5`
  })
  $('#cards').addEventListener('change', (e) => {
    if (e.target.matches('[data-ref-file]')) {
      const file = e.target.files?.[0]
      const id = e.target.dataset.refFile
      e.target.value = ''
      if (file) uploadReference(id, file)
      return
    }
    if (e.target.matches('[data-strength]')) {
      store.setStrength(e.target.dataset.cat, e.target.dataset.strength, e.target.value)
      renderPanel()
    }
  })

  $('#clear-category').addEventListener('click', () => {
    const cat = currentCategory()
    store.clearCategory(cat.key)
    renderAll()
    toast(`已清空「${cat.title_zh}」`)
  })

  $('#reset-all').addEventListener('click', async () => {
    const ok = await confirmModal(
      '恢复空白方案？',
      '所有维度已选特征、强度、角色设定、补充描述和负向词都会回到初始空白状态。方案名称和已上传的参考图会保留；这个操作不能撤销。',
      '恢复空白',
    )
    if (!ok) return
    store.resetScheme()
    view.quick = ''
    view.mood = ''
    view.query = ''
    view.mobileGroup = 'face'
    view.expanded.clear()
    $('#side-search-input').value = ''
    $$('.quick-chip').forEach((chip) => chip.classList.remove('is-active'))
    store.state.ui.category = 'face_shape'
    store.setUi({ category: 'face_shape' })
    syncSchemeFields()
    renderAll()
    $('.cards-wrap').scrollTop = 0
    toast('已恢复空白方案')
  })

  $('#reset-filter').addEventListener('click', () => {
    view.query = ''
    view.mood = ''
    $('#side-search-input').value = ''
    renderMoodRow()
    renderCards()
  })

  $('#side-search-input').addEventListener('input', debounce((e) => {
    view.query = e.target.value
    renderCards()
    renderStageHead()
  }, 110))

  $$('.quick-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const kind = chip.dataset.quick
      view.quick = view.quick === kind ? '' : kind
      $$('.quick-chip').forEach((c) => c.classList.toggle('is-active', c.dataset.quick === view.quick))
      view.query = ''
      view.mood = ''
      $('#side-search-input').value = ''
      renderStageHead()
      renderCards()
    })
  })

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      view.tab = tab.dataset.tab
      renderPanel()
    })
  })

  $('#modes').addEventListener('click', (e) => {
    const btn = e.target.closest('button')
    if (!btn) return
    const group = btn.closest('.seg').dataset.group
    store.setUi({ [group]: btn.dataset.val })
    renderPanel()
  })

  $$('[data-restore]').forEach((btn) => {
    btn.addEventListener('click', () => {
      store.restoreManual(btn.dataset.restore)
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      renderPanel()
      toast('已恢复自动生成版本')
    })
  })
  $('#conflict-box').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-id]')
    if (!btn) return
    store.removeItem(btn.dataset.removeCat, btn.dataset.removeId)
    renderAll()
  })

  $('#copy-btn').addEventListener('click', () => {
    if (view.tab === 'negative') copyText(currentNegativeText(), '负向提示词已复制')
    else if (view.tab === 'structure') copyText(structureText(), '结构化设定已复制')
    else copyText(currentFullText(), '完整提示词已复制')
  })

  $('#export-md-btn').addEventListener('click', () => {
    download(`${store.scheme.name || '角色方案'}-面部设定.md`, markdownExport(), 'text/markdown')
    toast('已导出 Markdown')
  })

  $('#scheme-name').addEventListener('change', (e) => {
    store.renameScheme(e.target.value)
    e.target.value = store.scheme.name
    toast('方案已重命名')
  })
  $('#visual-style').addEventListener('change', (e) => {
    store.setSchemeField('visualStyle', e.target.value)
    renderPanel()
  })
  $('#gender').addEventListener('change', (e) => {
    store.setSchemeField('gender', e.target.value)
    renderPanel()
  })
  $('#age').addEventListener('change', (e) => {
    store.setSchemeField('age', e.target.value)
    renderPanel()
  })
  $('#role').addEventListener('input', debounce((e) => {
    store.setSchemeField('role', e.target.value)
    renderPanel()
  }, 280))
  $('#custom-notes').addEventListener('input', debounce((e) => {
    store.setSchemeField('customNotes', e.target.value)
    renderPanel()
    renderFooter()
  }, 280))

  $('#new-scheme').addEventListener('click', () => {
    store.createScheme()
    view.quick = ''
    view.mood = ''
    store.state.ui.category = 'face_shape'
    store.setUi({ category: 'face_shape' })
    syncSchemeFields()
    renderAll()
    toast('已新建方案')
  })

  $('#more-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    $('#more-menu').hidden = !$('#more-menu').hidden
    $('#export-menu').hidden = true
  })
  $('#more-menu').addEventListener('click', async (e) => {
    const btn = e.target.closest('button')
    if (!btn) return
    $('#more-menu').hidden = true
    const act = btn.dataset.act
    if (act === 'duplicate') {
      store.duplicateScheme()
      syncSchemeFields()
      renderAll()
      toast('已复制当前方案')
    }
    if (act === 'rename') {
      const next = window.prompt('新的方案名称', store.scheme.name)
      if (next) {
        store.renameScheme(next)
        syncSchemeFields()
        toast('已重命名')
      }
    }
    if (act === 'import') $('#import-file').click()
    if (act === 'delete') {
      if (store.state.schemes.length <= 1) return toast('至少保留一个方案')
      const ok = await confirmModal('删除当前方案？', `「${store.scheme.name}」将被永久删除，这个操作不能撤销。`, '删除')
      if (!ok) return
      store.deleteScheme()
      syncSchemeFields()
      renderAll()
      toast('方案已删除')
    }
  })

  $('#export-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    $('#export-menu').hidden = !$('#export-menu').hidden
    $('#more-menu').hidden = true
  })
  $('#export-menu').addEventListener('click', (e) => {
    const btn = e.target.closest('button')
    if (!btn) return
    $('#export-menu').hidden = true
    const act = btn.dataset.act
    if (act === 'copy-full') copyText(currentFullText(), '完整提示词已复制')
    if (act === 'copy-negative') copyText(currentNegativeText(), '负向提示词已复制')
    if (act === 'export-md') {
      download(`${store.scheme.name || '角色方案'}-面部设定.md`, markdownExport(), 'text/markdown')
      toast('已导出 Markdown')
    }
    if (act === 'export-json') {
      download(`${store.scheme.name || '角色方案'}-面部设定.json`, jsonExport(), 'application/json')
      toast('已导出 JSON')
    }
  })

  $('#open-presets').addEventListener('click', openPresets)
  $('#randomize-btn').addEventListener('click', async () => {
    const count = countSelections(store.scheme)
    if (count > 0) {
      const ok = await confirmModal(
        '随机生成新角色？',
        `会替换当前已选的 ${count} 项特征，并重新随机视觉风格、性别、年龄和强度。方案名称与参考图会保留。`,
        '重新生成',
      )
      if (!ok) return
    }
    store.randomizeScheme()
    view.quick = ''
    view.mood = ''
    view.query = ''
    view.mobileGroup = 'face'
    view.expanded.clear()
    $('#side-search-input').value = ''
    $$('.quick-chip').forEach((chip) => chip.classList.remove('is-active'))
    store.state.ui.category = 'face_shape'
    store.setUi({ category: 'face_shape' })
    syncSchemeFields()
    renderAll()
    $('.cards-wrap').scrollTop = 0
    toast('已随机生成新角色')
  })
  $('#handoff-btn').addEventListener('click', handoffToFree)
  $('#open-search').addEventListener('click', openSearch)
  $('#close-search').addEventListener('click', closeOverlays)
  $('#global-search-input').addEventListener('input', (e) => renderSearch(e.target.value))
  $('#global-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveSearchFocus(1)
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveSearchFocus(-1)
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const target = view.searchResults[view.searchFocus]
      if (target) jumpTo(target.item)
      else {
        const first = searchItems(data, $('#global-search-input').value)[0]
        if (first) jumpTo(first.item)
      }
    }
  })
  $('#search-results').addEventListener('click', (e) => {
    const suggest = e.target.closest('[data-suggest]')
    if (suggest) {
      $('#global-search-input').value = suggest.dataset.suggest
      renderSearch(suggest.dataset.suggest)
      return
    }
    const row = e.target.closest('[data-jump]')
    if (row) {
      const item = itemMap.get(row.dataset.jump)
      if (item) jumpTo(item)
    }
  })

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      store.importScheme(parsed.scheme && parsed.scheme.selections ? parsed.scheme : parsed)
      syncSchemeFields()
      renderAll()
      toast('方案已导入')
    } catch (err) {
      toast(`导入失败：${err.message}`)
    }
    e.target.value = ''
  })

  $('#panel-toggle').addEventListener('click', () => $('#panel').classList.add('is-open'))
  $('#panel-close').addEventListener('click', () => $('#panel').classList.remove('is-open'))

  $('#search-overlay').addEventListener('click', (e) => {
    if (e.target === $('#search-overlay')) closeOverlays()
  })
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('#modal-overlay')) {
      view.confirmClose?.()
      closeOverlays()
    }
  })

  document.addEventListener('click', () => {
    $('#more-menu').hidden = true
    $('#export-menu').hidden = true
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      view.confirmClose?.()
      closeOverlays()
      $('#panel').classList.remove('is-open')
      return
    }
    const tag = document.activeElement?.tagName
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    if (e.key === '/' && !typing) {
      e.preventDefault()
      openSearch()
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      openSearch()
    }
  })
}

boot()
