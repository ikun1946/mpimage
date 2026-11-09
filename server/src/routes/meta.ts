import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { checkHealth } from '../services/magpie.js'
import { ImageModelCatalog } from '../services/image-model-catalog.js'
import type { SettingsStore } from '../services/settings-store.js'

const imageModelCatalog = new ImageModelCatalog()

export function registerMetaRoutes(
  app: FastifyInstance,
  deps: { concurrency?: () => number; settings: SettingsStore },
): void {
  app.get('/api/config', async () => {
    // 生图模型以 Magpie 实际返回的清单为准（X-Magpie-Drawers），拿不到时回落静态清单
    const catalog = await imageModelCatalog.list(await deps.settings.getBaseUrl())
    const allIds = catalog.map(model => model.id)
    const enabled = new Set(deps.settings.getEnabledImageModels(allIds))
    const imageModels = catalog
      .filter(model => enabled.has(model.id))
      .map(({ id, label }) => ({ id, label }))
    const configuredModel = deps.settings.getClientImageModel(allIds)
    // 默认模型排第一位，客户端下拉打开就能看到它
    const defaultIndex = imageModels.findIndex(model => model.id === configuredModel)
    if (defaultIndex > 0) {
      const [defaultModel] = imageModels.splice(defaultIndex, 1)
      if (defaultModel) imageModels.unshift(defaultModel)
    }
    return {
      ratios: config.ratios.map(({ id, label, shortLabel, width, height, nativeWidth, nativeHeight, promptHint }) => ({
        id,
        label,
        shortLabel,
        width,
        height,
        nativeWidth,
        nativeHeight,
        promptHint,
      })),
      /** 客户端可选的生图模型；服务端控制台可以逐项关掉，关掉的不下发给客户端 */
      imageModels,
      /** 客户端不传 model 时用的模型；若后台默认模型被关掉，就用列表里第一个 */
      defaultImageModel: imageModels.some(model => model.id === configuredModel)
        ? configuredModel
        : (imageModels[0]?.id || configuredModel),
      maxPromptLength: config.maxPromptLength,
      /** 当前允许的最大并行生图数（可在服务端控制台调整）；前端并行数不会超过它 */
      imageConcurrency: deps.concurrency ? deps.concurrency() : config.imageConcurrency,
      /** 前端据此决定要不要显示 AI 优化入口：没有可用对话模型时 hide */
      promptOptimize: {
        textModel: await deps.settings.getTextModel(),
      },
      defaults: {
        ratio: config.defaultRatio,
        byAssetType: {
          role: config.defaultRoleRatio,
          scene: config.defaultSceneRatio,
          prop: config.defaultPropRatio,
        },
      },
    }
  })

  app.get('/api/health', async () => {
    const magpie = await checkHealth({
      baseUrl: await deps.settings.getBaseUrl(),
      model: deps.settings.getImageModel(),
      timeoutMs: config.requestTimeoutMs,
    })
    return {
      status: magpie.reachable ? 'ok' : 'degraded',
      magpie,
    }
  })
}
