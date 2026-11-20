/**
 * ComfyUI 工作流配置：类型、持久化规范与公开模型 ID。
 *
 * 管理端导入的是可执行的 API 格式工作流（不是 ComfyUI 的 UI 画布 JSON）。
 * 这里只做纯数据校验与归一化，不执行工作流里的任何字符串。
 */
import { ApiError } from '../platform/errors.js'

export const COMFY_DEFAULT_BASE_URL = 'http://127.0.0.1:8188'
export const COMFY_PREFIX = 'comfy:'
const MAX_WORKFLOWS = 50
const MAX_NODES = 500
const MAX_INPUT_KEYS = 500
const MAX_INPUT_DEPTH = 12
const MAX_INPUT_STRING = 200_000
const MAX_WORKFLOW_JSON = 2 * 1024 * 1024
const ID_RE = /^[A-Za-z0-9_-]{1,48}$/
const NODE_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/

/** 工作流输入里绑定的一个节点 / 输入名 */
export interface ComfyInputRef {
  node: string
  input: string
}

export interface ComfyWorkflowMapping {
  /** 正面提示词写到哪些节点输入；可以写多个（例如多段文本编码） */
  prompt: ComfyInputRef[]
  /** 负面提示词；留空就沿用工作流里的原值 */
  negative: ComfyInputRef[]
  /** 按当前画幅写入的宽高；留空则使用工作流原尺寸 */
  width: ComfyInputRef[]
  height: ComfyInputRef[]
  /** 每张图随机种子；留空则沿用工作流原种子 */
  seed: ComfyInputRef[]
  /** 单图批大小（通常设为 1） */
  batch: ComfyInputRef[]
  /** 参考图按顺序写入这些 LoadImage 输入 */
  references: ComfyInputRef[]
  /** 从哪些输出节点取结果，必须显式配置 */
  output: string[]
  /** 是否把产品里的比例文字追加到提示词后面；有宽高映射时默认关闭 */
  appendRatioHint?: boolean
}

export type ComfyInputValue =
  | string
  | number
  | boolean
  | null
  | ComfyInputValue[]
  | { [key: string]: ComfyInputValue }

export interface ComfyApiNode {
  class_type: string
  inputs: Record<string, ComfyInputValue>
}

export type ComfyApiWorkflow = Record<string, ComfyApiNode>

export interface ComfyWorkflowConfig {
  /** 客户端公开 ID 的后半段：comfy:<id> */
  id: string
  label: string
  enabled: boolean
  sourceName?: string
  workflow: ComfyApiWorkflow
  mapping: ComfyWorkflowMapping
  updatedAt?: string
}

export interface ComfyConfig {
  baseUrl: string
  workflows: ComfyWorkflowConfig[]
}

export function comfyModelId(workflowId: string): string {
  return `${COMFY_PREFIX}${workflowId}`
}

export function parseComfyModelId(publicId: string): string | null {
  if (!publicId.startsWith(COMFY_PREFIX)) return null
  const id = publicId.slice(COMFY_PREFIX.length)
  return ID_RE.test(id) ? id : null
}

export function isComfyModelId(publicId: string): boolean {
  return parseComfyModelId(publicId) !== null
}

/** 读 settings.json 时容错：坏条目跳过，不阻断服务启动 */
export function normalizeComfyConfig(raw: unknown): ComfyConfig {
  const object = asRecord(raw)
  const baseUrl = normalizeBaseUrlSafe(object?.baseUrl) || COMFY_DEFAULT_BASE_URL
  const list = Array.isArray(object?.workflows) ? object.workflows : []
  const workflows: ComfyWorkflowConfig[] = []
  const used = new Set<string>()

  for (const entry of list.slice(0, MAX_WORKFLOWS)) {
    const item = asRecord(entry)
    if (!item) continue
    const parsed = normalizeWorkflowSafe(item, workflows.length + 1)
    if (!parsed || used.has(parsed.id)) continue
    used.add(parsed.id)
    workflows.push(parsed)
  }

  return { baseUrl, workflows }
}

