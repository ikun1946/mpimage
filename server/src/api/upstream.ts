import type { FastifyInstance } from 'fastify'
import { config, findImageModel } from '../app/platform/config.js'
import { ApiError } from '../app/platform/errors.js'
import { checkHealth } from '../app/products/images/magpie.js'
import { ModelCatalog } from '../app/control/model-catalog.js'
import { ImageModelCatalog } from '../app/control/image-model-catalog.js'
import type { ProviderConfig, ProviderModelConfig, SettingsStore } from '../app/control/settings-store.js'
import { customModelId } from '../app/control/client-models.js'
import type { GptAccountStore } from '../app/control/accounts/gpt-account-store.js'
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
  return ids
}


/** 供应商填地址时常把 /v1 一起粘进来，我们的图片请求会再拼 /v1/...，这里统一去掉 */
function stripApiVersion(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/i, '')
}

const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,32}$/

/**
 * 自定义供应商列表：任何兼容 OpenAI 图片接口的网关。
 * 全部校验通过才落盘，避免存进去一半坏数据。
 */
function parseProviders(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) {
    throw new ApiError('UPSTREAM_INVALID', '供应商列表必须是数组', 400)
  }
  if (raw.length > 20) {
    throw new ApiError('UPSTREAM_INVALID', '供应商最多 20 个', 400)
  }

  const providers: ProviderConfig[] = []
  const providerIds = new Set<string>()

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new ApiError('UPSTREAM_INVALID', '供应商条目格式不正确', 400)
    }
    const source = item as Record<string, unknown>

    const id = typeof source.id === 'string' ? source.id.trim() : ''
    if (!PROVIDER_ID_RE.test(id)) {
      throw new ApiError('UPSTREAM_INVALID', '供应商 ID 只能包含字母、数字、下划线和短横线（1-32 位）', 400)
    }
    if (providerIds.has(id)) {
      throw new ApiError('UPSTREAM_INVALID', '供应商 ID 重复：' + id, 400)
    }
    providerIds.add(id)

    const name = typeof source.name === 'string' ? source.name.trim().slice(0, 60) : ''
    const baseUrl = stripApiVersion(parseBaseUrl(source.baseUrl))
    const apiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : ''
    if (apiKey.length > 500) {
      throw new ApiError('UPSTREAM_INVALID', 'API Key 过长', 400)
    }

    if (!Array.isArray(source.models)) {
      throw new ApiError('UPSTREAM_INVALID', '供应商「' + (name || id) + '」的模型列表必须是数组', 400)
    }
    if (source.models.length > 200) {
      throw new ApiError('UPSTREAM_INVALID', '供应商「' + (name || id) + '」的模型最多 200 个', 400)
    }

    const models: ProviderModelConfig[] = []
    const modelIds = new Set<string>()
    for (const entry of source.models) {
      const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
      const modelId = record
        ? typeof record.id === 'string'
          ? record.id.trim()
          : ''
        : typeof entry === 'string'
          ? entry.trim()
          : ''
      if (!modelId) continue
      if (modelId.length > 160 || /\s/.test(modelId)) {
        throw new ApiError('UPSTREAM_INVALID', '模型 ID 不合法：' + modelId, 400)
      }
      if (modelIds.has(modelId)) continue
      modelIds.add(modelId)

      const label = record && typeof record.label === 'string' ? record.label.trim().slice(0, 60) : ''
      models.push({
        id: modelId,
        ...(label ? { label } : {}),
        enabled: record ? record.enabled !== false : true,
      })
    }

    providers.push({
      id,
      name: name || id,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      enabled: source.enabled !== false,
      models,
    })
  }

  return providers
}

/** 模型改名：{ 模型 id: 显示名 }；显示名留空即清除 */
function parseModelAliases(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError('UPSTREAM_INVALID', '模型名称覆写必须是对象', 400)
  }
  const aliases: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim()
    if (!id || id.length > 200) continue
    const label = typeof value === 'string' ? value.trim() : ''
    if (label.length > 60) {
      throw new ApiError('UPSTREAM_INVALID', '「' + id + '」的显示名不能超过 60 个字符', 400)
    }
    if (label) aliases[id] = label
  }
  return aliases
}

/** query 里 refresh=1/true 都算刷新，其余一律走缓存 */
function wantsRefresh(raw: unknown): boolean {
  return raw === true || raw === 1 || raw === '1' || raw === 'true'
}

