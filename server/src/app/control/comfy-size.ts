/**
 * ComfyUI 工作流能接受的像素尺寸。
 *
 * 本机显存有限，工作流节点不是任意宽高都能跑。这里把目标尺寸收敛到
 * 32 的倍数，并限制长边与总像素；生图接口和分辨率能力表共用这一份规则，
 * 避免界面显示 4K、实际却被悄悄压到 2K。
 */
export const COMFY_MAX_PIXELS = 4_200_000
export const COMFY_MAX_SIDE = 2048

export function fitComfySize(
  rawWidth: number,
  rawHeight: number,
): { width: number; height: number } {
  const ratio = rawWidth > 0 && rawHeight > 0 ? rawWidth / rawHeight : 1
  let best = { width: 1024, height: 1024, score: Number.POSITIVE_INFINITY }
  const targetArea = Math.min(
    COMFY_MAX_PIXELS,
    Math.max(256 * 256, rawWidth * rawHeight),
  )
  for (let height = 256; height <= COMFY_MAX_SIDE; height += 32) {
    const idealWidth = height * ratio
    for (const width of [Math.floor(idealWidth / 32) * 32, Math.ceil(idealWidth / 32) * 32]) {
      if (width < 256 || width > COMFY_MAX_SIDE) continue
      if (width * height > COMFY_MAX_PIXELS) continue
      const score =
        Math.abs(width / height - ratio) * 100 +
        Math.abs(width * height - targetArea) / Math.max(1, targetArea)
      if (score < best.score) best = { width, height, score }
    }
  }
  return { width: best.width, height: best.height }
}
