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
  const readonlyPrompts = await evalJs(`(() => {
    const full = document.querySelector('#prompt-full')
    const negative = document.querySelector('#prompt-negative')
    const before = full.value
    full.focus()
    full.setSelectionRange(0, 0)
    return {
      full: full.readOnly,
      negative: negative.readOnly,
      fullAria: full.getAttribute('aria-readonly'),
      negativeAria: negative.getAttribute('aria-readonly'),
      before,
    }
  })()`)
  assert.equal(readonlyPrompts.full, true)
  assert.equal(readonlyPrompts.negative, true)
  assert.equal(readonlyPrompts.fullAria, 'true')
  assert.equal(readonlyPrompts.negativeAria, 'true')
  await cdp('Input.insertText', { text: '禁止写入' })
  assert.equal(await evalJs(`document.querySelector('#prompt-full').value`), readonlyPrompts.before)
  await evalJs(`(() => {
    document.querySelector('.tab[data-tab="negative"]').click()
    const area = document.querySelector('#prompt-negative')
    area.focus()
    area.setSelectionRange(0, 0)
    return area.value
  })()`).then(async before => {
    await cdp('Input.insertText', { text: '禁止写入' })
    assert.equal(await evalJs(`document.querySelector('#prompt-negative').value`), before)
  })
  await evalJs(`document.querySelector('.tab[data-tab="full"]').click(); true`)

  await evalJs(`document.querySelector('#open-presets').click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('#modal [data-preset="preset_clear_classic"]'))`))
  await evalJs(`document.querySelector('#modal [data-preset="preset_clear_classic"]').click(); true`)
  await waitForPage(() => evalJs(`document.querySelector('#prompt-full')?.value.includes('瑞凤眼')`))
  assert.equal(await evalJs(`document.querySelector('#handoff-btn')?.disabled`), false)

  await evalJs(`document.querySelector('[data-group-head="eyes"]').click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('#nav [data-cat="eye_shape"]'))`))
  await evalJs(`document.querySelector('#nav [data-cat="eye_shape"]').click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('.card[data-id="eye_almond"]'))`))
  await waitForPage(() => evalJs(`Boolean(document.querySelector('.card[data-id="eye_almond"] img')?.naturalWidth)`))
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

  // 同类卡片关闭状态下必须保持统一宽高比；详情展开后才允许变高。
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1220,
    height: 896,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await cdp('Page.navigate', { url: `${base}/face.html` })
  await waitForPage(() => evalJs(`Boolean(window.__faceStudio)`), 20_000)
  await evalJs(`(() => {
    document.querySelector('[data-group-head="eyes"]')?.click()
    document.querySelector('#nav [data-cat="eye_spacing"]')?.click()
    return true
  })()`)
  await waitForPage(() => evalJs(`document.querySelectorAll('#cards .card.no-ref').length >= 3`))
  const noRefRatios = await evalJs(`(() => [...document.querySelectorAll('#cards .card:not(.is-open)')].map(card => {
    const rect = card.getBoundingClientRect()
    return { ratio: rect.width / rect.height, width: rect.width, height: rect.height }
  }))()`)
  assert.ok(noRefRatios.length >= 3)
  assert.ok(Math.max(...noRefRatios.map(item => item.ratio)) - Math.min(...noRefRatios.map(item => item.ratio)) < 0.01)
  assert.ok(noRefRatios.every(item => Math.abs(item.ratio - 0.94) < 0.02))
  const noRefOverflow = await evalJs(`(() => [...document.querySelectorAll('#cards .card:not(.is-open)')].map(card => {
    const body = card.querySelector('.card-body')
    return { id: card.dataset.id, overflow: body.scrollHeight - body.clientHeight }
  }).filter(item => item.overflow > 1))()`)
  assert.deepEqual(noRefOverflow, [])

  await evalJs(`(() => {
    document.querySelector('#nav [data-cat="eye_shape"]')?.click()
    return true
  })()`)
  await waitForPage(() => evalJs(`document.querySelectorAll('#cards .card:not(.no-ref)').length >= 16`))
  const imageRatios = await evalJs(`(() => [...document.querySelectorAll('#cards .card:not(.is-open):not(.no-ref)')].map(card => {
    const rect = card.getBoundingClientRect()
    return rect.width / rect.height
  }))()`)
  assert.ok(Math.max(...imageRatios) - Math.min(...imageRatios) < 0.01)
  assert.ok(imageRatios.every(ratio => Math.abs(ratio - 0.52) < 0.02))
  const imageOverflow = await evalJs(`(() => [...document.querySelectorAll('#cards .card:not(.is-open):not(.no-ref)')].map(card => {
    const body = card.querySelector('.card-body')
    return { id: card.dataset.id, overflow: body.scrollHeight - body.clientHeight }
  }).filter(item => item.overflow > 1))()`)
  assert.deepEqual(imageOverflow, [])

  const allNoRefOverflow = await evalJs(`(async () => {
    const failures = []
    for (const category of window.__faceStudio.data.categories) {
      document.querySelector('[data-group-head="' + category.group + '"]')?.click()
      await new Promise(resolve => requestAnimationFrame(resolve))
      document.querySelector('#nav [data-cat="' + category.key + '"]')?.click()
      await new Promise(resolve => requestAnimationFrame(resolve))
      for (const card of document.querySelectorAll('#cards .card.no-ref:not(.is-open)')) {
        const body = card.querySelector('.card-body')
        const overflow = body.scrollHeight - body.clientHeight
        if (overflow > 1) failures.push({ category: category.key, id: card.dataset.id, overflow })
      }
    }
    return failures
  })()`)
  assert.deepEqual(allNoRefOverflow, [])

  const shotDir = join(ROOT, 'release', 'face-tests')
  await mkdir(shotDir, { recursive: true })
  await evalJs(`(() => {
    document.querySelector('[data-group-head="eyes"]')?.click()
    document.querySelector('#nav [data-cat="eye_spacing"]')?.click()
    return true
  })()`)
  await waitForPage(() => evalJs(`document.querySelectorAll('#cards .card.no-ref').length >= 3`))
  const ratioShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(shotDir, 'face-card-ratios.png'), Buffer.from(ratioShot.data, 'base64'))

  // 大屏会被页面自动放大到 1.25 倍；工作区高度必须换算回真实可视高度，
  // 否则底部页脚和最后一行卡片会滚出屏幕，永远到不了。
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await cdp('Page.navigate', { url: `${base}/face.html` })
  await waitForPage(() => evalJs(`Boolean(window.__faceStudio)`), 20_000)
  await evalJs(`(() => {
    document.querySelector('[data-group-head="eyes"]')?.click()
    document.querySelector('#nav [data-cat="eye_shape"]')?.click()
    return true
  })()`)
  await waitForPage(() => evalJs(`document.querySelectorAll('#cards .card').length >= 16`))
  const scrollLayout = await evalJs(`(() => {
    const workspace = document.querySelector('.workspace').getBoundingClientRect()
    const wrap = document.querySelector('.cards-wrap')
    const foot = document.querySelector('.stage-foot').getBoundingClientRect()
    wrap.scrollTop = wrap.scrollHeight
    return new Promise(resolve => requestAnimationFrame(() => {
      const last = [...document.querySelectorAll('#cards .card')].at(-1).getBoundingClientRect()
      resolve({
        workspaceBottom: workspace.bottom,
        innerHeight,
        headerHeight: document.querySelector('.topbar').getBoundingClientRect().height,
        footerBottom: foot.bottom,
        lastCardBottom: last.bottom,
        wrapBottom: wrap.getBoundingClientRect().bottom,
        atBottom: wrap.scrollTop >= wrap.scrollHeight - wrap.clientHeight - 2,
      })
    }))
  })()`)
  assert.ok(scrollLayout.workspaceBottom <= scrollLayout.innerHeight + 1)
  assert.ok(scrollLayout.footerBottom <= scrollLayout.innerHeight + 1)
  assert.ok(scrollLayout.lastCardBottom <= scrollLayout.wrapBottom + 1)
  assert.equal(scrollLayout.atBottom, true)
  assert.ok(scrollLayout.headerHeight < 80)

  // 46 个维度共用同一个滚动区，逐个切过去，确认没有哪一页把底部卡住。
  const dimensionScroll = await evalJs(`(async () => {
    const failures = []
    const categories = window.__faceStudio.data.categories
    for (const category of categories) {
      document.querySelector('[data-group-head="' + category.group + '"]')?.click()
      await new Promise(resolve => requestAnimationFrame(resolve))
      document.querySelector('#nav [data-cat="' + category.key + '"]')?.click()
      await new Promise(resolve => requestAnimationFrame(resolve))
      const wrap = document.querySelector('.cards-wrap')
      const foot = document.querySelector('.stage-foot').getBoundingClientRect()
      wrap.scrollTop = wrap.scrollHeight
      await new Promise(resolve => requestAnimationFrame(resolve))
      const card = [...document.querySelectorAll('#cards .card')].at(-1)
      const last = card?.getBoundingClientRect()
      if (foot.bottom > innerHeight + 1 || (last && last.bottom > wrap.getBoundingClientRect().bottom + 1)) {
        failures.push({ key: category.key, footBottom: foot.bottom, lastBottom: last?.bottom || 0 })
      }
    }
    return { count: categories.length, failures }
  })()`)
  assert.equal(dimensionScroll.count, 46)
  assert.deepEqual(dimensionScroll.failures, [])

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

  await cdp('Page.navigate', { url: `${base}/face.html` })
  await waitForPage(() => evalJs(`Boolean(window.__faceStudio)`), 20_000)
  const beforeReset = await evalJs(`({
    name: window.__faceStudio.store.scheme.name,
    selected: Object.values(window.__faceStudio.store.scheme.selections).reduce((sum, ids) => sum + ids.length, 0),
  })`)
  assert.ok(beforeReset.selected > 0)
  await evalJs(`document.querySelector('#reset-all').click(); true`)
  await waitForPage(() => evalJs(`!document.querySelector('#modal-overlay').hidden && Boolean(document.querySelector('#modal [data-confirm]'))`))
  await evalJs(`document.querySelector('#modal [data-confirm]').click(); true`)
  await waitForPage(() => evalJs(`document.querySelector('#panel-toggle-count')?.textContent === '0'`))
  const afterReset = await evalJs(`({
    name: window.__faceStudio.store.scheme.name,
    selections: window.__faceStudio.store.scheme.selections,
    strengths: window.__faceStudio.store.scheme.strengths,
    role: window.__faceStudio.store.scheme.role,
    notes: window.__faceStudio.store.scheme.customNotes,
    category: window.__faceStudio.store.state.ui.category,
    title: document.querySelector('#cat-title').textContent,
    prompt: document.querySelector('#prompt-full').value,
  })`)
  assert.equal(afterReset.name, beforeReset.name)
  assert.deepEqual(afterReset.selections, {})
  assert.deepEqual(afterReset.strengths, {})
  assert.equal(afterReset.role, '')
  assert.equal(afterReset.notes, '')
  assert.equal(afterReset.category, 'face_shape')
  assert.equal(afterReset.title, '整体脸型')
  assert.equal(afterReset.prompt.includes('瑞凤眼'), false)

  await evalJs(`document.querySelector('#randomize-btn').click(); true`)
  await waitForPage(() => evalJs(`Number(document.querySelector('#panel-toggle-count')?.textContent || 0) > 30`))
  const randomized = await evalJs(`(() => {
    const studio = window.__faceStudio
    const scheme = studio.store.scheme
    const selected = Object.values(scheme.selections).reduce((sum, ids) => sum + ids.length, 0)
    const singleViolations = studio.data.categories.filter(category =>
      category.select_mode === 'single' && (scheme.selections[category.key] || []).length > 1
    ).map(category => category.key)
    const maxViolations = studio.data.categories.filter(category =>
      (scheme.selections[category.key] || []).length > Number(category.max_select || 1)
    ).map(category => category.key)
    const conflicts = studio.data.conflict_rules.filter(rule =>
      (scheme.selections[rule.left_category] || []).includes(rule.left) &&
      (scheme.selections[rule.right_category] || []).includes(rule.right)
    ).map(rule => [rule.left, rule.right])
    const badStrengths = Object.values(scheme.strengths).flatMap(group => Object.values(group))
      .filter(value => value < 2 || value > 4)
    return {
      selected,
      singleViolations,
      maxViolations,
      conflicts,
      badStrengths,
      style: scheme.visualStyle,
      styleExists: studio.data.visual_styles.some(style => style.id === scheme.visualStyle),
      prompt: document.querySelector('#prompt-full').value,
      promptReadonly: document.querySelector('#prompt-full').readOnly,
      buttonVisible: document.querySelector('#randomize-btn').getBoundingClientRect().right <= innerWidth,
    }
  })()`)
  assert.ok(randomized.selected > 30)
  assert.deepEqual(randomized.singleViolations, [])
  assert.deepEqual(randomized.maxViolations, [])
  assert.deepEqual(randomized.conflicts, [])
  assert.deepEqual(randomized.badStrengths, [])
  assert.equal(randomized.styleExists, true)
  assert.ok(randomized.prompt.length > 40)
  assert.equal(randomized.promptReadonly, true)
  assert.equal(randomized.buttonVisible, true)

  await evalJs(`document.querySelector('#randomize-btn').click(); true`)
  await waitForPage(() => evalJs(`!document.querySelector('#modal-overlay').hidden && Boolean(document.querySelector('#modal [data-confirm]'))`))
  await evalJs(`document.querySelector('#modal [data-confirm]').click(); true`)
  await waitForPage(() => evalJs(`document.querySelector('#modal-overlay').hidden && Number(document.querySelector('#panel-toggle-count')?.textContent || 0) > 30`))

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
    resetVisible: (() => {
      const button = document.querySelector('#reset-all')
      const rect = button?.getBoundingClientRect()
      return Boolean(button && rect && rect.width > 0 && rect.height > 0 && getComputedStyle(button).display !== 'none')
    })(),
    randomVisible: (() => {
      const button = document.querySelector('#randomize-btn')
      const rect = button?.getBoundingClientRect()
      return Boolean(button && rect && rect.width > 0 && rect.height > 0 && getComputedStyle(button).display !== 'none')
    })(),
  })`)
  assert.ok(mobile.scrollWidth <= mobile.innerWidth + 2)
  assert.equal(mobile.toggle, true)
  assert.equal(mobile.resetVisible, true)
  assert.equal(mobile.randomVisible, true)

  const shot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(shotDir, 'face-page-mobile.png'), Buffer.from(shot.data, 'base64'))

  console.log('✓ 捏脸页：服务端目录 484 条特征 / 46 维度 / 14 预设 / 16 张内置图')
  console.log('✓ 预设与提示词：载入清冷古典美人后实时生成完整提示词')
  console.log('✓ 提示词只读：完整提示词和负向词都无法用键盘增删改')
  console.log('✓ 服务端资产：参考图从 /face-assets/ 正常加载')
  console.log('✓ 账号隔离：本地状态键包含当前 userId')
  console.log('✓ 服务端修改：改名后客户端重新加载可见，恢复默认后还原')
  console.log('✓ 卡片比例：同类卡片宽高比一致，详情展开时才变高')
  console.log('✓ 大屏滚动：1.25 倍缩放下工作区不超出视口，最后一行和页脚都能滚到')
  console.log('✓ 全维度滚动：46 个维度逐页检查，最后一行都没有被底部截断')
  console.log('✓ 恢复空白：清空全部选择与设定、保留方案名称，移动端按钮仍可见')
  console.log('✓ 随机生成：符合单选/多选上限、无冲突、提示词只读，并支持确认后重新生成')
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
