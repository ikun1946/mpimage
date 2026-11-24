const DEGREE_ZH = { 1: '极轻微', 2: '轻微', 4: '明显', 5: '强烈' }
const DEGREE_EN = { 1: 'Very subtle ', 2: 'Subtle ', 4: 'Pronounced ', 5: 'Strong ' }

const SHOTS = {
  portrait: {
    zh: '半身参考构图，正面或轻微侧转，头部与肩部完整入镜，浅灰无缝背景，柔和均匀的棚拍光。',
    en: 'Half-body reference framing, frontal or a slight three-quarter turn, head and shoulders fully in frame, seamless light gray background, soft even studio lighting.',
  },
  headshot: {
    zh: '角色定妆照，正面平视，头部与肩部完整入画，中性自然表情，浅灰无缝背景，柔和均匀的棚拍光。',
    en: 'Character portrait sheet, frontal eye-level view, head and shoulders in frame, neutral expression, seamless light gray background, soft even studio lighting.',
  },
  turnaround: {
    zh: '角色三视图设定稿，同一角色的正面、侧面、背面三个视角并排，面部结构、发型长度与服装完全一致，浅灰无缝背景，均匀布光。',
    en: 'Character turnaround sheet with front, side and back views side by side; identical face structure, hair length and outfit across all views, seamless light gray background, even lighting.',
  },
}

const QUALITY = {
  zh: '保持面部五官结构清晰、比例协调、特征明确；发型结构完整，发丝层次自然；妆容边界清晰，不要让妆容或光线改变原本的脸型和五官。',
  en: 'Keep the facial structure clear, well proportioned and characteristic; render hair with coherent volume and natural strands; keep makeup edges clean, and never let makeup or lighting alter the underlying face shape or features.',
}

const SECTION_LABELS = [
  ['face', '脸型与面部结构', 'Face & structure'],
  ['browEye', '眉眼结构', 'Brows & eyes'],
  ['nose', '鼻部', 'Nose'],
  ['lip', '嘴唇', 'Lips'],
  ['skin', '肌肤', 'Skin'],
  ['hair', '发型', 'Hair'],
  ['hairExtra', '发色与发质', 'Hair color & texture'],
  ['makeup', '妆容', 'Makeup'],
  ['scene', '构图与光线', 'Composition & light'],
]

const SLOT_ORDER = [
  'face_shape', 'face_proportion', 'forehead', 'temple', 'cheek', 'bone_structure', 'jaw', 'chin',
  'brow', 'brow_eye', 'eye_shape', 'eye_corner', 'eyelid', 'eye_size', 'eye_spacing',
  'eye_position', 'iris', 'lash', 'undereye', 'gaze',
  'nose', 'lip', 'skin',
  'hair_length', 'hair_part', 'bangs', 'hair_cut', 'hair_style', 'updo', 'braid', 'ancient_bun',
  'hair_color', 'hair_texture', 'hair_accessory',
  'makeup_base', 'brow_makeup', 'eyeshadow', 'eyeliner', 'lash_makeup', 'aegyo',
  'blush', 'contour', 'highlight', 'lip_makeup', 'makeup_style', 'special_makeup',
]

const SECTION_SLOTS = {
  face: ['face_shape', 'face_proportion', 'forehead', 'temple', 'cheek', 'bone_structure', 'jaw', 'chin'],
  browEye: ['brow', 'brow_eye', 'eye_shape', 'eye_corner', 'eyelid', 'eye_size', 'eye_spacing', 'eye_position', 'iris', 'lash', 'undereye', 'gaze'],
  nose: ['nose'],
  lip: ['lip'],
  skin: ['skin'],
  hair: ['hair_length', 'hair_part', 'bangs', 'hair_cut', 'hair_style', 'updo', 'braid', 'ancient_bun'],
  hairExtra: ['hair_color', 'hair_texture', 'hair_accessory'],
  makeup: ['makeup_base', 'brow_makeup', 'eyeshadow', 'eyeliner', 'lash_makeup', 'aegyo', 'blush', 'contour', 'highlight', 'lip_makeup', 'makeup_style', 'special_makeup'],
}

