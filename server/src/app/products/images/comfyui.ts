/**
 * ComfyUI 原生适配器：上传参考图 → /prompt 提交 → /history 轮询 → /view 取图。
 *
 * 与 Magpie 适配器的边界：
 * - /api/images 仍负责校验、排队、存储、日志与响应；
 * - 这里只把一次生成变成一张图片，并返回与 Magpie 相同的 MagpieImageResult；
 * - 本机 ComfyUI 使用独立的 1 并发门闸，避免 6GB 显存被多张图同时打爆。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { ApiError } from '../../platform/errors.js'
import { SerialGate } from '../../platform/serial-gate.js'
import type {
  ComfyApiWorkflow,
  ComfyInputRef,
  ComfyInputValue,
  ComfyWorkflowConfig,
} from '../../control/comfy-config.js'
import type { ComfyObjectInfo } from './comfy-convert.js'
import { estimateTokens, type MagpieImageResult, type ReferenceImage } from './magpie.js'

const COMFY_REQUEST_TIMEOUT_MS = 20_000
const COMFY_POLL_MS = 900
const MAX_IMAGE_BYTES = 40 * 1024 * 1024
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024
const DEFAULT_COMFY_MAX_PIXELS = 4_200_000
const DEFAULT_COMFY_MAX_SIDE = 2048

/** ComfyUI 本机任务只放一张进 GPU；外面的产品并发再高，也会在这里排队 */
export const comfyGate = new SerialGate(1)

interface ObjectInfoCacheEntry {
  value: ComfyObjectInfo
  at: number
}

const objectInfoCache = new Map<string, ObjectInfoCacheEntry>()

export interface ComfyTestResult {
  reachable: boolean
  baseUrl: string
  version?: string
  device?: string
  vramTotal?: number
  objectInfoCount?: number
  workflowCount?: number
  detail: string
}

export interface ComfyRequestOptions {
  baseUrl: string
  /** 客户端看到的模型 ID，写入数据库与请求日志 */
  model: string
  workflow: ComfyWorkflowConfig
  timeoutMs: number
  apiKey?: string
}

export interface ComfyRequestParams {
  prompt: string
  ratioHint: string
  width: number
  height: number
  references: ReferenceImage[]
}

/** 管理端测试连通：同时检查 /system_stats 和 /object_info，不触发任何生成 */
export async function testComfyConnection(
  baseUrl: string,
  timeoutMs = COMFY_REQUEST_TIMEOUT_MS,
): Promise<ComfyTestResult> {
  const root = trimSlash(baseUrl)
  try {
    const [stats, objectInfo, workflows] = await Promise.all([
      fetchJson(root + '/system_stats', timeoutMs).catch(() => null),
      getComfyObjectInfo(root, timeoutMs, true).catch(() => null),
      listComfySavedWorkflows(root, timeoutMs).catch(() => null),
    ])
    if (!stats && !objectInfo) {
      return { reachable: false, baseUrl: root, detail: '无法连接 ComfyUI，请确认地址和端口' }
    }
    const system = asRecord(stats?.system)
    const devices = Array.isArray(stats?.devices) ? stats.devices : []
    const device = asRecord(devices[0])
    return {
      reachable: Boolean(stats),
      baseUrl: root,
      ...(system && typeof system.comfyui_version === 'string'
        ? { version: system.comfyui_version }
        : {}),
      ...(device && typeof device.name === 'string' ? { device: device.name } : {}),
      ...(device && Number.isFinite(Number(device.vram_total))
        ? { vramTotal: Number(device.vram_total) }
        : {}),
      ...(objectInfo ? { objectInfoCount: Object.keys(objectInfo).length } : {}),
      ...(workflows ? { workflowCount: workflows.length } : {}),
      detail: stats ? 'ComfyUI 可连通' : '接口可访问，但没有返回 system_stats',
    }
  } catch (error) {
    return {
      reachable: false,
      baseUrl: root,
      detail: error instanceof Error ? error.message : '无法连接 ComfyUI',
    }
  }
}

