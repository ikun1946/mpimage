/**
 * 每个生图模型实际可用的清晰度档位。
 *
 * Magpie 的 resolution 只是统一入口：不同供应商会把它转成 imageSize、
 * resolution、area 或像素尺寸，也有模型完全忽略档位。这里按模型 ID 给客户端
 * 下发白名单，避免 UI 对每个模型都展示同一组 1K/2K/4K。
 *
 * 未知模型一律只给 auto：宁可少显示，也不要让用户选了不存在的档位。
 */
import type { ImageResolution } from '../platform/config.js'

const AUTO: ImageResolution[] = ['auto']
const UP_TO_1K: ImageResolution[] = ['auto', '1K']
const UP_TO_2K: ImageResolution[] = ['auto', '1K', '2K']
const ALL: ImageResolution[] = ['auto', '1K', '2K', '4K']

export function resolutionTiersForModel(publicId: string): ImageResolution[] {
  const id = publicId.trim().toLowerCase()

  // 本机 ComfyUI 自己换算宽高，四档都能用
  if (id.startsWith('comfy:')) return ALL
  // 自定义供应商目前不接收 resolution
  if (id.startsWith('p:')) return AUTO

  // 固定尺寸的 OpenAI 图片模型：档位不会生效
  if (id.includes('gpt-image-1') || id.includes('dall-e') || id.includes('chatgpt-image')) {
    return AUTO
  }
  // GPT Image 2+ / Codex / Copilot：三档都接受，4K 由 Magpie 压到安全上限
  if (
    id.includes('gpt-image-2') ||
    id.includes('gpt-image-3') ||
    id.startsWith('codex/') ||
    id.includes('copilot')
  ) {
    return ALL
  }

  // Grok Imagine 原生只有 1k / 2k
  if (id.includes('grok')) return UP_TO_2K

  // Qwen / DashScope 只接受像素尺寸，不接受这些档位
  if (id.includes('qwen')) return AUTO

  // 这些供应商路径完全不读取档位
  if (
    id.includes('hunyuan') ||
    id.includes('workbuddy') ||
    id.includes('muse') ||
    id.includes('sensenova') ||
    id.includes('modelscope')
  ) {
    return AUTO
  }

  if (id.includes('minimax')) {
    // 只有明确的 H3 才按 1K/2K/4K 处理；MiniMax-Image 等别名无法确定
    return id.includes('h3') ? ALL : AUTO
  }

  // 火山方舟 Seedream：不同版本的档位表不同
  if (id.includes('seedream')) {
    if (id.includes('seedream-5-0-lite') || id.includes('seedream-5-lite')) {
      return ['auto', '2K', '4K']
    }
    if (id.includes('seedream-5')) return ['auto', '1K', '2K']
    if (id.includes('seedream-4-5')) return ['auto', '2K', '4K']
    return ALL
  }

  // Gemini 3.x / Nano Banana 3.x 支持三档；Lite 与 Gemini 2.x 只到 1K
  if (id.includes('gemini') || id.includes('nano-banana')) {
    if (id.includes('lite') || id.includes('gemini-2')) return UP_TO_1K
    return ALL
  }

  // 未知模型：保守地只提供 auto
  return AUTO
}
