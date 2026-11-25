#!/usr/bin/env node
/**
 * 把面容工坊的静态数据整理成画境服务端种子。
 *
 * 源项目只用于生成种子，运行时不依赖它：
 *   node scripts/build-face-catalog-seed.mjs [face-studio目录]
 *
 * 参考图仍由 tools/import 那套源文件生成；本脚本只负责目录 JSON 和路径映射。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(process.argv[2] || join(root, '..', 'face-studio'))
const featuresFile = join(source, 'src', 'data', 'features.json')
const manifestFile = join(source, 'src', 'data', 'reference-manifest.json')
const outFile = join(root, 'server', 'assets', 'face', 'catalog-seed.json')
const genderAffinityFile = join(root, 'server', 'assets', 'face', 'gender-affinity.json')
const extensionDirectory = join(root, 'server', 'assets', 'face', 'extensions')

const data = JSON.parse(readFileSync(featuresFile, 'utf8'))
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
const genderAffinity = JSON.parse(readFileSync(genderAffinityFile, 'utf8'))
const genderLabels = new Set(['male', 'female', 'neutral'])

for (const [id, labels] of Object.entries(genderAffinity.items || {})) {
  if (!Array.isArray(labels) || labels.length === 0 || labels.some(label => !genderLabels.has(label))) {
    throw new Error(`卡片 ${id} 的 gender_affinity 无效`)
  }
}

const references = Object.fromEntries(
  Object.entries(manifest).map(([id, url]) => [
    id,
    url.replace(/^\/assets\/references\//, '/face-assets/references/').replace(/\.(png|jpe?g)$/i, '.webp'),
  ]),
)

const groups = data.groups.map(group => ({
  ...group,
  visible: group.visible !== false,
  categories: [...(group.categories || [])],
}))

const normalizeItem = (item, category) => {
  const gender = Array.isArray(item.gender_affinity) && item.gender_affinity.length
    ? item.gender_affinity
    : genderAffinity.items[item.id] || genderAffinity.default || ['neutral']
  if (gender.some(label => !genderLabels.has(label))) {
    throw new Error(`卡片 ${item.id} 的 gender_affinity 无效`)
  }
  return {
    ...item,
    category: category.key,
    source_section: item.source_section || category.source_section || '',
    gender_affinity: gender,
    select_mode: category.select_mode,
    max_select: category.max_select,
    strength_supported: category.strength_supported,
    visible: item.visible !== false,
    is_custom: item.is_custom === true,
    reference_image: '',
    reference_status: references[item.id] ? 'ready' : 'pending',
  }
}

const categories = data.categories.map(category => ({
  ...category,
  visible: category.visible !== false,
  items: category.items.map(item => normalizeItem(item, category)),
}))

const conflictRules = JSON.parse(JSON.stringify(data.conflict_rules || []))
const extensionSources = []
let extensionVersion = ''
if (existsSync(extensionDirectory)) {
  const files = readdirSync(extensionDirectory)
    .filter(name => name.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right))
  for (const file of files) {
    const extension = JSON.parse(readFileSync(join(extensionDirectory, file), 'utf8'))
    extensionSources.push(extension.generated_from || file)
    if (typeof extension.version === 'string' && extension.version) {
      extensionVersion = extension.version
    }
    const anchors = new Map()
    for (const sourceCategory of extension.categories || []) {
      if (categories.some(category => category.key === sourceCategory.key)) {
        throw new Error(`扩展分类重复：${sourceCategory.key}`)
      }
      const category = {
        ...sourceCategory,
        visible: sourceCategory.visible !== false,
        items: [],
      }
      category.items = (sourceCategory.items || []).map(item => normalizeItem(item, category))
      category.count = category.items.length
      categories.push(category)
      const group = groups.find(entry => entry.key === category.group)
      if (!group) throw new Error(`扩展分类 ${category.key} 引用了不存在的分组：${category.group}`)
      if (!group.categories.includes(category.key)) {
        const anchor = anchors.get(group.key) ?? extension.category_order_after
        const anchorIndex = anchor ? group.categories.indexOf(anchor) : -1
        if (anchorIndex >= 0) group.categories.splice(anchorIndex + 1, 0, category.key)
        else group.categories.push(category.key)
      }
      anchors.set(group.key, category.key)
    }
    for (const rule of extension.conflict_rules || []) {
      conflictRules.push(rule)
    }
  }
}

const itemMap = new Map()
for (const category of categories) {
  category.count = category.items.length
  const names = new Set()
  for (const item of category.items) {
    if (itemMap.has(item.id)) throw new Error(`卡片 ID 重复：${item.id}`)
    if (names.has(item.name_zh)) throw new Error(`分类 ${category.key} 中文名重复：${item.name_zh}`)
    names.add(item.name_zh)
    itemMap.set(item.id, { category: category.key, item })
  }
}

const ruleKeys = new Set()
for (const rule of conflictRules) {
  const left = itemMap.get(rule.left)
  const right = itemMap.get(rule.right)
  if (!left || left.category !== rule.left_category) {
    throw new Error(`冲突规则左侧卡片不存在或分类不符：${rule.left}`)
  }
  if (!right || right.category !== rule.right_category) {
    throw new Error(`冲突规则右侧卡片不存在或分类不符：${rule.right}`)
  }
  const key = [rule.left_category, rule.left, rule.right_category, rule.right].join('|')
  if (ruleKeys.has(key)) throw new Error(`冲突规则重复：${key}`)
  ruleKeys.add(key)
}

const total = categories.reduce((sum, category) => sum + category.items.length, 0)
const catalog = {
  schemaVersion: 2,
  revision: 0,
  updatedAt: new Date().toISOString(),
  version: extensionVersion || data.version,
  generated_from: [data.generated_from, ...extensionSources].filter(Boolean).join(' + '),
  total,
  groups,
  categories,
  conflict_rules: conflictRules,
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
