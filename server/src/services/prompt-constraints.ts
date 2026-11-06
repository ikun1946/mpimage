/**
 * 提示词硬约束：把用户已经写下的风格与设定当成不可变条件。
 *
 * 背景：扩写 / 改写 / 改图都是让模型重写整条提示词，模型很容易把
 * 「赛博朋克」换成「霓虹夜景」、「低饱和」换成「色彩克制」，
 * 长提示词还会被压缩成短模板。风格一旦被换掉，出图就不再是用户要的。
 *
 * 这里做的是确定性保护，不依赖模型自觉：
 *   1. 从用户原文里抽出风格、色彩、质感、构图、必须出现的文字与否定约束；
 *   2. 成稿回来后逐条核对，缺了就用原文短语补回末尾。
 * 用户这次明确要改的那一条（改写指令里点名了）不保护，避免把旧值又补回去。
 */

export type ConstraintKind = 'style' | 'color' | 'texture' | 'composition' | 'literal' | 'negative'

export interface PromptConstraint {
  kind: ConstraintKind
  /** 回填时使用的原文短语 */
  text: string
  /** 判定成稿是否还在的依据，全部命中才算保留 */
  tokens: string[]
  /** 在原文中的位置，回填时按原文顺序排 */
  at: number
}

const STYLE_WORDS: readonly string[] = [
  // 绘画媒介
  '水彩', '油画', '国画', '工笔', '水墨', '素描', '版画', '丙烯', '粉彩', '水粉', '蜡笔', '钢笔速写',
  '马克笔', '线稿', '白描', '速写', '拼贴', '剪纸', '岩彩', '壁画', '篆刻', '水墨淡彩',
  // 插画 / 动画
  '插画', '原画', '概念设计', '概念艺术', '吉卜力', '新海诚', '宫崎骏', '京阿尼', '迪士尼', '皮克斯',
  '梦工厂', '赛璐璐', '厚涂', '平涂', '半厚涂', '二次元', '动漫', '漫画', '条漫', '日漫', '美漫',
  '国漫', '卡通', '动画', '黏土', '粘土', '定格', '手绘', '绘本', '儿童插画', '涂鸦',
  // 三维 / 数字
  '3d', '三维', '渲染', 'blender', 'octane', '虚幻', 'ue5', 'unity', 'c4d', 'low poly',
  '低多边形', '微缩', '等距', '等轴测', '像素风', '像素', 'voxel', '体素', '赛博朋克', '蒸汽波',
  '蒸汽朋克', '废土', '未来主义', '超现实', '魔幻', '奇幻', '科幻', '末日', '哥特', '巴洛克',
  '洛可可', '浮世绘', '装饰艺术', '极简主义', '极简', '波普', '孟菲斯', '霓虹', '赛博',
  // 摄影
  '摄影', '写实', '照片', '纪实', '电影剧照', '电影感', '胶片', '宝丽来', '拍立得', '人像摄影',
  '商业摄影', '产品摄影', '时尚大片', '航拍', '手机摄影', '微距', '广角', '长焦', '鱼眼', '移轴',
  '多次曝光', '长曝光', '慢门',
  // 平面
  '海报', '封面', '包装', '标志', '图标', '界面', '扁平化', '矢量', '字体设计', '排版', '信息图',
  '说明书', '广告', '宣传', '品牌',
  // 地域 / 年代
  '国风', '古风', '中式', '日式', '和风', '韩系', '欧美', '复古', '怀旧', '未来感', '手账',
  // 英文（英文提示词同样要保住风格词）
  'cyberpunk', 'watercolor', 'oil painting', 'anime', 'manga', 'illustration', 'photorealistic',
  'realistic', 'photograph', 'cinematic', 'film grain', 'pixel art', '3d render', 'isometric',
  'minimalist', 'vintage', 'retro', 'ghibli', 'disney', 'concept art', 'line art', 'cel shading',
  'poster', 'logo', 'vector', 'flat design', 'comic', 'sketch', 'ink wash',
]

