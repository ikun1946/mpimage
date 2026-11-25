/**
 * 捏脸目录服务端测试：种子数量、可见性、保存、备份、恢复与结构校验。
 * 运行：npm run test:face
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FaceCatalogError,
  FaceCatalogStore,
} from '../server/dist/app/products/face/catalog-store.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEED = join(ROOT, 'server', 'assets', 'face', 'catalog-seed.json')
const EXTENSION = join(ROOT, 'server', 'assets', 'face', 'extensions', 'hair-v1.1.json')
const dataDir = await mkdtemp(join(tmpdir(), 'huajing-face-catalog-'))

try {
  const extension = JSON.parse(await readFile(EXTENSION, 'utf8'))
  const extensionItems = extension.categories.flatMap(category => category.items)
  assert.equal(extension.categories.length, 10)
  assert.equal(extensionItems.length, 108)
  assert.equal(new Set(extensionItems.map(item => item.id)).size, 108)

  const store = new FaceCatalogStore(dataDir, SEED)
  await store.init()

  const initial = store.getMeta()
  assert.equal(initial.total, 592)
  assert.equal(initial.categories, 56)
  assert.equal(initial.presets, 14)
  assert.equal(initial.references, 16)
  assert.equal(store.getPublic().total, 592)
  assert.equal(store.getAdmin().schemaVersion, 2)
  assert.equal(store.getAdmin().version, '1.1')
  assert.equal(
    store.getAdmin().groups.find(group => group.key === 'hair').categories.length,
    21,
  )

  const base = store.getAdmin()
  const firstCategory = base.categories[0]
  const firstCard = firstCategory.items[0]
  const hiddenCard = base.categories
    .flatMap(category => category.items)
    .find(item => item.id !== firstCard.id)
  assert.ok(firstCategory && firstCard && hiddenCard)
  const genderCounts = base.categories
    .flatMap(category => category.items)
    .flatMap(item => item.gender_affinity)
    .reduce((counts, label) => ({ ...counts, [label]: (counts[label] || 0) + 1 }), {})
  assert.deepEqual(genderCounts, { neutral: 422, female: 132, male: 38 })

  firstCategory.visible = false
  hiddenCard.visible = false
  const saved = await store.save(base, base.revision)
  assert.equal(saved.revision, base.revision + 1)

  const hiddenSnapshot = store.getPublic()
  assert.equal(
    hiddenSnapshot.categories.some(category => category.key === firstCategory.key),
    false,
    '隐藏维度不应出现在客户端目录',
  )
  assert.equal(
    hiddenSnapshot.categories.flatMap(category => category.items).some(item => item.id === hiddenCard.id),
    false,
    '隐藏卡片不应出现在客户端目录',
  )
  assert.ok(hiddenSnapshot.total < 592)

  const backupDir = join(dataDir, 'face-card-backups')
  assert.equal(existsSync(backupDir), true, '保存后应生成备份目录')
  assert.ok((await readdir(backupDir)).some(name => name.endsWith('.json')))

  const restored = await store.restoreLast()
  assert.ok(restored.revision > saved.revision)
  assert.equal(store.getPublic().total, 592, '恢复上一版后应重新看到全部卡片')

  const invalid = store.getAdmin()
  invalid.references[invalid.categories[0].items[0].id] = 'https://example.com/not-allowed.png'
  await assert.rejects(
    () => store.save(invalid, invalid.revision),
    error => error instanceof FaceCatalogError && error.status === 422,
    '远程参考图地址应被拒绝',
  )

  const conflicted = store.getAdmin()
  await assert.rejects(
    () => store.save(conflicted, conflicted.revision - 1),
    error => error instanceof FaceCatalogError && error.status === 409,
    '旧 revision 保存应返回冲突',
  )

  const invalidGender = store.getAdmin()
  invalidGender.categories[0].items[0].gender_affinity = ['unknown']
  await assert.rejects(
    () => store.save(invalidGender, invalidGender.revision),
    error => error instanceof FaceCatalogError && error.status === 422,
    '未知性别适配标签应被拒绝',
  )

  const legacyDir = join(dataDir, 'legacy')
  await mkdir(legacyDir, { recursive: true })
  const legacy = JSON.parse(await readFile(SEED, 'utf8'))
  legacy.schemaVersion = 1
  legacy.revision = 7
  legacy.version = '1.0'
  const extensionCategoryKeys = new Set(extension.categories.map(category => category.key))
  const extensionIds = new Set(extensionItems.map(item => item.id))
  legacy.categories = legacy.categories.filter(category => !extensionCategoryKeys.has(category.key))
  const legacyHairGroup = legacy.groups.find(group => group.key === 'hair')
  legacyHairGroup.categories = legacyHairGroup.categories.filter(key => !extensionCategoryKeys.has(key))
  legacy.conflict_rules = legacy.conflict_rules.filter(rule =>
    !extensionIds.has(rule.left) && !extensionIds.has(rule.right))
  for (const category of legacy.categories) {
    for (const item of category.items) delete item.gender_affinity
  }
  legacy.categories.find(category => category.key === 'face_shape').items
    .find(item => item.id === 'face_oval').gender_affinity = ['female']
  legacy.categories.find(category => category.key === 'face_shape').items
    .find(item => item.id === 'face_square').name_zh = '管理员改过的方脸'
  legacy.categories.find(category => category.key === 'face_shape').items
    .find(item => item.id === 'face_square').visible = false
  await writeFile(join(legacyDir, 'face-cards.json'), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')
  const migratedStore = new FaceCatalogStore(legacyDir, SEED)
  await migratedStore.init()
  const migrated = migratedStore.getAdmin()
  const migratedItems = migrated.categories.flatMap(category => category.items)
  assert.equal(migrated.schemaVersion, 2)
  assert.equal(migrated.revision, 8)
  assert.equal(migrated.version, '1.1')
  assert.equal(migrated.total, 592)
  assert.equal(migrated.categories.length, 56)
  assert.deepEqual(migratedItems.find(item => item.id === 'face_oval').gender_affinity, ['female'])
  assert.deepEqual(migratedItems.find(item => item.id === 'face_square').gender_affinity, ['male'])
  assert.equal(migratedItems.find(item => item.id === 'face_square').name_zh, '管理员改过的方脸')
  assert.equal(migratedItems.find(item => item.id === 'face_square').visible, false)
  assert.ok(migratedItems.find(item => item.id === 'hair_male_fade'))
  assert.ok(migrated.groups.find(group => group.key === 'hair').categories.includes('hair_male_modern'))
  assert.ok(migrated.conflict_rules.some(rule => rule.left === 'hair_male_buzz_cut'))

  const reset = await store.reset()
  assert.equal(store.getPublic().total, 592)
  assert.ok(reset.revision > restored.revision)

  console.log('✓ 种子目录：592 张卡片 / 56 个维度 / 14 套预设 / 16 张参考图')
  console.log('✓ 发型扩展：10 个新分类、108 张新卡片，ID 和分类计数正确')
  console.log('✓ 公共服务目录会过滤隐藏维度和隐藏卡片')
  console.log('✓ 保存会生成备份，并可恢复上一版')
  console.log('✓ 旧目录会补齐发型扩展和性别适配标签，管理员已有修改不被覆盖')
  console.log('✓ 非法参考图或性别标签返回 422，旧 revision 返回 409')
  console.log('✓ 恢复默认目录正常')
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
