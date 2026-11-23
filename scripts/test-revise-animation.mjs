import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'release', 'revise-tests', `probe-${Date.now()}`)
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PASSWORD = 'revise-animation-test'
const chatRequests = []
await mkdir(OUT, { recursive: true })

const mock = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'codex/gpt-image-2', kind: 'image', display_name: 'GPT Image 2' }] }))
    return
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}')
    chatRequests.push({ at: Date.now(), body })
    const text = JSON.stringify(body)
    if (text.includes('FAIL_REVISE')) {
      setTimeout(() => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: '模拟改写失败' } }))
      }, 350)
      return
    }
    if (text.includes('NETWORK_REVISE')) {
      setTimeout(() => {
        req.destroy()
        res.destroy()
      }, 250)
      return
    }
    const delay = text.includes('TIMEOUT_REVISE')
      ? 7000
      : text.includes('FAST_REVISE')
        ? 40
        : text.includes('SLOW_REVISE')
          ? 3200
          : 1400
    setTimeout(() => {
      if (res.destroyed) return
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'mock-chat',
        choices: [{
          message: { content: '一只橘猫坐在清晨的木窗台上，水彩画风格，晨光柔和' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 },
      }))
    }, delay)
    return
  }
  res.writeHead(404).end()
})
await new Promise(r => mock.listen(0, '127.0.0.1', r))
const mockBase = `http://127.0.0.1:${mock.address().port}`

