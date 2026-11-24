/**
 * 桌面捏脸卡片编辑器界面测试。
 * 用 Chrome 加载本地 HTML，并注入模拟的 faceCardsApi，不写真实用户目录。
 * 运行：node scripts/test-face-cards-ui.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const catalog = JSON.parse(await readFile(join(ROOT, 'server', 'assets', 'face', 'catalog-seed.json'), 'utf8'))
catalog.revision = 1
catalog.updatedAt = new Date().toISOString()

const runDir = await mkdtemp(join(tmpdir(), 'huajing-face-cards-editor-'))
const profile = join(runDir, 'chrome-profile')
await mkdir(profile, { recursive: true })
const pending = new Map()
let nextId = 0
let chrome
let ws

try {
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
    height: 920,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const original = ${JSON.stringify(catalog)}
      let current = JSON.parse(JSON.stringify(original))
      window.__editorCalls = []
      window.__editorCatalog = () => current
      window.faceCardsApi = {
        fileUrl: async path => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#dfe7df"/><path d="M60 22c18 0 29 15 29 36 0 23-13 40-29 40S31 81 31 58c0-21 11-36 29-36z" fill="#84978a"/><circle cx="49" cy="54" r="3" fill="#fff"/><circle cx="71" cy="54" r="3" fill="#fff"/></svg>'
        ),
        api: async (path, init = {}) => {
          window.__editorCalls.push({ path, init })
          if (path === '/api/admin/face/catalog' && (!init.method || init.method === 'GET')) {
            return { status: 200, ok: true, data: { catalog: JSON.parse(JSON.stringify(current)), meta: { revision: current.revision } } }
          }
          if (path === '/api/admin/face/catalog' && init.method === 'PUT') {
            current = JSON.parse(JSON.stringify(init.body.catalog))
            current.revision = Number(init.body.baseRevision || 0) + 1
            current.updatedAt = new Date().toISOString()
            return { status: 200, ok: true, data: { catalog: JSON.parse(JSON.stringify(current)), meta: { revision: current.revision } } }
          }
          if (path === '/api/admin/face/catalog/reset' || path === '/api/admin/face/catalog/restore') {
            current = JSON.parse(JSON.stringify(original))
            return { status: 200, ok: true, data: { catalog: JSON.parse(JSON.stringify(current)), meta: { revision: current.revision } } }
          }
          if (path === '/api/reference-images') {
            return { status: 201, ok: true, data: { path: '参考图/测试-参考.png', width: 512, height: 512 } }
          }
          return { status: 404, ok: false, data: null, error: 'not found' }
        },
      }
    })()`,
  })

  await cdp('Page.navigate', { url: pathToFileURL(join(ROOT, 'desktop', 'face-cards.html')).href })
  await waitForPage(() => evalJs(`!document.querySelector('#app').hidden && document.querySelector('#status-state').textContent === '已保存'`))

  const initial = await evalJs(`({
    meta: document.querySelector('#meta-summary').textContent,
    revision: document.querySelector('#meta-revision').textContent,
    categories: document.querySelectorAll('.tree-cat').length,
    cards: document.querySelectorAll('[data-card]').length,
    title: document.title,
    editor: Boolean(document.querySelector('[data-card-field="name_zh"]')),
  })`)
  assert.equal(initial.revision, 'r1')
  assert.match(initial.meta, /46 维度 · 484 卡片 · 14 预设/)
  assert.ok(initial.categories > 0)
  assert.ok(initial.cards > 0)
  assert.equal(initial.editor, true)
  assert.equal(initial.title, '画境 · 捏脸卡片')

  // 新增卡片 → 改名 → 保存，验证整份目录 PUT 和 baseRevision。
  await evalJs(`document.querySelector('[data-action="add-card"]').click(); true`)
  await waitForPage(() => evalJs(`document.querySelector('[data-card-field="name_zh"]')?.value === '新卡片'`))
  await evalJs(`(() => {
    const input = document.querySelector('[data-card-field="name_zh"]')
    input.value = '测试新增卡片'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  assert.equal(await evalJs(`document.querySelector('#status-state').textContent`), '有未保存修改')
  assert.equal(await evalJs(`document.querySelector('#btn-save').disabled`), false)
  await evalJs(`document.querySelector('#btn-save').click(); true`)
  await waitForPage(() => evalJs(`window.__editorCalls.some(call => call.path === '/api/admin/face/catalog' && call.init.method === 'PUT')`))
  await waitForPage(() => evalJs(`document.querySelector('#status-state').textContent === '已保存'`))
  const save = await evalJs(`(() => {
    const call = window.__editorCalls.find(call => call.path === '/api/admin/face/catalog' && call.init.method === 'PUT')
    return {
      revision: call.init.body.baseRevision,
      total: call.init.body.catalog.categories.reduce((sum, cat) => sum + cat.items.length, 0),
      found: call.init.body.catalog.categories.some(cat => cat.items.some(item => item.name_zh === '测试新增卡片')),
      revisionAfter: window.__editorCatalog().revision,
    }
  })()`)
  assert.equal(save.revision, 1)
  assert.equal(save.total, 485)
  assert.equal(save.found, true)
  assert.equal(save.revisionAfter, 2)

  // 预设页：能列出 14 套，切换一张卡片后进入未保存状态。
  await evalJs(`document.querySelector('[data-mode="presets"]').click(); true`)
  await waitForPage(() => evalJs(`document.querySelectorAll('[data-preset]').length === 14`))
  await evalJs(`document.querySelector('[data-preset]').click(); true`)
  await waitForPage(() => evalJs(`document.querySelectorAll('[data-preset-cat]').length > 0`))
  await evalJs(`(() => {
    const input = [...document.querySelectorAll('[data-preset-cat]')].find(item => !item.checked)
    input.checked = true
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  assert.equal(await evalJs(`document.querySelector('#status-state').textContent`), '有未保存修改')

  // 高级 JSON：格式化并应用，页面不应报错。
  await evalJs(`document.querySelector('[data-mode="advanced"]').click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('#advanced-json'))`))
  await evalJs(`document.querySelector('[data-action="format-json"]').click(); true`)
  await waitForPage(() => evalJs(`document.querySelector('#advanced-json').value.includes('"schemaVersion"')`))
  await evalJs(`document.querySelector('[data-action="apply-json"]').click(); true`)
  assert.match(await evalJs(`document.querySelector('#status-msg').textContent`), /JSON 已应用/)

  // 回到卡片页截图，浅色 + 暗色各一张。
  await evalJs(`document.querySelector('[data-mode="cards"]').click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('[data-card-field="name_zh"]'))`))
  const shotDir = join(ROOT, 'release', 'face-tests')
  await mkdir(shotDir, { recursive: true })
  const light = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(shotDir, 'face-cards-editor.png'), Buffer.from(light.data, 'base64'))
  await cdp('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  })
  await new Promise(resolve => setTimeout(resolve, 250))
  const dark = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(shotDir, 'face-cards-editor-dark.png'), Buffer.from(dark.data, 'base64'))

  // 导入和导出按钮存在；真正下载/文件选择依赖 Electron，不在这里伪造。
  const actions = await evalJs(`[...document.querySelectorAll('.top-actions button')].map(button => button.textContent.trim())`)
  for (const label of ['导入 JSON', '导出 JSON', '恢复上一版', '恢复默认', '保存']) {
    assert.ok(actions.includes(label), `缺少按钮：${label}`)
  }

  console.log('✓ 桌面编辑器：三栏布局、46 维度和 484 张卡片正常载入')
  console.log('✓ 新增卡片：改名后标记未保存，PUT 携带 baseRevision 且总数变为 485')
  console.log('✓ 预设方案：14 套预设可编辑，卡片勾选会同步修改目录')
  console.log('✓ 高级 JSON：格式化与应用正常，不产生脚本异常')
  console.log('✓ 界面：浅色与暗色截图已输出到 release/face-tests/')
} finally {
  try { ws?.close() } catch {}
  if (chrome && !chrome.killed) chrome.kill()
  await new Promise(resolve => setTimeout(resolve, 400))
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

async function waitForPage(check, timeoutMs = 10_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check().catch(() => false)) return
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  throw new Error('页面等待超时')
}

async function waitForDevTools(profileDir) {
  const file = join(profileDir, 'DevToolsActivePort')
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
