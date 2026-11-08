/**
 * 运行期设置的持久化（<dataDir>/settings.json）。
 * 沿用老控制台的字段名 magpieBaseUrl，升级后后台保存过的上游地址继续生效；
 * 文件不存在时全部回落到环境变量。
 * 写入同样先落 .tmp 再 rename 原子替换，并排成一条链，避免并发保存互相覆盖。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { config } from '../config.js'

interface SettingsFile {
  magpieBaseUrl?: unknown
  magpieTextModel?: unknown
  magpieImageModel?: unknown
  /** 客户端可选生图模型 id 列表；缺省表示全部可用 */
  magpieEnabledImageModels?: unknown
}

export class SettingsStore {
  private readonly file: string
  private cache: SettingsFile = {}
  private pending: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string) {
    this.file = join(dataDir, 'settings.json')
  }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as SettingsFile | null
      this.cache = parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      // 首次运行没有文件，或文件损坏：全部回落到环境变量，不阻断服务启动
      this.cache = {}
    }
  }

  /** settings.json 里的地址优先，其次是 MAGPIE_BASE_URL 环境变量 */
  async getBaseUrl(): Promise<string> {
    const stored = this.cache.magpieBaseUrl
    if (typeof stored === 'string' && stored.trim()) return trimTrailingSlash(stored.trim())
    return config.magpieBaseUrl
  }

  /** 后台界面填的是覆写值，空串表示跟随环境变量（MAGPIE_IMAGE_MODEL） */
  getImageModelOverride(): string {
    const stored = this.cache.magpieImageModel
    return typeof stored === 'string' ? stored.trim() : ''
  }

  /** 生图模型：后台保存过就用保存值，否则用 MAGPIE_IMAGE_MODEL */
  getImageModel(): string {
    const override = this.getImageModelOverride()
    if (override) return override
    return config.imageModel
  }

  isImageModelFromSettings(): boolean {
    const stored = this.cache.magpieImageModel
    return typeof stored === 'string' && stored.trim().length > 0
  }

  /**
   * 客户端下拉里能看到的生图模型。
   * 文件里没有配置、或配置成了空数组时，都回落到全部可用模型，
   * 避免一次误写让客户端一个模型都选不了。
   */
  getEnabledImageModels(): string[] {
    const all = config.imageModels.map(model => model.id)
    const stored = this.cache.magpieEnabledImageModels
    if (!Array.isArray(stored)) return all
    const picked = stored.filter((id): id is string => typeof id === 'string' && all.includes(id))
    return picked.length ? picked : all
  }

  /** 客户端没指定模型时实际使用的模型：默认模型可见就用它，否则用第一个可见模型 */
  getClientImageModel(): string {
    const enabled = this.getEnabledImageModels()
    const configured = this.getImageModel()
    return enabled.includes(configured) ? configured : (enabled[0] || configured)
  }

  isEnabledImageModelsFromSettings(): boolean {
    const stored = this.cache.magpieEnabledImageModels
    return Array.isArray(stored) && stored.length > 0
  }

  /** 后台界面填的是覆写值，空串表示跟随环境变量，控制台清空输入框即复位 */
  getTextModelOverride(): string {
    const stored = this.cache.magpieTextModel
    return typeof stored === 'string' ? stored.trim() : ''
  }

  /** 提示词优化的对话模型：后台保存过就用保存值，否则用 MAGPIE_TEXT_MODEL */
  async getTextModel(): Promise<string> {
    const override = this.getTextModelOverride()
    if (override) return override
    return config.textModel
  }

  /** 后台界面据此提示「地址来自后台设置」还是「来自环境变量」 */
  isFromSettings(): boolean {
    const stored = this.cache.magpieBaseUrl
    return typeof stored === 'string' && stored.trim().length > 0
  }

  isTextModelFromSettings(): boolean {
    const stored = this.cache.magpieTextModel
    return typeof stored === 'string' && stored.trim().length > 0
  }

  async setBaseUrl(url: string): Promise<string> {
    const baseUrl = trimTrailingSlash(url.trim())
    await this.write({ magpieBaseUrl: baseUrl })
    return baseUrl
  }

  async setTextModel(model: string): Promise<string> {
    const textModel = model.trim()
    await this.write({ magpieTextModel: textModel })
    return textModel
  }

  async setImageModel(model: string): Promise<string> {
    const imageModel = model.trim()
    await this.write({ magpieImageModel: imageModel })
    return imageModel
  }

  async setEnabledImageModels(ids: string[]): Promise<string[]> {
    const enabled = ids.map(id => id.trim()).filter(Boolean)
    await this.write({ magpieEnabledImageModels: enabled })
    return enabled
  }

  /**
   * 所有写盘都走这条链：前一次写完（或失败）才轮到下一次，
   * 每次都以最新的 cache 为底合并，避免两个设置互相覆盖。
   */
  private write(patch: SettingsFile): Promise<void> {
    const run = async () => {
      const next: SettingsFile = { ...this.cache, ...patch }
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
      await rename(temp, this.file)
      this.cache = next
    }
    this.pending = this.pending.then(run, run)
    return this.pending as Promise<void>
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
