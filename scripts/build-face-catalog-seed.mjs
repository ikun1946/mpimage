#!/usr/bin/env node
/**
 * 把面容工坊的静态数据整理成画境服务端种子。
 *
 * 源项目只用于生成种子，运行时不依赖它：
 *   node scripts/build-face-catalog-seed.mjs [face-studio目录]
 *
 * 参考图仍由 tools/import 那套源文件生成；本脚本只负责目录 JSON 和路径映射。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(process.argv[2] || join(root, '..', 'face-studio'))
const featuresFile = join(source, 'src', 'data', 'features.json')
const manifestFile = join(source, 'src', 'data', 'reference-manifest.json')
const outFile = join(root, 'server', 'assets', 'face', 'catalog-seed.json')

const data = JSON.parse(readFileSync(featuresFile, 'utf8'))
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))

const references = Object.fromEntries(
  Object.entries(manifest).map(([id, url]) => [
    id,
    url.replace(/^\/assets\/references\//, '/face-assets/references/').replace(/\.(png|jpe?g)$/i, '.webp'),
  ]),
)

const catalog = {
  schemaVersion: 1,
  revision: 0,
  updatedAt: new Date().toISOString(),
  version: data.version,
  generated_from: data.generated_from,
  total: data.total,
  groups: data.groups.map(group => ({ ...group, visible: group.visible !== false })),
  categories: data.categories.map(category => ({
    ...category,
    visible: category.visible !== false,
    items: category.items.map(item => ({
      ...item,
      visible: item.visible !== false,
      reference_image: '',
      reference_status: references[item.id] ? 'ready' : 'pending',
    })),
  })),
  conflict_rules: data.conflict_rules,
  compatible_notes: data.compatible_notes,
  visual_styles: data.visual_styles,
  negatives: data.negatives,
  negative_triggers: data.negative_triggers,
  presets: data.presets.map(preset => ({ ...preset, visible: preset.visible !== false })),
  references,
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
console.log(`已生成 ${outFile}`)
console.log(`特征 ${catalog.total}，维度 ${catalog.categories.length}，预设 ${catalog.presets.length}，参考图 ${Object.keys(references).length}`)