const COLOR_WORDS: readonly string[] = [
  '低饱和', '高饱和', '饱和度', '莫兰迪', '马卡龙', '青橙', '青绿', '米白', '奶油色', '糖果色',
  '荧光', '双色', '单色', '黑白', '灰度', '暗调', '高调', '低对比', '高对比', '暖黄', '冷蓝',
  '紫粉', '粉紫', '霓虹灯', '冷色调', '暖色调', '冷调', '暖调', '冷色', '暖色', '紫色', '粉色', '红色', '蓝色', '绿色',
  '金色', '银色', '琥珀色', '棕褐', '复古色调', 'sepia',
  'low saturation', 'high saturation', 'black and white', 'monochrome', 'pastel', 'neon',
  'teal and orange', 'warm tone', 'cool tone',
]

const TEXTURE_WORDS: readonly string[] = [
  '胶片颗粒', '颗粒', '噪点', '柔光', '硬光', '柔焦', '景深', '虚化', '暗角', '磨砂', '纸纹',
  '宣纸', '油画布', '水痕', '笔触', '纹理', '哑光', '反光', '做旧', '褪色', '漏光', '光晕',
  '散景', '辉光', '金属质感', '布料质感',
  'grain', 'noise', 'soft light', 'hard light', 'bokeh', 'depth of field', 'vignette', 'matte',
  'glossy',
]

const COMPOSITION_WORDS: readonly string[] = [
  '留白', '对称', '三分法', '居中', '对角线构图', '框架构图', '俯拍', '仰拍', '平视', '特写',
  '近景', '全景', '远景', '浅景深', '大景深', '竖构图', '横构图', '横幅', '竖幅', '极简构图',
  '满画面', '35mm', '50mm', '85mm', '135mm', '24mm',
  'negative space', 'symmetry', 'rule of thirds', 'close-up', 'wide shot', 'full body',
]

/** 「X 风格 / X 画风」里 X 不能是这些泛词，否则保护规则会被整段文本误触发 */
const STYLE_PATTERN_BLOCKLIST: readonly string[] = [
  '角色', '人物', '画面', '本图', '以下', '这种', '同一', '资产', '统一', '整体', '最终', '目标',
  '唯一', '所有', '采用', '使用', '这套', '风格',
]

/**
 * 同一个意思的常见换写法：模型换了词也算保留，避免每轮都去补一遍。
 * 键是约束里抽出的原词，值是成稿里可接受的等价表达。
 */
const ACCEPT: Readonly<Record<string, readonly string[]>> = {
  低饱和: ['饱和度低', '饱和度压低', '压低饱和', '低彩度', '色彩克制', '饱和度克制'],
  高饱和: ['饱和度高', '高彩度', '饱和度拉高'],
  冷色调: ['冷调', '偏冷', '冷色'],
  暖色调: ['暖调', '偏暖', '暖色'],
  黑白: ['黑白', '单色', '灰度'],
  留白: ['留白', '空白'],
  胶片颗粒: ['胶片颗粒', '胶片质感', '细颗粒', '颗粒感'],
  景深: ['景深', '焦外', '虚化'],
  文字: ['文字', '字幕', '文本', '字样', '字体', '题字'],
  有人: ['有人', '人物', '行人', '人影', '人群', '路人', '人'],
  水印: ['水印', '标志', 'logo'],
  柔光: ['柔光', '柔和的光', '软光'],
  硬光: ['硬光', '硬朗的光', '直射光'],
  极简: ['极简', '简约', '简洁'],
  复古: ['复古', '怀旧', '旧感'],
  纸本质感: ['纸张质感', '纸质感', '纸纹', '宣纸质感', '纸质'],
  冷暖对比弱: ['冷暖对比很弱', '冷暖对比较弱', '冷暖反差小'],
  笔触明显: ['笔触清晰', '笔触可见', '明显笔触'],
  矿物颜料堆叠: ['矿物颜料', '矿物色', '矿石颜料'],
  边缘有颜料堆积: ['颜料堆积', '颜料堆叠', '厚涂堆积'],
}

