import type { FastifyInstance } from 'fastify'
import { config, findImageModel } from '../config.js'
import { ApiError } from '../lib/errors.js'
import { checkHealth } from '../services/magpie.js'
import { ModelCatalog } from '../services/model-catalog.js'
import { ImageModelCatalog } from '../services/image-model-catalog.js'
import type { SettingsStore } from '../services/settings-store.js'
import { requireAdmin } from './auth.js'

/** 缓存按上游地址分键，放在模块级才能跨请求复用 */
const modelCatalog = new ModelCatalog()
const imageModelCatalog = new ImageModelCatalog()

/**
 * 上游地址必须是 http/https 绝对地址，且不带账号密码——
 * 地址会被写进 settings.json 明文保存，把凭据带进来会白白泄露。
 * 返回值丢掉 query/hash 与末尾斜杠，后面拼 /v1/... 路径才稳。
 */
function parseBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiError('UPSTREAM_INVALID', '上游地址不能为空', 400)
  }

  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ApiError(
      'UPSTREAM_INVALID',
      '上游地址必须是完整的 http/https 地址，例如 http://127.0.0.1:3425',
      400,
    )
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError('UPSTREAM_INVALID', '上游地址只支持 http 或 https', 400)
  }
  if (url.username || url.password) {
    throw new ApiError('UPSTREAM_INVALID', '上游地址不能包含账号密码', 400)
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * 模型 ID 会原样拼进上游请求，带空格基本是手滑粘了空格或整段说明，
 * 长度上限只是防止有人把整段提示词填进来。
 * 空串是「清除后台覆写、回落到环境变量」，不是错误，控制台靠它复位。
 */
function parseModelId(raw: unknown, label: string): string {
  const model = typeof raw === 'string' ? raw.trim() : ''
  if (!model) return ''
  if (model.length > 120) {
    throw new ApiError('UPSTREAM_INVALID', `${label}不能超过 120 个字符`, 400)
  }
  if (/\s/.test(model)) {
    throw new ApiError('UPSTREAM_INVALID', `${label}不能包含空格`, 400)
  }
  return model
}

/**
 * 客户端可用模型：必须是白名单里的模型，且至少留一个，
 * 否则客户端会一个模型都选不了、完全没法生图。
 */
function parseEnabledModels(raw: unknown, allowedIds: string[]): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    throw new ApiError('UPSTREAM_INVALID', '客户端可用模型必须是数组', 400)
  }
  const ids: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || ids.includes(id)) continue
    if (!allowedIds.includes(id) && !findImageModel(id)) {
      throw new ApiError('UPSTREAM_INVALID', `未知的生图模型：${id}`, 400)
    }
    ids.push(id)
  }
  if (!ids.length) {
    throw new ApiError('UPSTREAM_INVALID', '客户端至少需要保留一个可用模型', 400)
  }
  return ids
}

/** query 里 refresh=1/true 都算刷新，其余一律走缓存 */
function wantsRefresh(raw: unknown): boolean {
  return raw === true || raw === 1 || raw === '1' || raw === 'true'
}

