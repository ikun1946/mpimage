import { config } from '../config.js'
import { ApiError } from '../lib/errors.js'
import { callChatCompletion, mergeTokens, type ChatTokens } from './chat-completion.js'
import {
  analyzeReferenceImages,
  formatObservations,
  type ImageObservation,
} from './image-analysis.js'
import type { ReferenceImage } from './reference-images.js'
// 三套系统提示词集中在 prompt-rulebook 里维护（改编自造梦师 v2.6.0，CC BY-NC 4.0）
import {
  CHECK_SYSTEM_PROMPT,
  EDIT_SYSTEM_PROMPT,
  EXPAND_SYSTEM_PROMPT,
} from './prompt-rulebook.js'

/** edit = 带参考图的改图；expand = 从零扩写画面 */
export type PromptMode = 'edit' | 'expand'

export interface PromptOptimizeOptions {
  baseUrl: string
  model: string
  timeoutMs: number
}

export interface PromptOptimizeParams {
  prompt: string
  ratioLabel?: string
  referenceCount?: number
  /** 本次随提示词一起送上游的参考图；按数组顺序标注为图1、图2…… */
  images?: ReferenceImage[]
}

export type PromptOptimizeTokens = ChatTokens

export interface PromptOptimizeResult {
  prompt: string
  model: string
  tokens: PromptOptimizeTokens
  mode: PromptMode
}

/**
 * 扩写要写得更细，token 预算跟着放宽，否则模型会在句子中间被截断。
 * 新规则要求 500–700 字，实测偶发写到 1000 字以上，2000 会撞上限，
 * 所以再留一截余量；撞上 length 会直接报错，用户拿不到半条提示词。
 */
const EXPAND_MAX_TOKENS = 2600
const EDIT_MAX_TOKENS = 700
/** 自检轮要重写整条提示词，预算与首轮相当 */
const CHECK_MAX_TOKENS = 2200
/** 自检轮最多用掉这么久，超时就保留首轮结果 */
const CHECK_TIMEOUT_CAP_MS = 25000
/** 观察阶段最多用掉总超时的一半，且不超过这个上限 */
const ANALYSIS_TIMEOUT_CAP_MS = 25000
/** 任何一阶段至少留这么久，避免总预算被上一段吃光 */
const MIN_STAGE_TIMEOUT_MS = 5000
/** 采样温度：扩写要发散，观察与自检要稳定 */
const EXPAND_TEMPERATURE = 0.85
const CHECK_TEMPERATURE = 0.3

/** 带参考图且文本像「改这里」时才走改图路径；没图一律当扩写 */
const EDIT_PATTERNS: RegExp[] = [
  /改成|改为|改一下|改掉|改个|修改|重绘|修掉/,
  /换成|换掉|换个|替换/,
  /去掉|去除|删掉|删除|移除|擦掉|涂抹/,
  /加上|添加|补上|增添/,
  /变成|调成|调亮|调暗|放大|缩小|调色/,
  /不要改|别改|不要出现|别让|保持原样|其余保持/,
  /\b(change|replace|remove|delete|add|erase|edit)\b/i,
]

export function classifyPromptIntent(prompt: string, hasImages: boolean): PromptMode {
  if (!hasImages) return 'expand'
  return EDIT_PATTERNS.some(pattern => pattern.test(prompt)) ? 'edit' : 'expand'
}

export async function optimizePrompt(
  options: PromptOptimizeOptions,
  params: PromptOptimizeParams,
): Promise<PromptOptimizeResult> {
  const images = params.images ?? []
  const mode = classifyPromptIntent(params.prompt, images.length > 0)

  if (mode === 'expand') {
    return requestExpand(options, params, images)
  }

  const observed = await requestEditWithObservation(options, params, images)
  if (observed) return observed

  // 观察没成（模型读不了图、超时、返回格式认不出）时退回一次调用：
  // 图片和改图提示词一起送，用户仍然拿到一条聚焦改图的提示词
  return requestPrompt(options, {
    systemPrompt: EDIT_SYSTEM_PROMPT,
    params,
    images,
    mode,
    maxTokens: EDIT_MAX_TOKENS,
  })
}

