/**
 * 每个生图模型实际可用的清晰度档位，以及生成后的尺寸核对规则。
 *
 * 这里不是“猜模型应该支持什么”，而是按实际链路给白名单：
 * - Codex 通道的 GPT Image 2 实测忽略 1K/2K/4K，只按画幅输出原生尺寸；
 * - ComfyUI 的工作流节点受本机显存限制，最高按 2K 出图；
 * - 自定义供应商目前不接收 resolution；
 * - 其它模型按 Magpie 当前转发规则给出可达档位。
 *
 * 未知模型一律只给 auto：宁可少显示，也不要让用户选了不存在的档位。
 */
import type { ImageResolution, RatioSpec } from '../platform/config.js'
import { fitComfySize } from './comfy-size.js'
import type { ComfyWorkflowConfig } from './comfy-config.js'

const AUTO: ImageResolution[] = ['auto']
const UP_TO_1K: ImageResolution[] = ['auto', '1K']
const UP_TO_2K: ImageResolution[] = ['auto', '1K', '2K']
const ALL: ImageResolution[] = ['auto', '1K', '2K', '4K']
const COMFY: ImageResolution[] = ['auto', '1K', '2K']

export interface ResolutionSupport {
  tiers: ImageResolution[]
  /** 客户端展示的支持范围与限制说明 */
  note: string
  /** 客户端界面提示；不填时沿用 note，设为空串则不在界面展示 */
  uiNote?: string
  /** 非 auto 档位是否真的能改变上游输出尺寸 */
  honorsTiers: boolean
}

export interface ResolutionTarget {
  width: number
  height: number
  /** 目标长边；用于生成后核对实际图片 */
  longEdge: number
  /** true 表示后端能把宽高精确写进请求或工作流 */
  exact: boolean
}

export interface ResolutionAssessment {
  checked: boolean
  matched: boolean
  warning?: string
}