/** 管理端保存时严格校验，任何一项有问题都整份拒绝，避免保存一半 */
export function parseComfyConfig(raw: unknown): ComfyConfig {
  const object = asRecord(raw)
  if (!object) throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 配置格式不正确', 400)

  const baseUrl = parseBaseUrl(object.baseUrl)
  if (!Array.isArray(object.workflows)) {
    throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 工作流列表必须是数组', 400)
  }
  if (object.workflows.length > MAX_WORKFLOWS) {
    throw new ApiError('UPSTREAM_INVALID', `ComfyUI 工作流最多 ${MAX_WORKFLOWS} 个`, 400)
  }

  const workflows: ComfyWorkflowConfig[] = []
  const used = new Set<string>()
  for (const [index, entry] of object.workflows.entries()) {
    const item = asRecord(entry)
    if (!item) throw new ApiError('UPSTREAM_INVALID', `第 ${index + 1} 个工作流格式不正确`, 400)
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!ID_RE.test(id)) {
      throw new ApiError('UPSTREAM_INVALID', `工作流 ID 不合法：${id || '(空)'}`, 400)
    }
    if (used.has(id)) throw new ApiError('UPSTREAM_INVALID', `工作流 ID 重复：${id}`, 400)
    used.add(id)
    const workflow = parseWorkflow(item.workflow, id)
    const mapping = parseMapping(item.mapping, workflow)
    workflows.push({
      id,
      label: text(item.label).slice(0, 80) || id,
      enabled: item.enabled !== false,
      ...(text(item.sourceName) ? { sourceName: text(item.sourceName).slice(0, 200) } : {}),
      workflow,
      mapping,
      updatedAt: new Date().toISOString(),
    })
  }

  return { baseUrl, workflows }
}

/** 公开模型 ID 可能来自低版本配置；find 不到时返回 null */
export function findComfyWorkflow(
  config: ComfyConfig,
  publicId: string,
): ComfyWorkflowConfig | null {
  const id = parseComfyModelId(publicId)
  if (!id) return null
  return config.workflows.find(item => item.id === id && item.enabled !== false) ?? null
}

export function emptyMapping(): ComfyWorkflowMapping {
  return {
    prompt: [],
    negative: [],
    width: [],
    height: [],
    seed: [],
    batch: [],
    references: [],
    output: [],
  }
}

function normalizeWorkflowSafe(
  item: Record<string, unknown>,
  fallbackIndex: number,
): ComfyWorkflowConfig | null {
  try {
    const fallbackId = `workflow-${fallbackIndex}`
    const id = ID_RE.test(text(item.id)) ? text(item.id) : fallbackId
    const workflow = parseWorkflow(item.workflow, id)
    const mapping = parseMapping(item.mapping, workflow)
    return {
      id,
      label: text(item.label).slice(0, 80) || id,
      enabled: item.enabled !== false,
      ...(text(item.sourceName) ? { sourceName: text(item.sourceName).slice(0, 200) } : {}),
      workflow,
      mapping,
      ...(text(item.updatedAt) ? { updatedAt: text(item.updatedAt) } : {}),
    }
  } catch {
    return null
  }
}

/** 管理端导入 API 格式 JSON 时复用同一套校验 */
export function parseApiWorkflow(raw: unknown, workflowId = 'workflow'): ComfyApiWorkflow {
  return parseWorkflow(raw, workflowId)
}

function parseWorkflow(raw: unknown, workflowId: string): ComfyApiWorkflow {
  const object = asRecord(raw)
  if (!object) throw new ApiError('UPSTREAM_INVALID', `工作流「${workflowId}」缺少 API 格式 JSON`, 400)
  const keys = Object.keys(object)
  if (!keys.length) throw new ApiError('UPSTREAM_INVALID', `工作流「${workflowId}」没有节点`, 400)
  if (keys.length > MAX_NODES) {
    throw new ApiError('UPSTREAM_INVALID', `工作流「${workflowId}」节点最多 ${MAX_NODES} 个`, 400)
  }

  let total = 0
  const result: ComfyApiWorkflow = {}
  for (const key of keys) {
    if (!NODE_ID_RE.test(key) || isUnsafeKey(key)) {
      throw new ApiError('UPSTREAM_INVALID', `工作流「${workflowId}」包含非法节点 ID：${key}`, 400)
    }
    const node = asRecord(object[key])
    if (!node) throw new ApiError('UPSTREAM_INVALID', `工作流「${workflowId}」节点 ${key} 格式不正确`, 400)
    const classType = text(node.class_type)
    if (!classType || classType.length > 160 || /[\u0000-\u001f<>]/.test(classType)) {
      throw new ApiError('UPSTREAM_INVALID', `工作流「${workflowId}」节点 ${key} 的 class_type 不合法`, 400)
    }
    const inputs = asRecord(node.inputs)
    if (!inputs) throw new ApiError('UPSTREAM_INVALID', `工作流「${workflowId}」节点 ${key} 缺少 inputs`, 400)
    const inputKeys = Object.keys(inputs)
    total += inputKeys.length
    if (total > MAX_INPUT_KEYS) {
      throw new ApiError('UPSTREAM_INVALID', `工作流「${workflowId}」输入项过多`, 400)
    }
    const cleanInputs: Record<string, ComfyInputValue> = {}
    for (const inputKey of inputKeys) {
      if (isUnsafeKey(inputKey) || inputKey.length > 120) {
        throw new ApiError('UPSTREAM_INVALID', `工作流「${workflowId}」包含非法输入名：${inputKey}`, 400)
      }
      cleanInputs[inputKey] = sanitizeValue(inputs[inputKey], 0)
    }
    result[key] = { class_type: classType, inputs: cleanInputs }
  }

  let encoded = ''
  try {
    encoded = JSON.stringify(result)
  } catch {
    throw new ApiError('UPSTREAM_INVALID', `工作流「${workflowId}」无法序列化`, 400)
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_WORKFLOW_JSON) {
    throw new ApiError('UPSTREAM_INVALID', `工作流「${workflowId}」太大，最多 2 MB`, 400)
  }
  return result
}

