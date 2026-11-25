#!/usr/bin/env node
/**
 * 生成 7 张眼尾走向参考图。
 *
 * 底色统一取现有的中性眼型照片，只在眼尾区域做平滑的局部形变，
 * 保证 7 张卡片的人物、皮肤、睫毛和虹膜完全一致，差异只来自眼尾结构。
 *
 * 运行：node scripts/build-eye-corner-references.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = join(root, 'server', 'assets', 'face', 'references', 'eyes', 'eye_corner')
const sourcePhoto = join(root, 'server', 'assets', 'face', 'references', 'eyes', 'eye_shape', 'eye_narrow.webp')
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const width = 720
const height = 900

const base = { innerX: 203, innerY: 505, cornerX: 627, cornerY: 512 }
const pivot = { x: 500, y: 512 }

const eyes = [
  { id: 'eye_corner_level', lift: 7, extend: 0, pinch: 0 },
  { id: 'eye_corner_slight_up', lift: 27, extend: 0, pinch: 0 },
  { id: 'eye_corner_high_up', lift: 43, extend: 0, pinch: 0 },
  { id: 'eye_corner_slight_down', lift: -11, extend: 0, pinch: 0 },
  { id: 'eye_corner_down', lift: -25, extend: 0, pinch: 0 },
  { id: 'eye_inner_sharp', lift: 7, extend: 0, pinch: 0.42 },
  { id: 'eye_outer_extended', lift: 7, extend: 46, pinch: 0 },
]

const rawCatalog = JSON.parse(readFileSync(join(root, 'server', 'assets', 'face', 'catalog-seed.json'), 'utf8'))
const eyeCorner = rawCatalog.categories.find(category => category.key === 'eye_corner')
const nameById = new Map(eyeCorner.items.map(item => [item.id, item.name_zh]))

for (const eye of eyes) {
  if (!nameById.has(eye.id)) throw new Error(`目录里找不到眼尾项：${eye.id}`)
}

const page = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>eye-corner</title></head>
<body style="margin:0;background:#000">
<canvas id="canvas" width="${width}" height="${height}"></canvas>
<script>
const W = ${width}
const H = ${height}
const BASE = ${JSON.stringify(base)}
const PIVOT = ${JSON.stringify(pivot)}
const canvas = document.getElementById('canvas')
const ctx = canvas.getContext('2d', { willReadFrequently: true })
const image = new Image()
image.src = 'data:image/webp;base64,${readFileSync(sourcePhoto).toString('base64')}'

function smoothstep(value) {
  const t = Math.min(1, Math.max(0, value))
  return t * t * (3 - 2 * t)
}

function windowWeight(x, y, centerX, centerY, radiusX, radiusY) {
  const dx = (x - centerX) / radiusX
  const dy = (y - centerY) / radiusY
  const radius = Math.hypot(dx, dy)
  if (radius >= 1) return 0
  if (radius <= 0.46) return 1
  const t = (radius - 0.46) / 0.54
  return 1 - t * t * (3 - 2 * t)
}

function sourcePoint(x, y, spec) {
  let sx = x
  let sy = y
  if (spec.pinch) {
    const weight = windowWeight(x, y, BASE.innerX + 34, BASE.innerY, 126, 94)
    if (weight > 0) {
      sy -= (BASE.innerY - sy) * spec.pinch * weight
    }
  }
  if (spec.lift) {
    const weight = windowWeight(x, y, BASE.cornerX, BASE.cornerY, 134, 120)
    if (weight > 0) {
      const angle = Math.asin(spec.lift / (BASE.cornerX - PIVOT.x)) * weight
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const rx = sx - PIVOT.x
      const ry = sy - PIVOT.y
      sx = PIVOT.x + rx * cos - ry * sin
      sy = PIVOT.y + rx * sin + ry * cos
    }
  }
  if (spec.extend) {
    const weight = windowWeight(x, y, BASE.cornerX, BASE.cornerY, 118, 122)
    sx -= spec.extend * weight
  }
  return { sx, sy }
}

function render(spec) {
  const basePixels = window.__basePixels
  const output = ctx.createImageData(W, H)
  const data = output.data
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const mapped = sourcePoint(x, y, spec)
      const sx = Math.min(W - 1, Math.max(0, mapped.sx))
      const sy = Math.min(H - 1, Math.max(0, mapped.sy))
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const x1 = Math.min(W - 1, x0 + 1)
      const y1 = Math.min(H - 1, y0 + 1)
      const fx = sx - x0
      const fy = sy - y0
      const i00 = (y0 * W + x0) * 4
      const i10 = (y0 * W + x1) * 4
      const i01 = (y1 * W + x0) * 4
      const i11 = (y1 * W + x1) * 4
      const index = (y * W + x) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        data[index + channel] =
          basePixels[i00 + channel] * (1 - fx) * (1 - fy) +
          basePixels[i10 + channel] * fx * (1 - fy) +
          basePixels[i01 + channel] * (1 - fx) * fy +
          basePixels[i11 + channel] * fx * fy
      }
      data[index + 3] = 255
    }
  }
  ctx.putImageData(output, 0, 0)
  drawGuides(spec)
  return canvas.toDataURL('image/webp', 0.94)
}

function drawGuides(spec) {
  const mapped = sourcePoint(BASE.cornerX, BASE.cornerY, spec)
  const cornerX = BASE.cornerX + (BASE.cornerX - mapped.sx)
  const cornerY = BASE.cornerY + (BASE.cornerY - mapped.sy)
  const axisY = BASE.innerY
  ctx.save()
  ctx.lineWidth = 1.4
  ctx.strokeStyle = 'rgba(111, 128, 107, 0.55)'
  ctx.setLineDash([8, 9])
  ctx.beginPath()
  ctx.moveTo(0, axisY)
  ctx.lineTo(BASE.innerX - 10, axisY)
  ctx.moveTo(cornerX + 14, axisY)
  ctx.lineTo(W, axisY)
  ctx.stroke()
  if (Math.abs(cornerY - axisY) > 6) {
    ctx.beginPath()
    ctx.moveTo(cornerX + 16, axisY)
    ctx.lineTo(cornerX + 16, cornerY)
    ctx.stroke()
  }
  if (spec.extend) {
    ctx.beginPath()
    ctx.moveTo(BASE.cornerX, cornerY + 14)
    ctx.lineTo(cornerX, cornerY + 14)
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.arc(cornerX, cornerY, 5.4, 0, Math.PI * 2)
  ctx.fillStyle = '#6F806B'
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = '#FBF8F2'
  ctx.stroke()
  if (spec.pinch) {
    ctx.beginPath()
    ctx.arc(BASE.innerX, BASE.innerY, 5, 0, Math.PI * 2)
    ctx.fillStyle = '#6F806B'
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = '#FBF8F2'
    ctx.stroke()
  }
  ctx.restore()
}

window.__renderAll = specs => {
  ctx.drawImage(image, 0, 0, W, H)
  window.__basePixels = ctx.getImageData(0, 0, W, H).data
  return specs.map(spec => ({ id: spec.id, dataUrl: render(spec) }))
}

image.decode().then(() => {
  window.__ready = true
}).catch(error => {
  window.__error = String(error)
})
</script>
</body>
</html>
`

function webpSize(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null
  }
  const chunk = buffer.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    return {
      width: buffer.readUIntLE(24, 3) + 1,
      height: buffer.readUIntLE(27, 3) + 1,
    }
  }
  if (chunk === 'VP8 ') {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    }
  }
  return null
}

mkdirSync(outputRoot, { recursive: true })
if (!existsSync(chrome)) throw new Error(`找不到 Chrome：${chrome}`)
if (!existsSync(sourcePhoto)) throw new Error(`找不到底图：${sourcePhoto}`)

const profile = mkdtempSync(join(tmpdir(), 'huajing-eye-warp-'))
const tmpDir = mkdtempSync(join(tmpdir(), 'huajing-eye-page-'))
const pageFile = join(tmpDir, 'eye-corner.html')
writeFileSync(pageFile, page, 'utf8')

const browser = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' })

const pending = new Map()
let nextId = 0
let socket
let ws

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

async function connectCdp(url) {
  const connection = new WebSocket(url)
  await new Promise((resolveOpen, rejectOpen) => {
    connection.onopen = resolveOpen
    connection.onerror = rejectOpen
  })
  connection.onmessage = event => {
    const message = JSON.parse(String(event.data))
    if (!message.id) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  }
  return connection
}

async function cdp(method, params = {}) {
  const id = ++nextId
  const promise = new Promise((resolveCall, rejectCall) => {
    pending.set(id, { resolve: resolveCall, reject: rejectCall })
  })
  socket.send(JSON.stringify({ id, method, params }))
  return promise
}

async function waitFor(expression, timeout = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const result = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
    })
    if (result.result?.value) return result.result.value
    await new Promise(resolveWait => setTimeout(resolveWait, 80))
  }
  throw new Error(`页面等待超时：${expression}`)
}

const references = {}
try {
  const devToolsPort = await waitForDevTools(profile)
  const target = await fetch(`http://127.0.0.1:${devToolsPort}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
  }).then(response => response.json())
  socket = await connectCdp(target.webSocketDebuggerUrl)
  ws = socket
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url: `file:///${pageFile.replace(/\\/g, '/')}` })
  await waitFor(`window.__ready === true || window.__error`)
  const failure = await cdp('Runtime.evaluate', { expression: 'window.__error || ""', returnByValue: true })
  if (failure.result?.value) throw new Error(`页面失败：${failure.result.value}`)

  const rendered = await cdp('Runtime.evaluate', {
    expression: `window.__renderAll(${JSON.stringify(eyes)})`,
    returnByValue: true,
  })
  if (rendered.exceptionDetails) {
    throw new Error(`渲染失败：${rendered.exceptionDetails.text}`)
  }
  const results = rendered.result.value
  for (const result of results) {
    const base64 = String(result.dataUrl).split(',')[1]
    if (!base64) throw new Error(`${result.id} 没有生成图片`)
    const buffer = Buffer.from(base64, 'base64')
    const size = webpSize(buffer)
    if (!size || size.width !== width || size.height !== height) {
      throw new Error(`${result.id} 尺寸错误：${size ? `${size.width}x${size.height}` : 'not webp'}`)
    }
    writeFileSync(join(outputRoot, `${result.id}.webp`), buffer)
    references[result.id] = `/face-assets/references/eyes/eye_corner/${result.id}.webp`
    console.log(`✓ ${result.id} ${nameById.get(result.id)} ${Math.round(buffer.length / 1024)}KB`)
  }
} finally {
  try { ws?.close() } catch {}
  if (!browser.killed) browser.kill()
  await new Promise(resolveWait => setTimeout(resolveWait, 150))
  for (const directory of [profile, tmpDir]) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {}
  }
}

const staleSvgDirectory = join(outputRoot, 'svg')
for (const eye of eyes) {
  try {
    rmSync(join(staleSvgDirectory, `${eye.id}.svg`), { force: true })
  } catch {}
}
try {
  rmdirSync(staleSvgDirectory)
} catch {}

const additionsFile = join(root, 'server', 'assets', 'face', 'reference-additions.json')
const additions = existsSync(additionsFile)
  ? JSON.parse(readFileSync(additionsFile, 'utf8'))
  : { version: 1, generated_from: '', references: {} }
const sources = new Set(
  String(additions.generated_from || '')
    .split(/,\s*/)
    .map(item => item.trim())
    .filter(Boolean),
)
sources.add('scripts/build-eye-corner-references.mjs')
writeFileSync(
  additionsFile,
  `${JSON.stringify({
    version: 1,
    generated_from: [...sources].join(', '),
    references: { ...(additions.references || {}), ...references },
  }, null, 2)}\n`,
  'utf8',
)

console.log(`已生成 ${eyes.length} 张眼尾参考图和 reference-additions.json`)