const NEGATIVE_NOUNS: readonly string[] = [
  '文字', '字幕', '水印', '标志', 'logo', '人物', '有人', '行人', '人影', '人群', '人脸', '皮肤',
  '阴影', '影子', '反光', '霓虹', '颗粒', '畸变', '变形', '多余', '手指', '五官', '印章',
  '题款', '落款', '边框', '界面', '按钮', '对话框', '磨皮', '噪点', '过曝', '欠曝', '模糊',
  '杂物', '广告', '摆拍', '烟雾', '光斑', '插件', '标签', '角标', '题字', '签名',
]

/**
 * 否定项必须是一个看得见的对象。
 * 「不要动」「不要太大」「其余不要」是操作要求，不是画面约束；
 * 补进提示词会变成莫名其妙的「不要出现：动」。
 */
function isVisualNegative(body: string): boolean {
  if (body.length >= 3) return true
  const words = [...STYLE_WORDS, ...COLOR_WORDS, ...TEXTURE_WORDS, ...COMPOSITION_WORDS, ...NEGATIVE_NOUNS]
  return words.some(word => word.includes(body))
}

const NEGATION = /(?:不要|别|禁止|避免|拒绝|不出现|不包含|去除|去掉|删除|移除|无|没有)/
const NEGATION_WINDOW = 14

function normalize(value: string): string {
  return value.replace(/[\s·・\-—_/]/g, '').toLowerCase()
}

function normalizeKeyword(value: string): string {
  return value.toLowerCase()
}

/** 把「不要出现任何文字」这类捕获清理成真正的被禁对象 */
function cleanNegativeBody(raw: string): string {
  const trimmed = raw.trim()
  let cleaned = trimmed
  // 前缀可能连着来（「出现任何文字」），逐轮剥到干净为止
  for (let round = 0; round < 4; round += 1) {
    const next = cleaned
      .replace(
        /^(?:出现|添加|加上|加|让|把|给|对|往|在|使用|采用|存在|有|任何|太多|过于|太|显得|变成|改成|画|拍摄|带有|带)/g,
        '',
      )
      .replace(/(?:之类|等等|什么)$/g, '')
      .trim()
    if (next === cleaned) break
    cleaned = next
  }
  // 清成单字（「有人」→「人」）会到处误命中，宁可保留原短语
  if (cleaned.length >= 2) return cleaned
  return trimmed.length >= 2 ? trimmed : ''
}

function pushConstraint(
  list: PromptConstraint[],
  kind: ConstraintKind,
  text: string,
  tokens: string[],
  at: number,
): void {
  const trimmedText = text.trim()
  const cleanedTokens = tokens.map(token => token.trim()).filter(token => token.length > 0)
  if (!trimmedText || !cleanedTokens.length) return

  const key = normalize(trimmedText)
  // 同义且更短的条目让位给更长的（「胶片」让位给「胶片颗粒」）：
  // 否则保护清单会先记下泛词，后面真正要保的复合词反而被当成重复丢掉。
  const shorterIndex = list.findIndex(item => {
    if (item.kind === kind) return false
    const other = normalize(item.text)
    return other !== key && key.includes(other)
  })
  if (shorterIndex >= 0) list.splice(shorterIndex, 1)

  const covered = list.some(item => {
    if (item.kind === kind) return normalize(item.text) === key
    const other = normalize(item.text)
    return other === key || other.includes(key)
  })
  if (covered) return

  list.push({ kind, text: trimmedText, tokens: cleanedTokens, at })
}

/** 扫描一个分句里的关键词；长的先匹配，命中过的区间不再重复计 */
function scanWords(
  list: PromptConstraint[],
  chunk: string,
  chunkAt: number,
  kind: ConstraintKind,
  words: readonly string[],
): void {
  const lower = normalizeKeyword(chunk)
  const covered: Array<[number, number]> = []
  const sorted = [...words].sort((a, b) => b.length - a.length)

  for (const word of sorted) {
    const key = normalizeKeyword(word)
    if (!key) continue
    let from = 0
    for (;;) {
      const index = lower.indexOf(key, from)
      if (index < 0) break
      const end = index + key.length
      const overlap = covered.some(([start, stop]) => index < stop && end > start)
      if (!overlap) {
        covered.push([index, end])
        pushConstraint(list, kind, chunk.slice(index, end), [chunk.slice(index, end)], chunkAt + index)
      }
      from = end
    }
  }
}

