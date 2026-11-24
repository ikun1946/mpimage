import { callChatCompletion } from '../prompts/chat-completion.js'

/** 拼图卡片左下角的名字：最多 7 个字，服务端决定用哪个文本模型 */
export const IMAGE_TITLE_MAX_CHARS = 7
/** 纯英文提示词时放宽到 16 个字符，否则名字只剩半个单词 */
const IMAGE_TITLE_MAX_LATIN = 16

/** 标题只是锦上添花，不能拖住生图结果；超时就退回提示词里的关键信息 */
const TITLE_TIMEOUT_MS = 12_000

export interface ImageTitleOptions {
  baseUrl: string
  model: string
}

const TITLE_SYSTEM_PROMPT = [
  '你是画境的画面命名助手。读用户给的生图提示词，为这张图起一个中文短名。',
  '',
  '起名方法：先找出画面里最显眼的主体（人、动物、物件），再找出它所在的场景或状态',
  '（地点、动作、季节、光线、情绪都算），把这两件事压成 2 到 6 个字。',
  '',
  '参考样例：园林团扇美人、月下白鹿、雪夜归舟、书生三视图、雨巷撑伞女、敦煌飞天、',
  '青瓷茶席、山间小屋、竹林抚琴、灯下读信。',
  '',
  '硬性要求：',
  '1. 只写名字本身，不要标点、引号、书名号、解释、编号、语气词。',
  '2. 不要照抄提示词里的句子或句子开头。',
  '3. 不要用「一位」「一个」「一名」「这幅」「这张」「画面」「图中」开头。',
  '4. 不要写纯风格词（高清、超清、写实、电影感、唯美、高级感、壁纸、插画）。',
  '5. 名字要具体：宁可写「竹筏渔火」，也不要写「美丽夜景」。',
  '6. 不要把操作说明当名字：「保持不变」「改为」「参考图」「图片1」「其余不变」都不是名字。',
  '7. 名字必须能让人想到具体主体、场景或状态，不能只写「不变」「修改」「调整」「参考」这类抽象词。',
].join('\n')

const TITLE_REPAIR_PROMPT = [
  '上一个名字不合格：它要么照抄了提示词，要么太长/太短，要么只是风格词，总之不像名字。',
  '如果它写成了「不变」「保持」「修改」「图片1」这类操作说明，也不算名字。',
  '请重新起名：先在心里找出「主体」和「场景/动作」，再把它们合成 2 到 6 个汉字。',
  '只输出这个名字，不要任何解释、编号或标点。',
].join('\n')

/** 模型常见的前缀：「标题：」「名字：」之类 */
function stripTitlePrefix(text: string): string {
  return text.replace(/^(?:标题|名字|名称|短名)\s*[:：]\s*/, '')
}

