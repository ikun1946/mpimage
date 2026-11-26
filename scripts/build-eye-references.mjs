#!/usr/bin/env node
/**
 * 把 outputs/eye-tests/raw 下的眼部原图统一成 720×900 WebP，
 * 写入 server/assets/face/references/eyes/<分类>/，并登记到 reference-additions.json。
 *
 * 原图建议 4:5（如 1024×1280 档位生成的 1122×1402），直接等比缩放，不裁切。
 *
 * 运行：node scripts/build-eye-references.mjs
 * 只处理部分卡片：node scripts/build-eye-references.mjs lid_ brow_eye_
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rawDir = join(root, 'outputs', 'eye-tests', 'raw')
const outputRoot = join(root, 'server', 'assets', 'face', 'references', 'eyes')
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const width = 720
const height = 900
const onlyPrefixes = process.argv.slice(2).filter(arg => !arg.startsWith('-'))

const catalog = JSON.parse(readFileSync(join(root, 'server', 'assets', 'face', 'catalog-seed.json'), 'utf8'))
const itemById = new Map()
for (const category of catalog.categories) {
  for (const item of category.items) itemById.set(item.id, { ...item, category: category.key })
}

if (!existsSync(rawDir)) throw new Error(`找不到原图目录：${rawDir}`)
const sources = readdirSync(rawDir)
  .filter(name => extname(name).toLowerCase() === '.png' && !name.startsWith('_'))
  .map(name => ({ id: name.slice(0, -4), file: name }))
  .filter(source => !onlyPrefixes.length || onlyPrefixes.some(prefix => source.id.startsWith(prefix)))
  .sort((a, b) => a.id.localeCompare(b.id))

if (!sources.length) throw new Error('原图目录里没有 PNG')
for (const source of sources) {
  if (!itemById.has(source.id)) throw new Error(`目录里找不到这张卡：${source.id}`)
}

const pageFile = join(rawDir, '_normalize.html')
writeFileSync(
  pageFile,
  `<!doctype html><html><head><meta charset="utf-8"></head><body>
<canvas id="canvas" width="${width}" height="${height}"></canvas>
<script>
const canvas = document.getElementById('canvas')
const ctx = canvas.getContext('2d')
window.__normalize = (src) => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => {
    try {
      ctx.fillStyle = '#E8E4DE'
      ctx.fillRect(0, 0, ${width}, ${height})
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(image, 0, 0, ${width}, ${height})
      resolve(canvas.toDataURL('image/webp', 0.92))
    } catch (error) {
      reject(new Error('画布导出失败: ' + String(error)))
    }
  }
  image.onerror = () => reject(new Error('图片加载失败: ' + src))
  image.src = src
})
window.__ready = true
</script></body></html>
`,
  'utf8',
)

function webpSize(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = buffer.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 }
  }
  if (chunk === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
  }
  return null
}

if (!existsSync(chrome)) throw new Error(`找不到 Chrome：${chrome}`)

const profile = mkdtempSync(join(tmpdir(), 'huajing-hair-'))
const browser = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--force-device-scale-factor=1',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' })

const pending = new Map()
let nextId = 0
let socket

async function waitForDevTools(profileDir) {
  const file = join(profileDir, 'DevToolsActivePort')
  const started = Date.now()
  while (Date.now() - started < 15_000) {
    try {
      const [port] = readFileSync(file, 'utf8').trim().split(/\r?\n/)
      if (port) return Number(port)
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 120))
  }
  throw new Error('Chrome DevTools 没有启动')
}

function cdp(method, params = {}) {
  const id = ++nextId
  const promise = new Promise((resolveCall, rejectCall) => {
    pending.set(id, { resolve: resolveCall, reject: rejectCall })
  })
  socket.send(JSON.stringify({ id, method, params }))
  return promise
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时`)), ms)),
  ])
}

const references = {}
try {
  const port = await waitForDevTools(profile)
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
  }).then(response => response.json())
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    socket.onopen = resolveOpen
    socket.onerror = rejectOpen
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

  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url: pathToFileURL(pageFile).href })
  await new Promise(resolveWait => setTimeout(resolveWait, 400))
  await cdp('Runtime.evaluate', { expression: 'window.__ready === true', returnByValue: true })

  for (const source of sources) {
    const result = await withTimeout(
      cdp('Runtime.evaluate', {
        expression: `window.__normalize(${JSON.stringify(source.file)})`,
        awaitPromise: true,
        returnByValue: true,
      }),
      20_000,
      source.id,
    )
    if (result.exceptionDetails) {
      throw new Error(`${source.id} 处理失败：${result.exceptionDetails.text}`)
    }
    const base64 = String(result.result.value || '').split(',')[1]
    if (!base64) throw new Error(`${source.id} 没有生成图片`)
    const buffer = Buffer.from(base64, 'base64')
    const size = webpSize(buffer)
    if (!size || size.width !== width || size.height !== height) {
      throw new Error(`${source.id} 尺寸错误：${size ? `${size.width}x${size.height}` : 'not webp'}`)
    }
    const category = itemById.get(source.id).category
    const directory = join(outputRoot, category)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `${source.id}.webp`), buffer)
    references[source.id] = `/face-assets/references/eyes/${category}/${source.id}.webp`
    console.log(`✓ ${source.id} → eyes/${category} ${Math.round(buffer.length / 1024)}KB`)
  }
} finally {
  try { socket?.close() } catch {}
  if (!browser.killed) browser.kill()
  await new Promise(resolveWait => setTimeout(resolveWait, 150))
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  try { rmSync(pageFile, { force: true }) } catch {}
}

const additionsFile = join(root, 'server', 'assets', 'face', 'reference-additions.json')
const additions = existsSync(additionsFile)
  ? JSON.parse(readFileSync(additionsFile, 'utf8'))
  : { version: 1, generated_from: '', references: {} }
const generators = new Set(
  String(additions.generated_from || '')
    .split(/,\s*/)
    .map(item => item.trim())
    .filter(Boolean),
)
generators.add('scripts/build-eye-references.mjs')
writeFileSync(
  additionsFile,
  `${JSON.stringify({
    version: 1,
    generated_from: [...generators].join(', '),
    references: { ...(additions.references || {}), ...references },
  }, null, 2)}\n`,
  'utf8',
)

console.log(`已生成 ${sources.length} 张眼部参考图和 reference-additions.json`)