export function registerUpstreamRoutes(
  app: FastifyInstance,
  deps: { settings: SettingsStore; accounts?: GptAccountStore },
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
      /** 自定义供应商与模型改名，控制台据此画供应商卡片 */
      providers: deps.settings.getProviders(),
      modelAliases: deps.settings.getModelAliases(),
      /** 账号池当前可用的生图模型；只读，由导入的账号决定 */
      accountImageModels: deps.accounts
        ? deps.accounts.availableModels().map(spec => ({
            id: spec.id,
            label: spec.label,
            accounts: deps.accounts!.countForModel(spec),
          }))
        : [],
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
      providers?: unknown
      modelAliases?: unknown
    }
    const baseUrl = parseBaseUrl(body.baseUrl)

    // 全部校验完再落盘，否则模型名不合法时地址已经被写进去一半
    const textModel = body.textModel === undefined ? undefined : parseModelId(body.textModel, '对话模型')
    const titleModel = body.titleModel === undefined ? undefined : parseModelId(body.titleModel, '标题模型')
    const imageModel = body.imageModel === undefined ? undefined : parseModelId(body.imageModel, '生图模型')
    const catalog = await imageModelCatalog.list(baseUrl)
    const catalogIds = catalog.map(model => model.id)
    const enabledImageModels = parseEnabledModels(body.enabledImageModels, catalogIds)
    const providers = body.providers === undefined ? undefined : parseProviders(body.providers)
    const modelAliases = body.modelAliases === undefined ? undefined : parseModelAliases(body.modelAliases)

    // 内置模型可以全部不勾，但至少要有一个模型可用（可以是自定义供应商的）
    const customEnabled = (providers ?? deps.settings.getProviders())
      .filter(provider => provider.enabled !== false)
      .reduce((count, provider) => count + provider.models.filter(model => model.enabled !== false).length, 0)
    if (enabledImageModels !== undefined && enabledImageModels.length === 0 && customEnabled === 0) {
      throw new ApiError('UPSTREAM_INVALID', '客户端至少需要一个可用模型（内置或自定义供应商）', 400)
    }

    // 生图模型可以是内置的，也可以是自定义供应商里的公开 ID
    if (imageModel) {
      const customIds = (providers ?? deps.settings.getProviders()).flatMap(provider =>
        provider.models.map(model => customModelId(provider.id, model.id)),
      )
      const accountIds = deps.accounts
        ? deps.accounts.availableModels().map(spec => spec.id)
        : []
      if (
        !catalogIds.includes(imageModel) &&
        !customIds.includes(imageModel) &&
        !accountIds.includes(imageModel) &&
        !findImageModel(imageModel)
      ) {
        throw new ApiError('UPSTREAM_INVALID', '未知的生图模型：' + imageModel, 400)
      }
    }

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
    if (providers !== undefined) {
      await deps.settings.setProviders(providers)
      request.log.info({ count: providers.length }, '自定义供应商已更新')
    }
    if (modelAliases !== undefined) {
      await deps.settings.setModelAliases(modelAliases)
      request.log.info({ count: Object.keys(modelAliases).length }, '模型显示名已更新')
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
      providers: deps.settings.getProviders(),
      modelAliases: deps.settings.getModelAliases(),
      accountImageModels: deps.accounts
        ? deps.accounts.availableModels().map(spec => ({
            id: spec.id,
            label: spec.label,
            accounts: deps.accounts!.countForModel(spec),
          }))
        : [],
    })
  })


  /**
   * 读取自定义供应商的模型列表（GET {baseUrl}/v1/models），
   * 测的是请求里带的地址与密钥，不写配置，方便先拉列表再勾选。
   */
  app.post('/api/admin/upstream/provider-models', async request => {
    requireAdmin(request)
    const body = (request.body ?? {}) as { baseUrl?: unknown; apiKey?: unknown }

    let baseUrl: string
    try {
      baseUrl = stripApiVersion(parseBaseUrl(body.baseUrl))
    } catch {
      return { ok: false, baseUrl: '', detail: '供应商地址无效，请填写完整的 http/https 地址', models: [] }
    }

    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)

    try {
      const response = await fetch(baseUrl + '/v1/models', {
        headers: {
          Accept: 'application/json',
          ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return {
          ok: false,
          baseUrl,
          detail: '上游返回 ' + response.status + (text ? '：' + text.slice(0, 160) : ''),
          models: [],
        }
      }

      const payload = (await response.json().catch(() => null)) as unknown
      const list = Array.isArray(payload)
        ? payload
        : payload && typeof payload === 'object'
          ? ((payload as Record<string, unknown>).data ??
            (payload as Record<string, unknown>).models ??
            [])
          : []

      const models: Array<{ id: string; ownedBy?: string }> = []
      const seen = new Set<string>()
      if (Array.isArray(list)) {
        for (const entry of list) {
          const id =
            typeof entry === 'string'
              ? entry.trim()
              : entry && typeof entry === 'object'
                ? String((entry as Record<string, unknown>).id ?? '').trim()
                : ''
          if (!id || seen.has(id)) continue
          seen.add(id)
          const ownedBy =
            entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).owned_by === 'string'
              ? (entry as Record<string, string>).owned_by
              : undefined
          models.push({ id, ...(ownedBy ? { ownedBy } : {}) })
        }
      }

      models.sort((a, b) => a.id.localeCompare(b.id))
      return { ok: true, baseUrl, detail: '', models }
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      return {
        ok: false,
        baseUrl,
        detail: name === 'AbortError' ? '请求超时，请检查地址或网络' : '无法连接供应商，请检查地址与密钥',
        models: [],
      }
    } finally {
      clearTimeout(timer)
    }
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
