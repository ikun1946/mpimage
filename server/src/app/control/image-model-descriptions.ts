/**
 * 客户端模型下拉里的简短介绍。
 *
 * 这里只写“这个模型适合什么、有什么限制”，不写价格或账号信息。
 * 未知的 Magpie 模型给一条通用说明，新增模型时再按 ID 补充即可。
 */
export function modelDescription(publicId: string, label: string): string {
  const id = publicId.trim().toLowerCase()
  const name = label.trim() || publicId

  if (id.startsWith('comfy:')) {
    return `本机 ComfyUI 工作流「${name}」，按已导入的工作流生成，不消耗 Magpie 额度。`
  }
  if (id.startsWith('p:')) {
    return `自定义供应商模型「${name}」，使用后台配置的接口出图；当前不接收分辨率档位。`
  }

  if (id.includes('gpt-image-2') || id.startsWith('codex/')) {
    return 'OpenAI GPT Image 2：擅长写实、文字排版和复杂指令，支持自动/1K/2K/4K；4K 受 3840 长边与面积上限限制。'
  }
  if (id.includes('gemini-3-pro')) {
    return 'Google Gemini 3 Pro Image（Nano Banana Pro）：理解力强，适合复杂构图、多图参考与高细节画面，支持 1K/2K/4K。'
  }
  if (id.includes('gemini-3.1') && !id.includes('lite')) {
    return 'Gemini 3.1 Flash Image：速度与质量均衡，适合日常与批量出图，支持 1K/2K/4K。'
  }
  if (id.includes('gemini-3') && !id.includes('lite')) {
    return 'Gemini 3 图像模型：适合复杂描述与参考图编辑，支持 1K/2K/4K。'
  }
  if (id.includes('gemini-3.1') && id.includes('lite')) {
    return 'Gemini 3.1 Flash Lite：速度优先，适合快速草图与批量试稿，仅支持 1K。'
  }
  if (id.includes('gemini-2')) {
    return 'Gemini 2.5 Flash Image：较早的 Gemini 图像模型，仅支持 1K。'
  }
  if (id.includes('nano-banana') && id.includes('lite')) {
    return 'Nano Banana Lite：速度优先的 Gemini 图像模型，仅支持 1K。'
  }
  if (id.includes('nano-banana')) {
    return `${name}：Google Gemini 图像模型，擅长角色一致性与参考图编辑，支持 1K/2K/4K。`
  }
  if (id.includes('grok')) {
    return 'xAI Grok Imagine：偏风格化与创意表达，最高支持 2K；选择 4K 会按 2K 发送。'
  }
  if (id.includes('qwen')) {
    return 'Qwen Image：通义千问图像模型，当前接口只接收像素尺寸，不支持 1K/2K/4K 档位。'
  }
  if (id.includes('seedream')) {
    return '火山方舟 Seedream 图像模型：擅长大场景与写实画面，按 Seedream 版本支持不同档位。'
  }
  if (id.includes('minimax') && id.includes('h3')) {
    return 'MiniMax H3 Image：支持 1K/2K/4K，按面积换算输出尺寸。'
  }
  if (id.includes('minimax')) {
    return 'MiniMax Image：当前无法确定具体子型号，暂只提供自动分辨率。'
  }
  if (id.includes('hunyuan')) {
    return '腾讯混元图像模型：当前项目默认隐藏。'
  }
  if (id.includes('gpt-image-1') || id.includes('dall-e') || id.includes('chatgpt-image')) {
    return 'OpenAI 固定尺寸图像模型：输出尺寸由模型自身决定，不支持 1K/2K/4K 档位。'
  }
  return `${name}：Magpie 上游生图模型。`
}
