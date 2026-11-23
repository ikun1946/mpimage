/**
 * 浏览器端分辨率测试：真正在页面里切换模型/画幅/分辨率并点生成。
 *
 * 依赖本机 Chrome 与已构建的 web/dist。用假 Magpie 返回指定尺寸的 PNG，
 * 因此不消耗真实额度。运行：
 *   npm --prefix server run build && npm --prefix web run build
 *   node scripts/test-resolution-ui.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'release', 'resolution-tests')
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PASSWORD = 'resolution-test-123'
let nextId = 0
const pending = new Map()

const upstreamRequests = []
const mock = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      data: [
        { id: 'codex/gpt-image-2', kind: 'image', display_name: 'GPT Image 2' },
        { id: 'ai-studio/gemini-3-pro-image', kind: 'image', display_name: 'Banana Pro' },
      ],
    }))
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
      data: [{ b64_json: validPng(width, height).toString('base64') }],
      model: body.model,
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    }))
    return
  }
  res.writeHead(404).end()
})
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
const mockBase = `http://127.0.0.1:${mock.address().port}`

const runDir = join(OUT_DIR, `ui-${Date.now()}`)
const dataDir = join(runDir, 'data')
await mkdir(dataDir, { recursive: true })
const port = await freePort()
const app = spawn(process.execPath, [join(ROOT, 'server', 'dist', 'main.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    MAGPIE_BASE_URL: mockBase,
    MAGPIE_IMAGE_MODEL: 'codex/gpt-image-2',
    ADMIN_SETUP_KEY: 'ui-setup-key',
    USER_DATABASE_PATH: join(runDir, 'users.json'),
    USAGE_DATABASE_PATH: join(runDir, 'usage.json'),
    PROJECT_DATABASE_PATH: join(runDir, 'projects.json'),
    STORAGE_DIR: join(runDir, 'generated'),
    DATA_DIR: dataDir,
    LOG_DIR: join(runDir, 'logs'),
    STYLE_LIBRARY_PATH: join(runDir, 'styles'),
    UPDATE_CHECK_DISABLED: '1',
    IMAGE_CONCURRENCY: '2',
    SESSION_SECRET: 'resolution-ui',
    SHUTDOWN_TOKEN: 'shutdown',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOutput = ''
app.stdout.on('data', chunk => { serverOutput += chunk })
app.stderr.on('data', chunk => { serverOutput += chunk })

const base = `http://127.0.0.1:${port}`
let chrome
let ws
try {
  await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 20_000, () => serverOutput)
  await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      setupKey: 'ui-setup-key',
      username: 'admin',
      displayName: '测试管理员',
      password: PASSWORD,
    }),
  })

  const profile = join(runDir, 'chrome-profile')
  await mkdir(profile, { recursive: true })
  chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: 'ignore' })

  const devToolsPort = await waitForDevTools(profile)
  const target = await fetch(`http://127.0.0.1:${devToolsPort}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
  }).then(response => response.json())
  ws = await connectCdp(target.webSocketDebuggerUrl)

  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url: `${base}/login.html` })
  await waitForPage(() => evalJs(`document.readyState === 'complete' && Boolean(document.querySelector('#username'))`))

  await evalJs(`(() => {
    document.querySelector('#username').value = 'admin'
    document.querySelector('#password').value = ${JSON.stringify(PASSWORD)}
    document.querySelector('#login-submit').click()
    return true
  })()`)
  await waitForPage(() => evalJs(`location.pathname === '/batch.html' && document.querySelectorAll('#free-model option').length > 1`))
  await evalJs(`document.querySelector('#tab-free')?.click(); true`)
  await waitForPage(() => evalJs(`document.querySelector('#free-resolution') && !document.querySelector('#free-resolution').closest('[hidden]')`))

  const codexUi = await evalJs(`(() => {
    const select = document.querySelector('#free-resolution')
    return {
      options: [...select.options].map(option => option.textContent),
      value: select.value,
      note: document.querySelector('#free-resolution-note')?.textContent || '',
    }
  })()`)
  assert.deepEqual(codexUi.options, ['自动（仅模型原生尺寸）'])
  assert.equal(codexUi.value, 'auto')
  assert.match(codexUi.note, /原生尺寸/)

  await evalJs(`(() => {
    const select = document.querySelector('#free-model')
    select.value = 'ai-studio/gemini-3-pro-image'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await waitForPage(() => evalJs(`document.querySelectorAll('#free-resolution option').length === 4`))

  const geminiUi = await evalJs(`(() => ({
    options: [...document.querySelector('#free-resolution').options].map(option => option.textContent),
    note: document.querySelector('#free-resolution-note')?.textContent || '',
  }))()`)
  assert.equal(geminiUi.options.length, 4)
  assert.ok(geminiUi.options.some(text => text.startsWith('1K')))
  assert.ok(geminiUi.options.some(text => text.startsWith('4K')))
  assert.match(geminiUi.note, /支持 1K\/2K\/4K/)

  await setSelect('#free-ratio', '16:9')
  await setSelect('#free-resolution', '1K')
  await typePrompt('一只橘猫坐在木窗台上，水彩画风格')
  await clickSubmit()
  await waitForPage(() => evalJs(`document.querySelector('#free-status').textContent.includes('1024 × 576')`), 20_000)
  assert.equal(upstreamRequests.at(-1)?.size, '16:9')
  assert.equal(upstreamRequests.at(-1)?.resolution, '1K')

  await setSelect('#free-resolution', '4K')
  await clickSubmit()
  await waitForPage(() => evalJs(`document.querySelector('#free-status').textContent.includes('4096 × 2304')`), 20_000)
  assert.equal(upstreamRequests.at(-1)?.resolution, '4K')

  await setSelect('#free-resolution', '2K')
  await clickSubmit()
  await waitForPage(() => evalJs(`document.querySelector('#free-status').textContent.includes('2048 × 1152')`), 20_000)
  assert.equal(upstreamRequests.at(-1)?.resolution, '2K')

  // 上游没按档位输出时，页面必须明说，而不是只显示一个“生成完成”
  await setSelect('#free-resolution', '1K')
  await typePrompt('FORCE_NATIVE 一只橘猫坐在木窗台上')
  await clickSubmit()
  await waitForPage(() => evalJs(`document.querySelector('#free-status').textContent.includes('分辨率未按请求生效')`), 20_000)
  const mismatchUi = await evalJs(`(() => ({
    status: document.querySelector('#free-status').textContent,
    toast: document.querySelector('#toast')?.textContent || '',
  }))()`)
  assert.match(mismatchUi.status, /1254 × 1254/)
  assert.match(mismatchUi.toast, /请求 1K/)

  // 换回只支持 auto 的 Codex：必须在界面里明确提示，而不是静默保留 2K
  await evalJs(`(() => {
    const select = document.querySelector('#free-model')
    select.value = 'codex/gpt-image-2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await waitForPage(() => evalJs(`document.querySelector('#free-resolution').value === 'auto'`))
  const afterSwitch = await evalJs(`(() => ({
    options: [...document.querySelector('#free-resolution').options].map(option => option.textContent),
    toast: document.querySelector('#toast')?.textContent || '',
  }))()`)
  assert.deepEqual(afterSwitch.options, ['自动（仅模型原生尺寸）'])
  assert.match(afterSwitch.toast, /不支持 1K/)

  await setSelect('#free-ratio', '1:1')
  await clickSubmit()
  await waitForPage(() => evalJs(`document.querySelector('#free-status').textContent.includes('1254 × 1254')`), 20_000)

  // 批量入口：用同一个服务端能力表，不应该给 Codex 显示 1K/2K/4K
  const project = await evalJs(`fetch('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '分辨率测试项目' }),
  }).then(response => response.json())`)
  const projectId = project?.project?.id
  assert.ok(projectId)
  await evalJs(`fetch('/api/projects/${projectId}', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assets: [{
        id: 'resolution-test-asset',
        type: 'role',
        name: '测试角色',
        fields: [{ label: '角色', value: '测试角色' }],
        raw: '',
        ratio: '3:4',
        styleId: '',
        status: 'idle',
        prompt: '测试角色',
        resultUrl: '',
        width: 0,
        height: 0,
        error: '',
        updatedAt: new Date().toISOString(),
      }],
      bulkParams: {
        role: { ratio: '3:4', resolution: 'auto', styleId: '', model: 'codex/gpt-image-2' },
        scene: {},
        prop: {},
      },
    }),
  }).then(response => response.json())`)
  await evalJs(`fetch('/api/projects/${projectId}/activate', { method: 'POST' }).then(response => response.json())`)
  await cdp('Page.navigate', { url: `${base}/batch.html` })
  await waitForPage(() => evalJs(`document.querySelector('[data-count="role"]')?.textContent.trim() === '1'`), 20_000)
  await evalJs(`document.querySelector('[data-mode="batch"]').click(); true`)
  await waitForPage(() => evalJs(`!document.querySelector('#tab-role').disabled`))
  await evalJs(`document.querySelector('#tab-role').click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('#bulk-resolution-role'))`))

  const batchCodex = await evalJs(`(() => ({
    options: [...document.querySelector('#bulk-resolution-role').options].map(option => option.textContent),
    summary: document.querySelector('[data-panel="role"] .workspace-head p')?.textContent || '',
  }))()`)
  assert.deepEqual(batchCodex.options, ['自动（仅模型原生尺寸）'])
  assert.match(batchCodex.summary, /分辨率 自动（模型原生）/)

  await setSelect('#bulk-model-role', 'ai-studio/gemini-3-pro-image')
  await waitForPage(() => evalJs(`document.querySelectorAll('#bulk-resolution-role option').length === 4`))
  const batchGemini = await evalJs(`(() => ({
    options: [...document.querySelector('#bulk-resolution-role').options].map(option => option.textContent),
  }))()`)
  assert.equal(batchGemini.options.length, 4)

  await setSelect('#bulk-ratio-role', '16:9')
  await setSelect('#bulk-resolution-role', '1K')
  await evalJs(`document.querySelector('[data-panel="role"] [data-action="select-type"]').click(); true`)
  await evalJs(`document.querySelector('[data-panel="role"] [data-action="apply-params"]').click(); true`)
  await evalJs(`document.querySelector('[data-panel="role"] [data-action="generate-selected"]').click(); true`)
  await waitForPage(
    () => evalJs(`document.querySelector('[data-panel="role"] .cell-progress-text')?.textContent.includes('1024 × 576')`),
    20_000,
  )
  assert.equal(upstreamRequests.at(-1)?.size, '16:9')
  assert.equal(upstreamRequests.at(-1)?.resolution, '1K')

  console.log('✓ 页面默认 Codex：分辨率下拉只有“自动（仅模型原生尺寸）”')
  console.log('✓ 切到 Gemini：1K/2K/4K 正常出现，并显示目标像素')
  console.log('✓ 16:9 1K → 1024×576、4K → 4096×2304、2K → 2048×1152')
  console.log('✓ 上游回落时页面显示“分辨率未按请求生效”并弹明确提示')
  console.log('✓ 切回 Codex：明确提示不支持 1K，自动落到 auto')
  console.log('✓ Codex 自动：页面收到并显示 1254×1254')
  console.log('✓ 批量入口与自由创作使用同一套分辨率白名单')
  console.log('✓ 批量生成 16:9 1K：上游收到 size=16:9、resolution=1K，页面显示 1024×576')
  console.log(`测试日志：${runDir}`)
} finally {
  try {
    await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'x-shutdown-token': 'shutdown' } })
  } catch {}
  try { ws?.close() } catch {}
  setTimeout(() => {
    if (chrome && !chrome.killed) chrome.kill()
    if (!app.killed) app.kill()
  }, 500).unref()
  mock.close()
}

async function setSelect(selector, value) {
  await evalJs(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)})
    select.value = ${JSON.stringify(value)}
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return select.value
  })()`)
}

async function typePrompt(text) {
  await evalJs(`(() => {
    const input = document.querySelector('#free-prompt')
    input.value = ${JSON.stringify(text)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

async function clickSubmit() {
  await waitForPage(() => evalJs(`!document.querySelector('#free-submit').disabled`))
  await evalJs(`document.querySelector('#free-submit').click(); true`)
}

async function evalJs(expression) {
  const result = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || '页面脚本执行失败')
  }
  return result.result?.value
}

async function cdp(method, params = {}) {
  const id = ++nextId
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  ws.send(JSON.stringify({ id, method, params }))
  return promise
}

async function connectCdp(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data))
    if (!message.id) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  }
  return socket
}

async function waitForPage(check, timeoutMs = 10_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check().catch(() => false)) return
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('页面等待超时')
}

async function waitForDevTools(profile) {
  const file = join(profile, 'DevToolsActivePort')
  const started = Date.now()
  while (Date.now() - started < 15_000) {
    try {
      const [port] = (await readFile(file, 'utf8')).trim().split(/\r?\n/)
      if (port) return Number(port)
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('Chrome DevTools 没有启动')
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
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))])
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
