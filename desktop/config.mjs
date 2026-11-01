import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 桌面端的配置：<数据根>/config.env。
 * 服务端仍然按它自己的 .env 逻辑读环境变量，这里只负责把值**注入给子进程**，
 * 所以打包后安装目录里不需要、也不应该放 .env。
 */
const DEFAULTS = {
  HOST: '0.0.0.0',
  PORT: '8787',
  MAGPIE_BASE_URL: 'http://127.0.0.1:3425',
  MAGPIE_IMAGE_MODEL: 'codex/gpt-image-2',
  IMAGE_TIMEOUT_MS: '300000',
  MAX_PROMPT_LENGTH: '12000',
  // 同时打向上游的生图请求上限；批量页的「并行数」不会超过它
  IMAGE_CONCURRENCY: '5',
  PUBLIC_BASE_URL: '',
  // 更新下载连接数：1 强制单流，2/4/6 强制该段数，auto 或其它值按探测速率自适应
  UPDATE_DOWNLOAD_CONNECTIONS: 'auto',
  // 更新下载镜像前缀（默认空 = 直连）：只在用户自己填时才把地址拼到原始下载链接前
  UPDATE_DOWNLOAD_MIRROR: '',
  LOG_LEVEL: 'info',
  CORS_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173',
}

export function configPath(root) {
  return join(root, 'config.env')
}

function parseEnv(text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function serialize(values) {
  const lines = [
    '# 画境桌面端配置',
    '# 改完需要重启应用才生效；密码类字段只在本机保存',
    '',
  ]
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue
    lines.push(`${key}=${value}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * 读取配置；缺省项补齐并写回。
 * SESSION_SECRET 持久化（重启后不用重新登录），ADMIN_SETUP_KEY 持久化
 * （首次建管理员时要用，之后服务端会自动忽略它）。
 */
export function loadConfig(root) {
  const file = configPath(root)
  const saved = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
  const merged = { ...DEFAULTS, ...saved }

  if (!merged.SESSION_SECRET) merged.SESSION_SECRET = randomBytes(32).toString('hex')
  if (!merged.ADMIN_SETUP_KEY) merged.ADMIN_SETUP_KEY = randomBytes(10).toString('hex').toUpperCase()

  if (!existsSync(file) || !saved.SESSION_SECRET || !saved.ADMIN_SETUP_KEY) {
    writeFileSync(file, serialize(merged), 'utf8')
  }
  return merged
}

export function saveConfig(root, values) {
  writeFileSync(configPath(root), serialize(values), 'utf8')
}