interface RequestPromptInput {
  systemPrompt: string
  params: PromptOptimizeParams
  images: ReferenceImage[]
  mode: PromptMode
  maxTokens: number
  /** 采样温度：扩写偏高、自检偏低；不传走默认 0.8 */
  temperature?: number
  /** 扩写要保住段落分隔，改图压成一行 */
  keepParagraphs?: boolean
  /** 观察阶段产出的参考图摘要 */
  observations?: ImageObservation[]
  /** 自检轮要拿到的首轮草稿 */
  draft?: string
}

/**
 * 扩写路径：有图先观察 → 写首轮草稿 → 自检轮修补。
 * 观察与自检都是加分项，任一步失败都静默退回已有的结果，用户不会因此拿不到提示词。
 */
async function requestExpand(
  options: PromptOptimizeOptions,
  params: PromptOptimizeParams,
  images: ReferenceImage[],
): Promise<PromptOptimizeResult> {
  const startedAt = Date.now()
  let observations: ImageObservation[] | undefined
  let tokens: ChatTokens = { input: 0, output: 0, total: 0 }

  // 带图扩写也先看图：把参考图里的主体特征写进提示词，比让模型边看边编更稳
  if (images.length > 0) {
    const analysisTimeout = Math.max(
      MIN_STAGE_TIMEOUT_MS,
      Math.min(ANALYSIS_TIMEOUT_CAP_MS, Math.floor(options.timeoutMs / 3)),
    )
    const analysis = await analyzeReferenceImages(
      { ...options, timeoutMs: analysisTimeout },
      images,
    )
    if (analysis) {
      observations = analysis.observations
      tokens = analysis.tokens
    }
  }

  // 观察成功时图片信息已经在摘要里，不再重复上传；观察失败才退回多模态直送
  const first = await requestPrompt(
    { ...options, timeoutMs: remainingTimeout(options, startedAt) },
    {
      systemPrompt: EXPAND_SYSTEM_PROMPT,
      params,
      images: observations ? [] : images,
      mode: 'expand',
      maxTokens: EXPAND_MAX_TOKENS,
      temperature: EXPAND_TEMPERATURE,
      keepParagraphs: true,
      observations,
    },
  )
  let result: PromptOptimizeResult = {
    ...first,
    tokens: mergeTokens(tokens, first.tokens),
  }

  const checkBudget = remainingTimeout(options, startedAt)
  if (checkBudget >= MIN_STAGE_TIMEOUT_MS * 2) {
    const checked = await requestSelfCheck(options, {
      prompt: result.prompt,
      checkBudget,
      params,
      observations,
    })
    if (checked) result = { ...checked, tokens: mergeTokens(result.tokens, checked.tokens) }
  }

  return result
}

/** 自检轮：失败、超时、结果反而明显变短都保留首轮草稿 */
async function requestSelfCheck(
  options: PromptOptimizeOptions,
  input: {
    prompt: string
    checkBudget: number
    params: PromptOptimizeParams
    observations?: ImageObservation[]
  },
): Promise<PromptOptimizeResult | null> {
  try {
    const checked = await requestPrompt(
      { ...options, timeoutMs: Math.min(CHECK_TIMEOUT_CAP_MS, input.checkBudget) },
      {
        systemPrompt: CHECK_SYSTEM_PROMPT,
        params: input.params,
        images: [],
        mode: 'expand',
        maxTokens: CHECK_MAX_TOKENS,
        temperature: CHECK_TEMPERATURE,
        keepParagraphs: true,
        observations: input.observations,
        draft: input.prompt,
      },
    )
    // 自检把内容砍掉一大截多半是丢细节，宁可用首轮
    if (checked.prompt.length < input.prompt.length * 0.6) return null
    return checked
  } catch {
    return null
  }
}

function remainingTimeout(options: PromptOptimizeOptions, startedAt: number): number {
  return Math.max(MIN_STAGE_TIMEOUT_MS, options.timeoutMs - (Date.now() - startedAt))
}