function parseMapping(raw: unknown, workflow: ComfyApiWorkflow): ComfyWorkflowMapping {
  const object = asRecord(raw) ?? {}
  const mapping: ComfyWorkflowMapping = {
    prompt: parseRefs(object.prompt, workflow, '提示词'),
    negative: parseRefs(object.negative, workflow, '负面提示词'),
    width: parseRefs(object.width, workflow, '宽度'),
    height: parseRefs(object.height, workflow, '高度'),
    seed: parseRefs(object.seed, workflow, '种子'),
    batch: parseRefs(object.batch, workflow, '批大小'),
    references: parseRefs(object.references, workflow, '参考图'),
    output: parseOutputs(object.output, workflow),
    appendRatioHint: object.appendRatioHint === true,
  }
  if (!mapping.output.length) {
    throw new ApiError('UPSTREAM_INVALID', '每个 ComfyUI 工作流至少要选择一个输出节点', 400)
  }
  if (!mapping.prompt.length) {
    throw new ApiError('UPSTREAM_INVALID', '每个 ComfyUI 工作流至少要配置一个提示词节点', 400)
  }
  return mapping
}

function parseRefs(raw: unknown, workflow: ComfyApiWorkflow, label: string): ComfyInputRef[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new ApiError('UPSTREAM_INVALID', `ComfyUI ${label}映射必须是数组`, 400)
  }
  if (raw.length > 50) throw new ApiError('UPSTREAM_INVALID', `ComfyUI ${label}映射最多 50 项`, 400)
  const result: ComfyInputRef[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const item = asRecord(entry)
    const node = text(item?.node)
    const input = text(item?.input)
    if (!node || !input) throw new ApiError('UPSTREAM_INVALID', `ComfyUI ${label}映射缺少节点或输入名`, 400)
    const target = workflow[node]
    if (!target) throw new ApiError('UPSTREAM_INVALID', `ComfyUI ${label}映射的节点不存在：${node}`, 400)
    if (!(input in target.inputs)) {
      throw new ApiError('UPSTREAM_INVALID', `ComfyUI ${label}映射的输入不存在：${node}.${input}`, 400)
    }
    const key = `${node}.${input}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ node, input })
  }
  return result
}

function parseOutputs(raw: unknown, workflow: ComfyApiWorkflow): string[] {
  if (!Array.isArray(raw)) {
    throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 输出节点映射必须是数组', 400)
  }
  if (raw.length > 8) throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 输出节点最多 8 个', 400)
  const result: string[] = []
  for (const entry of raw) {
    const id = text(entry)
    if (!id || !workflow[id]) {
      throw new ApiError('UPSTREAM_INVALID', `ComfyUI 输出节点不存在：${id || '(空)'}`, 400)
    }
    if (!result.includes(id)) result.push(id)
  }
  return result
}

function parseBaseUrl(raw: unknown): string {
  const value = text(raw)
  if (!value) return COMFY_DEFAULT_BASE_URL
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 地址必须是完整的 http/https 地址', 400)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 地址只支持 http 或 https', 400)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 地址不能包含账号、查询参数或锚点', 400)
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function normalizeBaseUrlSafe(raw: unknown): string {
  const value = text(raw)
  if (!value) return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (url.username || url.password || url.search || url.hash) return ''
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

function sanitizeValue(value: unknown, depth: number): ComfyInputValue {
  if (depth > MAX_INPUT_DEPTH) {
    throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 工作流输入嵌套过深', 400)
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 工作流包含非有限数值', 400)
    return value
  }
  if (typeof value === 'string') {
    if (value.length > MAX_INPUT_STRING) {
      throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 工作流里有超长文本', 400)
    }
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 工作流数组过长', 400)
    return value.map(item => sanitizeValue(item, depth + 1))
  }
  const object = asRecord(value)
  if (object) {
    const result: Record<string, ComfyInputValue> = {}
    for (const [key, item] of Object.entries(object)) {
      if (isUnsafeKey(key)) continue
      result[key] = sanitizeValue(item, depth + 1)
    }
    return result
  }
  throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 工作流包含不支持的值', 400)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isUnsafeKey(key: string): boolean {
  return key === '__proto__' || key === 'prototype' || key === 'constructor'
}
