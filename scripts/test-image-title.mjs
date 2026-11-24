import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

import {
  fallbackImageTitle,
  isUsableImageTitle,
} from '../server/dist/app/products/images/image-title.js'
import {
  SettingsStore,
  TITLE_MODEL_DISABLED,
} from '../server/dist/app/control/settings-store.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PASSWORD = 'title-test-password'

const facePrompt =
  '严格参考图片2中的白膜的脸型和五官位置，将图片1中的角色的脸型和五官位置改为图片2白膜的脸型和五官位置，其余保持图片1中的不变'

assert.equal(fallbackImageTitle(facePrompt), '面部调整')
assert.equal(fallbackImageTitle('将图1的人物服装换成图2的人物服装，人物脸型和五官保持不变'), '服装调整')
assert.equal(fallbackImageTitle('按以下提示词修改图片光影，场景不要过于暗'), '光影调整')
assert.equal(fallbackImageTitle('月下的白鹿站在雪地里，冷蓝色调，电影感光影'), '月下白鹿')

for (const bad of ['不变', '其他不变', '五官保持不变', '图一面部五官', '按以下提示词修改']) {
  assert.equal(isUsableImageTitle(bad, facePrompt), false, `不应接受标题：${bad}`)
}

const panelHtml = readFileSync(join(ROOT, 'desktop', 'panel.html'), 'utf8')
assert.match(panelHtml, /关闭（不调用 AI 命名）/)
assert.match(panelHtml, /TITLE_MODEL_DISABLED/)

const dir = await mkdtemp(join(tmpdir(), 'huajing-title-test-'))
try {
  const settings = new SettingsStore(dir)
  await settings.init()
  await settings.setTitleModel(TITLE_MODEL_DISABLED)
  assert.equal(settings.getTitleModelOverride(), TITLE_MODEL_DISABLED)
  assert.equal(settings.isTitleModelDisabled(), true)
  assert.equal(await settings.getTitleModel(), '')
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log('✓ 标题兜底：改图提示词不再切成“不变”等操作说明')
console.log('✓ 标题校验：拒绝“其他不变 / 五官保持不变 / 图一面部五官”等伪标题')
console.log('✓ 标题模型：关闭状态可持久化，且不会返回可调用的模型 ID')
console.log('✓ 后台下拉：已提供“关闭（不调用 AI 命名）”选项')

let chatCalls = 0
const mock = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      data: [
        {
          id: 'codex/gpt-image-2',
          kind: 'image',
          display_name: 'GPT Image 2',
          modalities: { output: ['image'] },
        },
      ],
    }))
    return
  }
  if (request.method === 'POST' && request.url === '/v1/images/generations') {
    for await (const _chunk of request) {
      // 读空请求体即可，本测试只关心标题模型有没有被调用
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      data: [{ b64_json: validPng(1024, 576).toString('base64') }],
      model: 'codex/gpt-image-2',
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    }))
    return
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    chatCalls += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      model: 'mock-title-model',
      choices: [{ message: { content: '优雅标题' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }))
    return
  }
  response.writeHead(404).end()
})
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
const mockBase = `http://127.0.0.1:${mock.address().port}`

const runDir = await mkdtemp(join(tmpdir(), 'huajing-title-api-'))
const port = await freePort()
const app = spawn(process.execPath, [join(ROOT, 'server', 'dist', 'main.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    MAGPIE_BASE_URL: mockBase,
    MAGPIE_IMAGE_MODEL: 'codex/gpt-image-2',
    MAGPIE_TEXT_MODEL: 'mock-title-model',
    ADMIN_SETUP_KEY: 'title-test-key',
    USER_DATABASE_PATH: join(runDir, 'users.json'),
    USAGE_DATABASE_PATH: join(runDir, 'usage.json'),
    PROJECT_DATABASE_PATH: join(runDir, 'projects.json'),
    STORAGE_DIR: join(runDir, 'generated'),
    DATA_DIR: join(runDir, 'data'),
    LOG_DIR: join(runDir, 'logs'),
    STYLE_LIBRARY_PATH: join(runDir, 'styles'),
    UPDATE_CHECK_DISABLED: '1',
    IMAGE_CONCURRENCY: '1',
    SESSION_SECRET: 'title-test-session',
    SHUTDOWN_TOKEN: 'title-test-shutdown',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOutput = ''
app.stdout.on('data', chunk => { serverOutput += chunk })
app.stderr.on('data', chunk => { serverOutput += chunk })
const base = `http://127.0.0.1:${port}`

try {
  await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 20_000)
  await requestJson('/api/auth/setup', {
    method: 'POST',
    body: {
      setupKey: 'title-test-key',
      username: 'admin',
      displayName: '测试管理员',
      password: PASSWORD,
    },
  })
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  })
  assert.equal(login.status, 200)
  const setCookie = login.headers.getSetCookie?.()[0] || login.headers.get('set-cookie')
  assert.ok(setCookie, '登录后应返回会话 Cookie')
  const cookie = setCookie.split(';')[0]

  const api = (path, init = {}) => requestJson(path, {
    ...init,
    headers: { ...(init.headers || {}), cookie },
  })

  await api('/api/admin/upstream', {
    method: 'PUT',
    body: { baseUrl: mockBase, titleModel: 'mock-title-model' },
  })
  const enabledSettings = await api('/api/admin/upstream')
  assert.equal(enabledSettings.titleModelDisabled, false)
  assert.equal(enabledSettings.titleModelOverride, 'mock-title-model')

  const enabledImage = await api('/api/images', {
    method: 'POST',
    body: imageRequest(),
  })
  assert.equal(enabledImage.name, '优雅标题')
  assert.equal(chatCalls, 1)

  await api('/api/admin/upstream', {
    method: 'PUT',
    body: { baseUrl: mockBase, titleModel: TITLE_MODEL_DISABLED },
  })
  const disabledSettings = await api('/api/admin/upstream')
  assert.equal(disabledSettings.titleModelDisabled, true)
  assert.equal(disabledSettings.titleModelOverride, TITLE_MODEL_DISABLED)
  assert.equal(chatCalls, 1)

  const disabledImage = await api('/api/images', {
    method: 'POST',
    body: imageRequest(),
  })
  assert.equal(disabledImage.name, '面部调整')
  assert.equal(chatCalls, 1, '关闭标题模型后不应再请求对话模型')

  console.log('✓ 后台接口：标题模型可保存为关闭，并返回明确的关闭状态')
  console.log('✓ 生图链路：关闭后直接使用本地短名，对话模型请求次数保持不变')
} finally {
  try {
    await fetch(`${base}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-shutdown-token': 'title-test-shutdown' },
    })
  } catch {}
  if (!app.killed) app.kill()
  mock.close()
  await rm(runDir, { recursive: true, force: true })
}

function imageRequest() {
  return {
    prompt: facePrompt,
    ratio: '16:9',
    category: '自由创作',
    name: '标题测试',
    source: 'free',
    count: 1,
    resolution: 'auto',
  }
}

async function requestJson(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    method: init.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text}\n${serverOutput}`)
  return text ? JSON.parse(text) : null
}

async function waitFor(check, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`等待服务启动超时\n${serverOutput}`)
}

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

function validPng(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([length, body, crc])
  }
  const row = Buffer.alloc(1 + width * 3, 0)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
