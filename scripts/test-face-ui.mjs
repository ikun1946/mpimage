import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PASSWORD = 'face-ui-password'
const pending = new Map()
let nextId = 0
let ws
let chrome

const runDir = await mkdtemp(join(tmpdir(), 'huajing-face-ui-'))
const dataDir = join(runDir, 'data')
await mkdir(dataDir, { recursive: true })
const port = await freePort()
const base = `http://127.0.0.1:${port}`
const app = spawn(process.execPath, [join(ROOT, 'server', 'dist', 'main.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    MAGPIE_BASE_URL: 'http://127.0.0.1:3425',
    ADMIN_SETUP_KEY: 'face-ui-key',
    USER_DATABASE_PATH: join(runDir, 'users.json'),
    USAGE_DATABASE_PATH: join(runDir, 'usage.json'),
    PROJECT_DATABASE_PATH: join(runDir, 'projects.json'),
    STORAGE_DIR: join(runDir, 'generated'),
    DATA_DIR: dataDir,
    LOG_DIR: join(runDir, 'logs'),
    STYLE_LIBRARY_PATH: join(runDir, 'styles'),
    UPDATE_CHECK_DISABLED: '1',
    IMAGE_CONCURRENCY: '1',
    SESSION_SECRET: 'face-ui-session',
    SHUTDOWN_TOKEN: 'face-ui-shutdown',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOutput = ''
app.stdout.on('data', chunk => { serverOutput += chunk })
app.stderr.on('data', chunk => { serverOutput += chunk })

try {
  await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 20_000)
  await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      setupKey: 'face-ui-key',
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
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  })

  await cdp('Page.navigate', { url: `${base}/login.html` })
  await waitForPage(() => evalJs(`document.readyState === 'complete' && Boolean(document.querySelector('#username'))`))
  await evalJs(`(() => {
    document.querySelector('#username').value = 'admin'
    document.querySelector('#password').value = ${JSON.stringify(PASSWORD)}
    document.querySelector('#login-submit').click()
    return true
  })()`)
  await waitForPage(() => evalJs(`location.pathname === '/batch.html'`))

  assert.equal(await evalJs(`document.querySelector('#tab-face')?.getAttribute('href')`), '/face.html')
  await cdp('Page.navigate', { url: `${base}/face.html` })
  await waitForPage(() => evalJs(`Boolean(window.__faceStudio)`), 20_000)
  await waitForPage(() => evalJs(`!document.body.classList.contains('is-booting')`))

  const catalog = await evalJs(`({
    total: window.__faceStudio.data.total,
    categories: window.__faceStudio.data.categories.length,
    presets: window.__faceStudio.data.presets.length,
    references: Object.keys(window.__faceStudio.data.references || {}).length,
    title: document.title,
    back: document.querySelector('.back-link')?.getAttribute('href'),
    userId: window.__FACE_USER_ID__,
  })`)
  assert.equal(catalog.total, 484)
  assert.equal(catalog.categories, 46)
  assert.equal(catalog.presets, 14)
  assert.equal(catalog.references, 16)
  assert.equal(catalog.title, '画境 · 捏脸')
  assert.equal(catalog.back, '/batch.html')
  assert.ok(catalog.userId)

  await evalJs(`document.querySelector('#open-presets').click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('#modal [data-preset="preset_clear_classic"]'))`))
  await evalJs(`document.querySelector('#modal [data-preset="preset_clear_classic"]').click(); true`)
  await waitForPage(() => evalJs(`document.querySelector('#prompt-full')?.value.includes('瑞凤眼')`))
  assert.equal(await evalJs(`document.querySelector('#handoff-btn')?.disabled`), false)

  await evalJs(`document.querySelector('[data-group-head="eyes"]').click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('#nav [data-cat="eye_shape"]'))`))
  await evalJs(`document.querySelector('#nav [data-cat="eye_shape"]').click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('.card[data-id="eye_almond"]'))`))
  const eyeCard = await evalJs(`(() => {
    const image = document.querySelector('.card[data-id="eye_almond"] img')
    return { src: image?.getAttribute('src') || '', loaded: Boolean(image?.naturalWidth > 0) }
  })()`)
  assert.match(eyeCard.src, /^\/face-assets\/references\/eyes\/eye_shape\/eye_almond\.webp/)
  assert.equal(eyeCard.loaded, true)

  const storageHasUser = await evalJs(`Object.keys(localStorage).some(key => key.startsWith('huajing.faceStudio.v1.${catalog.userId}'))`)
  assert.equal(storageHasUser, true)

  const admin = await evalJs(`fetch('/api/admin/face/catalog').then(r => r.json())`)
  const changed = JSON.parse(JSON.stringify(admin.catalog))
  const faceShape = changed.categories.find(category => category.key === 'face_shape')
  const oval = faceShape.items.find(item => item.id === 'face_oval')
  oval.name_zh = '标准鹅蛋脸·服务端修改'
  const saveResult = await evalJs(`fetch('/api/admin/face/catalog', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catalog: ${JSON.stringify(changed)}, baseRevision: ${admin.meta.revision} }),
  }).then(r => r.json())`)
  assert.equal(saveResult.meta.revision, admin.meta.revision + 1)

  await cdp('Page.navigate', { url: `${base}/face.html` })
  await waitForPage(() => evalJs(`Boolean(window.__faceStudio)`), 20_000)
  await waitForPage(() => evalJs(`document.querySelector('[data-group-head="face"]')?.click() || true`))
  const changedName = await evalJs(`window.__faceStudio.data.categories.find(c => c.key === 'face_shape').items.find(i => i.id === 'face_oval').name_zh`)
  assert.equal(changedName, '标准鹅蛋脸·服务端修改')

  await evalJs(`fetch('/api/admin/face/catalog/reset', { method: 'POST' }).then(r => r.json())`)
  await cdp('Page.navigate', { url: `${base}/face.html` })
  await waitForPage(() => evalJs(`Boolean(window.__faceStudio)`), 20_000)
  assert.equal(
    await evalJs(`window.__faceStudio.data.categories.find(c => c.key === 'face_shape').items.find(i => i.id === 'face_oval').name_zh`),
    '标准鹅蛋脸',
  )

  await evalJs(`document.querySelector('#handoff-btn').click(); true`)
  await waitForPage(() => evalJs(`location.pathname === '/batch.html' && location.search.includes('from=face')`), 20_000)
  await waitForPage(() => evalJs(`document.querySelector('#free-prompt')?.value.includes('瑞凤眼')`), 20_000)
  const handoff = await evalJs(`({
    prompt: document.querySelector('#free-prompt').value,
    tab: document.querySelector('#tab-free')?.getAttribute('aria-selected'),
  })`)
  assert.match(handoff.prompt, /瑞凤眼/)
  assert.match(handoff.prompt, /【不要出现】/)
  assert.equal(handoff.tab, 'true')

  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await cdp('Page.navigate', { url: `${base}/face.html` })
  await waitForPage(() => evalJs(`Boolean(window.__faceStudio)`), 20_000)
  const mobile = await evalJs(`({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth,
    toggle: Boolean(document.querySelector('#panel-toggle')),
  })`)
  assert.ok(mobile.scrollWidth <= mobile.innerWidth + 2)
  assert.equal(mobile.toggle, true)

  const shotDir = join(ROOT, 'release', 'face-tests')
  await mkdir(shotDir, { recursive: true })
  const shot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(shotDir, 'face-page-mobile.png'), Buffer.from(shot.data, 'base64'))

  console.log('✓ 捏脸页：服务端目录 484 条特征 / 46 维度 / 14 预设 / 16 张内置图')
  console.log('✓ 预设与提示词：载入清冷古典美人后实时生成完整提示词')
  console.log('✓ 服务端资产：参考图从 /face-assets/ 正常加载')
  console.log('✓ 账号隔离：本地状态键包含当前 userId')
  console.log('✓ 服务端修改：改名后客户端重新加载可见，恢复默认后还原')
  console.log('✓ 带入自由创作：提示词和负向约束成功写入自由创作')
  console.log('✓ 移动端：390px 无横向溢出，提示词抽屉入口存在')
} finally {
  try {
    await fetch(`${base}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-shutdown-token': 'face-ui-shutdown' },
    })
  } catch {}
  try { ws?.close() } catch {}
  if (chrome && !chrome.killed) chrome.kill()
  if (!app.killed) app.kill()
  await new Promise(resolve => setTimeout(resolve, 600))
  await rm(runDir, { recursive: true, force: true }).catch(() => {})
}

async function evalJs(expression) {
  const result = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行失败')
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

async function waitForPage(check, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check().catch(() => false)) return
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`页面等待超时\n${serverOutput}`)
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
