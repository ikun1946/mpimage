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

  getModel(): string {
    return config.imageModel
  }

  /** 后台界面据此提示「地址来自后台设置」还是「来自环境变量」 */
  isFromSettings(): boolean {
    const stored = this.cache.magpieBaseUrl
    return typeof stored === 'string' && stored.trim().length > 0
  }

  async setBaseUrl(url: string): Promise<string> {
    const baseUrl = trimTrailingSlash(url.trim())
    const run = async () => {
      const next: SettingsFile = { ...this.cache, magpieBaseUrl: baseUrl }
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
      await rename(temp, this.file)
      this.cache = next
      return baseUrl
    }
    this.pending = this.pending.then(run, run)
    return this.pending as Promise<string>
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