/** 读取 ComfyUI 用户目录里保存的 UI 工作流名称 */
export async function listComfySavedWorkflows(
  baseUrl: string,
  timeoutMs = COMFY_REQUEST_TIMEOUT_MS,
): Promise<string[]> {
  const response = await fetchWithTimeout(
    trimSlash(baseUrl) + '/api/userdata?dir=workflows',
    { method: 'GET', headers: comfyHeaders() },
    timeoutMs,
  )
  if (!response.ok) throw upstreamHttpError('读取 ComfyUI 工作流列表', response.status)
  const payload = await readJson(response)
  const list = Array.isArray(payload) ? payload : []
  const names: string[] = []
  for (const entry of list) {
    const name =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string'
          ? String((entry as Record<string, unknown>).name)
          : ''
    if (!name || name.length > 220 || name.includes('..') || name.includes('\\')) continue
    if (!names.includes(name)) names.push(name)
  }
  return names.slice(0, 400)
}

/** 读取一个保存的 UI 工作流原始 JSON；返回任意 JSON（交给 convertWorkflow 判断格式） */
export async function fetchComfySavedWorkflow(
  baseUrl: string,
  name: string,
  timeoutMs = COMFY_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const clean = String(name || '').trim()
  if (!clean || clean.length > 220 || clean.includes('..') || clean.includes('\\') || clean.startsWith('/')) {
    throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 工作流名称无效', 400)
  }
  const relative = clean.startsWith('workflows/') ? clean : `workflows/${clean}`
  const response = await fetchWithTimeout(
    trimSlash(baseUrl) + '/api/userdata/' + encodeURIComponent(relative),
    { method: 'GET', headers: comfyHeaders() },
    timeoutMs,
  )
  if (!response.ok) throw upstreamHttpError('读取 ComfyUI 工作流', response.status)
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ApiError('UPSTREAM_BAD_RESPONSE', 'ComfyUI 返回的工作流不是有效 JSON', 502)
  }
}

/** /object_info 体量很大，导入和重复保存时复用短期缓存 */
export async function getComfyObjectInfo(
  baseUrl: string,
  timeoutMs = COMFY_REQUEST_TIMEOUT_MS,
  force = false,
): Promise<ComfyObjectInfo> {
  const key = trimSlash(baseUrl)
  const cached = objectInfoCache.get(key)
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.value

  const response = await fetchWithTimeout(
    key + '/object_info',
    { method: 'GET', headers: comfyHeaders() },
    timeoutMs,
  )
  if (!response.ok) throw upstreamHttpError('读取 ComfyUI 节点列表', response.status)
  const payload = await readJson(response)
  const object = asRecord(payload)
  if (!object) throw new ApiError('UPSTREAM_BAD_RESPONSE', 'ComfyUI 节点列表格式不正确', 502)
  const value = object as ComfyObjectInfo
  objectInfoCache.set(key, { value, at: Date.now() })
  return value
}

/**
 * 执行一次 ComfyUI 工作流，返回第一张输出图。
 * 调用方应在外层使用 comfyGate；这个函数自身不获取闸门，便于记录排队耗时。
 */
