#!/usr/bin/env node
/**
 * 把服务端随包资产复制进 server/dist。
 *
 * 这样 Electron 打包时只复制 server/dist，也能把内置捏脸目录和参考图一起带走；
 * 单独部署 server/dist 的服务端同样自带这些图片。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'server', 'assets')
const target = join(root, 'server', 'dist', 'assets')

if (!existsSync(source)) {
  console.error(`缺少服务端资产目录：${source}`)
  process.exit(1)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(dirname(target), { recursive: true })
cpSync(source, target, { recursive: true })
console.log(`已复制服务端资产 → ${target}`)