export function resolutionSupportForModel(
  publicId: string,
  comfyWorkflow?: Pick<ComfyWorkflowConfig, 'mapping'>,
): ResolutionSupport {
  const id = publicId.trim().toLowerCase()

  if (id.startsWith('comfy:')) {
    const mapped = Boolean(
      comfyWorkflow?.mapping.width.length && comfyWorkflow?.mapping.height.length,
    )
    return {
      tiers: mapped ? COMFY : AUTO,
      note: mapped
        ? '本机 ComfyUI 受显存限制，最高按 2K（长边 2048）出图，4K 不可用。'
        : '这个 ComfyUI 工作流没有同时绑定宽度和高度节点，无法指定分辨率，只能按工作流原生尺寸出图。',
      honorsTiers: mapped,
    }
  }
  if (id.startsWith('p:')) {
    return {
      tiers: AUTO,
      note: '自定义供应商目前不接收分辨率档位，只按接口自己的原生尺寸出图。',
      honorsTiers: false,
    }
  }

  // Codex 的 ChatGPT 出图通道实测不执行 size / resolution，必须先于 gpt-image-2 判断。
  if (id.startsWith('codex/')) {
    return {
      tiers: AUTO,
      note: 'Codex 通道只按画幅输出原生尺寸，1K/2K/4K 不会生效；1:1 约 1254×1254，16:9 约 1672×941。',
      uiNote: '',
      honorsTiers: false,
    }
  }

  // 固定尺寸的 OpenAI 图片模型：档位不会生效
  if (id.includes('gpt-image-1') || id.includes('dall-e') || id.includes('chatgpt-image')) {
    return {
      tiers: AUTO,
      note: '该模型只按自身固定尺寸出图，不支持 1K/2K/4K。',
      honorsTiers: false,
    }
  }
  // GPT Image 2+ / Copilot：Magpie 会把档位换算成宽高再交给上游
  if (id.includes('gpt-image-2') || id.includes('gpt-image-3') || id.includes('copilot')) {
    return {
      tiers: ALL,
      note: '支持 1K/2K/4K；4K 受 3840 长边和约 829 万像素上限约束，实际宽高以生图结果为准。',
      honorsTiers: true,
    }
  }

  // Grok Imagine 原生只有 1k / 2k
  if (id.includes('grok')) {
    return {
      tiers: UP_TO_2K,
      note: 'xAI Grok Imagine 原生最高 2K，不支持 4K。',
      honorsTiers: true,
    }
  }

  // Qwen / DashScope 只接受像素尺寸，不接受这些档位
  if (id.includes('qwen')) {
    return {
      tiers: AUTO,
      note: 'Qwen 接口只接收像素尺寸，当前不接收 1K/2K/4K 档位。',
      honorsTiers: false,
    }
  }

  // 这些供应商路径完全不读取档位
  if (
    id.includes('hunyuan') ||
    id.includes('workbuddy') ||
    id.includes('muse') ||
    id.includes('sensenova') ||
    id.includes('modelscope')
  ) {
    return {
      tiers: AUTO,
      note: '该供应商路径当前不读取分辨率档位，只能使用模型原生尺寸。',
      honorsTiers: false,
    }
  }

  if (id.includes('minimax')) {
    // 只有明确的 H3 才按 1K/2K/4K 处理；MiniMax-Image 等别名无法确定
    return id.includes('h3')
      ? {
          tiers: ALL,
          note: 'MiniMax H3 Image 按面积换算支持 1K/2K/4K。',
          honorsTiers: true,
        }
      : {
          tiers: AUTO,
          note: 'MiniMax 当前型号无法确定档位，只提供自动分辨率。',
          honorsTiers: false,
        }
  }

  // 火山方舟 Seedream：不同版本的档位表不同
  if (id.includes('seedream')) {
    if (id.includes('seedream-5-0-lite') || id.includes('seedream-5-lite')) {
      return {
        tiers: ['auto', '2K', '4K'],
        note: 'Seedream 5 Lite 支持 2K/4K。',
        honorsTiers: true,
      }
    }
    if (id.includes('seedream-5')) {
      return {
        tiers: ['auto', '1K', '2K'],
        note: 'Seedream 5 支持 1K/2K。',
        honorsTiers: true,
      }
    }
    if (id.includes('seedream-4-5')) {
      return {
        tiers: ['auto', '2K', '4K'],
        note: 'Seedream 4.5 支持 2K/4K。',
        honorsTiers: true,
      }
    }
    return {
      tiers: ALL,
      note: 'Seedream 按版本支持 1K/2K/4K，实际宽高以生图结果为准。',
      honorsTiers: true,
    }
  }

  // Gemini 3.x / Nano Banana 3.x 支持三档；Lite 与 Gemini 2.x 只到 1K
  if (id.includes('gemini') || id.includes('nano-banana')) {
    if (id.includes('lite') || id.includes('gemini-2')) {
      return {
        tiers: UP_TO_1K,
        note: '该 Gemini 图像模型只支持 1K。',
        honorsTiers: true,
      }
    }
    return {
      tiers: ALL,
      note: '支持 1K/2K/4K，实际宽高以生图结果为准。',
      honorsTiers: true,
    }
  }

  return {
    tiers: AUTO,
    note: '当前模型没有可验证的分辨率档位，只提供模型原生尺寸。',
    honorsTiers: false,
  }
}

export function resolutionTiersForModel(publicId: string): ImageResolution[] {
  return resolutionSupportForModel(publicId).tiers
}

/** auto 返回 null；模型不支持该档位也返回 null */
export function resolutionTargetForModel(
  ratio: RatioSpec,
  resolution: ImageResolution,
  publicId: string,
  comfyWorkflow?: Pick<ComfyWorkflowConfig, 'mapping'>,
): ResolutionTarget | null {
  if (resolution === 'auto') return null
  const support = resolutionSupportForModel(publicId, comfyWorkflow)
  if (!support.tiers.includes(resolution)) return null

  const id = publicId.trim().toLowerCase()
  if (id.startsWith('comfy:')) {
    const raw = genericTierPixels(ratio, resolution)
    const size = fitComfySize(raw.width, raw.height)
    return { ...size, longEdge: Math.max(size.width, size.height), exact: true }
  }
  if (id.startsWith('codex/') || id.startsWith('p:')) return null
  if (id.includes('gpt-image-2') || id.includes('gpt-image-3') || id.includes('copilot')) {
    const size = gptTierPixels(ratio, resolution)
    return { ...size, longEdge: Math.max(size.width, size.height), exact: false }
  }

  const size = genericTierPixels(ratio, resolution)
  return { ...size, longEdge: Math.max(size.width, size.height), exact: false }
}

