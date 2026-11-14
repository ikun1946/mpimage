#!/usr/bin/env node
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 打包后清理 release/ 里的旧安装包。
 *
 * electron-builder 每打一次都留一套 setup + portable + blockmap（一套约 160MB），
 * 攒几版就是好几个 GB。默认只保留最新一版，旧的直接删掉；
 * 需要留几版做回归就用 `node scripts/prune-release.mjs 3`。
 */

const keep = Math.max(1, Number(process.argv[2]) || 1)
const dir = resolve(process.cwd(), 'release')

function parseVersion(name) {
  const match = /^huajing-(?:setup|portable)-(\d+)\.(\d+)\.(\d+)\.exe(?:\.blockmap)?$/.exec(name)
  if (!match) return null
  return match.slice(1).map(Number)
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return b[i] - a[i]
  }
  return 0
}

let entries = []
try {
  entries = readdirSync(dir)
} catch {
  console.log('release/ 不存在，跳过清理')
  process.exit(0)
}

const groups = new Map()
for (const name of entries) {
  const version = parseVersion(name)
  if (!version) continue
  const key = version.join('.')
  if (!groups.has(key)) groups.set(key, { version, files: [] })
  groups.get(key).files.push(name)
}

const ordered = [...groups.values()].sort((a, b) => compareVersion(a.version, b.version))
const kept = new Set(ordered.slice(0, keep).map(group => group.version.join('.')))

let removed = 0
let bytes = 0
for (const group of ordered) {
  const key = group.version.join('.')
  if (kept.has(key)) continue
  for (const name of group.files) {
    const full = join(dir, name)
    try {
      bytes += statSync(full).size
      rmSync(full, { force: true })
      removed += 1
    } catch (error) {
      console.warn(`删除失败 ${name}: ${error.message}`)
    }
  }
}

const mb = (bytes / 1024 / 1024).toFixed(0)
console.log(
  removed > 0
    ? `已清理 ${removed} 个旧安装包，释放 ${mb} MB（保留最近 ${keep} 版）`
    : `没有需要清理的旧安装包（保留最近 ${keep} 版）`,
)