/** 风格块的引导语：命中后把后面的整段风格描述逐句锁住 */
const STYLE_BLOCK_START =
  /(?:^|\n)\s*(?:【[^】\n]{0,20}风格[^】\n]*】|(?:风格|画风|Style)\s*(?:指令|设定|说明)?\s*[：:])\s*/gi

/** 风格块里的元信息，不是画面条件，锁了会补出莫名其妙的话 */
const STYLE_BLOCK_META = /(?:优先级|以下所有|以下|本图|唯一|必须执行|执行这套|冲突|描述|采用|资产|画面必须)/

/** 把一段风格描述拆成可回填的短句；一次最多锁这么多，避免整段照抄 */
const MAX_STYLE_BLOCK_CLAUSES = 10

function extractStyleBlockClauses(text: string, list: PromptConstraint[]): void {
  STYLE_BLOCK_START.lastIndex = 0
  let match: RegExpExecArray | null
  let added = 0
  while ((match = STYLE_BLOCK_START.exec(text)) !== null && added < MAX_STYLE_BLOCK_CLAUSES) {
    const start = match.index + match[0].length
    const head = text.slice(start, start + 800)
    // 到下一个方括号标题或空行为止
    const stop = head.search(/\n\s*\n|\n\s*【/)
    const block = (stop >= 0 ? head.slice(0, stop) : head).trim()
    if (!block) continue

    for (const rawClause of block.split(/[，,。；;\n]/)) {
      const clause = rawClause.trim()
      if (clause.length < 3 || clause.length > 40) continue
      if (STYLE_BLOCK_META.test(clause)) continue

      if (/^(?:不要|禁止|避免|拒绝|不能|不可|不出现|不包含|去掉|去除|删除|移除|别)/.test(clause)) {
        const body = cleanNegativeBody(
          clause.replace(/^(?:不要|禁止|避免|拒绝|不能|不可|不出现|不包含|去掉|去除|删除|移除|别)/, ''),
        )
        if (body && isVisualNegative(body)) {
          pushConstraint(list, 'negative', body, [body], start)
          added += 1
        }
        continue
      }

      pushConstraint(list, 'style', clause, [clause], start)
      added += 1
      if (added >= MAX_STYLE_BLOCK_CLAUSES) break
    }
  }
}

/**
 * 从用户原文里抽硬约束。
 * 只抽「用户已经定了的视觉条件」，不抽动作、情节和普通描述——
 * 那些是交给模型补全的部分，锁太死反而写不活。
 */