export async function requestComfyImage(
  options: ComfyRequestOptions,
  params: ComfyRequestParams,
): Promise<MagpieImageResult> {
  const startedAt = Date.now()
  const deadline = startedAt + Math.max(10_000, options.timeoutMs || 300_000)
  const workflow = options.workflow
  const mapping = workflow.mapping
  const graph = cloneWorkflow(workflow.workflow)
  const reachable = collectReachable(graph, mapping.output)
  if (!reachable.size) {
    throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 工作流没有可执行的输出节点', 400)
  }

  const activePrompt = activeRefs(mapping.prompt, reachable)
  if (!activePrompt.length) {
    throw new ApiError('UPSTREAM_INVALID', '工作流当前输出分支里没有配置提示词节点', 400)
  }
  const activeWidth = activeRefs(mapping.width, reachable)
  const activeHeight = activeRefs(mapping.height, reachable)
  const activeSeed = activeRefs(mapping.seed, reachable)
  const activeBatch = activeRefs(mapping.batch, reachable)
  const activeReferences = activeRefs(mapping.references, reachable)

  if (params.references.length > activeReferences.length) {
    throw new ApiError(
      'REFERENCE_INVALID',
      `这个 ComfyUI 工作流最多支持 ${activeReferences.length} 张参考图，本次收到 ${params.references.length} 张`,
      400,
    )
  }
  if (!activeReferences.length && params.references.length) {
    throw new ApiError('REFERENCE_INVALID', '这个 ComfyUI 工作流的输出分支没有配置参考图节点', 400)
  }
  if (activeReferences.length && params.references.length === 0) {
    throw new ApiError('REFERENCE_INVALID', '这个 ComfyUI 工作流至少需要 1 张参考图', 400)
  }

  // 工作流可能预留了 6 个 LoadImage 槽位，但这次只带 1～5 张：
  // 用前 N 个槽位，把多余的槽位和指向它们的连线一起删掉。
  // MiniMax 这类多图节点是 Autogrow/可选输入，少传几张仍然能执行。
  const usedReferences = activeReferences.slice(0, params.references.length)
  const unusedReferences = activeReferences.slice(usedReferences.length)
  if (unusedReferences.length) dropReferenceSlots(graph, unusedReferences)

  const promptText =
    mapping.appendRatioHint || (!activeWidth.length && !activeHeight.length)
      ? `${params.prompt}\n\n${params.ratioHint}`
      : params.prompt
  applyText(graph, activePrompt, promptText)

  if (activeWidth.length || activeHeight.length) {
    const size = fitComfySize(params.width, params.height)
    applyNumber(graph, activeWidth, size.width)
    applyNumber(graph, activeHeight, size.height)
  }
  if (activeSeed.length) applyNumber(graph, activeSeed, randomSeed())
  if (activeBatch.length) applyNumber(graph, activeBatch, 1)

  let uploadMs = 0
  if (usedReferences.length) {
    const uploadStartedAt = Date.now()
    const uploaded = await Promise.all(
      params.references.map(image => uploadReferenceImage(options, image, deadline)),
    )
    for (const [index, ref] of usedReferences.entries()) {
      const name = uploaded[index]
      if (name) setInput(graph, ref, name)
    }
    uploadMs = Date.now() - uploadStartedAt
  }

  // 只保留当前输出分支需要的节点，避免工作流里其它 SaveImage/云节点被一起执行
  const finalGraph = pruneWorkflow(graph, mapping.output)
  if (!Object.keys(finalGraph).length) {
    throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 工作流裁剪后没有可执行节点', 400)
  }

  const clientId = `huajing-${randomUUID()}`
  const promptId = randomUUID()
  const submitStartedAt = Date.now()
  const submitResponse = await fetchWithTimeout(
    trimSlash(options.baseUrl) + '/prompt',
    {
      method: 'POST',
      headers: {
        ...comfyHeaders(options.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: finalGraph,
        client_id: clientId,
        prompt_id: promptId,
        partial_execution_targets: mapping.output,
      }),
    },
    Math.min(60_000, Math.max(1, deadline - Date.now())),
  )
  const submittedAt = Date.now()
  if (!submitResponse.ok) throw await promptRejectedError(submitResponse)

  const submitted = await readJson(submitResponse).catch(() => null)
  const nodeErrors = asRecord(submitted?.node_errors)
  if (nodeErrors && Object.keys(nodeErrors).length) {
    throw new ApiError('UPSTREAM_ERROR', summarizeNodeErrors(nodeErrors), 502)
  }
  const serverPromptId =
    submitted && typeof submitted.prompt_id === 'string' && submitted.prompt_id
      ? submitted.prompt_id
      : promptId

  const completedAt = await waitForCompletion(options, serverPromptId, deadline)
  const outputs = completedAt.outputs
  const imageRef = firstOutputImage(outputs, mapping.output)
  if (!imageRef) {
    throw new ApiError('UPSTREAM_BAD_RESPONSE', 'ComfyUI 完成了任务，但没有返回图片', 502)
  }

  const downloadStartedAt = Date.now()
  const buffer = await downloadImage(options, imageRef, deadline)
  const downloadMs = Date.now() - downloadStartedAt

  return {
    buffer,
    model: options.model,
    tokens: estimateTokens(promptText),
    metrics: {
      upstream_headers_ms: submittedAt - submitStartedAt,
      upstream_ms: Date.now() - submitStartedAt - downloadMs,
      parse_ms: uploadMs,
      download_ms: downloadMs,
    },
  }
}