const port = await freePort()
const app = spawn(process.execPath, [join(ROOT, 'server', 'dist', 'main.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    MAGPIE_BASE_URL: mockBase,
    MAGPIE_IMAGE_MODEL: 'codex/gpt-image-2',
    MAGPIE_TEXT_MODEL: 'mock-chat',
    ADMIN_SETUP_KEY: 'revise-setup',
    USER_DATABASE_PATH: join(OUT, 'users.json'),
    USAGE_DATABASE_PATH: join(OUT, 'usage.json'),
    PROJECT_DATABASE_PATH: join(OUT, 'projects.json'),
    STORAGE_DIR: join(OUT, 'generated'),
    DATA_DIR: join(OUT, 'data'),
    LOG_DIR: join(OUT, 'logs'),
    STYLE_LIBRARY_PATH: join(OUT, 'styles'),
    UPDATE_CHECK_DISABLED: '1',
    PROMPT_OPTIMIZE_TIMEOUT_MS: '4500',
    IMAGE_CONCURRENCY: '2',
    SESSION_SECRET: 'revise-probe',
    SHUTDOWN_TOKEN: 'shutdown',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOutput = ''
app.stdout.on('data', c => { serverOutput += c })
app.stderr.on('data', c => { serverOutput += c })

const base = `http://127.0.0.1:${port}`
let chrome
let ws
let nextId = 0
const pending = new Map()
try {
  await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 20_000, () => serverOutput)
  await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      setupKey: 'revise-setup',
      username: 'admin',
      displayName: '测试管理员',
      password: PASSWORD,
    }),
  })

  const profile = join(OUT, 'chrome-profile')
  await mkdir(profile, { recursive: true })
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' })
  const devPort = await waitForDevTools(profile)
  const target = await fetch(`http://127.0.0.1:${devPort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' }).then(r => r.json())
  ws = await connectCdp(target.webSocketDebuggerUrl)
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp('Page.navigate', { url: `${base}/login.html` })
  await waitForPage(() => evalJs(`document.readyState === 'complete' && Boolean(document.querySelector('#username'))`))
  await evalJs(`(() => {
    document.querySelector('#username').value = 'admin'
    document.querySelector('#password').value = ${JSON.stringify(PASSWORD)}
    document.querySelector('#login-submit').click()
    return true
  })()`)
  await waitForPage(() => evalJs(`location.pathname === '/batch.html' && document.querySelectorAll('#free-model option').length > 0`), 20_000)
  await evalJs(`document.querySelector('#tab-free')?.click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('#free-prompt'))`))

  const prompt = '一只橘猫坐在木窗台上，窗外是雨后的青苔庭院，水彩画风格'
  await evalJs(`(() => {
    const input = document.querySelector('#free-prompt')
    input.value = ${JSON.stringify(prompt)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

  await openPanel()
  await setInstruction('改成清晨')
  const before = await snapshot('before')
  assert.equal(before.hidden, false)
  assert.equal(before.classes.includes('is-loading'), false)
  assert.equal(before.resultHidden, true)
  await evalJs(`document.querySelector('#free-revise-run').click(); true`)

  const t100 = await waitSnapshot('loading', 100)
  const t450 = await waitSnapshot('loading-450', 350)
  await screenshot('loading-450')
  const t700 = await waitSnapshot('loading-700', 250)
  await screenshot('loading')
  assert.equal(t100.classes.includes('is-loading'), true)
  assert.equal(t100.spinner, true)
  assert.equal(t100.pseudoAnimation, 'revise-inline-sweep')
  assert.equal(t100.pseudoTransform, 'none')
  assert.ok(Number(t100.bodyOpacity) < 1)
  assert.equal(t700.panelHeight, before.panelHeight)
  assert.equal(t700.pseudoTransform, 'none')
  await waitForPage(() => evalJs(`document.querySelector('#free-revise').classList.contains('has-result')`), 10_000)
  const done = await snapshot('done')
  await sleep(600)
  const doneLater = await snapshot('done-600')
  await screenshot('done')
  assert.equal(done.classes.includes('is-loading'), false)
  assert.equal(done.classes.includes('has-result'), true)
  assert.equal(done.resultHidden, false)
  assert.equal(done.spinner, false)
  assert.equal(done.runText, '应用')
  assert.equal(doneLater.spinner, false)
  assert.equal(doneLater.pseudoAnimation, 'none')

  // 连续改写：点“重新改写”后立即再发，确认不会叠出两个 loading spinner
  await evalJs(`document.querySelector('#free-revise-again').click(); true`)
  await setInstruction('改成清晨')
  const callsBeforeDouble = chatRequests.length
  await evalJs(`document.querySelector('#free-revise-run').click(); document.querySelector('#free-revise-run').click(); true`)
  await sleep(200)
  const double = await snapshot('double')
  await waitForPage(() => evalJs(`document.querySelector('#free-revise').classList.contains('has-result')`), 10_000)
  const doubleCalls = chatRequests.length - callsBeforeDouble
  assert.equal(doubleCalls, 1)
  assert.equal(double.spinner, true)

  // 长耗时改写：3.2 秒内动画持续，完成后正常收尾
  await evalJs(`document.querySelector('#free-revise-again').click(); true`)
  await setInstruction('SLOW_REVISE 改成清晨')
  await evalJs(`document.querySelector('#free-revise-run').click(); true`)
  const slowMid = await waitSnapshot('slow-mid', 900)
  assert.equal(slowMid.classes.includes('is-loading'), true)
  assert.equal(slowMid.spinner, true)
  await waitForPage(() => evalJs(`document.querySelector('#free-revise').classList.contains('has-result')`), 10_000)
  const slowDone = await snapshot('slow-done')
  assert.equal(slowDone.classes.includes('is-loading'), false)
  assert.equal(slowDone.spinner, false)
  assert.equal(slowDone.resultHidden, false)

  // 取消：收起面板后旧请求不能把面板重新点亮
  await evalJs(`document.querySelector('#free-revise-again').click(); true`)
  await setInstruction('SLOW_REVISE 改成清晨')
  await evalJs(`document.querySelector('#free-revise-run').click(); true`)
  await sleep(250)
  const cancelLoading = await snapshot('cancel-loading')
  await evalJs(`document.querySelector('#free-revise-cancel').click(); true`)
  await sleep(300)
  const canceled = await snapshot('canceled')
  await sleep(3500)
  const canceledLater = await snapshot('canceled-3.5s')
  assert.equal(canceled.hidden, true)
  assert.equal(canceled.classes.includes('is-loading'), false)
  assert.equal(canceled.spinner, false)
  assert.equal(canceledLater.hidden, true)
  assert.equal(canceledLater.resultHidden, true)

  // 失败：动画必须收起，按钮恢复
  await openPanel()
  await setInstruction('FAIL_REVISE 改成清晨')
  await evalJs(`document.querySelector('#free-revise-run').click(); true`)
  await waitForPage(() => evalJs(`document.querySelector('#free-revise-status').textContent.includes('模拟改写失败')`), 10_000)
  const failed = await snapshot('failed')
  assert.equal(failed.classes.includes('is-loading'), false)
  assert.equal(failed.spinner, false)
  assert.equal(failed.runDisabled, false)
  assert.equal(failed.runText, '开始改写')

  await setInstruction('FAST_REVISE 改成清晨')
  await evalJs(`document.querySelector('#free-revise-run').click(); true`)
  await waitForPage(() => evalJs(`document.querySelector('#free-revise').classList.contains('has-result')`), 10_000)
  const fastDone = await snapshot('fast-done')
  assert.equal(fastDone.classes.includes('is-loading'), false)
  assert.equal(fastDone.spinner, false)

  await evalJs(`document.querySelector('#free-revise-again').click(); true`)
  await setInstruction('NETWORK_REVISE 改成清晨')
  await evalJs(`document.querySelector('#free-revise-run').click(); true`)
  await waitForPage(() => evalJs(`!document.querySelector('#free-revise').classList.contains('is-loading') && document.querySelector('#free-revise-status').textContent.trim() && document.querySelector('#free-revise-status').textContent.trim() !== '正在改写…'`), 10_000)
  const networkFailed = await snapshot('network-failed')
  assert.equal(networkFailed.classes.includes('is-loading'), false)
  assert.equal(networkFailed.spinner, false)
  assert.equal(networkFailed.runDisabled, false)

  await setInstruction('TIMEOUT_REVISE 改成清晨')
  await evalJs(`document.querySelector('#free-revise-run').click(); true`)
  await waitForPage(() => evalJs(`!document.querySelector('#free-revise').classList.contains('is-loading') && document.querySelector('#free-revise-status').textContent.includes('超时')`), 10_000)
  const timeoutFailed = await snapshot('timeout-failed')
  assert.equal(timeoutFailed.classes.includes('is-loading'), false)
  assert.equal(timeoutFailed.spinner, false)
  assert.equal(timeoutFailed.runDisabled, false)

  // 减少动画偏好
  await evalJs(`document.querySelector('#free-revise-again')?.click(); true`)
  await setInstruction('SLOW_REVISE 改成清晨')
  await cdp('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  await evalJs(`document.querySelector('#free-revise-run').click(); true`)
  await sleep(250)
  const reduced = await snapshot('reduced-motion')
  assert.equal(reduced.spinnerAnimation, 'none')
  assert.equal(reduced.pseudoAnimation, 'none')
  assert.equal(reduced.pseudoOpacity, '0.65')
  await evalJs(`document.querySelector('#free-revise-cancel').click(); true`)
  await cdp('Emulation.setEmulatedMedia', { features: [] })

  // 资产弹窗入口：验证另一套 ai-busy 动画也能启动、结束、关窗后收尾
  const project = await evalJs(`fetch('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '改写动画测试' }),
  }).then(r => r.json())`)
  const projectId = project?.project?.id
  await evalJs(`fetch('/api/projects/${projectId}', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assets: [{
        id: 'revise-animation-asset',
        type: 'role',
        name: '测试角色',
        fields: [{ label: '角色', value: '测试角色' }],
        raw: '',
        ratio: '3:4',
        styleId: '',
        status: 'idle',
        prompt: '一只橘猫坐在木窗台上，水彩画风格',
        resultUrl: '',
        width: 0,
        height: 0,
        error: '',
        updatedAt: new Date().toISOString(),
      }],
    }),
  }).then(r => r.json())`)
  await evalJs(`fetch('/api/projects/${projectId}/activate', { method: 'POST' }).then(r => r.json())`)
  await cdp('Page.navigate', { url: `${base}/batch.html` })
  await waitForPage(() => evalJs(`document.querySelector('[data-count="role"]')?.textContent.trim() === '1'`), 20_000)
  await evalJs(`document.querySelector('[data-mode="batch"]').click(); true`)
  await waitForPage(() => evalJs(`!document.querySelector('#tab-role').disabled`))
  await evalJs(`document.querySelector('#tab-role').click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('.asset-name-button'))`))
  await evalJs(`document.querySelector('.asset-name-button').click(); true`)
  await waitForPage(() => evalJs(`document.querySelector('#asset-modal').classList.contains('visible')`))
  await evalJs(`document.querySelector('#modal-revise-prompt').click(); true`)
  await waitForPage(() => evalJs(`document.querySelector('#revise-modal').classList.contains('visible')`))
  await evalJs(`(() => {
    const input = document.querySelector('#revise-instruction')
    input.value = '改成清晨'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('#revise-run').click()
    return true
  })()`)
  await sleep(150)
  const modalLoading = await snapshotModal('modal-loading')
  assert.equal(modalLoading.busyClass, true)
  assert.equal(modalLoading.layer, true)
  assert.equal(modalLoading.runDisabled, true)
  await waitForPage(() => evalJs(`document.querySelector('#revise-result-wrap').hidden === false`), 10_000)
  await sleep(150)
  const modalDone = await snapshotModal('modal-done')
  assert.equal(modalDone.busyClass, false)
  assert.equal(modalDone.layer, false)

  await evalJs(`(() => {
    const input = document.querySelector('#revise-instruction')
    input.value = 'SLOW_REVISE 改成清晨'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('#revise-run').click()
    return true
  })()`)
  await sleep(200)
  const modalSlow = await snapshotModal('modal-slow')
  assert.equal(modalSlow.busyClass, true)
  await evalJs(`document.querySelector('#revise-close').click(); true`)
  await sleep(150)
  const modalClosedBusy = await snapshotModal('modal-closed-busy')
  await sleep(3600)
  const modalClosedDone = await snapshotModal('modal-closed-done')
  assert.equal(modalClosedBusy.modalVisible, false)
  assert.equal(modalClosedBusy.busyClass, true)
  assert.match(modalClosedBusy.pill, /AI 仍在改写/)
  assert.equal(modalClosedDone.busyClass, false)
  assert.equal(modalClosedDone.layer, false)

  const report = { before, t100, t450, t700, done, doneLater, double, doubleCalls, slowMid, slowDone, cancelLoading, canceled, canceledLater, failed, fastDone, networkFailed, timeoutFailed, reduced, modalLoading, modalDone, modalSlow, modalClosedBusy, modalClosedDone, chatCount: chatRequests.length }
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log('✓ 改写开始：加载态、转圈、扫光条启动，面板高度不跳')
  console.log('✓ 扫光条限制在面板内，不再横穿页面')
  console.log('✓ 改写完成：加载态清理，结果淡入，按钮切到“应用”')
  console.log('✓ 连续点击只发出一次请求，不会叠多个转圈')
  console.log('✓ 长耗时改写：3.2 秒内动画持续，完成后正常收尾')
  console.log('✓ 取消：面板收起、请求中止，旧结果不会回填')
  console.log('✓ 失败 / 网络中断 / 超时：动画都能结束，按钮恢复')
  console.log('✓ 减少动态效果：扫光和转圈停止，保留静态提示')
  console.log('✓ 资产弹窗改写：忙碌层正常开始、结束，关窗后仍能收尾')
  console.log(`测试报告：${join(OUT, 'report.json')}`)
} finally {
  try { await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'x-shutdown-token': 'shutdown' } }) } catch {}
  try { ws?.close() } catch {}
  setTimeout(() => {
    if (chrome && !chrome.killed) chrome.kill()
    if (!app.killed) app.kill()
  }, 500).unref()
  mock.close()
}