export function extractPromptConstraints(source: string): PromptConstraint[] {
  const text = String(source || '').trim()
  if (!text) return []

  const found: PromptConstraint[] = []

  // 0. 显式的风格块：用户把风格要求单独写了一段时，逐句保留
  extractStyleBlockClauses(text, found)

  // 1. 否定约束：「不要 / 禁止 / 不出现 / 删除 …」
  const negativePattern =
    /(?:不要|禁止|避免|拒绝|不能|不可|不出现|不包含|去掉|去除|删除|移除|(?<![特区分级性个])别)([^，。；;\n]{1,30})/g
  let negativeMatch: RegExpExecArray | null
  while ((negativeMatch = negativePattern.exec(text)) !== null) {
    const capture = negativeMatch[1]
    if (capture === undefined) continue
    const at = negativeMatch.index
    for (const part of capture.split(/[、,]/)) {
      const body = cleanNegativeBody(part)
      if (!body || !isVisualNegative(body)) continue
      // 「不要」后面常跟一串并列项，用整个并列串太长，逐项补更自然
      pushConstraint(found, 'negative', body.slice(0, 24), [body.slice(0, 24)], at)
    }
    if (negativeMatch[0].length === 0) break
  }

  // 2. 必须出现的文字与品牌：引号内容、`品牌名为 X` 这类显式标注
  // 英文否定约束：no text / without people / avoid...
  const englishNegative = /\b(?:no|without|avoid|don't|do not|remove|exclude)\b\s+([^,.;\n]{2,40})/gi
  let englishMatch: RegExpExecArray | null
  while ((englishMatch = englishNegative.exec(text)) !== null) {
    const body = (englishMatch[1] ?? '').trim()
    if (!body) continue
    pushConstraint(found, 'negative', body, [body], englishMatch.index)
  }

  const quotedPattern = /[“"「『]([^”"」』\n]{1,24})[”"」』]/g
  let quotedMatch: RegExpExecArray | null
  while ((quotedMatch = quotedPattern.exec(text)) !== null) {
    const literal = quotedMatch[1]
    if (!literal) continue
    if (/^[，。；;、\s]+$/.test(literal)) continue
    pushConstraint(found, 'literal', literal, [literal], quotedMatch.index)
  }

  const labeledPattern =
    /(?:文字|字样|标语|品牌名?|店名|片名|标题|logo|Logo)\s*(?:为|是|：|:)\s*([^\s，。；;、\n]{1,24})/g
  let labeledMatch: RegExpExecArray | null
  while ((labeledMatch = labeledPattern.exec(text)) !== null) {
    const literal = labeledMatch[1]
    if (!literal) continue
    pushConstraint(found, 'literal', literal, [literal], labeledMatch.index)
  }

  // 3. 风格 / 色彩 / 质感 / 构图：按分句扫关键词
  const chunks = text.split(/[，,。；;\n]/)
  let cursor = 0
  for (const rawChunk of chunks) {
    const chunk = rawChunk.trim()
    const chunkAt = rawChunk ? text.indexOf(rawChunk, cursor) : -1
    if (chunk && chunkAt >= 0) cursor = chunkAt + rawChunk.length
    if (!chunk) continue
    // 否定分句里出现的词是被禁对象，不能当成正向约束
    if (/^(?:不要|禁止|避免|拒绝|不能|不可|不出现|不包含|去掉|去除|删除|移除|别)/.test(chunk)) continue

    scanWords(found, chunk, chunkAt, 'style', STYLE_WORDS)
    scanWords(found, chunk, chunkAt, 'color', COLOR_WORDS)
    scanWords(found, chunk, chunkAt, 'texture', TEXTURE_WORDS)
    scanWords(found, chunk, chunkAt, 'composition', COMPOSITION_WORDS)

    // 「敦煌风格」「青花瓷风格」这类词典外的画风：取 X 作为依据
    const stylePattern = /([一-龥A-Za-z0-9]{2,8})(?:风格|画风)/g
    let styleMatch: RegExpExecArray | null
    while ((styleMatch = stylePattern.exec(chunk)) !== null) {
      const name = styleMatch[1]
      if (!name) continue
      // 「本图唯一采用以下角色风格」这种句子也会命中，必须整词排除
      if (STYLE_PATTERN_BLOCKLIST.some(word => name.includes(word))) continue
      if (found.some(item => item.kind === 'style' && normalize(name).includes(normalize(item.text)))) {
        continue
      }
      pushConstraint(found, 'style', `${name}风格`, [name], chunkAt + (styleMatch.index ?? 0))
    }
  }

  found.sort((a, b) => a.at - b.at)
  return found.slice(0, 32)
}

function tokensOf(constraint: PromptConstraint): string[] {
  const extra = constraint.tokens.flatMap(token => ACCEPT[token] ?? [])
  return [...constraint.tokens, ...extra]
}

/** 成稿里是否还留着这条约束；否定项还要求附近有否定词，避免把禁止项写成正向描述 */
export function isConstraintPresent(prompt: string, constraint: PromptConstraint): boolean {
  const haystack = normalize(prompt)
  const accepted = tokensOf(constraint)

  if (constraint.kind === 'negative') {
    return constraint.tokens.some(token => {
      const candidates = [token, ...(ACCEPT[token] ?? [])]
      return candidates.some(candidate => {
        const key = normalize(candidate)
        if (!key) return true
        let from = 0
        for (;;) {
          const index = haystack.indexOf(key, from)
          if (index < 0) return false
          const before = haystack.slice(Math.max(0, index - NEGATION_WINDOW), index)
          if (NEGATION.test(before)) return true
          from = index + key.length
        }
      })
    })
  }

  return accepted.some(candidate => {
    const key = normalize(candidate)
    return key.length > 0 && haystack.includes(key)
  })
}

export function missingConstraints(prompt: string, constraints: readonly PromptConstraint[]): PromptConstraint[] {
  return constraints.filter(constraint => !isConstraintPresent(prompt, constraint))
}

/** 改写 / 改图指令里点名过的约束，说明用户这次就是要动它，不再保护 */
function instructionMentions(instruction: string, constraint: PromptConstraint): boolean {
  const haystack = normalize(instruction)
  return constraint.tokens.some(token => {
    const key = normalize(token)
    return key.length >= 2 && haystack.includes(key)
  })
}

const CHANGE_VERBS_TAIL = /(?:去掉|去除|删除|移除|不要|擦掉|换掉|改成|换成|变成|改为|调成|替换)$/
const CHANGE_VERBS_HEAD = /^(?:去掉|去除|删除|移除|擦掉|换掉|改成|换成|变成|改为|调成|替换)/

/**
 * 用户这次是不是明确要动这一条。
 * 「把霓虹去掉」「不要霓虹」要放开保护；「保持赛博朋克，不要改成卡通」里
 * 赛博朋克是保留对象，不能因为附近出现「不要」就误判成要删。
 */
function instructionTargetsChange(instruction: string, constraint: PromptConstraint): boolean {
  const haystack = normalize(instruction)
  return constraint.tokens.some(token => {
    const key = normalize(token)
    if (key.length < 2) return false
    let index = 0
    while (index < haystack.length) {
      const found = haystack.indexOf(key, index)
      if (found < 0) return false
      const before = haystack.slice(Math.max(0, found - 10), found)
      const after = haystack.slice(found + key.length, found + key.length + 10)
      if (CHANGE_VERBS_TAIL.test(before) || CHANGE_VERBS_HEAD.test(after)) return true
      index = found + key.length
    }
    return false
  })
}

/** 用户明确要求换风格时，旧风格与旧色调不该被补回去 */
const RESTYLE_INTENT =
  /(?:改成|换成|变成|改为|转成|换一种|换个|换风格|改风格|换画风|改画风)[^。；;，,\n]{0,14}(?:风格|画风|水彩|油画|国画|工笔|水墨|素描|插画|动漫|动画|摄影|写实|胶片|3d|三维|像素|赛博|极简|复古|黑白|彩色|色调|配色|颜色)/i

/** 换成非摄影媒介时，旧照片的焦段与胶片参数必须一起退出，否则两种媒介打架 */
const RESTYLE_TO_NON_PHOTO =
  /(?:改成|换成|变成|改为|转成|换一种|换个|换风格|改风格|换画风|改画风)[^。；;，,\n]{0,14}(?:水彩|油画|国画|工笔|水墨|素描|版画|插画|动漫|动画|漫画|卡通|像素|3d|三维|矢量|扁平|图标|黏土|剪纸)/i

const RESTYLE_INTENT_EN =
  /\b(?:change|convert|switch|turn|make)\b[^,.;\n]{0,30}\b(?:to|into)\b[^,.;\n]{0,30}\b(?:style|watercolor|oil painting|anime|manga|illustration|sketch|comic|pixel art|3d|vector|flat|black and white|monochrome|sepia|pastel|neon|retro|vintage|minimalist|realistic|photographic|cinematic)\b/i

const RESTYLE_TO_NON_PHOTO_EN =
  /\b(?:change|convert|switch|turn|make)\b[^,.;\n]{0,30}\b(?:to|into)\b[^,.;\n]{0,30}\b(?:watercolor|oil painting|anime|manga|illustration|sketch|comic|pixel art|3d|vector|flat design|cartoon|clay)\b/i

const PHOTO_PARAM_WORDS: readonly string[] = [
  '35mm', '50mm', '85mm', '135mm', '24mm', '胶片颗粒', '噪点', '景深', '柔焦', '暗角',
  '慢门', '长曝光', '反光', '镜头', 'film grain', 'grain', 'noise', 'depth of field', 'bokeh',
  'lens', 'vignette',
]

/**
 * 过滤出这次仍然需要保护的约束。
 * instruction 为用户这次的修改要求（改写 / 改图）；扩写时传空。
 *
 * ignoreMentions：改图模式下 instruction 就是用户整段要求，
 * 「保持赛博朋克风格」这句话本身提到风格词，但它是在要求保留而不是要改，
 * 不能因为提到就取消保护。只有明确「换成某种风格」才按换风格处理。
 */
export function selectConstraints(
  source: string,
  instruction?: string,
  options: { ignoreMentions?: boolean } = {},
): PromptConstraint[] {
  const constraints = extractPromptConstraints(source)
  const text = String(instruction || '').trim()
  if (!text) return constraints

  // 「不要改成卡通」是在禁止换风格，不是要换风格：先把否定式的换风格句剥掉
  const restyleText = text.replace(
    /(?:不要|别|不许|不能|不用|禁止)[^。；;，,\n]{0,8}(?:改成|换成|变成|改为|转成|换风格|改风格|换画风|改画风)[^。；;，,\n]{0,8}/g,
    '',
  )
  const restyle = RESTYLE_INTENT.test(restyleText) || RESTYLE_INTENT_EN.test(restyleText)
  const toNonPhoto = RESTYLE_TO_NON_PHOTO.test(restyleText) || RESTYLE_TO_NON_PHOTO_EN.test(restyleText)
  return constraints.filter(constraint => {
    if (restyle && (constraint.kind === 'style' || constraint.kind === 'color')) return false
    if (toNonPhoto && PHOTO_PARAM_WORDS.some(word => constraint.text.includes(word))) return false
    if (instructionTargetsChange(text, constraint)) return false
    if (options.ignoreMentions) return true
    return !instructionMentions(text, constraint)
  })
}

/** 回填文案跟着成稿语言走：英文提示词后面别接一整句中文 */
function isMostlyLatin(text: string): boolean {
  const latin = (text.match(/[A-Za-z]/g) || []).length
  const cjk = (text.match(/[一-龥]/g) || []).length
  return latin > 20 && latin > cjk * 2
}

const MAX_POSITIVE_BACKFILL = 12
const MAX_NEGATIVE_BACKFILL = 12

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = normalize(value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/**
 * 把丢失的约束补回末尾。
 *
 * 补在末尾而不是硬塞进某一段：末尾的词在图像模型里权重高，
 * 又不会破坏原段落的结构与叙事；重复一次比丢掉一次安全得多。
 */
export function applyConstraintGuard(
  prompt: string,
  constraints: readonly PromptConstraint[],
  maxLength: number,
): { prompt: string; restored: string[] } {
  const missing = missingConstraints(prompt, constraints)
  if (!missing.length) return { prompt, restored: [] }

  const positives = dedupe(
    missing
      .filter(constraint => constraint.kind !== 'negative')
      .map(constraint => constraint.text),
  ).slice(0, MAX_POSITIVE_BACKFILL)
  const negatives = dedupe(
    missing.filter(constraint => constraint.kind === 'negative').map(constraint => constraint.text),
  ).slice(0, MAX_NEGATIVE_BACKFILL)

  const english = isMostlyLatin(prompt)
  const joiner = english ? ', ' : '，'
  const lines: string[] = []
  if (english) {
    if (positives.length) {
      lines.push(`Style and visual constraints (keep unchanged): ${positives.join(joiner)}.`)
    }
    if (negatives.length) lines.push(`Do not include: ${negatives.join(joiner)}.`)
  } else {
    if (positives.length) lines.push(`风格与画面约束（保持不变）：${positives.join(joiner)}。`)
    if (negatives.length) lines.push(`不要出现：${negatives.join(joiner)}。`)
  }
  if (!lines.length) return { prompt, restored: [] }

  const block = `\n\n${lines.join('\n')}`
  const body =
    prompt.length + block.length <= maxLength
      ? prompt
      : prompt.slice(0, Math.max(0, maxLength - block.length - 4)).trim()

  return {
    prompt: body + block,
    restored: [...positives, ...negatives],
  }
}