/**
 * 生成后核对：档位请求必须同时满足“长边接近目标”和“宽高比不变”。
 * 模型自己回落到原生尺寸、或接口改写了画幅，都会在这里留下明确提示，
 * 不会把差异伪装成成功。
 */
export function assessResolutionOutput(args: {
  requested: ImageResolution
  ratio: RatioSpec
  target: ResolutionTarget | null
  actual: { width?: number; height?: number } | null
  modelNote?: string
}): ResolutionAssessment {
  const { requested, ratio, target, actual } = args
  if (requested === 'auto' || !target || !actual?.width || !actual?.height) {
    return { checked: false, matched: true }
  }

  const expectedRatio = target.width / target.height
  const actualRatio = actual.width / actual.height
  const actualEdge = Math.max(actual.width, actual.height)
  const edgeDrift = Math.abs(actualEdge - target.longEdge) / Math.max(1, target.longEdge)
  const ratioDrift = Math.abs(actualRatio - expectedRatio) / expectedRatio

  // 4K 在 GPT Image 2 上会被面积上限压到 3840 以内；10% 容差覆盖这种明确约束。
  const sizeOk = edgeDrift <= 0.12
  const ratioOk = ratioDrift <= 0.025
  if (sizeOk && ratioOk) return { checked: true, matched: true }

  const reasons: string[] = []
  if (!sizeOk) reasons.push(`长边应为约 ${target.longEdge}px`)
  if (!ratioOk) reasons.push(`画幅应为 ${ratio.width}:${ratio.height}`)
  const note = args.modelNote ? ` ${args.modelNote}` : ''
  return {
    checked: true,
    matched: false,
    warning: `请求 ${requested}（目标 ${target.width}×${target.height}），上游实际返回 ${actual.width}×${actual.height}，${reasons.join('，')}。已保留上游原图并记录差异。${note}`.trim(),
  }
}

function genericTierPixels(
  ratio: Pick<RatioSpec, 'width' | 'height'>,
  resolution: Exclude<ImageResolution, 'auto'>,
): { width: number; height: number } {
  const edge = tierEdge(resolution)
  const value = ratio.width / ratio.height
  const width = value >= 1 ? edge : edge * value
  const height = value >= 1 ? edge / value : edge
  return { width: roundTo(width, 16), height: roundTo(height, 16) }
}

/** Magpie 对 GPT Image 2+ 的换算：16 的倍数、3840 长边、约 829 万像素上限 */
function gptTierPixels(
  ratio: Pick<RatioSpec, 'width' | 'height'>,
  resolution: Exclude<ImageResolution, 'auto'>,
): { width: number; height: number } {
  const value = ratio.width / ratio.height
  const edge = Math.min(tierEdge(resolution), 3840)
  let width = value >= 1 ? edge : edge * value
  let height = value >= 1 ? edge / value : edge
  const area = width * height
  const most = 8_294_400
  const least = 655_360
  if (area > most) {
    const scale = Math.sqrt(most / area)
    width *= scale
    height *= scale
  } else if (area < least) {
    const scale = Math.sqrt(least / area)
    width *= scale
    height *= scale
  }
  return { width: roundTo(width, 16), height: roundTo(height, 16) }
}

function tierEdge(resolution: Exclude<ImageResolution, 'auto'>): number {
  return resolution === '4K' ? 4096 : resolution === '2K' ? 2048 : 1024
}

function roundTo(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step)
}
