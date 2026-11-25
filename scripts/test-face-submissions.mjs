/**
 * 社区捏脸内容审核测试：提交、本人可见、管理员修改发布、驳回重提和并发入口回归。
 * 运行：node scripts/test-face-submissions.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PASSWORD = 'face-review-password'
const SHUTDOWN_TOKEN = 'face-review-shutdown'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const DATA_URL = `data:image/png;base64,${PNG}`

const runDir = await mkdtemp(join(tmpdir(), 'huajing-face-submissions-'))
const dataDir = join(runDir, 'data')
const storageDir = join(runDir, 'generated')
await mkdir(dataDir, { recursive: true })
await mkdir(storageDir, { recursive: true })

const port = await freePort()
const base = `http://127.0.0.1:${port}`
const app = spawn(process.execPath, [join(ROOT, 'server', 'dist', 'main.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    MAGPIE_BASE_URL: 'http://127.0.0.1:3425',
    ADMIN_SETUP_KEY: 'face-review-setup',
    USER_DATABASE_PATH: join(runDir, 'users.json'),
    USAGE_DATABASE_PATH: join(runDir, 'usage.json'),
    PROJECT_DATABASE_PATH: join(runDir, 'projects.json'),
    STORAGE_DIR: storageDir,
    DATA_DIR: dataDir,
    LOG_DIR: join(runDir, 'logs'),
    STYLE_LIBRARY_PATH: join(runDir, 'styles'),
    UPDATE_CHECK_DISABLED: '1',
    IMAGE_CONCURRENCY: '1',
    SESSION_SECRET: 'face-review-session',
    SHUTDOWN_TOKEN,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverOutput = ''
app.stdout.on('data', chunk => { serverOutput += chunk })
app.stderr.on('data', chunk => { serverOutput += chunk })

class Client {
  cookies = new Map()

  cookieHeader() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ')
  }

  async request(path, { method = 'GET', body, headers = {} } = {}) {
    const finalHeaders = { ...headers }
    if (body !== undefined) finalHeaders['content-type'] = 'application/json'
    if (this.cookies.size) finalHeaders.cookie = this.cookieHeader()
    const response = await fetch(`${base}${path}`, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)
    for (const cookie of setCookies) {
      const pair = String(cookie).split(';')[0]
      const separator = pair.indexOf('=')
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
    }
    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    return { status: response.status, data, headers: response.headers }
  }
}

function cardPayload(id, category, name) {
  return {
    id,
    category,
    name_zh: name,
    name_en: `Community ${id}`,
    definition: '社区提交的轮廓与五官组合。',
    prompt_zh: '窄长脸型，五官清晰，正面自然光。',
    prompt_en: 'Narrow long face, clear features, natural frontal light.',
    aliases: [name],
    mood_tags: ['社区'],
    visual_features: ['窄长脸', '清晰五官'],
    compatibility: [],
    conflicts: [],
    gender_affinity: ['male', 'neutral'],
    sort_order: 9999,
    visible: true,
    is_custom: true,
  }
}

try {
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/api/health`)).ok
    } catch {
      return false
    }
  }, 20_000)

  const admin = new Client()
  await admin.request('/api/auth/setup', {
    method: 'POST',
    body: {
      setupKey: 'face-review-setup',
      username: 'admin',
      displayName: '审核管理员',
      password: PASSWORD,
    },
  })
  let response = await admin.request('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: PASSWORD },
  })
  assert.equal(response.status, 200)

  async function createUser(username, displayName) {
    response = await admin.request('/api/auth/register', {
      method: 'POST',
      body: { username, displayName, password: PASSWORD },
    })
    assert.equal(response.status, 200)
    const registrations = await admin.request('/api/admin/registrations')
    const pending = registrations.data.registrations.find(item => item.username === username)
    assert.ok(pending, `找不到 ${username} 的注册申请`)
    response = await admin.request(`/api/admin/registrations/${pending.id}/approve`, { method: 'POST' })
    assert.equal(response.status, 200)
    const client = new Client()
    response = await client.request('/api/auth/login', {
      method: 'POST',
      body: { username, password: PASSWORD },
    })
    assert.equal(response.status, 200)
    return client
  }

  const userA = await createUser('review_a', '提交用户 A')
  const userB = await createUser('review_b', '普通用户 B')

  response = await new Client().request('/api/face/submissions', {
    method: 'POST',
    body: {
      kind: 'card',
      category: 'face_shape',
      targetId: 'anonymous_card',
      card: cardPayload('anonymous_card', 'face_shape', '匿名卡片'),
    },
  })
  assert.equal(response.status, 401, '未登录不能提交审核')

  const initialCatalog = await userA.request('/api/face/catalog')
  assert.equal(initialCatalog.status, 200)
  const initialRevision = initialCatalog.data.meta.revision

  const cardId = `community_test_${Date.now().toString(36)}`
  response = await userA.request('/api/face/submissions', {
    method: 'POST',
    body: {
      kind: 'card',
      category: 'face_shape',
      targetId: cardId,
      card: cardPayload(cardId, 'face_shape', '社区测试脸型'),
      dataUrl: DATA_URL,
    },
  })
  assert.equal(response.status, 201)
  const cardSubmission = response.data.submission
  assert.equal(cardSubmission.status, 'pending')
  assert.ok(cardSubmission.imagePath.startsWith('参考图-待审核/'))
  assert.equal(cardSubmission.imageWidth, 1)
  assert.equal(cardSubmission.imageHeight, 1)
  await access(join(storageDir, cardSubmission.imagePath))

  let mine = await userA.request('/api/face/submissions/mine')
  assert.equal(mine.data.submissions.length, 1)
  assert.equal(mine.data.submissions[0].id, cardSubmission.id)
  let otherMine = await userB.request('/api/face/submissions/mine')
  assert.equal(otherMine.data.submissions.length, 0, '别人的提交不能出现在自己的列表')

  const removeImageId = `community_remove_image_${Date.now().toString(36)}`
  response = await userA.request('/api/face/submissions', {
    method: 'POST',
    body: {
      kind: 'card',
      category: 'face_shape',
      targetId: removeImageId,
      card: cardPayload(removeImageId, 'face_shape', '移除图片测试卡片'),
      dataUrl: DATA_URL,
    },
  })
  assert.equal(response.status, 201)
  const imageSubmissionId = response.data.submission.id
  assert.ok(response.data.submission.imagePath)
  response = await userA.request('/api/face/submissions', {
    method: 'POST',
    body: {
      kind: 'card',
      category: 'face_shape',
      targetId: removeImageId,
      card: cardPayload(removeImageId, 'face_shape', '移除图片测试卡片'),
      removeImage: true,
    },
  })
  assert.equal(response.status, 201)
  assert.equal(response.data.submission.id, imageSubmissionId, '同一卡片重复提交应复用记录')
  assert.equal(response.data.submission.imagePath, '')
  await userA.request(`/api/face/submissions/${imageSubmissionId}`, { method: 'DELETE' })

  const beforePublish = await userB.request('/api/face/catalog')
  assert.equal(
    beforePublish.data.catalog.categories.flatMap(category => category.items).some(item => item.id === cardId),
    false,
    '待审核卡片不能提前出现在公共目录',
  )
  assert.equal((await userB.request('/api/admin/face/submissions')).status, 403)
  assert.equal((await userB.request(`/api/admin/face/submissions/${cardSubmission.id}/approve`, { method: 'POST' })).status, 403)

  response = await admin.request(`/api/admin/face/submissions/${cardSubmission.id}`, {
    method: 'PATCH',
    body: {
      card: {
        ...cardPayload(cardId, 'face_shape', '社区测试脸型·审核修改'),
        prompt_zh: '管理员修改后的窄长脸提示词。',
      },
      reviewNote: '审核时统一了名称和提示词',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.data.submission.card.name_zh, '社区测试脸型·审核修改')

  response = await admin.request(`/api/admin/face/submissions/${cardSubmission.id}/approve`, { method: 'POST' })
  assert.equal(response.status, 200)
  const publishedCard = response.data.catalog.categories
    .flatMap(category => category.items)
    .find(item => item.id === cardId)
  assert.ok(publishedCard, '发布后卡片应进入公共目录')
  assert.equal(publishedCard.name_zh, '社区测试脸型·审核修改')
  assert.equal(publishedCard.source_section, 'community')
  assert.equal(publishedCard.reference_status, 'ready')
  assert.ok(response.data.catalog.revision > initialRevision)
  assert.ok(response.data.catalog.references[cardId].startsWith('参考图/'))
  await access(join(storageDir, response.data.catalog.references[cardId]))
  const publishedSubmission = response.data.submission
  assert.equal(publishedSubmission.status, 'approved')
  assert.equal(publishedSubmission.publishedTargetId, cardId)
  const publishedRevision = response.data.catalog.revision
  response = await admin.request(`/api/admin/face/submissions/${cardSubmission.id}/approve`, { method: 'POST' })
  assert.equal(response.status, 409, '重复发布应直接拒绝')
  assert.equal((await userB.request('/api/face/catalog')).data.meta.revision, publishedRevision, '重复发布不能再次改目录')

  const afterPublish = await userB.request('/api/face/catalog')
  const visibleCard = afterPublish.data.catalog.categories
    .flatMap(category => category.items)
    .find(item => item.id === cardId)
  assert.ok(visibleCard, '其他账号刷新目录后应看到已发布卡片')
  assert.equal(visibleCard.name_zh, '社区测试脸型·审核修改')
  assert.equal(afterPublish.data.meta.revision, publishedRevision)

  const targetId = 'eye_almond'
  const referenceBefore = (await userB.request('/api/face/catalog')).data.catalog.references[targetId]
  response = await userA.request('/api/face/submissions', {
    method: 'POST',
    body: {
      kind: 'reference',
      category: 'eye_shape',
      targetId,
      name: 'eye_almond',
      dataUrl: DATA_URL,
    },
  })
  assert.equal(response.status, 201)
  const referenceSubmission = response.data.submission
  assert.equal(referenceSubmission.kind, 'reference')
  assert.ok(referenceSubmission.imagePath.startsWith('参考图-待审核/'))
  assert.equal((await userB.request('/api/face/catalog')).data.catalog.references[targetId], referenceBefore)

  response = await admin.request(`/api/admin/face/submissions/${referenceSubmission.id}/approve`, { method: 'POST' })
  assert.equal(response.status, 200)
  const referenceAfter = response.data.catalog.references[targetId]
  assert.ok(referenceAfter.startsWith('参考图/'))
  assert.notEqual(referenceAfter, referenceBefore)
  assert.equal((await userB.request('/api/face/catalog')).data.catalog.references[targetId], referenceAfter)

  response = await userA.request('/api/face/submissions', {
    method: 'POST',
    body: {
      kind: 'reference',
      category: 'eye_shape',
      targetId: 'eye_deer',
      name: 'eye_deer',
    },
  })
  assert.equal(response.status, 201)
  const emptyReferenceSubmission = response.data.submission
  response = await admin.request(`/api/admin/face/submissions/${emptyReferenceSubmission.id}/approve`, { method: 'POST' })
  assert.equal(response.status, 422)
  assert.match(response.data.error, /缺少图片/)
  await userA.request(`/api/face/submissions/${emptyReferenceSubmission.id}`, { method: 'DELETE' })

  const rejectId = `community_reject_${Date.now().toString(36)}`
  response = await userA.request('/api/face/submissions', {
    method: 'POST',
    body: {
      kind: 'card',
      category: 'face_shape',
      targetId: rejectId,
      card: cardPayload(rejectId, 'face_shape', '待驳回社区卡片'),
    },
  })
  assert.equal(response.status, 201)
  const rejectedSubmission = response.data.submission
  assert.equal(
    (await userB.request(`/api/face/submissions/${rejectedSubmission.id}/resubmit`, { method: 'POST' })).status,
    403,
  )
  response = await admin.request(`/api/admin/face/submissions/${rejectedSubmission.id}/reject`, {
    method: 'POST',
    body: { note: '脸型描述不够具体，请补充轮廓特征' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.data.submission.status, 'rejected')
  mine = await userA.request('/api/face/submissions/mine')
  const rejectedMine = mine.data.submissions.find(item => item.id === rejectedSubmission.id)
  assert.equal(rejectedMine.status, 'rejected')
  assert.equal(rejectedMine.reviewNote, '脸型描述不够具体，请补充轮廓特征')

  response = await userA.request(`/api/face/submissions/${rejectedSubmission.id}/resubmit`, { method: 'POST' })
  assert.equal(response.status, 200)
  assert.equal(response.data.submission.status, 'pending')
  response = await userA.request(`/api/face/submissions/${rejectedSubmission.id}`, { method: 'DELETE' })
  assert.equal(response.status, 200)
  mine = await userA.request('/api/face/submissions/mine')
  assert.equal(mine.data.submissions.some(item => item.id === rejectedSubmission.id), false)

  response = await userA.request('/api/face/submissions', {
    method: 'POST',
    body: {
      kind: 'card',
      category: 'face_shape',
      targetId: `community_bad_image_${Date.now().toString(36)}`,
      card: cardPayload(`community_bad_image_${Date.now().toString(36)}`, 'face_shape', '坏图片卡片'),
      dataUrl: 'data:image/png;base64,AAAA',
    },
  })
  assert.equal(response.status, 400)

  response = await userA.request('/api/face/submissions', {
    method: 'POST',
    body: {
      kind: 'card',
      category: 'not_exists',
      targetId: 'bad_category',
      card: cardPayload('bad_category', 'not_exists', '错误分类'),
    },
  })
  assert.equal(response.status, 404)

  response = await userA.request('/api/face/submissions', {
    method: 'POST',
    body: {
      kind: 'card',
      category: 'face_shape',
      targetId: 'face_oval',
      card: cardPayload('face_oval', 'face_shape', '重复 ID 卡片'),
    },
  })
  assert.equal(response.status, 201)
  const duplicateIdSubmission = response.data.submission
  response = await admin.request(`/api/admin/face/submissions/${duplicateIdSubmission.id}/approve`, { method: 'POST' })
  assert.equal(response.status, 409)
  assert.match(response.data.error, /ID 已存在/)
  await userA.request(`/api/face/submissions/${duplicateIdSubmission.id}`, { method: 'DELETE' })

  const duplicateNameId = `community_duplicate_name_${Date.now().toString(36)}`
  response = await userA.request('/api/face/submissions', {
    method: 'POST',
    body: {
      kind: 'card',
      category: 'face_shape',
      targetId: duplicateNameId,
      card: cardPayload(duplicateNameId, 'face_shape', '标准鹅蛋脸'),
    },
  })
  assert.equal(response.status, 201)
  const duplicateNameSubmission = response.data.submission
  response = await admin.request(`/api/admin/face/submissions/${duplicateNameSubmission.id}/approve`, { method: 'POST' })
  assert.equal(response.status, 409)
  assert.match(response.data.error, /同名卡片/)

  mine = await userA.request('/api/face/submissions/mine')
  for (const submission of mine.data.submissions.filter(item => item.status !== 'approved')) {
    await userA.request(`/api/face/submissions/${submission.id}`, { method: 'DELETE' })
  }

  for (let index = 0; index < 20; index += 1) {
    const id = `community_limit_${Date.now().toString(36)}_${index}`
    response = await userA.request('/api/face/submissions', {
      method: 'POST',
      body: {
        kind: 'card',
        category: 'face_shape',
        targetId: id,
        card: cardPayload(id, 'face_shape', `限额卡片 ${index + 1}`),
      },
    })
    assert.equal(response.status, 201)
  }
  const overLimitId = `community_limit_over_${Date.now().toString(36)}`
  response = await userA.request('/api/face/submissions', {
    method: 'POST',
    body: {
      kind: 'card',
      category: 'face_shape',
      targetId: overLimitId,
      card: cardPayload(overLimitId, 'face_shape', '超额卡片'),
    },
  })
  assert.equal(response.status, 429)
  assert.match(response.data.error, /最多 20 条/)

  const stored = JSON.parse(await readFile(join(dataDir, 'face-submissions.json'), 'utf8'))
  assert.ok(Array.isArray(stored.submissions))
  assert.ok(stored.submissions.some(item => item.id === cardSubmission.id && item.status === 'approved'))

  console.log('✓ 未登录不能提交，普通用户不能访问审核接口')
  console.log('✓ 新卡片提交后本人可用、其他人不可见，图片进入待审核目录')
  console.log('✓ 管理员修改卡片后发布，目录 revision 增加，其他账号可见')
  console.log('✓ 参考图提交审核通过后替换公共参考图')
  console.log('✓ 驳回原因可见、本人可重新提交、可撤回')
  console.log('✓ 非法图片、错误分类、重复 ID 和同名卡片都有明确错误')
  console.log('✓ 单账号待审核上限 20 条，超额返回 429')
} catch (error) {
  console.error(serverOutput)
  throw error
} finally {
  try {
    await fetch(`${base}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-shutdown-token': SHUTDOWN_TOKEN },
    })
  } catch {
    // 服务已经退出时忽略
  }
  await new Promise(resolve => setTimeout(resolve, 150))
  if (!app.killed) app.kill()
  await rm(runDir, { recursive: true, force: true })
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  throw new Error(`等待超时\n${serverOutput}`)
}