/** 先观察参考图，再带着观察结果写改图指令；观察失败返回 null 交给调用方降级 */
async function requestEditWithObservation(
  options: PromptOptimizeOptions,
  params: PromptOptimizeParams,
  images: ReferenceImage[],
): Promise<PromptOptimizeResult | null> {
  const startedAt = Date.now()
  const analysisTimeout = Math.max(
    MIN_STAGE_TIMEOUT_MS,
    Math.min(ANALYSIS_TIMEOUT_CAP_MS, Math.floor(options.timeoutMs / 2)),
  )

  const analysis = await analyzeReferenceImages(
    { ...options, timeoutMs: analysisTimeout },
    images,
  )
  if (!analysis) return null

  const remaining = Math.max(
    MIN_STAGE_TIMEOUT_MS,
    options.timeoutMs - (Date.now() - startedAt),
  )

  try {
    const result = await requestPrompt(
      { ...options, timeoutMs: remaining },
      {
        systemPrompt: EDIT_SYSTEM_PROMPT,
        params,
        images: [],
        mode: 'edit',
        maxTokens: EDIT_MAX_TOKENS,
        observations: analysis.observations,
      },
    )
    return { ...result, tokens: mergeTokens(analysis.tokens, result.tokens) }
  } catch {
    // 第二阶段失败也走降级，让用户可以重试而不是直接吃报错
    return null
  }
}

async function requestPrompt(
  options: PromptOptimizeOptions,
  input: RequestPromptInput,
): Promise<PromptOptimizeResult> {
  let result
  try {
    result = await callChatCompletion(options, {
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: buildUserContent(input) },
      ],
      maxTokens: input.maxTokens,
      temperature: input.temperature,
    })
  } catch (error) {
    throw translateChatError(error, input.images.length > 0)
  }

  const cleaned = truncate(cleanPrompt(result.content, input.keepParagraphs))
  if (!cleaned) {
    throw new ApiError('UPSTREAM_BAD_RESPONSE', '模型没有返回提示词', 502)
  }

  return { prompt: cleaned, model: result.model, tokens: result.tokens, mode: input.mode }
}

function buildUserContent(input: RequestPromptInput): unknown {
  const { params, images, observations, draft } = input
  const lines = [`画面想法：${params.prompt}`]
  if (params.ratioLabel) lines.push(`画幅：${params.ratioLabel}`)

  // 老客户端只传张数不上图，这里继续沿用那句「保持参考图主体特征」
  const imageCount = images.length || params.referenceCount || 0
  if (imageCount > 0) {
    if (input.mode === 'edit') {
      lines.push(
        imageCount === 1
          ? '参考图：1 张，即图1，作为底图。'
          : `参考图：共 ${imageCount} 张，按输入顺序编号为图1至图${imageCount}；用户点名的图号即底图，未点名时以图1为底图。`,
      )
    } else if (imageCount === 1) {
      lines.push(
        '参考图：1 张，即图1（需保持参考图中主体的外观特征；这张图只控制身份与外观，不要把它的场景、构图和光线一起搬进新画面，除非用户点名要参考）。',
      )
    } else {
      lines.push(
        `参考图：共 ${imageCount} 张，按输入顺序编号为图1至图${imageCount}（需保持参考图中主体的外观特征；按观察摘要为每张图指派职责——身份与长相、服装、道具结构、场景、构图、材质或光，一张图只控制它被指派的部分，不要把整张图原样搬进新画面）。`,
      )
    }
  }
  if (observations?.length) {
    // 改图先读观察再改；扩写要把观察里的特征写进对应段落
    lines.push(
      input.mode === 'edit'
        ? '参考图观察（改图前先读这里）：'
        : '参考图观察（把这些看得见的特征写进对应段落，不要另编一套与参考图矛盾的外貌）：',
      formatObservations(observations),
    )
  }
  if (draft) {
    lines.push('待检查的提示词草稿：', draft)
  }

  const text = lines.join('\n')
  if (images.length === 0) return text

  // 带图时按 OpenAI 兼容的多模态格式逐张附上，并在每张前标图号
  return [
    { type: 'text', text },
    ...images.flatMap((image, index) => [
      { type: 'text', text: `图${index + 1}：` },
      {
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.buffer.toString('base64')}` },
      },
    ]),
  ]
}

/**
 * 上游报错要翻成用户看得懂的话：读不了图就让管理员换多模态模型，
 * 不认 reasoning 参数就让管理员换模型，其余原样透出。
 */
function translateChatError(error: unknown, hasImages: boolean): unknown {
  if (!(error instanceof ApiError)) return error
  const lower = error.message.toLowerCase()

  if (hasImages && /image|vision|multimodal|unsupported/.test(lower)) {
    return new ApiError(
      'VISION_UNSUPPORTED',
      '当前提示词优化模型不支持读取图片，请在控制台换成多模态模型',
      502,
    )
  }
  if (/reasoning|unknown parameter/.test(lower)) {
    return new ApiError(
      'UPSTREAM_ERROR',
      '当前模型不接受提示词优化请求里的参数（如 reasoning），请在控制台更换模型',
      error.statusCode,
    )
  }
  return error
}

/** 模型有时会先写一段分析再给正文；带标记就取标记之后，否则丢掉开头的分析行 */
const PROMPT_MARKER = /^\s*(?:最终提示词|改图提示词|优化后的?提示词|提示词|改写后|结果|输出)\s*[：:]\s*/
const INLINE_MARKER = /(?:最终提示词|改图提示词|提示词|改写后|结果|输出)\s*[：:]\s*/
const ANALYSIS_LINE = /^\s*(?:分析|观察|看图|判断|思路|步骤|目标|底图|修改项|保留项|说明)\s*[：:]/

export function cleanPrompt(input: string, keepParagraphs = false): string {
  let text = stripAnalysisPreamble(input.replace(/```[a-zA-Z]*\n?/g, ''))

  // 前缀可能连续出现（例如「优化后的提示词：提示词：…」），循环剥到干净为止
  while (PROMPT_MARKER.test(text)) text = text.replace(PROMPT_MARKER, '')

  if (keepParagraphs) return normalizeParagraphs(stripWrappingQuotes(text))

  text = text
    // 换行会把「逗号断句的连续描述」拆成列表观感，中文里直接接上更自然
    .replace(/\s*\r?\n+\s*/g, '')
    .trim()

  // 引号可能包住多段（模型先换行再包），所以去引号后再压一次空白
  return stripWrappingQuotes(text).replace(/\s{2,}/g, ' ').trim()
}

/** 列表符号与「第一段：」「【主体】」这类段落标签，段落里都不该出现，防御性剥掉 */
const LIST_MARKER = /^\s*(?:[-*•·]|（?\d{1,2}[.、)）]|[一二三四五六七八九十]+[、.）)])\s*/
const SECTION_LABEL = /^\s*(?:【[^】]{1,8}】|第[一二三四五六七八九十\d]{1,3}[段部分]?[：:、.）)]?|（\d{1,2}）|\[\d{1,2}\])\s*/
/** 剥完标签后可能剩「第一段：主体是…」这种半截编号，再清一次 */
const LEADING_LABEL_WORD = /^\s*[：:]\s*/