interface HistoryCompletion {
  outputs: Record<string, unknown>
  completedAt: number
}

async function waitForCompletion(
  options: ComfyRequestOptions,
  promptId: string,
  deadline: number,
): Promise<HistoryCompletion> {
  const historyUrl = trimSlash(options.baseUrl) + '/history/' + encodeURIComponent(promptId)
  while (Date.now() < deadline) {
    const response = await fetchWithTimeout(
      historyUrl,
      { method: 'GET', headers: comfyHeaders(options.apiKey) },
      Math.min(20_000, Math.max(1, deadline - Date.now())),
    )
    if (!response.ok) throw upstreamHttpError('读取 ComfyUI 历史', response.status)
    const payload = await readJson(response)
    const entry = asRecord(payload?.[promptId])
    if (!entry) {
      await sleep(Math.min(COMFY_POLL_MS, Math.max(0, deadline - Date.now())))
      continue
    }
    const status = asRecord(entry.status)
    const statusStr = typeof status?.status_str === 'string' ? status.status_str : ''
    const completed = status?.completed === true || statusStr === 'success' || statusStr === 'error'
    if (!completed) {
      await sleep(Math.min(COMFY_POLL_MS, Math.max(0, deadline - Date.now())))
      continue
    }
    if (statusStr === 'error') {
      throw new ApiError('UPSTREAM_ERROR', readExecutionError(status ?? {}), 502)
    }
    const outputs = asRecord(entry.outputs)
    if (!outputs) {
      throw new ApiError('UPSTREAM_BAD_RESPONSE', 'ComfyUI 历史里没有 outputs', 502)
    }
    return { outputs, completedAt: Date.now() }
  }
  throw new ApiError('UPSTREAM_TIMEOUT', 'ComfyUI 生成超时，请检查队列与工作流耗时', 504)
}

interface OutputImageRef {
  filename: string
  subfolder: string
  type: 'output' | 'temp'
}

function firstOutputImage(
  outputs: Record<string, unknown>,
  outputIds: string[],
): OutputImageRef | null {
  const seen = new Set<string>()
  for (const id of outputIds) {
    const nodeOutput = asRecord(outputs[id])
    const images = Array.isArray(nodeOutput?.images) ? nodeOutput.images : []
    for (const entry of images) {
      const item = asRecord(entry)
      if (!item) continue
      const filename = typeof item.filename === 'string' ? item.filename : ''
      const subfolder = typeof item.subfolder === 'string' ? item.subfolder : ''
      const type = item.type === 'temp' ? 'temp' : item.type === 'output' ? 'output' : ''
      if (!filename || !safeFilename(filename) || !safeSubfolder(subfolder) || !type) continue
      const key = `${type}/${subfolder}/${filename}`
      if (seen.has(key)) continue
      seen.add(key)
      return { filename, subfolder, type }
    }
  }
  return null
}

async function downloadImage(
  options: ComfyRequestOptions,
  image: OutputImageRef,
  deadline: number,
): Promise<Buffer> {
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder,
    type: image.type,
  })
  const response = await fetchWithTimeout(
    trimSlash(options.baseUrl) + '/view?' + query.toString(),
    { method: 'GET', headers: comfyHeaders(options.apiKey) },
    Math.min(60_000, Math.max(1, deadline - Date.now())),
  )
  if (!response.ok) throw upstreamHttpError('下载 ComfyUI 图片', response.status)
  const length = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) {
    throw new ApiError('IMAGE_INVALID', 'ComfyUI 返回的图片过大', 502)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ApiError('IMAGE_INVALID', 'ComfyUI 返回的图片为空或过大', 502)
  }
  return bytes
}

