/**
 * 客户端可见的生图模型清单。
 *
 * 两个来源：
 * 1. Magpie 网关实际返回的模型（沿用原来的白名单与勾选逻辑）；
 * 2. 后台添加的自定义供应商，每个模型用 `p:<供应商>:<模型>` 作为公开 ID，
 *    请求时再解析回供应商地址与上游模型名。
 *
 * 显示名统一在这里合并：内置模型可以单独改名，自定义模型用供应商里填的名字。
 */
import type { ProviderConfig, ProviderModelConfig, SettingsStore } from './settings-store.js'
import { ImageModelCatalog } from './image-model-catalog.js'
import type { GptAccountStore } from './accounts/gpt-account-store.js'

const imageModelCatalog = new ImageModelCatalog()

export interface ClientImageModel {
  id: string
  label: string
  /** magpie 或自定义供应商 id */
  provider: string
}

const CUSTOM_PREFIX = 'p:'

/** 公开 ID 里带上供应商，避免两个网关有同名模型时互相覆盖 */
export function customModelId(providerId: string, modelId: string): string {
  return `${CUSTOM_PREFIX}${providerId}:${modelId}`
}

export function parseCustomModelId(id: string): { providerId: string; modelId: string } | null {
  if (!id.startsWith(CUSTOM_PREFIX)) return null
  const rest = id.slice(CUSTOM_PREFIX.length)
  const sep = rest.indexOf(':')
  if (sep <= 0 || sep === rest.length - 1) return null
  const providerId = rest.slice(0, sep)
  const modelId = rest.slice(sep + 1)
  if (!providerId || !modelId) return null
  return { providerId, modelId }
}

export interface ClientModelList {
  models: ClientImageModel[]
  /** 只有内置模型的勾选状态；自定义模型由供应商里的 enabled 控制 */
  magpieCatalogIds: string[]
  aliases: Record<string, string>
}

export async function listClientImageModels(
  settings: SettingsStore,
  accounts?: GptAccountStore,
): Promise<ClientModelList> {
  const catalog = await imageModelCatalog.list(await settings.getBaseUrl())
  const magpieCatalogIds = catalog.map(model => model.id)
  const enabled = new Set(settings.getEnabledImageModels(magpieCatalogIds))
  const aliases = settings.getModelAliases()

  const models: ClientImageModel[] = catalog
    .filter(model => enabled.has(model.id))
    .map(model => ({
      id: model.id,
      label: aliases[model.id] || model.label,
      provider: 'magpie',
    }))

  for (const provider of settings.getProviders()) {
    if (provider.enabled === false) continue
    for (const model of provider.models) {
      if (model.enabled === false) continue
      models.push({
        id: customModelId(provider.id, model.id),
        label: model.label || model.id,
        provider: provider.id,
      })
    }
  }

  // 账号池模型：只有存在可用账号时才出现，导入/停用账号后立即生效
  if (accounts) {
    for (const spec of accounts.availableModels()) {
      models.push({ id: spec.id, label: spec.label, provider: 'gpt-accounts' })
    }
  }

  return { models, magpieCatalogIds, aliases }
}

/** 客户端传了自定义模型 ID 时，找回供应商与上游模型；找不到返回 null */
export function resolveCustomProviderModel(
  settings: SettingsStore,
  publicId: string,
): { provider: ProviderConfig; model: ProviderModelConfig } | null {
  const parsed = parseCustomModelId(publicId)
  if (!parsed) return null
  const provider = settings
    .getProviders()
    .find(item => item.id === parsed.providerId && item.enabled !== false)
  if (!provider) return null
  const model = provider.models.find(
    item => item.id === parsed.modelId && item.enabled !== false,
  )
  if (!model) return null
  return { provider, model }
}
