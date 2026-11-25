#!/usr/bin/env node
/**
 * 生成 13 张整体脸型矢量参考图。
 *
 * SVG 是可维护的源稿，PNG 是客户端实际读取的参考图。
 * 运行：node scripts/build-face-shape-vectors.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = join(root, 'server', 'assets', 'face', 'references', 'face', 'face_shape')
const svgDirectory = join(outputRoot, 'svg')
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const shapes = [
  { id: 'face_oval', forehead: 355, cheekbone: 365, jaw: 280, chin: 120, length: 1.00, chinRound: 36 },
  { id: 'face_narrow_oval', forehead: 300, cheekbone: 315, jaw: 240, chin: 100, length: 1.03, chinRound: 34 },
  { id: 'face_long_oval', forehead: 330, cheekbone: 345, jaw: 260, chin: 110, length: 1.12, chinRound: 34 },
  { id: 'face_round', forehead: 340, cheekbone: 390, jaw: 310, chin: 145, length: 0.90, chinRound: 55 },
  { id: 'face_short_wide', forehead: 375, cheekbone: 415, jaw: 325, chin: 155, length: 0.86, chinRound: 48 },
  { id: 'face_square', forehead: 380, cheekbone: 385, jaw: 345, chin: 150, length: 0.98, chinRound: 16 },
  { id: 'face_rectangular', forehead: 355, cheekbone: 365, jaw: 330, chin: 140, length: 1.12, chinRound: 22 },
  { id: 'face_heart', forehead: 410, cheekbone: 380, jaw: 250, chin: 75, length: 1.02, chinRound: 6 },
  { id: 'face_inverted_triangle', forehead: 420, cheekbone: 365, jaw: 235, chin: 65, length: 1.02, chinRound: 4 },
  { id: 'face_diamond', forehead: 300, cheekbone: 430, jaw: 240, chin: 75, length: 1.02, chinRound: 6 },
  { id: 'face_pear', forehead: 295, cheekbone: 340, jaw: 400, chin: 170, length: 0.98, chinRound: 40 },
  { id: 'face_trapezoid', forehead: 285, cheekbone: 340, jaw: 410, chin: 180, length: 1.00, chinRound: 35 },
  { id: 'face_oblong', forehead: 310, cheekbone: 325, jaw: 250, chin: 100, length: 1.16, chinRound: 26 },
]

const rawCatalog = JSON.parse(readFileSync(join(root, 'server', 'assets', 'face', 'catalog-seed.json'), 'utf8'))
const faceShape = rawCatalog.categories.find(category => category.key === 'face_shape')
const nameById = new Map(faceShape.items.map(item => [item.id, item.name_zh]))

function geometry(shape) {
  const centerX = 520
  const top = 300
  const foreheadY = top + 230 * shape.length
  const cheekY = top + 450 * shape.length
  const jawY = top + 690 * shape.length
  const chinY = top + 880 * shape.length
  return {
    centerX,
    top,
    foreheadY,
    cheekY,
    jawY,
    chinY,
  }
}

function facePath(shape) {
  const g = geometry(shape)
  const c = g.centerX
  const height = g.chinY - g.top
  const right = [
    { x: c, y: g.top },
    { x: c + shape.forehead * 0.62, y: g.top + height * 0.075 },
    { x: c + shape.forehead, y: g.foreheadY },
    { x: c + shape.cheekbone, y: g.cheekY },
    { x: c + shape.jaw, y: g.jawY },
    { x: c + shape.chin * 0.92, y: g.chinY - 26 },
    { x: c, y: g.chinY + shape.chinRound * 0.55 },
  ]
  const left = right.slice(1, -1).reverse().map(point => ({ x: c * 2 - point.x, y: point.y }))
  const points = [...right, ...left]
  let path = `M ${points[0].x} ${points[0].y}`
  for (let index = 0; index < points.length; index += 1) {
    const p0 = points[(index - 1 + points.length) % points.length]
    const p1 = points[index]
    const p2 = points[(index + 1) % points.length]
    const p3 = points[(index + 2) % points.length]
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
    path += ` C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`
  }
  return `${path} Z`
}

function insetPath(shape) {
  return facePath(shape)
}

function svgFor(shape) {
  const g = geometry(shape)
  const path = facePath(shape)
  const noseTop = g.foreheadY + 180
  const noseBottom = g.cheekY + 90
  const mouthY = g.chinY - 165
  const eyeY = g.foreheadY + 150
  const eyeOffset = Math.max(86, shape.cheekbone * 0.38)
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500">
  <rect width="1200" height="1500" fill="#F6F2EA"/>
  <rect x="0" y="0" width="1200" height="1500" fill="url(#paper)"/>
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FBF8F2" stop-opacity="0.9"/>
      <stop offset="0.58" stop-color="#F4EFE6" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#EDE5D8" stop-opacity="0.65"/>
    </linearGradient>
    <linearGradient id="skin" x1="0" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#F0E3D2"/>
      <stop offset="0.58" stop-color="#E7D6C1"/>
      <stop offset="1" stop-color="#D8C2AA"/>
    </linearGradient>
  </defs>

  <g opacity="0.55">
    <path d="M ${g.centerX - 385} 1500 C ${g.centerX - 360} 1370, ${g.centerX - 260} 1280, ${g.centerX - 160} 1230 L ${g.centerX + 160} 1230 C ${g.centerX + 260} 1280, ${g.centerX + 360} 1370, ${g.centerX + 385} 1500 Z" fill="#D7C7B4" stroke="#B49E85" stroke-width="4"/>
    <path d="M ${g.centerX - 115} ${g.chinY - 70} L ${g.centerX - 105} 1290 C ${g.centerX - 80} 1330, ${g.centerX + 80} 1330, ${g.centerX + 105} 1290 L ${g.centerX + 115} ${g.chinY - 70} Z" fill="#DECDB9" stroke="#A9947B" stroke-width="4"/>
  </g>

  <ellipse cx="${g.centerX - shape.cheekbone * 0.99}" cy="${g.cheekY - 68}" rx="28" ry="${82 * shape.length}" fill="#E3D1BB" stroke="#A58E73" stroke-width="4"/>
  <ellipse cx="${g.centerX + shape.cheekbone * 0.99}" cy="${g.cheekY - 68}" rx="28" ry="${82 * shape.length}" fill="#E3D1BB" stroke="#A58E73" stroke-width="4"/>

  <path d="${path}" fill="url(#skin)" stroke="#393732" stroke-width="7" stroke-linejoin="round"/>

  <g fill="none" stroke="#A4917B" stroke-width="3" opacity="0.36">
    <path d="M ${g.centerX - shape.forehead * 0.82} ${eyeY} Q ${g.centerX - eyeOffset} ${eyeY - 14}, ${g.centerX - eyeOffset * 0.24} ${eyeY + 6}"/>
    <path d="M ${g.centerX + shape.forehead * 0.82} ${eyeY} Q ${g.centerX + eyeOffset} ${eyeY - 14}, ${g.centerX + eyeOffset * 0.24} ${eyeY + 6}"/>
    <path d="M ${g.centerX} ${noseTop} Q ${g.centerX - 14} ${(noseTop + noseBottom) / 2}, ${g.centerX} ${noseBottom}"/>
    <path d="M ${g.centerX - 34} ${mouthY} Q ${g.centerX} ${mouthY + 14}, ${g.centerX + 34} ${mouthY}"/>
  </g>

  <g stroke="#8F806C" stroke-width="2.5" stroke-dasharray="10 13" opacity="0.42">
    <path d="M ${g.centerX} ${g.foreheadY - 80} L ${g.centerX} ${g.chinY + 50}"/>
    <path d="M ${g.centerX - shape.cheekbone - 36} ${g.cheekY} L ${g.centerX + shape.cheekbone + 36} ${g.cheekY}"/>
    <path d="M ${g.centerX - shape.jaw - 28} ${g.jawY} L ${g.centerX + shape.jaw + 28} ${g.jawY}"/>
  </g>

  <g fill="#6F806B" stroke="#F6F2EA" stroke-width="4">
    <circle cx="${g.centerX - shape.cheekbone}" cy="${g.cheekY}" r="8"/>
    <circle cx="${g.centerX + shape.cheekbone}" cy="${g.cheekY}" r="8"/>
    <circle cx="${g.centerX - shape.jaw}" cy="${g.jawY}" r="7"/>
    <circle cx="${g.centerX + shape.jaw}" cy="${g.jawY}" r="7"/>
    <circle cx="${g.centerX}" cy="${g.chinY}" r="7"/>
  </g>

  <g>
    <rect x="900" y="118" width="248" height="330" rx="30" fill="#FBF8F1" fill-opacity="0.78" stroke="#C8BA9F" stroke-width="3" stroke-dasharray="9 10"/>
    <g transform="translate(925 140) scale(0.185 0.255) translate(${-g.centerX} ${-g.top})">
      <path d="${insetPath(shape)}" fill="#E9D9C5" stroke="#4B4841" stroke-width="18" stroke-linejoin="round"/>
      <path d="M ${g.centerX} ${g.foreheadY - 60} L ${g.centerX} ${g.chinY + 20}" stroke="#9B8A75" stroke-width="10" stroke-dasharray="20 26" opacity="0.38"/>
      <ellipse cx="${g.centerX - shape.cheekbone}" cy="${g.cheekY}" rx="18" ry="18" fill="#6F806B"/>
      <ellipse cx="${g.centerX + shape.cheekbone}" cy="${g.cheekY}" rx="18" fill="#6F806B"/>
    </g>
  </g>
</svg>
`
}

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
  return null
}

mkdirSync(svgDirectory, { recursive: true })
if (!existsSync(chrome)) throw new Error(`找不到 Chrome：${chrome}`)

const profile = mkdtempSync(join(tmpdir(), 'huajing-face-vectors-'))
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

async function waitFor(expression) {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    const result = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
    })
    if (result.result?.value === true) return
    await new Promise(resolveWait => setTimeout(resolveWait, 60))
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
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 1500,
    deviceScaleFactor: 1,
    mobile: false,
  })

  for (const shape of shapes) {
    const label = nameById.get(shape.id)
    if (!label) throw new Error(`目录里找不到脸型：${shape.id}`)
    const svgFile = join(svgDirectory, `${shape.id}.svg`)
    const webpFile = join(outputRoot, `${shape.id}.webp`)
    writeFileSync(svgFile, svgFor(shape), 'utf8')
    await cdp('Page.navigate', { url: pathToFileURL(svgFile).href })
    await waitFor(`document.readyState === 'complete'`)
    const shot = await cdp('Page.captureScreenshot', {
      format: 'webp',
      quality: 92,
      fromSurface: true,
    })
    const buffer = Buffer.from(shot.data, 'base64')
    const size = webpSize(buffer)
    if (!size || size.width !== 1200 || size.height !== 1500) {
      throw new Error(`${shape.id} 截图尺寸错误：${size ? `${size.width}x${size.height}` : 'not webp'}`)
    }
    writeFileSync(webpFile, buffer)
    rmSync(join(outputRoot, `${shape.id}.png`), { force: true })
    references[shape.id] = `/face-assets/references/face/face_shape/${shape.id}.webp`
    console.log(`✓ ${shape.id} ${label}`)
  }
} finally {
  try { ws?.close() } catch {}
  if (!browser.killed) browser.kill()
  await new Promise(resolveWait => setTimeout(resolveWait, 150))
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {}
}

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
sources.add('scripts/build-face-shape-vectors.mjs')
writeFileSync(
  additionsFile,
  `${JSON.stringify({
    version: 1,
    generated_from: [...sources].join(', '),
    references: { ...(additions.references || {}), ...references },
  }, null, 2)}\n`,
  'utf8',
)

console.log(`已生成 ${shapes.length} 张脸型矢量参考图和 reference-additions.json`)