async function uploadReferenceImage(
  options: ComfyRequestOptions,
  image: ReferenceImage,
  deadline: number,
): Promise<string> {
  if (image.buffer.byteLength > MAX_REFERENCE_BYTES) {
    throw new ApiError('REFERENCE_TOO_LARGE', '参考图不能超过 8 MB', 413)
  }
  const extension = image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png'
  const hash = createHash('sha256').update(image.buffer).digest('hex').slice(0, 24)
  const filename = `huajing-ref-${hash}.${extension}`
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(image.buffer)], { type: image.mimeType }), filename)
  form.append('type', 'input')
  form.append('subfolder', 'huajing')
  form.append('overwrite', 'true')

  const response = await fetchWithTimeout(
    trimSlash(options.baseUrl) + '/upload/image',
    { method: 'POST', headers: comfyHeaders(options.apiKey), body: form },
    Math.min(60_000, Math.max(1, deadline - Date.now())),
  )
  if (!response.ok) throw upstreamHttpError('上传参考图到 ComfyUI', response.status)
  const payload = await readJson(response).catch(() => null)
  const name = payload && typeof payload.name === 'string' ? payload.name : ''
  const subfolder = payload && typeof payload.subfolder === 'string' ? payload.subfolder : ''
  if (!safeFilename(name) || !safeSubfolder(subfolder)) {
    throw new ApiError('UPSTREAM_BAD_RESPONSE', 'ComfyUI 上传参考图后返回了无效文件名', 502)
  }
  return subfolder ? `${subfolder}/${name}` : name
}

function applyText(workflow: ComfyApiWorkflow, refs: ComfyInputRef[], text: string): void {
  for (const ref of refs) {
    const node = workflow[ref.node]
    if (node && ref.input in node.inputs) node.inputs[ref.input] = text
  }
}

function applyNumber(workflow: ComfyApiWorkflow, refs: ComfyInputRef[], value: number): void {
  for (const ref of refs) {
    const node = workflow[ref.node]
    if (node && ref.input in node.inputs) node.inputs[ref.input] = value
  }
}

function setInput(workflow: ComfyApiWorkflow, ref: ComfyInputRef, value: ComfyInputValue): void {
  const node = workflow[ref.node]
  if (node && ref.input in node.inputs) node.inputs[ref.input] = value
}

function activeRefs(refs: ComfyInputRef[], reachable: Set<string>): ComfyInputRef[] {
  return refs.filter(ref => reachable.has(ref.node))
}

/**
 * 删除本次用不到的参考图槽位：连同 LoadImage 节点和所有指向它的连线。
 * 多图节点（MiniMax H3 的 Autogrow images.image_N）允许少传，
 * 但留下空的槽位会让节点读到一个不存在的图，必须一起摘掉。
 */
function dropReferenceSlots(workflow: ComfyApiWorkflow, slots: ComfyInputRef[]): void {
  const drop = new Set(slots.map(slot => slot.node))
  for (const id of drop) delete workflow[id]
  for (const node of Object.values(workflow)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (isNodeRef(value) && drop.has(value[0])) {
        delete node.inputs[key]
        continue
      }
      if (Array.isArray(value) && value.some(item => isNodeRef(item) && drop.has(item[0]))) {
        node.inputs[key] = value.filter(item => !(isNodeRef(item) && drop.has(item[0])))
      }
    }
  }
}

function collectReachable(workflow: ComfyApiWorkflow, outputIds: string[]): Set<string> {
  const keep = new Set<string>()
  const stack = [...outputIds]
  while (stack.length) {
    const id = stack.pop()
    if (!id || keep.has(id) || !workflow[id]) continue
    keep.add(id)
    for (const value of Object.values(workflow[id].inputs)) {
      if (isNodeRef(value) && workflow[value[0]] && !keep.has(value[0])) stack.push(value[0])
    }
  }
  return keep
}

function pruneWorkflow(workflow: ComfyApiWorkflow, outputIds: string[]): ComfyApiWorkflow {
  const keep = collectReachable(workflow, outputIds)
  const result: ComfyApiWorkflow = {}
  for (const id of Object.keys(workflow)) {
    if (keep.has(id)) result[id] = workflow[id]!
  }
  return result
}

function cloneWorkflow(workflow: ComfyApiWorkflow): ComfyApiWorkflow {
  return JSON.parse(JSON.stringify(workflow)) as ComfyApiWorkflow
}

function isNodeRef(value: ComfyInputValue): value is [string, number] {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string' && typeof value[1] === 'number'
}