async function openPanel() {
  if (await evalJs(`document.querySelector('#free-revise').hidden`)) {
    await evalJs(`document.querySelector('#free-prompt-revise').click(); true`)
    await waitForPage(() => evalJs(`!document.querySelector('#free-revise').hidden`))
  }
}

async function setInstruction(text) {
  await evalJs(`(() => {
    const input = document.querySelector('#free-revise-instruction')
    input.value = ${JSON.stringify(text)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

async function snapshot(label) {
  return evalJs(`(() => {
    const panel = document.querySelector('#free-revise')
    const body = panel.querySelector('.revise-inline-body')
    const chip = panel.querySelector('.revise-inline-chip')
    const run = document.querySelector('#free-revise-run')
    const spinner = panel.querySelector('.revise-inline-spin')
    const pseudo = getComputedStyle(panel, '::before')
    const result = document.querySelector('#free-revise-result')
    return {
      label: ${JSON.stringify(label)},
      hidden: panel.hidden,
      classes: panel.className,
      panelHeight: panel.getBoundingClientRect().height,
      panelOverflow: getComputedStyle(panel).overflow,
      bodyDisplay: getComputedStyle(body).display,
      bodyOpacity: getComputedStyle(body).opacity,
      chipOpacity: getComputedStyle(chip).opacity,
      runText: run.textContent.trim(),
      runHtml: run.innerHTML,
      runDisabled: run.disabled,
      spinner: Boolean(spinner),
      spinnerAnimation: spinner ? getComputedStyle(spinner).animationName : '',
      pseudoOpacity: pseudo.opacity,
      pseudoAnimation: pseudo.animationName,
      pseudoTransform: pseudo.transform,
      status: document.querySelector('#free-revise-status').textContent,
      resultHidden: result.hidden,
      resultHeight: result.hidden ? 0 : result.getBoundingClientRect().height,
      promptValue: document.querySelector('#free-prompt').value,
    }
  })()`)
}

async function snapshotModal(label) {
  return evalJs(`(() => {
    const field = document.querySelector('#modal-prompt-field')
    const layer = field?.querySelector('.ai-busy-layer')
    const pill = layer?.querySelector('.ai-busy-text')
    const modal = document.querySelector('#revise-modal')
    return {
      label: ${JSON.stringify(label)},
      modalVisible: modal.classList.contains('visible'),
      busyClass: field?.classList.contains('is-ai-busy') || false,
      layer: Boolean(layer),
      pill: pill?.textContent || '',
      runDisabled: document.querySelector('#revise-run').disabled,
      runText: document.querySelector('#revise-run').textContent.trim(),
      status: document.querySelector('#revise-status').textContent,
      resultHidden: document.querySelector('#revise-result-wrap').hidden,
      promptPaddingTop: field ? getComputedStyle(document.querySelector('#modal-prompt')).paddingTop : '',
    }
  })()`)
}

async function waitSnapshot(label, delay) {
  await sleep(delay)
  return snapshot(label)
}

async function screenshot(label) {
  const result = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(OUT, `${label}.png`), Buffer.from(result.data, 'base64'))
}

async function evalJs(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本执行失败')
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
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
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
    await sleep(100)
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
    await sleep(150)
  }
  throw new Error('Chrome DevTools 没有启动')
}

async function waitFor(check, timeoutMs, output) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try { if (await check()) return } catch {}
    await sleep(250)
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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
