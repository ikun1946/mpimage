/**
 * 分辨率契约测试。
 *
 * 覆盖三层：
 * 1. 能力表 / 目标尺寸 / 生成后核对的纯函数；
 * 2. 真实 HTTP 服务从 /api/config 到 /api/images 的参数传递；
 * 3. 用本地假 Magpie 捕获“前端请求 → 服务端 → 上游”的最终请求体。
 *
 * 不访问真实 Magpie，不消耗额度。运行前先构建后端：
 *   npm --prefix server run build
 *   node scripts/test-resolution-contract.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'release', 'resolution-tests')
const TOKEN = 'resolution-contract-token'

const {
  assessResolutionOutput,
  resolutionSupportForModel,
  resolutionTargetForModel,
} = await import('../server/dist/app/control/image-resolution-capabilities.js')
const { fitComfySize, COMFY_MAX_SIDE } = await import('../server/dist/app/control/comfy-size.js')

const ratio = (id, width, height, nativeWidth = width * 100, nativeHeight = height * 100) => ({
  id,
  width,
  height,
  nativeWidth,
  nativeHeight,
  label: id,
  shortLabel: id,
  promptHint: id,
})

const ratios = {
  square: ratio('1:1', 1, 1, 1254, 1254),
  landscape: ratio('16:9', 16, 9, 1672, 941),
  portrait: ratio('3:4', 3, 4, 1086, 1448),
}

// ---------- 纯函数：能力、目标尺寸、核对 ----------

assert.deepEqual(resolutionSupportForModel('codex/gpt-image-2').tiers, ['auto'])
assert.match(resolutionSupportForModel('codex/gpt-image-2').note, /原生尺寸/)

const mappedComfy = {
  mapping: {
    width: [{ node: '1', input: 'width' }],
    height: [{ node: '1', input: 'height' }],
  },
}
const unmappedComfy = { mapping: { width: [], height: [] } }
assert.deepEqual(resolutionSupportForModel('comfy:test', mappedComfy).tiers, ['auto', '1K', '2K'])
assert.deepEqual(resolutionSupportForModel('comfy:test', unmappedComfy).tiers, ['auto'])

assert.deepEqual(
  resolutionTargetForModel(ratios.square, '1K', 'comfy:test', mappedComfy),
  { width: 1024, height: 1024, longEdge: 1024, exact: true },
)
assert.deepEqual(
  resolutionTargetForModel(ratios.landscape, '2K', 'comfy:test', mappedComfy),
  { width: 2048, height: 1152, longEdge: 2048, exact: true },
)
assert.equal(resolutionTargetForModel(ratios.square, '4K', 'comfy:test', mappedComfy), null)
assert.deepEqual(fitComfySize(4096, 4096), { width: COMFY_MAX_SIDE, height: COMFY_MAX_SIDE })

const matched = assessResolutionOutput({
  requested: '1K',
  ratio: ratios.square,
  target: { width: 1024, height: 1024, longEdge: 1024, exact: true },
  actual: { width: 1024, height: 1024 },
})
assert.equal(matched.matched, true)

const ignored = assessResolutionOutput({
  requested: '1K',
  ratio: ratios.square,
  target: { width: 1024, height: 1024, longEdge: 1024, exact: false },
  actual: { width: 1254, height: 1254 },
})
assert.equal(ignored.matched, false)
assert.match(ignored.warning, /1254×1254/)

// ---------- 假 Magpie + 真服务端 ----------

function pngBuffer(width, height) {
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
  const idat = deflateSync(Buffer.alloc(1 + width * 3, 0))
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

const upstreamRequests = []
const mockModels = [
  { id: 'codex/gpt-image-2', kind: 'image', display_name: 'GPT Image 2' },
  { id: 'ai-studio/gemini-3-pro-image', kind: 'image', display_name: 'Banana Pro' },
  { id: 'ai-studio/gemini-3.1-flash-lite-image', kind: 'image', display_name: 'Gemini Lite' },
]

const mock = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: mockModels }))
    return
  }
  if (req.method === 'POST' && req.url === '/v1/images/generations') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}')
    upstreamRequests.push(body)
    let width = 1254
    let height = 1254
    if (body.model?.includes('gemini')) {
      const [w, h] = String(body.size || '1:1').split(':').map(Number)
      const value = w / h
      const edge = body.resolution === '4K' ? 4096 : body.resolution === '2K' ? 2048 : 1024
      const rawW = value >= 1 ? edge : edge * value
      const rawH = value >= 1 ? edge / value : edge
      width = Math.max(16, Math.round(rawW / 16) * 16)
      height = Math.max(16, Math.round(rawH / 16) * 16)
    }
    if (String(body.prompt || '').includes('FORCE_NATIVE')) {
      width = 1254
      height = 1254
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      data: [{ b64_json: pngBuffer(width, height).toString('base64') }],
      model: body.model,
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    }))
    return
  }
  res.writeHead(404).end()
})

await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
const mockPort = mock.address().port
const mockBase = `http://127.0.0.1:${mockPort}`

const tempRoot = join(OUT_DIR, `run-${Date.now()}`)
const dataDir = join(tempRoot, 'data')
await mkdir(dataDir, { recursive: true })
await writeFile(
  join(tempRoot, 'users.json'),
  JSON.stringify({
    users: [{
      id: '11111111-1111-4111-8111-111111111111',
      username: 'admin',
      displayName: '测试管理员',
      passwordSalt: '00',
      passwordHash: '00',
      role: 'admin',
      disabled: false,
      pending: false,
      createdAt: new Date().toISOString(),
      lastLoginAt: '',
    }],
  }, null, 2),
)

const port = await freePort()
const child = spawn(process.execPath, [join(ROOT, 'server', 'dist', 'main.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    MAGPIE_BASE_URL: mockBase,
    MAGPIE_IMAGE_MODEL: 'codex/gpt-image-2',
    DESKTOP_TOKEN: TOKEN,
    USER_DATABASE_PATH: join(tempRoot, 'users.json'),
    USAGE_DATABASE_PATH: join(tempRoot, 'usage.json'),
    PROJECT_DATABASE_PATH: join(tempRoot, 'projects.json'),
    STORAGE_DIR: join(tempRoot, 'generated'),
    DATA_DIR: dataDir,
    LOG_DIR: join(tempRoot, 'logs'),
    STYLE_LIBRARY_PATH: join(tempRoot, 'styles'),
    UPDATE_CHECK_DISABLED: '1',
    IMAGE_CONCURRENCY: '4',
    SESSION_SECRET: 'resolution-contract',
    SHUTDOWN_TOKEN: 'shutdown',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverOutput = ''
child.stdout.on('data', chunk => { serverOutput += chunk })
child.stderr.on('data', chunk => { serverOutput += chunk })

const base = `http://127.0.0.1:${port}`
const headers = { 'content-type': 'application/json', 'x-desktop-token': TOKEN }

try {
  await waitFor(async () => {
    const response = await fetch(`${base}/api/config`, { headers })
    return response.ok
  }, 20_000, () => serverOutput)

  const config = await fetch(`${base}/api/config`, { headers }).then(response => response.json())
  const codex = config.imageModels.find(model => model.id === 'codex/gpt-image-2')
  const gemini = config.imageModels.find(model => model.id === 'ai-studio/gemini-3-pro-image')
  const lite = config.imageModels.find(model => model.id === 'ai-studio/gemini-3.1-flash-lite-image')
  assert.deepEqual(codex?.resolutionTiers, ['auto'])
  assert.match(codex?.resolutionNote || '', /原生尺寸/)
  assert.deepEqual(gemini?.resolutionTiers, ['auto', '1K', '2K', '4K'])
  assert.deepEqual(lite?.resolutionTiers, ['auto', '1K'])

  const beforeUnsupported = upstreamRequests.length
  const unsupported = await postImage({ model: 'codex/gpt-image-2', ratio: '1:1', resolution: '1K' })
  assert.equal(unsupported.status, 422)
  assert.equal(unsupported.body.code, 'RESOLUTION_UNSUPPORTED')
  assert.equal(upstreamRequests.length, beforeUnsupported, '不支持的分辨率不应打到上游')

  const auto = await postImage({ model: 'codex/gpt-image-2', ratio: '1:1', resolution: 'auto' })
  assert.equal(auto.status, 200)
  assert.equal(auto.body.width, 1254)
  assert.equal(auto.body.height, 1254)
  assert.equal(auto.body.resolutionMatched, null)
  assert.equal(upstreamRequests.at(-1)?.size, undefined)
  assert.equal(upstreamRequests.at(-1)?.resolution, undefined)

  const first = await postImage({ model: 'ai-studio/gemini-3-pro-image', ratio: '1:1', resolution: '1K' })
  assert.equal(first.status, 200)
  assert.deepEqual([first.body.width, first.body.height], [1024, 1024])
  assert.equal(first.body.resolutionMatched, true)
  assert.deepEqual(first.body.requestedSize, { width: 1024, height: 1024 })
  assert.equal(upstreamRequests.at(-1)?.size, '1:1')
  assert.equal(upstreamRequests.at(-1)?.resolution, '1K')

  const landscape = await postImage({ model: 'ai-studio/gemini-3-pro-image', ratio: '16:9', resolution: '2K' })
  assert.equal(landscape.status, 200)
  assert.deepEqual([landscape.body.width, landscape.body.height], [2048, 1152])
  assert.equal(landscape.body.resolutionMatched, true)
  assert.equal(upstreamRequests.at(-1)?.size, '16:9')
  assert.equal(upstreamRequests.at(-1)?.resolution, '2K')

  const portrait = await postImage({ model: 'ai-studio/gemini-3-pro-image', ratio: '3:4', resolution: '1K' })
  assert.equal(portrait.status, 200)
  assert.deepEqual([portrait.body.width, portrait.body.height], [768, 1024])
  assert.equal(portrait.body.resolutionMatched, true)

  const mismatch = await postImage({
    model: 'ai-studio/gemini-3-pro-image',
    ratio: '1:1',
    resolution: '1K',
    prompt: 'FORCE_NATIVE 一只橘猫',
  })
  assert.equal(mismatch.status, 200)
  assert.deepEqual([mismatch.body.width, mismatch.body.height], [1254, 1254])
  assert.equal(mismatch.body.resolutionMatched, false)
  assert.match(mismatch.body.resolutionWarning || '', /请求 1K/)
  const logList = await fetch(`${base}/api/admin/monitor/requests?limit=60`, { headers }).then(response => response.json())
  const mismatchSummary = logList.entries.find(entry => entry.promptPreview?.includes('FORCE_NATIVE'))
  assert.ok(mismatchSummary, '请求日志里应能找到这次回落')
  const logDetail = await fetch(`${base}/api/admin/monitor/requests/${mismatchSummary.id}`, { headers })
    .then(response => response.json())
  assert.equal(logDetail.entry.params.resolutionMatched, false)
  assert.match(logDetail.entry.params.resolutionWarning, /请求 1K/)
  assert.match(logDetail.entry.params.upstreamResolutionRequest, /resolution=1K/)

  // 连续切换：1K → 4K → 2K，每次都必须带上当次选择
  for (const [tier, size] of [['1K', [1024, 1024]], ['4K', [4096, 4096]], ['2K', [2048, 2048]]]) {
    const result = await postImage({ model: 'ai-studio/gemini-3-pro-image', ratio: '1:1', resolution: tier })
    assert.equal(result.status, 200)
    assert.deepEqual([result.body.width, result.body.height], size)
    assert.equal(upstreamRequests.at(-1)?.resolution, tier)
  }

  const beforeLite = upstreamRequests.length
  const liteRejected = await postImage({
    model: 'ai-studio/gemini-3.1-flash-lite-image',
    ratio: '1:1',
    resolution: '4K',
  })
  assert.equal(liteRejected.status, 422)
  assert.equal(liteRejected.body.code, 'RESOLUTION_UNSUPPORTED')
  assert.equal(upstreamRequests.length, beforeLite)

  const invalid = await postImage({ model: 'codex/gpt-image-2', ratio: '1:1', resolution: '8K' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.code, 'RESOLUTION_INVALID')

  console.log('✓ 能力表：Codex 仅 auto，Comfy 2K 上限，未映射宽高仅 auto')
  console.log('✓ 尺寸换算：1K/2K/4K、正方形/横屏/竖屏、Comfy 2048 上限')
  console.log('✓ 生成后核对：1024 通过，1254 回落会明确报警')
  console.log('✓ API 拦截：不支持的档位 422，且不会请求上游')
  console.log('✓ 参数链路：选择值 → /api/images → Magpie size/resolution 全部一致')
  console.log('✓ 连续切换：1K → 4K → 2K 每次请求与返回尺寸都正确')
  console.log('✓ 请求日志：保留请求值、目标尺寸、实际上游参数与差异提示')
  console.log(`测试日志：${tempRoot}`)
} finally {
  try {
    await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'x-shutdown-token': 'shutdown' } })
  } catch {}
  setTimeout(() => {
    if (!child.killed) child.kill()
  }, 500).unref()
  mock.close()
}

async function postImage(payload) {
  const response = await fetch(`${base}/api/images`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt: '一只橘猫坐在木窗台上，水彩画风格\n\n画面比例测试',
      count: 1,
      ...payload,
    }),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

async function waitFor(check, timeoutMs, output) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`等待服务启动超时\n${output()}`)
}

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
