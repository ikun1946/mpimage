/**
 * 逐个测试网关的生图模型：
 *   node scripts/test-image-models.mjs            # 只测 /v1/images/generations
 *   node scripts/test-image-models.mjs --edits    # 再测图生图 /v1/images/edits
 *   node scripts/test-image-models.mjs --only=codex/gpt-image-2,ai-studio/gemini-3.1-flash-image
 *
 * 直连网关，不经过本项目的登录与额度；结果写到 release/model-tests/。
 * 默认并发 3，可用 --concurrency=2 调整。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = (process.env.MAGPIE_BASE_URL || 'http://127.0.0.1:3425').replace(/\/+$/, '')

const DEFAULT_MODELS = [
  'ai-studio/gemini-3-pro-image',
  'ai-studio/gemini-3.1-flash-image',
  'ai-studio/gemini-3.1-flash-lite-image',
  'antigravity/gemini-3.1-flash-image',
  'ai-studio/gemini-nano-banana-2.1',
  'ai-studio/gemini-2.5-flash-image',
  'grok/grok-imagine-image',
  'grok/grok-imagine-image-quality',
  'codex/gpt-image-2',
]

const PROMPT = '一只橘猫坐在木窗台上，窗外是雨后的青苔庭院，水彩画风格'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'release', 'model-tests')
const REFERENCE = join(ROOT, 'build', 'icon.png')

const args = process.argv.slice(2)
const withEdits = args.includes('--edits')
const onlyArg = args.find(arg => arg.startsWith('--only='))
const models = onlyArg ? onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_MODELS
const concurrencyArg = args.find(arg => arg.startsWith('--concurrency='))
const concurrency = Math.max(1, Number(concurrencyArg?.slice('--concurrency='.length)) || 3)
const timeoutArg = args.find(arg => arg.startsWith('--timeout='))
const timeoutMs = Math.max(1000, Number(timeoutArg?.slice('--timeout='.length)) || 300_000)

function slug(model) {
  return model.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
}

/** 只读图片头部，拿宽高和格式，不依赖第三方库 */
function readImageInfo(buffer) {
  if (buffer.length > 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue }
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { format: 'jpg', width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
    return { format: 'jpg', width: null, height: null }
  }
  if (buffer.length > 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { format: 'webp', width: null, height: null }
  }
  return { format: 'unknown', width: null, height: null }
}

/** 有的模型返回 b64_json，有的只给 url（比如混元），两种都要能取到图 */
async function extractImage(payload) {
  const first = payload?.data?.[0]
  if (typeof first?.b64_json === 'string') return Buffer.from(first.b64_json, 'base64')
  if (typeof first?.url === 'string' && first.url) {
    const response = await fetch(first.url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
  return null
}

function errorMessage(raw) {
  try {
    const payload = JSON.parse(raw)
    const error = payload?.error
    if (typeof error === 'string') return error
    if (error?.message) return String(error.message)
    if (payload?.message) return String(payload.message)
  } catch {}
  return raw.slice(0, 300).replace(/\s+/g, ' ')
}

async function callGeneration(model) {
  const response = await fetch(`${BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: PROMPT, n: 1 }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${errorMessage(raw)}`)
  let payload
  try { payload = JSON.parse(raw) } catch { throw new Error('返回不是 JSON') }
  const buffer = await extractImage(payload)
  if (!buffer) throw new Error(`没有返回图片数据：${errorMessage(raw)}`)
  return { buffer, returnedModel: payload.model || null, usage: payload.usage || null }
}

async function callEdit(model) {
  const { readFile } = await import('node:fs/promises')
  const reference = await readFile(REFERENCE)
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', '把这张图改成水彩画风格')
  form.append('n', '1')
  form.append('image', new Blob([new Uint8Array(reference)], { type: 'image/png' }), 'reference.png')
  const response = await fetch(`${BASE_URL}/v1/images/edits`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${errorMessage(raw)}`)
  let payload
  try { payload = JSON.parse(raw) } catch { throw new Error('返回不是 JSON') }
  const buffer = await extractImage(payload)
  if (!buffer) throw new Error(`没有返回图片数据：${errorMessage(raw)}`)
  return { buffer, returnedModel: payload.model || null, usage: payload.usage || null }
}

async function testModel(model) {
  const result = { model, generations: null, edits: null }
  const started = Date.now()
  try {
    const generated = await callGeneration(model)
    const info = readImageInfo(generated.buffer)
    const file = join(OUT_DIR, `${slug(model)}.png`)
    await writeFile(file, generated.buffer)
    result.generations = {
      ok: true,
      ms: Date.now() - started,
      bytes: generated.buffer.byteLength,
      ...info,
      returnedModel: generated.returnedModel,
      file,
    }
  } catch (error) {
    result.generations = { ok: false, ms: Date.now() - started, error: error.message }
  }

  if (withEdits) {
    const editStarted = Date.now()
    try {
      const edited = await callEdit(model)
      const info = readImageInfo(edited.buffer)
      const file = join(OUT_DIR, `${slug(model)}-edit.png`)
      await writeFile(file, edited.buffer)
      result.edits = {
        ok: true,
        ms: Date.now() - editStarted,
        bytes: edited.buffer.byteLength,
        ...info,
        returnedModel: edited.returnedModel,
        file,
      }
    } catch (error) {
      result.edits = { ok: false, ms: Date.now() - editStarted, error: error.message }
    }
  }

  const parts = [`${model}`]
  parts.push(result.generations.ok ? `文生图 ✓ ${result.generations.width}×${result.generations.height} ${result.generations.ms}ms` : `文生图 ✗ ${result.generations.error}`)
  if (withEdits) parts.push(result.edits.ok ? `图生图 ✓ ${result.edits.width}×${result.edits.height} ${result.edits.ms}ms` : `图生图 ✗ ${result.edits.error}`)
  console.log(parts.join(' | '))
  return result
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

await mkdir(OUT_DIR, { recursive: true })
console.log(`网关 ${BASE_URL} · ${models.length} 个模型 · 并发 ${concurrency}${withEdits ? ' · 含图生图' : ''}`)

const results = await runPool(models, concurrency, async model => {
  try {
    return await testModel(model)
  } catch (error) {
    console.log(`${model} | 测试脚本异常：${error.message}`)
    return { model, generations: { ok: false, error: error.message }, edits: withEdits ? { ok: false, error: error.message } : null }
  }
})

const report = { baseUrl: BASE_URL, prompt: PROMPT, withEdits, testedAt: new Date().toISOString(), results }
await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8')

const generationOk = results.filter(item => item.generations?.ok).length
const editOk = withEdits ? results.filter(item => item.edits?.ok).length : 0
console.log(`\n文生图可用 ${generationOk}/${results.length}${withEdits ? ` · 图生图可用 ${editOk}/${results.length}` : ''} · 报告 ${join(OUT_DIR, 'report.json')}`)
process.exitCode = generationOk ? 0 : 1
