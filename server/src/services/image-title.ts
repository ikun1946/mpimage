import { callChatCompletion } from './chat-completion.js'

/** 拼图卡片左下角的名字：最多 7 个字，服务端决定用哪个文本模型 */
export const IMAGE_TITLE_MAX_CHARS = 7

/** 标题只是锦上添花，不能拖住生图结果；超时就退回提示词里的第一个短句 */
const TITLE_TIMEOUT_MS = 12_000

export interface ImageTitleOptions {
  baseUrl: string
  model: string
}

const TITLE_SYSTEM_PROMPT = [
  '你是画境的画面命名助手。根据用户的生图提示词，为生成的画面起一个中文短名。',
  '要求：2 到 7 个汉字；只写名字本身；不要标点、引号、书名号、表情、解释或编号。',
].join('')

/** 清掉模型可能带上的标点、引号、前缀，并硬性截到 7 个字 */
export function sanitizeImageTitle(raw: string): string {
  let text = String(raw || '').trim().split(/\r?\n/)[0] || ''
  text = text.replace(/^(?:标题|名字|名称)\s*[:：]\s*/, '')
  text = text.replace(/[《》「」『』【】（）()"'“”‘’<>]/g, '')
  text = text.replace(/[，。！？、；：,.!?;:～~…—\-\s]/g, '')
  text = text.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '')
  return [...text].slice(0, IMAGE_TITLE_MAX_CHARS).join('')
}

/** 模型不可用或超时时的兜底：取提示词里第一个短句 */
export function fallbackImageTitle(prompt: string): string {
  const first = String(prompt || '')
    .split(/[，,。；;\n]/)
    .map(part => part.trim())
    .find(Boolean)
  return sanitizeImageTitle(first || '') || '未命名'
}

/**
 * 根据生图提示词生成拼图卡片名。
 * 任何失败都吞掉并退回提示词短句，绝不影响生图主流程。
 */
export async function generateImageTitle(
  options: ImageTitleOptions,
  prompt: string,
): Promise<string> {
  const source = String(prompt || '').trim()
  if (!source) return '未命名'

  try {
    const result = await callChatCompletion(
      { baseUrl: options.baseUrl, model: options.model, timeoutMs: TITLE_TIMEOUT_MS },
      {
        messages: [
          { role: 'system', content: TITLE_SYSTEM_PROMPT },
          { role: 'user', content: `提示词：${source.slice(0, 1200)}\n\n请只输出名字。` },
        ],
        maxTokens: 24,
        temperature: 0.5,
      },
    )
    return sanitizeImageTitle(result.content) || fallbackImageTitle(source)
  } catch {
    return fallbackImageTitle(source)
  }
}
