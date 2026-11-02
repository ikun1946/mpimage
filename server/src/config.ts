import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 优先加载 server/.env，其次项目根目录 .env
const here = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(here, '..', '.env') })
loadEnv({ path: resolve(here, '..', '..', '.env') })

export interface RatioSpec {
  id: string
  label: string
  shortLabel: string
  width: number
  height: number
  /**
   * 上游按该画幅输出的原生像素尺寸。
   * 实测同一提示词重复生成尺寸完全稳定，比例偏差 ≤ 0.06%，
   * 因此可直接交付原图，无需再缩放。
   */
  nativeWidth: number
  nativeHeight: number
  /**
   * 追加到提示词里的比例描述。
   * 实测：不传 size 参数、仅用文字描述比例时，上游返回图的宽高比偏差在 1% 以内；
   * 传 size 参数反而可能让构图严重走样（实测 16:9 偏差达 31%）。
   */
  promptHint: string
}

const ratios: RatioSpec[] = [
  {
    id: '1:1',
    label: '1 : 1 方形',
    shortLabel: '1 : 1',
    width: 1,
    height: 1,
    nativeWidth: 1254,
    nativeHeight: 1254,
    promptHint: '画面比例 1:1，正方形构图，方形画幅',
  },
  {
    id: '4:3',
    label: '4 : 3 横向',
    shortLabel: '4 : 3',
    width: 4,
    height: 3,
    nativeWidth: 1448,
    nativeHeight: 1086,
    promptHint: '画面比例 4:3，横向构图，宽幅画幅',
  },
  {
    id: '3:4',
    label: '3 : 4 纵向',
    shortLabel: '3 : 4',
    width: 3,
 height: 4,
    nativeWidth: 1086,
    nativeHeight: 1448,
    promptHint: '画面比例 3:4，纵向构图，竖幅画幅',
  },
  {
    id: '16:9',
    label: '16 : 9 宽银幕',
    shortLabel: '16 : 9',
    width: 16,
    height: 9,
    nativeWidth: 1672,
    nativeHeight: 941,
    promptHint: '画面比例 16:9，宽银幕横向构图，宽幅画幅',
  },
  {
    id: '9:16',
    label: '9 : 16 竖屏',
    shortLabel: '9 : 16',
    width: 9,
    height: 16,
    nativeWidth: 941,
    nativeHeight: 1672,
    promptHint: '画面比例 9:16，竖屏纵向构图，竖幅画幅',
  },
]

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function listFromEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name]
  if (!raw) return fallback
  const items = raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  return items.length ? items : fallback
}

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: intFromEnv('PORT', 8787),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  magpieBaseUrl: (process.env.MAGPIE_BASE_URL || 'http://127.0.0.1:3425').replace(/\/+$/, ''),
  imageModel: process.env.MAGPIE_IMAGE_MODEL || 'codex/gpt-image-2',
  /**
   * 同时打向 Magpie 的生图请求上限（1–8）。
   * 服务端控制台保存过 data/concurrency.json 时以文件为准；这里只是文件缺失时的默认值，
   * 前端并行数不会超过当前上限。
   */
  imageConcurrency: Math.min(Math.max(intFromEnv('IMAGE_CONCURRENCY', 5), 1), 8),
  requestTimeoutMs: intFromEnv('IMAGE_TIMEOUT_MS', 300000),
  maxPromptLength: intFromEnv('MAX_PROMPT_LENGTH', 12000),
  storageDir: process.env.STORAGE_DIR || '',
  styleLibraryPath: process.env.STYLE_LIBRARY_PATH || '',
  userDatabasePath: process.env.USER_DATABASE_PATH || '',
  usageDatabasePath: process.env.USAGE_DATABASE_PATH || '',
  projectDatabasePath: process.env.PROJECT_DATABASE_PATH || '',
  /** 流量/限流/额度这些运行期数据的目录；留空用 <项目根>/data */
  dataDir: process.env.DATA_DIR || '',
  /** 按天日志的目录；留空用 <项目根>/logs */
  logDir: process.env.LOG_DIR || '',
  /** 前端构建产物目录；留空用 <项目根>/web/dist */
  webDistDir: process.env.WEB_DIST_DIR || '',
  /** 会话签名密钥；留空则每次启动随机生成（会话令牌落盘，登录状态不受影响） */
  sessionSecret: process.env.SESSION_SECRET || '',
  /** 引导创建首个管理员的管理密钥；留空则禁用引导接口 */
  adminSetupKey: process.env.ADMIN_SETUP_KEY || '',
  /** 优雅退出令牌；留空则关闭 /api/shutdown 接口（桌面端/控制台会注入随机值） */
  shutdownToken: process.env.SHUTDOWN_TOKEN || '',
  /**
   * 桌面控制台的免登录令牌。桌面端每次启动随机生成、只注入给本机子进程，
   * 控制台窗口没有浏览器会话，靠它直接以管理员身份调管理接口。
   * 留空即完全关闭这条通道，只保留 cookie 登录。
   */
  desktopToken: process.env.DESKTOP_TOKEN || '',
  /** 当前应用版本；桌面端安装包里会注入，留空时从 server/package.json 读取 */
  appVersion: process.env.APP_VERSION || '',
  /** 更新检查的 GitHub 仓库（owner/repo） */
  updateRepo: process.env.UPDATE_REPO || 'ikun1946/mpimage',
  /** 自定义更新源地址；非空时优先于 GitHub，桌面端可指向自己的发布接口 */
  updateFeedUrl: process.env.UPDATE_FEED_URL || '',
  /** 访问 GitHub 私有/限流时的令牌；公开仓库留空即可 */
  updateToken: process.env.UPDATE_TOKEN || '',
  /** UPDATE_CHECK_DISABLED=1 时完全不联网查版本（离线环境用） */
  updateDisabled: process.env.UPDATE_CHECK_DISABLED === '1',
  corsOrigins: listFromEnv('CORS_ORIGINS', [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
  ]),
  ratios,
  defaultRatio: '1:1',
  defaultRoleRatio: '3:4',
  defaultSceneRatio: '16:9',
  defaultPropRatio: '1:1',
} as const

export function findRatio(id: unknown): RatioSpec | undefined {
  if (typeof id !== 'string') return undefined
  return ratios.find(ratio => ratio.id === id)
}