const COMPACT_SLOTS = [
  'face_shape', 'bone_structure', 'eye_shape', 'eye_corner', 'iris', 'nose', 'lip', 'skin',
  'hair_length', 'bangs', 'hair_style', 'hair_color', 'hair_texture', 'makeup_style', 'lip_makeup',
]

export function createCompiler(data) {
  const categoryMap = new Map(data.categories.map((c) => [c.key, c]))
  const itemMap = new Map()
  for (const cat of data.categories) for (const item of cat.items) itemMap.set(item.id, item)

  const getItems = (scheme, catKey) => {
    const ids = scheme.selections?.[catKey] || []
    return ids.map((id) => itemMap.get(id)).filter(Boolean)
  }

  const withStrength = (item, scheme, lang) => {
    const level = Number(scheme.strengths?.[item.category]?.[item.id] || 3)
    if (!item.strength_supported || level === 3) {
      return lang === 'zh' ? item.prompt_zh : item.prompt_en
    }
    if (lang === 'zh') {
      const word = DEGREE_ZH[level]
      if (!word) return item.prompt_zh
      const fragment = item.prompt_zh || ''
      return /极轻微|轻微|明显|强烈/.test(fragment)
        ? fragment.replace(/极轻微|轻微|明显|强烈/, word)
        : `${word}${fragment}`
    }
    const word = DEGREE_EN[level]
    const fragment = item.prompt_en || ''
    if (!word) return fragment
    if (/very subtle|subtle|pronounced|strong/i.test(fragment)) {
      return fragment.replace(/very subtle|subtle|pronounced|strong/i, word.trim())
    }
    return `${word}${fragment.charAt(0).toLowerCase()}${fragment.slice(1)}`
  }

  const itemsForSlots = (scheme, slots) => slots.flatMap((key) => getItems(scheme, key))

  const styleLine = (scheme, lang) => {
    const style = data.visual_styles.find((s) => s.id === scheme.visualStyle) || data.visual_styles[0]
    if (!style) return ''
    return lang === 'zh' ? style.prompt_zh : style.prompt_en
  }

  const introLine = (scheme, lang) => {
    const bits = []
    if (lang === 'zh') {
      bits.push('原创虚构角色')
      bits.push(scheme.age ? `${scheme.age}人物` : '成年人物')
      if (scheme.gender) bits.push(scheme.gender)
      if (scheme.role?.trim()) bits.push(scheme.role.trim())
      return `${bits.join('，')}。`
    }
    bits.push('Original fictional character')
    bits.push(scheme.age === '中年' ? 'middle-aged adult' : 'young adult')
    if (scheme.gender === '男性呈现') bits.push('male-presenting')
    else if (scheme.gender === '中性呈现') bits.push('androgynous')
    else if (scheme.gender === '女性呈现') bits.push('female-presenting')
    if (scheme.role?.trim()) bits.push(`role: ${scheme.role.trim()}`)
    return `${bits.join(', ')}.`
  }

  const sectionText = (scheme, lang, slots) => {
    const parts = itemsForSlots(scheme, slots)
      .map((item) => withStrength(item, scheme, lang))
      .filter(Boolean)
      .map((fragment) => fragment.replace(lang === 'zh' ? /[。；;，,]+$/ : /[.。;；,]+$/, ''))
      .filter(Boolean)
    return parts.join(lang === 'zh' ? '，' : ', ')
  }

  const sceneLine = (scheme, lang, shot) => {
    const s = SHOTS[shot] || SHOTS.portrait
    return lang === 'zh' ? s.zh : s.en
  }

  const notesLine = (scheme, lang) => {
    const notes = scheme.customNotes?.trim()
    if (!notes) return ''
    return lang === 'zh' ? `补充要求：${notes}。` : `Additional notes: ${notes}.`
  }

  function buildFull(scheme, lang, shot) {
    if (lang === 'en') {
      const lines = []
      lines.push(introLine(scheme, 'en'))
      if (styleLine(scheme, 'en')) lines.push(`Visual style: ${styleLine(scheme, 'en')}`)
      for (const [key, , enLabel] of SECTION_LABELS) {
        if (key === 'scene') {
          lines.push(`Composition: ${sceneLine(scheme, 'en', shot)}`)
          continue
        }
        const text = sectionText(scheme, 'en', SECTION_SLOTS[key])
        if (text) lines.push(`${enLabel}: ${text}.`)
      }
      const notes = notesLine(scheme, 'en')
      if (notes) lines.push(notes)
      lines.push(QUALITY.en)
      return lines.join('\n\n')
    }
    const lines = []
    lines.push(introLine(scheme, 'zh'))
    if (styleLine(scheme, 'zh')) lines.push(`【整体视觉风格】\n${styleLine(scheme, 'zh')}`)
    for (const [key, zhLabel] of SECTION_LABELS) {
      if (key === 'scene') {
        lines.push(`【构图与光线】\n${sceneLine(scheme, 'zh', shot)}`)
        continue
      }
      const text = sectionText(scheme, 'zh', SECTION_SLOTS[key])
      if (text) lines.push(`【${zhLabel}】\n${text}。`)
    }
    const notes = notesLine(scheme, 'zh')
    if (notes) lines.push(`【补充要求】\n${notes}`)
    lines.push(QUALITY.zh)
    return lines.join('\n\n')
  }

  function buildCompact(scheme, lang, shot) {
    const style = data.visual_styles.find((s) => s.id === scheme.visualStyle) || data.visual_styles[0]
    if (lang === 'en') {
      const bits = [
        style?.prompt_en || '',
        ...COMPACT_SLOTS.map((slot) => itemsForSlots(scheme, [slot]).map((i) => withStrength(i, scheme, 'en')).join(', ')),
      ].filter(Boolean)
      return `${bits.join(', ')}. ${sceneLine(scheme, 'en', shot)} ${QUALITY.en}`
    }
    const bits = [
      style?.name_zh || '',
      ...COMPACT_SLOTS.map((slot) => itemsForSlots(scheme, [slot]).map((i) => withStrength(i, scheme, 'zh')).join('，')),
    ].filter(Boolean)
    const notes = notesLine(scheme, 'zh')
    return `${bits.join('，')}。${notes ? `${notes}` : ''}${sceneLine(scheme, 'zh', shot)} 面部五官清晰，结构协调，人物辨识度明确。`
  }

  function buildNegative(scheme, lang = 'zh') {
    const picked = new Set(scheme.negatives || [])
    const terms = []
    for (const neg of data.negatives) {
      if (picked.has(neg.id)) terms.push(lang === 'zh' ? neg.prompt_zh : neg.prompt_en)
    }
    const has = (cat, id) => (scheme.selections?.[cat] || []).includes(id)
    const extra = (zh, en) => terms.push(lang === 'zh' ? zh : en)
    if (has('bangs', 'bang_none')) extra('多余刘海，刘海遮挡眼睛', 'unwanted bangs covering the eyes')
    if ((scheme.selections?.bangs || []).some((id) => id.startsWith('bang_'))) extra('额头大面积空白，发际线过高', 'fully exposed forehead, receding hairline')
    const lengthIndex = { hair_length_ultra_short: 0, hair_length_ear_above: 1, hair_length_ear: 2, hair_length_chin: 3, hair_length_neck: 4 }
    const lengthId = (scheme.selections?.hair_length || [])[0]
    if (lengthId && lengthIndex[lengthId] !== undefined) extra('长发及腰，发尾拖地', 'floor-length hair')
    if (has('eyelid', 'lid_monolid')) extra('明显双眼皮褶皱', 'visible double-eyelid crease')
    if (has('lip', 'lip_thin')) extra('厚唇，唇部过于饱满', 'overly full lips')
    if (has('skin', 'skin_matte')) extra('油光满面，过度反光', 'greasy shine, excessive reflections')
    if (has('hair_accessory', 'accessory_none')) extra('未指定的帽子、耳饰、头饰和装饰', 'unrequested headwear or ornaments')
    if (has('lip_makeup', 'lipmake_matte')) extra('水光唇，玻璃唇反光', 'glossy glass lips')
    if (has('eye_corner', 'eye_corner_high_up')) extra('眼尾下垂', 'downturned eye corners')
    if (has('face_shape', 'face_round')) extra('面颊过度凹陷，面部过瘦', 'hollow cheeks, overly thin face')
    return [...new Set(terms)].join(lang === 'zh' ? '，' : ', ')
  }

  function buildStructured(scheme) {
    const rows = []
    for (const group of data.groups) {
      const cats = group.categories
        .map((key) => categoryMap.get(key))
        .filter(Boolean)
      const groupRows = cats.map((cat) => {
        const items = getItems(scheme, cat.key)
        return {
          label: cat.title_zh,
          value: items.map((item) => {
            const level = Number(scheme.strengths?.[cat.key]?.[item.id] || 3)
            return item.strength_supported && level !== 3 ? `${item.name_zh}（${level}/5）` : item.name_zh
          }).join('、'),
          empty: items.length === 0,
        }
      })
      rows.push({ title: group.title_zh, rows: groupRows })
    }
    return rows
  }

  function detectConflicts(scheme) {
    const found = []
    for (const rule of data.conflict_rules) {
      const leftOn = (scheme.selections?.[rule.left_category] || []).includes(rule.left)
      const rightOn = (scheme.selections?.[rule.right_category] || []).includes(rule.right)
      if (!leftOn || !rightOn) continue
      found.push({
        message: rule.message,
        left: { cat: rule.left_category, id: rule.left },
        right: { cat: rule.right_category, id: rule.right },
      })
    }
    if (found.length > 1) {
      const seen = new Set()
      return found.filter((c) => {
        const key = [c.message, c.left.id, c.right.id].join('|')
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }
    return found
  }

  function compile(scheme, options = {}) {
    const { lang = 'zh', length = 'full', shot = 'portrait' } = options
    const zh = length === 'compact' ? buildCompact(scheme, 'zh', shot) : buildFull(scheme, 'zh', shot)
    const en = length === 'compact' ? buildCompact(scheme, 'en', shot) : buildFull(scheme, 'en', shot)
    let full = zh
    if (lang === 'en') full = en
    if (lang === 'both') full = `${zh}\n\n— English —\n\n${en}`
    return {
      zh,
      en,
      full,
      negative: buildNegative(scheme, 'zh'),
      negativeEn: buildNegative(scheme, 'en'),
      structured: buildStructured(scheme),
      conflicts: detectConflicts(scheme),
      count: Object.values(scheme.selections || {}).reduce((n, list) => n + (list?.length || 0), 0),
    }
  }

  return { compile, categoryMap, itemMap, getItems }
}

export function searchItems(data, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/).filter(Boolean)
  const results = []
  for (const cat of data.categories) {
    for (const item of cat.items) {
      const haystack = [
        item.name_zh, item.name_en, ...(item.aliases || []), ...(item.mood_tags || []),
        item.definition, cat.title_zh, cat.title_en,
      ].join(' ').toLowerCase()
      if (terms.every((t) => haystack.includes(t))) {
        const nameHit = (item.name_zh + item.name_en + (item.aliases || []).join('')).toLowerCase().includes(terms[0])
        results.push({ item, cat, score: nameHit ? 2 : 1 })
      }
    }
  }
  return results.sort((a, b) => b.score - a.score || a.item.sort_order - b.item.sort_order).slice(0, 80)
}