/**
 * 扩写保留段落：空行是段落分隔，段内换行按中文习惯直接接上。
 * 分段能让图像模型分出主次；压成一整段则所有词同权，权重就立不起来。
 */
function normalizeParagraphs(text: string): string {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map(block =>
      block
        .split(/\r?\n/)
        .map(line => stripLineLabels(line))
        .filter(Boolean)
        .join(''),
    )
    .map(block => block.replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function stripLineLabels(line: string): string {
  let text = line.trim()
  // 模型可能连着写「第一段：【主体】…」，剥到没有标签为止
  for (let round = 0; round < 3; round += 1) {
    const next = text.replace(LIST_MARKER, '').replace(SECTION_LABEL, '').replace(LEADING_LABEL_WORD, '')
    if (next === text) break
    text = next
  }
  return text.trim()
}

function stripAnalysisPreamble(text: string): string {
  const lines = text.split(/\r?\n/)

  // 优先认「提示词：」这类显式标记，取最后一个标记之后的内容
  let markerIndex = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line !== undefined && PROMPT_MARKER.test(line)) {
      markerIndex = index
      break
    }
  }
  if (markerIndex >= 0) {
    const rest = lines.slice(markerIndex)
    const first = rest[0] ?? ''
    rest[0] = first.replace(PROMPT_MARKER, '')
    return rest.join('\n')
  }

  // 没有标记：丢掉开头连续的空白与「分析/观察/步骤…」行
  let start = 0
  while (start < lines.length) {
    const line = lines[start]
    if (line === undefined) break
    if (line.trim() && !ANALYSIS_LINE.test(line)) break
    start += 1
  }
  if (start > 0 && start < lines.length) return lines.slice(start).join('\n')

  // 单行里模型把分析和正文写在一起：取最后一个「提示词：」之后的内容
  const match = text.match(INLINE_MARKER)
  return match ? text.slice((match.index ?? 0) + match[0].length) : text
}

function stripWrappingQuotes(text: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
  ]
  for (const [open, close] of pairs) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, -close.length).trim()
    }
  }
  return text
}

function truncate(text: string): string {
  if (text.length <= config.maxPromptLength) return text
  return text.slice(0, config.maxPromptLength).trim()
}
