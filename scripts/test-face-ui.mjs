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
  const memoryStorage = new Map()
  globalThis.window = { __FACE_USER_ID__: 'scope-migration' }
  globalThis.localStorage = {
    clear: () => memoryStorage.clear(),
    getItem: key => memoryStorage.get(key) ?? null,
    setItem: (key, value) => memoryStorage.set(key, String(value)),
  }
  const { Store } = await import('../web/src/face-app/store.js')
  const seedCatalog = JSON.parse(await readFile(join(ROOT, 'server', 'assets', 'face', 'catalog-seed.json'), 'utf8'))
  const migrateScope = (legacyValue) => {
    memoryStorage.clear()
    const initial = new Store(seedCatalog)
    initial.save()
    const state = JSON.parse(memoryStorage.get(`huajing.faceStudio.v1.${globalThis.window.__FACE_USER_ID__}`))
    delete state.ui.randomGenderScope
    if (legacyValue === undefined) delete state.ui.randomGenderAware
    else state.ui.randomGenderAware = legacyValue
    memoryStorage.set(`huajing.faceStudio.v1.${globalThis.window.__FACE_USER_ID__}`, JSON.stringify(state))
    const migrated = new Store(seedCatalog)
    assert.equal(migrated.state.ui.randomGenderAware, undefined)
    return migrated.state.ui.randomGenderScope
  }
  assert.equal(migrateScope(undefined), 'mixed')
  assert.equal(migrateScope(false), 'any')
  assert.equal(migrateScope(true), 'mixed')
  memoryStorage.clear()
  delete globalThis.window
  delete globalThis.localStorage

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
  assert.equal(catalog.total, 592)
  assert.equal(catalog.categories, 56)
  assert.equal(catalog.presets, 14)
  assert.equal(catalog.references, 272)
  assert.equal(catalog.title, '画境 · 捏脸')
  assert.equal(catalog.back, '/batch.html')
  assert.ok(catalog.userId)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('.card[data-id="face_oval"] .thumb img')?.naturalWidth)`))
  const faceShapeReference = await evalJs(`document.querySelector('.card[data-id="face_oval"] .thumb img')?.getAttribute('src')`)
  assert.match(faceShapeReference, /^\/face-assets\/references\/face\/face_shape\/face_oval\.webp$/)
  await waitForPage(() => evalJs(`(() => {
    const images = [...document.querySelectorAll('#cards .card .thumb img')]
    return images.length === 13 && images.every(image => image.complete && image.naturalWidth > 0)
  })()`), 15_000)
  await evalJs(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 350))))`)
  await mkdir(join(ROOT, 'release', 'face-tests'), { recursive: true })
  const faceShapeShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(ROOT, 'release', 'face-tests', 'face-shape-vectors-app.png'), Buffer.from(faceShapeShot.data, 'base64'))
  const hairExtension = await evalJs(`(() => {
    const studio = window.__faceStudio
    const categoryMap = new Map(studio.data.categories.map(category => [category.key, category]))
    const keys = [
      'hair_male_modern', 'hair_female_short', 'hair_curl_form', 'hair_curl_pattern',
      'hair_braid_cultural', 'hair_updo_detail', 'hairline_sideburn', 'hair_silhouette',
      'hair_state', 'hair_history',
    ]
    const scheme = {
      ...studio.store.scheme,
      selections: {
        hair_male_modern: ['hair_male_fade'],
        hair_curl_form: ['hair_curl_spring'],
        hair_curl_pattern: ['curl_3a'],
        hair_history: ['hair_history_china_tang_high'],
        hairline_sideburn: ['hairline_peaks'],
        hair_silhouette: ['hair_silhouette_high_crown'],
        hair_state: ['hair_state_static_drape'],
      },
      strengths: {},
    }
    const femaleScheme = {
      ...scheme,
      selections: { hair_female_short: ['hair_female_french_bob'] },
    }
    const full = studio.compiler.compile(scheme, { lang: 'zh', length: 'full', shot: 'headshot' }).full
    const compact = studio.compiler.compile(scheme, { lang: 'zh', length: 'compact', shot: 'headshot' }).zh
    const femaleFull = studio.compiler.compile(femaleScheme, { lang: 'zh', length: 'full', shot: 'headshot' }).full
    return {
      counts: Object.fromEntries(keys.map(key => [key, categoryMap.get(key)?.items.length || 0])),
      missingCategories: keys.filter(key => !categoryMap.has(key)),
      pendingRefs: keys.flatMap(key => categoryMap.get(key)?.items || [])
        .filter(item => item.reference_status !== 'pending' || item.reference_image).length,
      full,
      compact,
      femaleFull,
    }
  })()`)
  assert.deepEqual(hairExtension.missingCategories, [])
  assert.deepEqual(hairExtension.counts, {
    hair_male_modern: 14,
    hair_female_short: 10,
    hair_curl_form: 8,
    hair_curl_pattern: 9,
    hair_braid_cultural: 11,
    hair_updo_detail: 10,
    hairline_sideburn: 8,
    hair_silhouette: 8,
    hair_state: 7,
    hair_history: 23,
  })
  assert.equal(hairExtension.pendingRefs, 108)
  for (const phrase of [
    '两侧及后脑由短到长自然渐变',
    '卷束呈连续弹簧状',
    '形成较大、较松的螺旋卷束',
    '发束高高盘起，顶部体积饱满',
    '额头中央发际线形成自然尖角',
    '头顶发根自然蓬松，形成明显高颅顶轮廓',
    '发丝顺着重力自然向下延伸',
  ]) {
    assert.match(hairExtension.full, new RegExp(phrase))
    assert.match(hairExtension.compact, new RegExp(phrase))
  }
  assert.match(hairExtension.femaleFull, /发尾落在下巴附近/)

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

  await evalJs(`document.querySelector('#nav [data-cat="eye_corner"]').click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('.card[data-id="eye_corner_level"]'))`))
  await waitForPage(() => evalJs(`(() => {
    const images = [...document.querySelectorAll('#cards .card .thumb img')]
    return images.length === 7 && images.every(image => image.complete && image.naturalWidth > 0)
  })()`), 15_000)
  const eyeCornerReference = await evalJs(`document.querySelector('.card[data-id="eye_corner_high_up"] .thumb img')?.getAttribute('src')`)
  assert.match(eyeCornerReference, /^\/face-assets\/references\/eyes\/eye_corner\/eye_corner_high_up\.webp$/)
  await evalJs(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))`)
  const eyeCornerShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(ROOT, 'release', 'face-tests', 'eye-corner-references-app.png'), Buffer.from(eyeCornerShot.data, 'base64'))

  for (const [category, count, sampleId] of [
    ['eyelid', 9, 'lid_monolid'],
    ['eye_size', 5, 'eye_size_large'],
    ['eye_spacing', 3, 'eye_spacing_wide'],
    ['eye_position', 2, 'eye_position_high'],
    ['brow_eye', 5, 'brow_eye_defined'],
  ]) {
    await evalJs(`document.querySelector('#nav [data-cat="${category}"]').click(); true`)
    await waitForPage(() => evalJs(`Boolean(document.querySelector('.card[data-id="${sampleId}"]'))`))
    await waitForPage(() => evalJs(`(() => {
      const images = [...document.querySelectorAll('#cards .card .thumb img')]
      return images.length === ${count} && images.every(image => image.complete && image.naturalWidth > 0)
    })()`), 15_000)
  }
  await evalJs(`document.querySelector('#nav [data-cat="eyelid"]').click(); true`)
  await waitForPage(() => evalJs(`(() => {
    const images = [...document.querySelectorAll('#cards .card .thumb img')]
    return images.length === 9 && images.every(image => image.complete && image.naturalWidth > 0)
  })()`), 15_000)
  const eyelidReference = await evalJs(`document.querySelector('.card[data-id="lid_inner_double"] .thumb img')?.getAttribute('src')`)
  assert.match(eyelidReference, /^\/face-assets\/references\/eyes\/eyelid\/lid_inner_double\.webp$/)
  await evalJs(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))`)
  const eyelidShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(ROOT, 'release', 'face-tests', 'eye-lid-references-app.png'), Buffer.from(eyelidShot.data, 'base64'))

  await evalJs(`document.querySelector('[data-group-head="hair"]').click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('#nav [data-cat="bangs"]'))`))
  await evalJs(`document.querySelector('#nav [data-cat="bangs"]').click(); true`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('.card[data-id="bang_air"]'))`))
  await waitForPage(() => evalJs(`(() => {
    const images = [...document.querySelectorAll('#cards .card .thumb img')]
    return images.length === 15 && images.every(image => image.complete && image.naturalWidth > 0)
  })()`), 15_000)
  const bangReference = await evalJs(`document.querySelector('.card[data-id="bang_air"] .thumb img')?.getAttribute('src')`)
  assert.match(bangReference, /^\/face-assets\/references\/hair\/bangs\/bang_air\.webp$/)
  await evalJs(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))`)
  const bangsShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(ROOT, 'release', 'face-tests', 'hair-bangs-app.png'), Buffer.from(bangsShot.data, 'base64'))

  for (const [category, count, sampleId] of [
    ['hair_cut', 15, 'cut_wolf'],
    ['braid', 12, 'braid_fishtail'],
    ['hair_style', 15, 'style_fluffy'],
    ['updo', 16, 'updo_high_ponytail'],
    ['hair_length', 12, 'hair_length_chin'],
    ['hair_part', 7, 'hair_part_center'],
    ['ancient_bun', 12, 'ancient_bun_double_ring'],
    ['hair_male_modern', 14, 'hair_male_quiff'],
    ['hair_female_short', 10, 'hair_female_french_bob'],
    ['hair_curl_form', 8, 'hair_curl_afro'],
    ['hair_curl_pattern', 9, 'curl_3b'],
    ['hair_state', 7, 'hair_state_windblown'],
    ['hair_braid_cultural', 11, 'hair_braid_bow'],
    ['hair_updo_detail', 10, 'hair_updo_ballet_bun'],
    ['hairline_sideburn', 8, 'hairline_peaks'],
    ['hair_silhouette', 8, 'hair_silhouette_high_crown'],
    ['hair_history', 23, 'hair_history_china_tang_high'],
  ]) {
    await evalJs(`document.querySelector('#nav [data-cat="${category}"]').click(); true`)
    await waitForPage(() => evalJs(`Boolean(document.querySelector('.card[data-id="${sampleId}"]'))`))
    await waitForPage(() => evalJs(`(() => {
      const images = [...document.querySelectorAll('#cards .card .thumb img')]
      return images.length === ${count} && images.every(image => image.complete && image.naturalWidth > 0)
    })()`), 15_000)
  }
  await evalJs(`document.querySelector('#nav [data-cat="hair_cut"]').click(); true`)
  await waitForPage(() => evalJs(`(() => {
    const images = [...document.querySelectorAll('#cards .card .thumb img')]
    return images.length === 15 && images.every(image => image.complete && image.naturalWidth > 0)
  })()`), 15_000)
  const cutReference = await evalJs(`document.querySelector('.card[data-id="cut_bob"] .thumb img')?.getAttribute('src')`)
  assert.match(cutReference, /^\/face-assets\/references\/hair\/hair_cut\/cut_bob\.webp$/)
  await evalJs(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))`)
  const hairCutShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(ROOT, 'release', 'face-tests', 'hair-cut-app.png'), Buffer.from(hairCutShot.data, 'base64'))

  await evalJs(`document.querySelector('#nav [data-cat="updo"]').click(); true`)
  await waitForPage(() => evalJs(`(() => {
    const images = [...document.querySelectorAll('#cards .card .thumb img')]
    return images.length === 16 && images.every(image => image.complete && image.naturalWidth > 0)
  })()`), 15_000)
  const updoReference = await evalJs(`document.querySelector('.card[data-id="updo_high_bun"] .thumb img')?.getAttribute('src')`)
  assert.match(updoReference, /^\/face-assets\/references\/hair\/updo\/updo_high_bun\.webp$/)
  await evalJs(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))`)
  const updoShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(ROOT, 'release', 'face-tests', 'hair-updo-app.png'), Buffer.from(updoShot.data, 'base64'))

  await evalJs(`document.querySelector('#nav [data-cat="ancient_bun"]').click(); true`)
  await waitForPage(() => evalJs(`(() => {
    const images = [...document.querySelectorAll('#cards .card .thumb img')]
    return images.length === 12 && images.every(image => image.complete && image.naturalWidth > 0)
  })()`), 15_000)
  const ancientBunReference = await evalJs(`document.querySelector('.card[data-id="ancient_bun_double_ring"] .thumb img')?.getAttribute('src')`)
  assert.match(ancientBunReference, /^\/face-assets\/references\/hair\/ancient_bun\/ancient_bun_double_ring\.webp$/)
  await evalJs(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))`)
  const ancientBunShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(ROOT, 'release', 'face-tests', 'hair-ancient-bun-app.png'), Buffer.from(ancientBunShot.data, 'base64'))

  await evalJs(`document.querySelector('#nav [data-cat="hair_length"]').click(); true`)
  await waitForPage(() => evalJs(`(() => {
    const images = [...document.querySelectorAll('#cards .card .thumb img')]
    return images.length === 12 && images.every(image => image.complete && image.naturalWidth > 0)
  })()`), 15_000)
  await evalJs(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))`)
  const hairLengthShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(ROOT, 'release', 'face-tests', 'hair-length-app.png'), Buffer.from(hairLengthShot.data, 'base64'))

  await evalJs(`document.querySelector('#nav [data-cat="hair_male_modern"]').click(); true`)
  await waitForPage(() => evalJs(`(() => {
    const images = [...document.querySelectorAll('#cards .card .thumb img')]
    return images.length === 14 && images.every(image => image.complete && image.naturalWidth > 0)
  })()`), 15_000)
  await evalJs(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))`)
  const maleModernShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(ROOT, 'release', 'face-tests', 'hair-male-modern-app.png'), Buffer.from(maleModernShot.data, 'base64'))

  await evalJs(`document.querySelector('#nav [data-cat="hair_curl_pattern"]').click(); true`)
  await waitForPage(() => evalJs(`(() => {
    const images = [...document.querySelectorAll('#cards .card .thumb img')]
    return images.length === 9 && images.every(image => image.complete && image.naturalWidth > 0)
  })()`), 15_000)
  await evalJs(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))`)
  const curlPatternShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(ROOT, 'release', 'face-tests', 'hair-curl-pattern-app.png'), Buffer.from(curlPatternShot.data, 'base64'))

  await evalJs(`document.querySelector('#nav [data-cat="hair_braid_cultural"]').click(); true`)
  await waitForPage(() => evalJs(`(() => {
    const images = [...document.querySelectorAll('#cards .card .thumb img')]
    return images.length === 11 && images.every(image => image.complete && image.naturalWidth > 0)
  })()`), 15_000)
  await evalJs(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))`)
  const braidCulturalShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(ROOT, 'release', 'face-tests', 'hair-braid-cultural-app.png'), Buffer.from(braidCulturalShot.data, 'base64'))

  await evalJs(`document.querySelector('#nav [data-cat="hair_history"]').click(); true`)
  await waitForPage(() => evalJs(`(() => {
    const images = [...document.querySelectorAll('#cards .card .thumb img')]
    return images.length === 23 && images.every(image => image.complete && image.naturalWidth > 0)
  })()`), 15_000)
  await evalJs(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))`)
  const hairHistoryShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(ROOT, 'release', 'face-tests', 'hair-history-app.png'), Buffer.from(hairHistoryShot.data, 'base64'))

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

  await evalJs(`(() => {
    document.querySelector('[data-group-head="hair"]')?.click()
    document.querySelector('#nav [data-cat="hair_male_modern"]')?.click()
    return true
  })()`)
  await waitForPage(() => evalJs(`document.querySelectorAll('#cards .card').length === 14`))
  const maleCards = await evalJs(`({
    cards: document.querySelectorAll('#cards .card').length,
    placeholders: [...document.querySelectorAll('#cards .card')].filter(card => card.classList.contains('no-ref')).length,
    images: document.querySelectorAll('#cards .card .thumb img').length,
  })`)
  assert.equal(maleCards.cards, 14)
  assert.equal(maleCards.placeholders, 0)
  assert.equal(maleCards.images, 14)
  await mkdir(join(ROOT, 'release', 'face-tests'), { recursive: true })
  const hairExtensionShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(ROOT, 'release', 'face-tests', 'face-hair-extension.png'), Buffer.from(hairExtensionShot.data, 'base64'))
  await evalJs(`(() => {
    const input = document.querySelector('#side-search-input')
    input.value = 'Fade Haircut'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await waitForPage(() => evalJs(`document.querySelectorAll('#cards .card').length === 1 && Boolean(document.querySelector('.card[data-id="hair_male_fade"]'))`))
  await evalJs(`(() => {
    const input = document.querySelector('#side-search-input')
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

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
    document.querySelector('#nav [data-cat="iris"]')?.click()
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
    document.querySelector('#nav [data-cat="iris"]')?.click()
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

  // 56 个维度共用同一个滚动区，逐个切过去，确认没有哪一页把底部卡住。
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
  assert.equal(dimensionScroll.count, 56)
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

  await evalJs(`(() => {
    const studio = window.__faceStudio
    const store = studio.store
    store.setSchemeField('gender', '男性呈现')
    store.setSchemeField('age', '中年')
    store.setSchemeField('role', '守夜人')
    store.setSchemeField('customNotes', '左眉有一道旧伤')
    store.setSchemeField('visualStyle', 'ink')
    store.setUi({ randomGenderScope: 'mixed' })
    return true
  })()`)
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
      gender: scheme.gender,
      age: scheme.age,
      role: scheme.role,
      notes: scheme.customNotes,
      name: scheme.name,
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
  assert.equal(randomized.gender, '男性呈现')
  assert.equal(randomized.age, '中年')
  assert.equal(randomized.role, '守夜人')
  assert.equal(randomized.notes, '左眉有一道旧伤')
  assert.equal(randomized.style, 'ink')
  assert.equal(randomized.name, beforeReset.name)

  await evalJs(`document.querySelector('#randomize-btn').click(); true`)
  await waitForPage(() => evalJs(`!document.querySelector('#modal-overlay').hidden && Boolean(document.querySelector('#modal [data-confirm]'))`))
  await evalJs(`document.querySelector('#modal [data-confirm]').click(); true`)
  await waitForPage(() => evalJs(`document.querySelector('#modal-overlay').hidden && Number(document.querySelector('#panel-toggle-count')?.textContent || 0) > 30`))

  const genderScopes = await evalJs(`(() => {
    const studio = window.__faceStudio
    const store = studio.store
    const scheme = store.scheme
    const faceShape = studio.data.categories.find(category => category.key === 'face_shape')
    const itemMap = new Map(faceShape.items.map(item => [item.id, item]))
    const originalCommit = store.commit
    store.commit = () => true
    const makeRandom = (seed) => () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    const rate = (gender, scope, count = 80) => {
      scheme.gender = gender
      store.state.ui.randomGenderScope = scope
      const random = makeRandom(20261125)
      const hits = { male: 0, female: 0, neutral: 0 }
      for (let index = 0; index < count; index += 1) {
        store.randomizeScheme(random)
        const id = (scheme.selections.face_shape || [])[0]
        const labels = itemMap.get(id)?.gender_affinity || []
        for (const label of Object.keys(hits)) {
          if (labels.includes(label)) hits[label] += 1 / count
        }
      }
      return hits
    }
    try {
      return {
        maleMixed: rate('男性呈现', 'mixed'),
        femaleMixed: rate('女性呈现', 'mixed'),
        neutralMixed: rate('中性呈现', 'mixed'),
        maleAny: rate('男性呈现', 'any'),
        maleSameOnly: rate('男性呈现', 'same-only'),
      }
    } finally {
      store.commit = originalCommit
    }
  })()`)
  assert.ok(genderScopes.maleMixed.male > 0.48)
  assert.equal(genderScopes.maleMixed.female, 0)
  assert.ok(genderScopes.maleMixed.neutral > 0)
  assert.ok(genderScopes.femaleMixed.female > 0.34)
  assert.equal(genderScopes.femaleMixed.male, 0)
  assert.ok(genderScopes.femaleMixed.neutral > 0)
  assert.equal(genderScopes.neutralMixed.male, 0)
  assert.equal(genderScopes.neutralMixed.female, 0)
  assert.ok(genderScopes.neutralMixed.neutral > 0.9)
  assert.ok(genderScopes.maleAny.female > 0)
  assert.ok(genderScopes.maleAny.male > 0)
  assert.ok(genderScopes.maleSameOnly.male > 0.99)
  assert.equal(genderScopes.maleSameOnly.female, 0)
  assert.equal(genderScopes.maleSameOnly.neutral, 0)

  const sameOnlyFallback = await evalJs(`(() => {
    const store = window.__faceStudio.store
    const scheme = store.scheme
    const originalCommit = store.commit
    store.commit = () => true
    scheme.gender = '男性呈现'
    store.state.ui.randomGenderScope = 'same-only'
    const makeRandom = (seed) => () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    try {
      store.randomizeScheme(makeRandom(202611253))
      const category = window.__faceStudio.data.categories.find(item => item.key === 'face_proportion')
      const itemMap = new Map(category.items.map(item => [item.id, item]))
      const ids = scheme.selections.face_proportion || []
      return {
        ids,
        labels: ids.map(id => itemMap.get(id)?.gender_affinity || []),
      }
    } finally {
      store.commit = originalCommit
    }
  })()`)
  assert.ok(sameOnlyFallback.ids.length > 0)
  assert.ok(sameOnlyFallback.labels.every(labels => labels.includes('neutral')))

  const hairRandom = await evalJs(`(() => {
    const store = window.__faceStudio.store
    const scheme = store.scheme
    const primaryKeys = [
      'hair_cut', 'hair_style', 'updo', 'braid', 'ancient_bun',
      'hair_male_modern', 'hair_female_short', 'hair_curl_form',
      'hair_braid_cultural', 'hair_updo_detail', 'hair_history',
    ]
    const primarySet = new Set(primaryKeys)
    const originalCommit = store.commit
    store.commit = () => true
    const makeRandom = (seed) => () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    const run = (gender, seed, count = 120) => {
      scheme.gender = gender
      store.state.ui.randomGenderScope = 'mixed'
      const random = makeRandom(seed)
      let badPrimaryCount = 0
      let maleModernHits = 0
      let femaleShortHits = 0
      let mixedGenderStyles = 0
      for (let index = 0; index < count; index += 1) {
        store.randomizeScheme(random)
        const picked = Object.keys(scheme.selections || {}).filter(key => primarySet.has(key))
        if (picked.length !== 1) badPrimaryCount += 1
        if (picked.includes('hair_male_modern')) maleModernHits += 1
        if (picked.includes('hair_female_short')) femaleShortHits += 1
        if (picked.includes('hair_male_modern') && picked.includes('hair_female_short')) mixedGenderStyles += 1
      }
      return { badPrimaryCount, maleModernHits, femaleShortHits, mixedGenderStyles }
    }
    try {
      return {
        male: run('男性呈现', 202611251),
        female: run('女性呈现', 202611252),
      }
    } finally {
      store.commit = originalCommit
    }
  })()`)
  assert.equal(hairRandom.male.badPrimaryCount, 0)
  assert.equal(hairRandom.female.badPrimaryCount, 0)
  assert.equal(hairRandom.male.mixedGenderStyles, 0)
  assert.equal(hairRandom.female.mixedGenderStyles, 0)
  assert.ok(hairRandom.male.maleModernHits >= 12)
  assert.ok(hairRandom.female.femaleShortHits >= 8)

  await evalJs(`(() => {
    window.__faceStudio.store.setSchemeField('gender', '男性呈现')
    window.__faceStudio.store.setUi({ randomGenderScope: 'mixed' })
    return true
  })()`)
  await evalJs(`document.querySelector('#random-settings-btn').click(); true`)
  await waitForPage(() => evalJs(`!document.querySelector('#random-settings').hidden`))
  const settingsOpen = await evalJs(`({
    checked: document.querySelector('[data-random-scope="mixed"]').getAttribute('aria-checked'),
    disabled: [...document.querySelectorAll('[data-random-scope]')].some(button => button.disabled),
    state: document.querySelector('#random-scope-state').textContent,
    hint: document.querySelector('#random-gender-hint').textContent,
    layout: (() => {
      const random = document.querySelector('#randomize-btn').getBoundingClientRect()
      const settings = document.querySelector('#random-settings-btn').getBoundingClientRect()
      return {
        overlap: random.right > settings.left + 0.5,
        randomWidth: random.width,
        settingsWidth: settings.width,
        insideViewport: settings.right <= innerWidth,
      }
    })(),
  })`)
  assert.equal(settingsOpen.checked, 'true')
  assert.equal(settingsOpen.disabled, false)
  assert.match(settingsOpen.state, /同性优先/)
  assert.match(settingsOpen.hint, /男性呈现/)
  assert.match(settingsOpen.hint, /男性和中性/)
  assert.equal(settingsOpen.layout.overlap, false)
  assert.ok(settingsOpen.layout.randomWidth > 40)
  assert.ok(settingsOpen.layout.settingsWidth >= 30)
  assert.equal(settingsOpen.layout.insideViewport, true)

  const readSlideThumb = (groupSelector, activeSelector) => evalJs(`(() => {
    const group = document.querySelector(${JSON.stringify(groupSelector)})
    const thumb = group?.querySelector(':scope > .seg-thumb')
    const active = group?.querySelector(${JSON.stringify(activeSelector)})
    if (!group || !thumb || !active) return null
    const t = thumb.getBoundingClientRect()
    const a = active.getBoundingClientRect()
    const style = getComputedStyle(thumb)
    return {
      ready: group.classList.contains('is-ready'),
      opacity: Number(style.opacity),
      dx: Math.abs(t.left - a.left),
      dw: Math.abs(t.width - a.width),
      duration: style.transitionDuration,
      active: active.textContent.trim(),
    }
  })()`)

  const randomThumb = await readSlideThumb('#random-gender-scope', '[aria-checked="true"]')
  assert.ok(randomThumb, '性别范围缺少滑动指示块')
  assert.equal(randomThumb.ready, true)
  assert.ok(randomThumb.opacity > 0.9)
  assert.ok(randomThumb.dx < 1.5, `初始指示块左边缘偏差 ${randomThumb.dx}`)
  assert.ok(randomThumb.dw < 1.5, `初始指示块宽度偏差 ${randomThumb.dw}`)
  assert.notEqual(randomThumb.duration, '0s')

  await evalJs(`document.querySelector('#random-settings-btn').click(); true`)
  await evalJs(`document.querySelector('#random-settings-btn').click(); true`)
  await waitForPage(() => evalJs(`!document.querySelector('#random-settings').hidden`))
  const reopenedThumb = await readSlideThumb('#random-gender-scope', '[aria-checked="true"]')
  assert.ok(reopenedThumb.dx < 1.5, `重新打开后指示块左边缘偏差 ${reopenedThumb.dx}`)
  assert.ok(reopenedThumb.dw < 1.5, `重新打开后指示块宽度偏差 ${reopenedThumb.dw}`)

  const randomSettingsShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(shotDir, 'face-random-settings.png'), Buffer.from(randomSettingsShot.data, 'base64'))
  await evalJs(`(() => {
    document.querySelector('[data-random-scope="same-only"]').click()
    return true
  })()`)
  assert.equal(await evalJs(`window.__faceStudio.store.state.ui.randomGenderScope`), 'same-only')
  assert.match(await evalJs(`document.querySelector('#random-gender-hint').textContent`), /中性卡兜底/)
  await evalJs(`new Promise(resolve => setTimeout(resolve, 320))`)
  const movedThumb = await readSlideThumb('#random-gender-scope', '[aria-checked="true"]')
  assert.equal(movedThumb.active, '仅同性')
  assert.ok(movedThumb.dx < 1.5, `切换后指示块左边缘偏差 ${movedThumb.dx}`)
  assert.ok(movedThumb.dw < 1.5, `切换后指示块宽度偏差 ${movedThumb.dw}`)
  const segmentedShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(shotDir, 'segmented-slider.png'), Buffer.from(segmentedShot.data, 'base64'))
  await evalJs(`(() => {
    document.querySelector('[data-random-scope="any"]').click()
    return true
  })()`)
  assert.equal(await evalJs(`window.__faceStudio.store.state.ui.randomGenderScope`), 'any')
  await evalJs(`(() => {
    const select = document.querySelector('#gender')
    select.value = '中性呈现'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  assert.equal(await evalJs(`[...document.querySelectorAll('[data-random-scope]')].every(button => button.disabled)`), true)
  assert.match(await evalJs(`document.querySelector('#random-gender-hint').textContent`), /固定使用中性/)
  const disabledThumb = await readSlideThumb('#random-gender-scope', '[aria-checked="true"]')
  assert.ok(disabledThumb.opacity < 0.5, `禁用态指示块没有变淡：${disabledThumb.opacity}`)
  await evalJs(`(() => {
    const select = document.querySelector('#gender')
    select.value = '男性呈现'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)

  for (const [group, value, label] of [['lang', 'en', 'English'], ['length', 'compact', '精简'], ['shot', 'turnaround', '三视图']]) {
    await evalJs(`document.querySelector('#modes .seg[data-group="${group}"] button[data-val="${value}"]').click(); true`)
    await evalJs(`new Promise(resolve => setTimeout(resolve, 320))`)
    const metrics = await readSlideThumb(`#modes .seg[data-group="${group}"]`, 'button.is-active')
    assert.ok(metrics, `${group} 分段按钮缺少滑动指示块`)
    assert.equal(metrics.active, label)
    assert.ok(metrics.dx < 1.5, `${group} 指示块左边缘偏差 ${metrics.dx}`)
    assert.ok(metrics.dw < 1.5, `${group} 指示块宽度偏差 ${metrics.dw}`)
  }
  await evalJs(`document.querySelector('#modes .seg[data-group="lang"] button[data-val="zh"]').click(); true`)
  await evalJs(`document.querySelector('#modes .seg[data-group="length"] button[data-val="full"]').click(); true`)
  await evalJs(`document.querySelector('#modes .seg[data-group="shot"] button[data-val="portrait"]').click(); true`)
  await evalJs(`new Promise(resolve => setTimeout(resolve, 320))`)
  const restoredShot = await readSlideThumb('#modes .seg[data-group="shot"]', 'button.is-active')
  assert.equal(restoredShot.active, '半身参考')

  // 自定义卡片：保存后自动提交审核，本人立即可用；参考图走待审核，不走公共目录。
  await evalJs(`document.querySelector('#random-settings-btn').click(); true`)
  await evalJs(`(() => {
    document.querySelector('[data-group-head="face"]')?.click()
    document.querySelector('#nav [data-cat="face_shape"]')?.click()
    return true
  })()`)
  await waitForPage(() => evalJs(`Boolean(document.querySelector('[data-custom-add="face_shape"]'))`))
  await evalJs(`document.querySelector('[data-custom-add="face_shape"]').click(); true`)
  await waitForPage(() => evalJs(`!document.querySelector('#modal-overlay').hidden && Boolean(document.querySelector('#custom-name'))`))
  await evalJs(`(() => {
    document.querySelector('#custom-name').value = '审核流程测试脸型'
    document.querySelector('#custom-def').value = '窄长轮廓，颧骨平缓'
    document.querySelector('#custom-prompt').value = '窄长轮廓，颧骨平缓，正面自然光'
    document.querySelector('[data-save-custom]').click()
    return true
  })()`)
  await waitForPage(() => evalJs(`document.querySelector('.review-badge.pending')?.textContent.trim() === '审核中'`), 12_000)
  const customReview = await evalJs(`(() => {
    const item = window.__faceStudio.store.state.customItems.at(-1)
    const card = document.querySelector('.card[data-id="' + item.id + '"]')
    return {
      id: item.id,
      badge: card?.querySelector('.review-badge')?.textContent.trim(),
      status: card?.querySelector('.ref-upload-head span')?.textContent.trim(),
      note: card?.querySelector('.review-note')?.textContent.trim(),
    }
  })()`)
  assert.equal(customReview.badge, '审核中')
  assert.match(customReview.status, /仅本人可见/)
  assert.match(customReview.note, /其他用户才能看到/)
  let customSubmission = await evalJs(`fetch('/api/face/submissions/mine').then(r => r.json()).then(data => data.submissions.find(item => item.targetId === ${JSON.stringify(customReview.id)}))`)
  assert.equal(customSubmission.kind, 'card')
  assert.equal(customSubmission.status, 'pending')

  await evalJs(`(async () => {
    const input = document.querySelector('[data-ref-file="${customReview.id}"]')
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 80
    const context = canvas.getContext('2d')
    context.fillStyle = '#d9d2c4'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#6e7f70'
    context.beginPath()
    context.ellipse(32, 40, 20, 28, 0, 0, Math.PI * 2)
    context.fill()
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    const transfer = new DataTransfer()
    transfer.items.add(new File([blob], 'review.png', { type: 'image/png' }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await waitForPage(() => evalJs(`fetch('/api/face/submissions/mine').then(r => r.json()).then(data => Boolean(data.submissions.find(item => item.targetId === ${JSON.stringify(customReview.id)})?.imagePath))`), 12_000)
  customSubmission = await evalJs(`fetch('/api/face/submissions/mine').then(r => r.json()).then(data => data.submissions.find(item => item.targetId === ${JSON.stringify(customReview.id)}))`)
  assert.equal(customSubmission.imageWidth, 64)
  assert.equal(customSubmission.imageHeight, 80)
  assert.ok(customSubmission.imagePath.startsWith('参考图-待审核/'))
  assert.equal(await evalJs(`Boolean(window.__faceStudio.store.state.referenceOverrides[${JSON.stringify(customReview.id)}])`), true)
  assert.equal(await evalJs(`document.querySelector('.card[data-id="${customReview.id}"] [data-reset-ref]')?.textContent.trim()`), '移除参考图')
  await waitForPage(() => evalJs(`(() => {
    const image = document.querySelector('.card[data-id="${customReview.id}"] .thumb img')
    return Boolean(image && image.complete && image.naturalWidth > 0)
  })()`), 12_000)
  const previewImage = await evalJs(`(() => {
    const image = document.querySelector('.card[data-id="${customReview.id}"] .thumb img')
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0, 1, 1)
    return {
      src: image.currentSrc,
      pixel: [...context.getImageData(0, 0, 1, 1).data],
      display: getComputedStyle(image).display,
      opacity: getComputedStyle(image).opacity,
    }
  })()`)
  assert.equal(previewImage.display, 'block')
  assert.equal(previewImage.opacity, '1')
  assert.ok(previewImage.pixel[0] > 150 && previewImage.pixel[3] > 0)
  await evalJs(`new Promise(resolve => {
    const wrap = document.querySelector('.cards-wrap')
    wrap.scrollTop = wrap.scrollHeight
    requestAnimationFrame(() => resolve(true))
  })`)
  const customReviewShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(shotDir, 'face-custom-review.png'), Buffer.from(customReviewShot.data, 'base64'))

  await evalJs(`document.querySelector('[data-reset-ref="${customReview.id}"]').click(); true`)
  await waitForPage(() => evalJs(`!document.querySelector('#modal-overlay').hidden && Boolean(document.querySelector('#modal [data-confirm]'))`))
  await evalJs(`document.querySelector('#modal [data-confirm]').click(); true`)
  await waitForPage(() => evalJs(`fetch('/api/face/submissions/mine').then(r => r.json()).then(data => data.submissions.find(item => item.targetId === ${JSON.stringify(customReview.id)})?.imagePath === '')`), 12_000)
  await waitForPage(() => evalJs(`!window.__faceStudio.store.state.referenceOverrides[${JSON.stringify(customReview.id)}]`), 12_000)
  assert.equal(await evalJs(`document.querySelector('.card[data-id="${customReview.id}"] .review-badge.pending')?.textContent.trim()`), '审核中')

  const rejected = await evalJs(`fetch('/api/admin/face/submissions/${customSubmission.id}/reject', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: '参考图构图需要再清楚一点' }),
  }).then(r => r.json())`)
  assert.equal(rejected.submission.status, 'rejected')
  await evalJs(`window.dispatchEvent(new Event('focus')); true`)
  await waitForPage(() => evalJs(`document.querySelector('.review-badge.rejected')?.textContent.trim() === '未通过'`), 12_000)
  const rejectedNote = await evalJs(`document.querySelector('.card[data-id="${customReview.id}"] .review-note')?.textContent.trim()`)
  assert.match(rejectedNote, /参考图构图需要再清楚一点/)

  await evalJs(`document.querySelector('[data-resubmit-review="${customReview.id}"]').click(); true`)
  await waitForPage(() => evalJs(`document.querySelector('.card[data-id="${customReview.id}"] .review-badge.pending')?.textContent.trim() === '审核中'`), 12_000)
  const resubmitted = await evalJs(`fetch('/api/face/submissions/mine').then(r => r.json()).then(data => data.submissions.find(item => item.targetId === ${JSON.stringify(customReview.id)}))`)
  assert.equal(resubmitted.status, 'pending')
  await evalJs(`fetch('/api/face/submissions/${customSubmission.id}', { method: 'DELETE' }).then(r => r.json())`)

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
    settingsVisible: (() => {
      const button = document.querySelector('#random-settings-btn')
      const rect = button?.getBoundingClientRect()
      return Boolean(button && rect && rect.width > 0 && rect.height > 0 && getComputedStyle(button).display !== 'none')
    })(),
    randomScope: window.__faceStudio.store.state.ui.randomGenderScope,
    randomOverlap: (() => {
      const random = document.querySelector('#randomize-btn').getBoundingClientRect()
      const settings = document.querySelector('#random-settings-btn').getBoundingClientRect()
      return random.right > settings.left + 0.5
    })(),
  })`)
  assert.ok(mobile.scrollWidth <= mobile.innerWidth + 2)
  assert.equal(mobile.toggle, true)
  assert.equal(mobile.resetVisible, true)
  assert.equal(mobile.randomVisible, true)
  assert.equal(mobile.settingsVisible, true)
  assert.equal(mobile.randomScope, 'any')
  assert.equal(mobile.randomOverlap, false)

  const shot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(shotDir, 'face-page-mobile.png'), Buffer.from(shot.data, 'base64'))

  console.log('✓ 捏脸页：服务端目录 592 条特征 / 56 维度 / 14 预设 / 272 张内置图')
  console.log('✓ 预设与提示词：载入清冷古典美人后实时生成完整提示词')
  console.log('✓ 提示词只读：完整提示词和负向词都无法用键盘增删改')
  console.log('✓ 服务端资产：参考图从 /face-assets/ 正常加载')
  console.log('✓ 脸型矢量图：13 张轮廓图随目录提供并在卡片中正常显示')
  console.log('✓ 账号隔离：本地状态键包含当前 userId')
  console.log('✓ 服务端修改：改名后客户端重新加载可见，恢复默认后还原')
  console.log('✓ 卡片比例：同类卡片宽高比一致，详情展开时才变高')
  console.log('✓ 发型扩展：108 张新卡、10 个分类、男发/女短发参考图和完整/精简提示词正常')
  console.log('✓ 大屏滚动：1.25 倍缩放下工作区不超出视口，最后一行和页脚都能滚到')
  console.log('✓ 全维度滚动：56 个维度逐页检查，最后一行都没有被底部截断')
  console.log('✓ 恢复空白：清空全部选择与设定、保留方案名称，移动端按钮仍可见')
  console.log('✓ 随机生成：保留角色设定与画风，三档性别范围生效且设置可持久化')
  console.log('✓ 随机主发型：每次只选一个主结构，不会混合男发与女短发')
  console.log('✓ 自定义审核：保存自动提交、参考图待审、驳回原因和重新提交正常')
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
