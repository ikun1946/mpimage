/**
 * 捏脸目录服务端测试：种子数量、可见性、保存、备份、恢复与结构校验。
 * 运行：npm run test:face
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FaceCatalogError,
  FaceCatalogStore,
} from '../server/dist/app/products/face/catalog-store.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEED = join(ROOT, 'server', 'assets', 'face', 'catalog-seed.json')
const dataDir = await mkdtemp(join(tmpdir(), 'huajing-face-catalog-'))

try {
  const store = new FaceCatalogStore(dataDir, SEED)
  await store.init()

  const initial = store.getMeta()
  assert.equal(initial.total, 484)
  assert.equal(initial.categories, 46)
  assert.equal(initial.presets, 14)
  assert.equal(initial.references, 16)
  assert.equal(store.getPublic().total, 484)

  const base = store.getAdmin()
  const firstCategory = base.categories[0]
  const firstCard = firstCategory.items[0]
  const hiddenCard = base.categories
    .flatMap(category => category.items)
    .find(item => item.id !== firstCard.id)
  assert.ok(firstCategory && firstCard && hiddenCard)

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
  assert.ok(hiddenSnapshot.total < 484)

  const backupDir = join(dataDir, 'face-card-backups')
  assert.equal(existsSync(backupDir), true, '保存后应生成备份目录')
  assert.ok((await readdir(backupDir)).some(name => name.endsWith('.json')))

  const restored = await store.restoreLast()
  assert.ok(restored.revision > saved.revision)
  assert.equal(store.getPublic().total, 484, '恢复上一版后应重新看到全部卡片')

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

  const reset = await store.reset()
  assert.equal(store.getPublic().total, 484)
  assert.ok(reset.revision > restored.revision)

  console.log('✓ 种子目录：484 张卡片 / 46 个维度 / 14 套预设 / 16 张参考图')
  console.log('✓ 公共服务目录会过滤隐藏维度和隐藏卡片')
  console.log('✓ 保存会生成备份，并可恢复上一版')
  console.log('✓ 非法参考图路径返回 422，旧 revision 返回 409')
  console.log('✓ 恢复默认目录正常')
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