function fitComfySize(rawWidth: number, rawHeight: number): { width: number; height: number } {
  const ratio = rawWidth > 0 && rawHeight > 0 ? rawWidth / rawHeight : 1
  let best = { width: 1024, height: 1024, score: Number.POSITIVE_INFINITY }
  const targetArea = Math.min(
    DEFAULT_COMFY_MAX_PIXELS,
    Math.max(256 * 256, rawWidth * rawHeight),
  )
  for (let height = 256; height <= DEFAULT_COMFY_MAX_SIDE; height += 32) {
    const idealWidth = height * ratio
    for (const width of [Math.floor(idealWidth / 32) * 32, Math.ceil(idealWidth / 32) * 32]) {
      if (width < 256 || width > DEFAULT_COMFY_MAX_SIDE) continue
      if (width * height > DEFAULT_COMFY_MAX_PIXELS) continue
      const score =
        Math.abs(width / height - ratio) * 100 +
        Math.abs(width * height - targetArea) / Math.max(1, targetArea)
      if (score < best.score) best = { width, height, score }
    }
  }
  return { width: best.width, height: best.height }
}

function randomSeed(): number {
  return Number(randomBytes(8).readBigUInt64LE() % 9_000_000_000_000_000n) + 1
}

async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const response = await fetchWithTimeout(url, { method: 'GET', headers: comfyHeaders() }, timeoutMs)
  if (!response.ok) throw upstreamHttpError('连接 ComfyUI', response.status)
  return asRecord(await readJson(response).catch(() => null))
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError('UPSTREAM_TIMEOUT', 'ComfyUI 请求超时', 504)
    }
    throw new ApiError(
      'UPSTREAM_UNREACHABLE',
      '无法连接 ComfyUI，请确认地址、端口和服务是否运行',
      502,
    )
  } finally {
    clearTimeout(timer)
  }
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ApiError('UPSTREAM_BAD_RESPONSE', 'ComfyUI 返回了非 JSON 内容', 502)
  }
}

function comfyHeaders(apiKey?: string): Record<string, string> {
  return {
    Accept: 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }
}

async function promptRejectedError(response: Response): Promise<ApiError> {
  const payload = await readJson(response).catch(() => null)
  const error = asRecord(payload?.error)
  const nodeErrors = asRecord(payload?.node_errors)
  if (nodeErrors && Object.keys(nodeErrors).length) {
    return new ApiError('UPSTREAM_ERROR', summarizeNodeErrors(nodeErrors), 502)
  }
  const message =
    (error && typeof error.message === 'string' && error.message) ||
    `ComfyUI 拒绝了工作流（HTTP ${response.status}）`
  return new ApiError('UPSTREAM_ERROR', message.slice(0, 500), 502)
}

function summarizeNodeErrors(nodeErrors: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [nodeId, value] of Object.entries(nodeErrors).slice(0, 3)) {
    const row = asRecord(value)
    const errors = Array.isArray(row?.errors) ? row.errors : []
    const first = asRecord(errors[0])
    const message = first && typeof first.message === 'string' ? first.message : '节点校验失败'
    parts.push(`节点 ${nodeId}：${message}`)
  }
  return `ComfyUI 工作流校验失败：${parts.join('；')}`
}

function readExecutionError(status: Record<string, unknown>): string {
  const messages = Array.isArray(status.messages) ? status.messages : []
  for (const entry of messages) {
    if (!Array.isArray(entry) || (entry[0] !== 'execution_error' && entry[0] !== 'execution_interrupted')) {
      continue
    }
    const detail = asRecord(entry[1])
    const message =
      (detail && typeof detail.exception_message === 'string' && detail.exception_message) ||
      (detail && typeof detail.message === 'string' && detail.message) ||
      'ComfyUI 执行失败'
    return message.slice(0, 500)
  }
  return 'ComfyUI 执行失败'
}

function upstreamHttpError(action: string, status: number): ApiError {
  return new ApiError('UPSTREAM_ERROR', `${action}失败（HTTP ${status}）`, 502)
}

function safeFilename(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 220 &&
    !value.includes('..') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !/[\u0000-\u001f]/.test(value)
  )
}

function safeSubfolder(value: string): boolean {
  return (
    value.length <= 300 &&
    !value.includes('..') &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !/[\u0000-\u001f]/.test(value)
  )
}

function trimSlash(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '')
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
