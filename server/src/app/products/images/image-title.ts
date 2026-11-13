import { callChatCompletion } from '../prompts/chat-completion.js'

/** 拼图卡片左下角的名字：最多 7 个字，服务端决定用哪个文本模型 */
export const IMAGE_TITLE_MAX_CHARS = 7

/** 标题只是锦上添花，不能拖住生图结果；超时就退回提示词里的关键信息 */
const TITLE_TIMEOUT_MS = 12_000

export interface ImageTitleOptions {
  baseUrl: string
  model: string
}

const TITLE_SYSTEM_PROMPT = [
  '你是画境的画面命名助手。读用户给的生图提示词，为这张图起一个中文短名。',
  '短名要概括画面，通常由「主体 + 场景/动作」组成，例如：园林团扇美人、月下白鹿、雪夜归舟、书生三视图。',
  '只输出 2 到 6 个汉字（绝对不超过 7 个），只写名字本身：不要标点、引号、书名号、解释、编号。',
  '严禁照抄提示词里的句子或句子开头；严禁以「一位」「一个」「一名」「这幅」「这张」「画面」开头。',
].join('\n')

const TITLE_REPAIR_PROMPT = [
  '上一个名字不合格：它要么照抄了提示词，要么超过 7 个字，要么不像名字。',
  '请重新起名：先在心里找出「主体」和「场景/动作」，再把它们合成 2 到 7 个汉字。',
  '只输出这个名字，不要任何解释。',
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

/** 「一只」「一个」这类量词出现在标题里，基本都是从提示词里抄来的口语句子 */
const TITLE_COUNTERS = /(?:[一二两三四五六七八九十几]?(?:位|只|条|棵|朵|群|座|张|幅|片)|一个|一名)/
/** 标题以这些动词/助词结尾，说明是半句话而不是名字 */
const BAD_TITLE_ENDINGS = /[站坐卧倚立在的着了是和与而并把被从向于]/
/** 标题里出现这些词，说明写成了句子 */
const BAD_TITLE_WORDS = /(正在|已经|然后|并且|一只|一个|一位|一名)/

const GENERIC_LEADS = [
  '一位', '一个', '一名', '一幅', '一张', '这只', '这位',
  '画面', '图中', '图片', '照片', '图像', '整体',
]

/** 标题是否真的像名字：长度 2–7、不是提示词句首、不是泛泛的开头 */
export function isUsableImageTitle(title: string, prompt: string): boolean {
  const chars = [...title]
  if (chars.length < 2 || chars.length > IMAGE_TITLE_MAX_CHARS) return false
  if (GENERIC_LEADS.some(lead => title.startsWith(lead))) return false
  if (TITLE_COUNTERS.test(title)) return false
  if (BAD_TITLE_WORDS.test(title)) return false
  if (BAD_TITLE_ENDINGS.test(title)) return false
  if (looksCopiedFromPrompt(title, prompt)) return false
  return true
}

const FALLBACK_STOPWORDS =
  /(一位|一个|一名|一幅|一张|画面|图片|照片|整体|采用|构图|镜头|视角|中景|前景|背景|人物|置于|位于|呈现|生成|给出|要求|风格|光线|光影|色调|氛围|质感|细节|非常|十分|并且|然后|以及|同时)/g

/**
 * 模型不可用或超时时的兜底：
 * 先从「人物在场景」这类句子里抽主体 + 地点，拼成短名；
 * 抽不出来再去掉套话取前几个字，避免出现「一位古风美女独」这种半截话。
 */
export function fallbackImageTitle(prompt: string): string {
  const source = String(prompt || '').trim()
  if (!source) return '未命名'

  const clauses = source
    .split(/[，,。；;\n]/)
    .map(part => part.trim())
    .filter(Boolean)

  for (const clause of clauses.slice(0, 4)) {
    const match = clause.match(
      /^([^，。；]{2,10}?)(?:独立|站立|站|端坐|坐|卧|倚|漫步|行走|出现|立|位于|置身|停)?(?:在|于)([^，。；]{2,8}?)(?:的|之|间|中|里|旁|前|下|上)/,
    )
    if (!match) continue
    const subject = (match[1] ?? '')
      .replace(/^(?:一位|一个|一名|一只|一条)/, '')
      .replace(FALLBACK_STOPWORDS, '')
    const place = (match[2] ?? '').replace(FALLBACK_STOPWORDS, '')
    // 地点超过 3 个字时只取前 2 个字，避免把「江南园林」切成「江南园」
    const placeChars = [...place]
    const placeShort = (placeChars.length >= 4 ? placeChars.slice(0, 2) : placeChars).join('')
    const subjectShort = [...subject]
      .slice(0, Math.max(2, IMAGE_TITLE_MAX_CHARS - [...placeShort].length))
      .join('')
    const combined = `${placeShort}${subjectShort}`
    const title = sanitizeImageTitle(combined)
    if (isUsableImageTitle(title, source)) return title
  }

  const cleaned = clauses
    .map(part => part.replace(/^(?:一位|一个|一名|一幅|一张|一只|一条)/, '').replace(FALLBACK_STOPWORDS, ''))
    .map(part => part.trim())
    .find(part => part.length >= 2)

  return sanitizeImageTitle(cleaned || '') || '未命名'
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
            content: `提示词：${source.slice(0, 1200)}\n\n${extra || '请只输出 2 到 7 个汉字的短名。'}`,
          },
        ],
        maxTokens: 24,
        temperature: 0.4,
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