/** 清掉模型可能带上的标点、引号、空格，保留汉字/字母/数字，不做截断 */
export function cleanImageTitle(raw: string): string {
  let text = String(raw || '').trim().split(/\r?\n/)[0] || ''
  text = stripTitlePrefix(text)
  text = text.replace(/[《》「」『』【】（）()"'“”‘’<>]/g, '')
  text = text.replace(/[，。！？、；：,.!?;:～~…—\-\s]/g, '')
  return text.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '')
}

/** 兼容旧调用：清洗后硬性截到 7 个字 */
export function sanitizeImageTitle(raw: string): string {
  return [...cleanImageTitle(raw)].slice(0, IMAGE_TITLE_MAX_CHARS).join('')
}

const HAN = /\p{Script=Han}/u

function titleMaxChars(title: string): number {
  return HAN.test(title) ? IMAGE_TITLE_MAX_CHARS : IMAGE_TITLE_MAX_LATIN
}

/**
 * 判定标题是不是「把提示词第一句按字数截断」出来的半截话。
 * 关键看截断点：如果标题后面紧跟的还是汉字，说明砍在词/句中间（一位古风美女独 | 立…）；
 * 如果后面是标点或已经到一句的结尾（书生角色三视图 | ，），那它就是正常的短句。
 */
function looksCopiedFromPrompt(title: string, prompt: string): boolean {
  if ([...title].length < 4) return false
  const text = String(prompt || '').replace(/\s/g, '')
  if (!text.startsWith(title)) return false
  const next = text[title.length] || ''
  return /[\p{Script=Han}A-Za-z0-9]/u.test(next)
}

/**
 * 量词只在开头才是「照抄句子」的信号（一位、三只、两把…）；
 * 出现在中间往往是正常名字（竹林一片、雪落满城）。
 */
const TITLE_COUNTER_LEAD =
  /^(?:[一二两三四五六七八九十几]?(?:位|只|条|棵|朵|群|座|张|幅|片|把|盏|匹|头)|一个|一名)/
/** 标题以这些动词/助词结尾，说明是半句话而不是名字 */
const BAD_TITLE_ENDINGS = /[站坐卧倚立在的着了是和与而并把被从向于]/
/** 标题里出现这些词，说明写成了句子 */
const BAD_TITLE_WORDS = /(正在|已经|然后|并且|以及|同时|这是|那是)/
/** 操作说明、参考关系、状态约束不是画面名 */
const INSTRUCTION_TITLE_PATTERN =
  /^(?:图|图片|参考|保持|修改|调整|其余|其他|将|把|不变|按|按照|根据|基于|使用|提示词)|(?:不变|保持|相同|一致|原样|改为|改成)$/

const GENERIC_LEADS = [
  '一位', '一个', '一名', '一幅', '一张', '这只', '这位',
  '画面', '图中', '图片', '照片', '图像', '整体',
]

/** 整条名字只有风格词时不算名字 */
const STYLE_ONLY_TITLES = new Set([
  '高清', '超清', '超高清', '高清壁纸', '写实', '写实风', '唯美', '唯美风',
  '电影感', '高级感', '质感', '画质', '壁纸', '插画', '摄影', '特写',
  '纯色背景', '白色背景', '人像', '人物', '美女', '帅哥', '风景', '画面',
  '服装', '衣服', '服饰', '发型', '头发', '光影', '背景', '场景', '角色',
  '面部', '五官', '面容', '效果', '修改', '调整', '参考',
])

/** 标题是否真的像名字：长度 2–7（英文 16）、不是提示词句首、不是泛泛的开头 */
export function isUsableImageTitle(
  title: string,
  prompt: string,
  options: { allowPromptPrefix?: boolean } = {},
): boolean {
  const chars = [...title]
  if (chars.length < 2 || chars.length > titleMaxChars(title)) return false
  if (STYLE_ONLY_TITLES.has(title)) return false
  if (GENERIC_LEADS.some(lead => title.startsWith(lead))) return false
  if (TITLE_COUNTER_LEAD.test(title)) return false
  if (BAD_TITLE_WORDS.test(title)) return false
  if (BAD_TITLE_ENDINGS.test(title)) return false
  if (INSTRUCTION_TITLE_PATTERN.test(title)) return false
  // 兜底本来就是从提示词里切的，「是提示词前缀」不算错；模型输出才算抄
  if (!options.allowPromptPrefix && looksCopiedFromPrompt(title, prompt)) return false
  return true
}

/** 提示词里的技术参数、风格套话：这些分句不适合拿来命名 */
const TECHNICAL_CLAUSE =
  /(分辨率|像素|画质|镜头|视角|景深|焦段|构图|光线|光影|色调|色彩|饱和度|风格|材质|渲染|笔刷|比例|横版|竖版|方图|正方形|纯色|无缝|背景色|留白|不要|禁止|要求|参考图|提示词|尺寸|画面底部|画幅|画面主体|中轴线)/

/** 修改要求、参考图坐标与“保持不变”的约束，不适合拿来当标题 */
const INSTRUCTION_CLAUSE =
  /(严格参考|只参考|参考图|图片\s*[一二三四五六七八九十\d]|图\s*[一二三四五六七八九十\d]|改为|改成|换成|替换|去掉|删除|保持.{0,8}不变|其余.{0,4}不变|其他.{0,4}不变|按以下|按照|根据|基于|提示词|修改图片|调整图片)/

/** 分句开头的套话：「画面是一位」「图中」「描绘了」… */
const CLAUSE_LEAD =
  /^(?:画面(?:中|里|上)?(?:是|为|有)?|图中|图片(?:中|里)?|照片(?:中|里)?|主体(?:是|为)?|描绘(?:了)?|展现(?:了)?|呈现(?:了)?|一位|一个|一名|一只|一条|一幅|一张|这[位只张幅])/

const FALLBACK_STOPWORDS =
  /(一位|一个|一名|一幅|一张|画面|图片|照片|整体|采用|构图|镜头|视角|中景|前景|背景|人物|置于|位于|呈现|生成|给出|要求|风格|光线|光影|色调|氛围|质感|细节|非常|十分|并且|然后|以及|同时)/g

/** 主体 + 位置/动作：「女子站在江南园林」「白鹿立在雪地里」 */
const PLACE_MARK =
  /(?:独立在|行走在|漫步在|站立在|站在|立在|坐在|卧在|躺在|趴在|蹲在|走在|立于|位于|置身于?|停在|飘在|浮在|悬在)/
/** 地点说到哪儿为止：园林的/窗台上/荷塘里 */
const PLACE_TAIL = /(?:的|之|里|中|间|旁|前|后|下|上)/

/** 整条提示词都在讲怎么改图时，用被修改的对象生成一个明确的短名 */
const INSTRUCTION_TITLE_HINTS: Array<{ pattern: RegExp; title: string }> = [
  { pattern: /脸型|五官|面部|长相|容貌/, title: '面部调整' },
  { pattern: /服装|衣服|服饰|穿搭|衣裙|裙子|旗袍|外套/, title: '服装调整' },
  { pattern: /发型|头发|发髻|发饰|刘海|马尾/, title: '发型调整' },
  { pattern: /光影|光线|灯光|色调|氛围/, title: '光影调整' },
  { pattern: /背景|场景|环境|空间/, title: '场景调整' },
  { pattern: /姿势|动作|站姿|坐姿/, title: '姿态调整' },
  { pattern: /画幅|比例|构图|视角/, title: '构图调整' },
]

function instructionFallbackTitle(prompt: string): string {
  if (!INSTRUCTION_CLAUSE.test(prompt)) return ''
  let best: { title: string; index: number; targeted: boolean } | null = null
  for (const item of INSTRUCTION_TITLE_HINTS) {
    const match = item.pattern.exec(prompt)
    if (!match || match.index === undefined) continue
    // “将衣服改成…”里的衣服是本次修改对象；“脸型保持不变”只是附带约束。
    const nearby = prompt.slice(Math.max(0, match.index - 20), match.index)
    const targeted = /(?:将|把|给|为|修改|调整|更换|换|改)[^，。；\n]{0,20}$/.test(nearby)
    if (!best || (targeted && !best.targeted) || (targeted === best.targeted && match.index < best.index)) {
      best = { title: item.title, index: match.index, targeted }
    }
  }
  return best?.title || '画面修改'
}

/** 剥掉套话与量词，长修饰语只留中心词：「月下的白鹿」→「月下白鹿」 */
function normalizeSubject(raw: string): string {
  let body = raw
  for (let guard = 0; guard < 3; guard += 1) {
    const next = body.replace(CLAUSE_LEAD, '')
    if (next === body) break
    body = next
  }
  body = body.replace(TITLE_COUNTER_LEAD, '').replace(FALLBACK_STOPWORDS, '').trim()
  // 主体后面常跟状语，去掉才剩得下真正的名字
  body = body.replace(/(?:独自地?|正|正在|缓缓地?|慢慢地?|轻轻地?|静静地?|一个人|孤身)$/, '')
  if (!body.includes('的')) return body
  const parts = body.split('的').filter(Boolean)
  const head = parts[parts.length - 1] ?? ''
  const modifier = parts.length >= 2 ? (parts[parts.length - 2] ?? '') : ''
  // 两字以内的修饰值得带上：月下 + 白鹿
  return `${[...modifier].length <= 2 ? modifier : ''}${head}`
}

/** 切出地点：「江南园林的水榭里」→「江南园林」 */
function cutPlace(raw: string): string {
  const body = raw.replace(FALLBACK_STOPWORDS, '')
  const idx = body.search(PLACE_TAIL)
  return (idx > 0 ? body.slice(0, idx) : body).trim()
}

/** 英文提示词的兜底：取前几个实词，别把整句塞进卡片 */
function latinTitle(clause: string): string {
  const words = clause
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(word => !/^(a|an|the|of|in|on|at|with|and|for|to)$/i.test(word))
    .slice(0, 2)
  const title = words.join(' ').replace(/\s+/g, ' ').trim()
  return [...title].slice(0, IMAGE_TITLE_MAX_LATIN).join('').trim()
}

/**
 * 模型不可用或超时时的兜底：
 * 先把技术参数、风格套话的分句剔掉，再从剩下的句子里找「主体 + 地点」；
 * 没有地点就把长修饰语削掉只留中心词（中文名词是中心词在后）。
 */
export function fallbackImageTitle(prompt: string): string {
  const source = String(prompt || '').trim()
  if (!source) return '未命名'

  const clauses = source
    .split(/[，,。；;\n]/)
    .map(part => part.trim())
    .filter(Boolean)
  if (!clauses.length) return '未命名'

  // 纯英文提示词：没有汉字可供切词，取前几个实词
  if (!HAN.test(source)) {
    return latinTitle(clauses[0] ?? '') || '未命名'
  }

  const cleanedClauses = clauses
    .map(part => part.replace(/^(?:\d+[kK]|\d+:\d+)\s*/, ''))
    .filter(Boolean)
  const useful = cleanedClauses.filter(
    part => !TECHNICAL_CLAUSE.test(part) && !INSTRUCTION_CLAUSE.test(part),
  )
  const pool = useful.length ? useful : cleanedClauses

  for (const clause of pool.slice(0, 5)) {
    const mark = clause.match(PLACE_MARK)
    if (!mark || mark.index === undefined) continue
    const rawSubject = clause.slice(0, mark.index)
    const subject = normalizeSubject(rawSubject)
    const place = cutPlace(clause.slice(mark.index + mark[0].length))
    if ([...subject].length < 2) continue
    // 主体自带短修饰（月下的白鹿）就单独用；修饰太长或没有，就用「地点两字 + 主体」
    const parts = rawSubject.split('的').filter(Boolean)
    const shortModifier =
      parts.length >= 2 && [...(parts[parts.length - 2] ?? '')].length <= 2
    const title = sanitizeImageTitle(
      shortModifier || !place ? subject : `${[...place].slice(0, 2).join('')}${subject}`,
    )
    if (isUsableImageTitle(title, source, { allowPromptPrefix: true })) return title
  }

  for (const clause of pool.slice(0, 5)) {
    const body = normalizeSubject(clause)
    // 超过字数上限时直接截断只会得到半截话，交给下面的动作切分
    const direct = [...body].length <= IMAGE_TITLE_MAX_CHARS ? sanitizeImageTitle(body) : ''
    if (direct && isUsableImageTitle(direct, source, { allowPromptPrefix: true })) return direct
    // 长句在动作前断开：古风少女手持长剑 → 古风少女
    const verb = body.search(/(?:手持|手拿|手握|握着|拿着|执着|举着|穿着|披着|戴着|背负|斜挎|提着|托着|抱着|牵着)/)
    if (verb > 0) {
      const cut = sanitizeImageTitle(body.slice(0, verb))
      if (isUsableImageTitle(cut, source, { allowPromptPrefix: true })) return cut
    }
  }

  // 改图类提示词经常通篇都是“参考图片 / 改成 / 其余不变”，
  // 这种没有主体句时按被修改的对象命名，避免切出「不变」「其他不变」。
  const instructionTitle = instructionFallbackTitle(source)
  if (instructionTitle) return instructionTitle

  const cleaned = (useful.length ? useful : clauses)
    .map(part => part.replace(CLAUSE_LEAD, '').replace(TITLE_COUNTER_LEAD, '').replace(FALLBACK_STOPWORDS, ''))
    .map(part => part.trim())
    .find(part => part.length >= 2)

  const short = sanitizeImageTitle(cleaned || '')
  if (short && isUsableImageTitle(short, source, { allowPromptPrefix: true })) return short
  // 提示词本身只有一个字（猫、鹤）：用它比「未命名」强
  const single = sanitizeImageTitle(source)
  if (single && isUsableImageTitle(single, source, { allowPromptPrefix: true })) return single
  return '未命名'
}

const TITLE_MARKS = '①②③④⑤⑥⑦⑧⑨⑩'

/**
 * 一次请求出多张图时，卡片名不能全都一样（拼图墙上一摞同名卡片没法区分）。
 * 名字后面缀一个序号标记；标记不进字数上限，名字本身仍是 7 字以内。
 */
export function titleForImage(base: string, index: number, total: number): string {
  const name = base || '未命名'
  if (total <= 1) return name
  const mark = index < TITLE_MARKS.length ? TITLE_MARKS[index] : `(${index + 1})`
  return `${name}${mark}`
}

function candidatesFrom(raw: string): string[] {
  return String(raw || '')
    .split(/\r?\n/)
    .map(line => line.replace(/^[\s\-*•·\d.、]+/, ''))
    .map(line => cleanImageTitle(line))
    .filter(Boolean)
}

/**
 * 根据生图提示词生成拼图卡片名。
 * 任何失败都吞掉并退回提示词关键词，绝不影响生图主流程。
 */
export async function generateImageTitle(
  options: ImageTitleOptions,
  prompt: string,
): Promise<string> {
  const source = String(prompt || '').trim()
  if (!source) return '未命名'

  // 两次模型调用加在一起也要有上限，标题不能拖住出图
  const deadline = Date.now() + 18_000

  const ask = async (systemPrompt: string, extra = ''): Promise<string | null> => {
    const remaining = deadline - Date.now()
    if (remaining < 2_500) return null
    const result = await callChatCompletion(
      { baseUrl: options.baseUrl, model: options.model, timeoutMs: Math.min(TITLE_TIMEOUT_MS, remaining) },
      {
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `提示词：${source.slice(0, 1200)}\n\n${extra || '请只输出 2 到 6 个汉字的短名，不要标点和解释。'}`,
          },
        ],
        maxTokens: 24,
        temperature: 0.5,
      },
    )
    const first = candidatesFrom(result.content).find(title => isUsableImageTitle(title, source))
    return first || null
  }

  try {
    const title = await ask(TITLE_SYSTEM_PROMPT)
    if (title) return title

    // 第一次不合格（常见是把提示词首句截短）：再纠正一次，
    // 标题本来就和生图并行，这点额外耗时不会让用户多等。
    const repaired = await ask(TITLE_SYSTEM_PROMPT, TITLE_REPAIR_PROMPT)
    if (repaired) return repaired
  } catch {
    // 走兜底
  }
  return fallbackImageTitle(source)
}
