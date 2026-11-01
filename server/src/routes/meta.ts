import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { checkHealth } from '../services/magpie.js'
import type { SettingsStore } from '../services/settings-store.js'

export function registerMetaRoutes(
  app: FastifyInstance,
  deps: { concurrency?: () => number; settings: SettingsStore },
): void {
  app.get('/api/config', async () => ({
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
    maxPromptLength: config.maxPromptLength,
    /** 当前允许的最大并行生图数（可在服务端控制台调整）；前端并行数不会超过它 */
    imageConcurrency: deps.concurrency ? deps.concurrency() : config.imageConcurrency,
    defaults: {
      ratio: config.defaultRatio,
      byAssetType: {
        role: config.defaultRoleRatio,
        scene: config.defaultSceneRatio,
        prop: config.defaultPropRatio,
      },
    },
  }))

  app.get('/api/health', async () => {
    const magpie = await checkHealth({
      baseUrl: await deps.settings.getBaseUrl(),
      model: deps.settings.getModel(),
      timeoutMs: config.requestTimeoutMs,
    })
    return {
      status: magpie.reachable ? 'ok' : 'degraded',
      magpie,
    }
  })
}