export function registerUpstreamRoutes(
  app: FastifyInstance,
  deps: { settings: SettingsStore },
): void {
  app.get('/api/admin/upstream', async request => {
    requireAdmin(request)
    const baseUrl = await deps.settings.getBaseUrl()
    const catalog = await imageModelCatalog.list(baseUrl)
    const catalogIds = catalog.map(model => model.id)
    return {
      baseUrl,
      model: deps.settings.getImageModel(),
      fromSettings: deps.settings.isFromSettings(),
      /** 生效中的对话模型（可能是环境变量默认值） */
      textModel: await deps.settings.getTextModel(),
      /** 后台覆写值，空串表示没覆写；控制台输入框绑定这个 */
      textModelOverride: deps.settings.getTextModelOverride(),
      textModelFromSettings: deps.settings.isTextModelFromSettings(),
      /** 拼图卡片标题模型：留空时跟随 textModel */
      titleModel: await deps.settings.getTitleModel(),
      titleModelOverride: deps.settings.getTitleModelOverride(),
      titleModelFromSettings: deps.settings.isTitleModelFromSettings(),
      /** 生效中的生图模型（可能是 MAGPIE_IMAGE_MODEL 默认值） */
      imageModel: deps.settings.getImageModel(),
      imageModelOverride: deps.settings.getImageModelOverride(),
      imageModelFromSettings: deps.settings.isImageModelFromSettings(),
      /** 客户端可选的模型全集（Magpie 实际返回）与当前勾选值，控制台据此画勾选框 */
      imageModels: catalog,
      enabledImageModels: deps.settings.getEnabledImageModels(catalogIds),
      enabledImageModelsFromSettings: deps.settings.isEnabledImageModelsFromSettings(),
    }
  })

  /**
   * 模型自动发现：后台填完地址后直接列出上游可用模型，省得手抄模型名。
   * refresh=1 跳过缓存（后台的「刷新」按钮），其余请求走 60 秒缓存。
   */
  app.get('/api/admin/upstream/models', async request => {
    requireAdmin(request)
    const query = (request.query ?? {}) as { refresh?: unknown }
    const baseUrl = await deps.settings.getBaseUrl()
    const result = await modelCatalog.list(baseUrl, { force: wantsRefresh(query.refresh) })
    return { baseUrl, ...result }
  })

  app.put('/api/admin/upstream', async (request, reply) => {
    requireAdmin(request)
    const body = (request.body ?? {}) as {
      baseUrl?: unknown
      textModel?: unknown
      titleModel?: unknown
      imageModel?: unknown
      enabledImageModels?: unknown
    }
    const baseUrl = parseBaseUrl(body.baseUrl)

    // 全部校验完再落盘，否则模型名不合法时地址已经被写进去一半
    const textModel = body.textModel === undefined ? undefined : parseModelId(body.textModel, '对话模型')
    const titleModel = body.titleModel === undefined ? undefined : parseModelId(body.titleModel, '标题模型')
    const imageModel = body.imageModel === undefined ? undefined : parseModelId(body.imageModel, '生图模型')
    const catalog = await imageModelCatalog.list(baseUrl)
    const enabledImageModels = parseEnabledModels(body.enabledImageModels, catalog.map(model => model.id))

    await deps.settings.setBaseUrl(baseUrl)
    request.log.info({ baseUrl }, '上游地址已更新')

    // 模型字段是后加的，旧客户端不会传，不能因此报错
    if (textModel !== undefined) {
      await deps.settings.setTextModel(textModel)
      request.log.info({ textModel }, '提示词优化模型已更新')
    }
    if (titleModel !== undefined) {
      await deps.settings.setTitleModel(titleModel)
      request.log.info({ titleModel }, '卡片标题模型已更新')
    }
    if (imageModel !== undefined) {
      await deps.settings.setImageModel(imageModel)
      request.log.info({ imageModel }, '生图模型已更新')
    }
    if (enabledImageModels !== undefined) {
      await deps.settings.setEnabledImageModels(enabledImageModels)
      request.log.info({ enabledImageModels }, '客户端可选生图模型已更新')
    }

    return reply.send({
      ok: true,
      baseUrl,
      textModel: await deps.settings.getTextModel(),
      textModelOverride: deps.settings.getTextModelOverride(),
      textModelFromSettings: deps.settings.isTextModelFromSettings(),
      titleModel: await deps.settings.getTitleModel(),
      titleModelOverride: deps.settings.getTitleModelOverride(),
      titleModelFromSettings: deps.settings.isTitleModelFromSettings(),
      imageModel: deps.settings.getImageModel(),
      imageModelOverride: deps.settings.getImageModelOverride(),
      imageModelFromSettings: deps.settings.isImageModelFromSettings(),
      imageModels: catalog,
      enabledImageModels: deps.settings.getEnabledImageModels(catalog.map(model => model.id)),
      enabledImageModelsFromSettings: deps.settings.isEnabledImageModelsFromSettings(),
    })
  })

  /**
   * 连通性测试：测的是请求里带的地址（可能是还没保存的），
   * 不写配置，供后台在保存前先试一下。
   */
  app.post('/api/admin/upstream/test', async request => {
    requireAdmin(request)
    const body = (request.body ?? {}) as { baseUrl?: unknown }

    let baseUrl: string
    try {
      baseUrl = parseBaseUrl(body.baseUrl)
    } catch {
      return { reachable: false, status: null, detail: '上游地址无效，请填写完整的 http/https 地址' }
    }

    const health = await checkHealth({
      baseUrl,
      model: deps.settings.getImageModel(),
      timeoutMs: config.requestTimeoutMs,
    })

    return {
      reachable: health.reachable,
      status: null,
      detail: health.reachable ? '上游可连通' : health.error ?? '无法连接上游',
    }
  })
}
