import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 项目的根目录（server 的上一级）。
 * src/app/platform 与 dist/app/platform 都是四层到根，开发与打包后一致。
 */
const here = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = resolve(here, '..', '..', '..', '..')

/** 环境变量里的路径：绝对路径直接用，相对路径一律按项目根解析 */
export function resolveProjectPath(value: string): string {
  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value)
}

export function projectPath(...parts: string[]): string {
  return join(PROJECT_ROOT, ...parts)
}
