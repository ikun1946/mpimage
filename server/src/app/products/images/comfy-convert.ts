/**
 * ComfyUI 工作流导入：把 UI 画布 JSON 转成 /prompt 需要的 API 格式，
 * 并给出节点映射建议。这里只遍历 JSON 数据，绝不执行节点里的任何字符串。
 *
 * 限制与边界：
 * - 只编译当前启用的节点（mode 2/4 跳过），Reroute / SetNode / GetNode 走纯数据转发；
 * - 默认从所有输出节点开始裁剪，保留所有输出分支，运行时再按管理员选定的输出裁剪；
 * - UI 里没有 object_info 的节点仍会保留并给出警告，由 ComfyUI 自己判断是否可用。
 */
import { ApiError } from '../../platform/errors.js'
import {
  emptyMapping,
  parseApiWorkflow,
  type ComfyApiWorkflow,
  type ComfyInputRef,
  type ComfyInputValue,
  type ComfyWorkflowMapping,
} from '../../control/comfy-config.js'

export interface ComfyObjectInputSpec {
  required?: Record<string, [unknown, ...unknown[]]>
  optional?: Record<string, [unknown, ...unknown[]]>
  hidden?: Record<string, unknown>
}

export interface ComfyNodeDefinition {
  input?: ComfyObjectInputSpec
  output_node?: boolean
  output?: unknown[]
}

export type ComfyObjectInfo = Record<string, ComfyNodeDefinition>

export interface ComfyNodeCandidate {
  id: string
  classType: string
  title?: string
  output: boolean
  prompt: boolean
  reference: boolean
  inputs: string[]
  preview?: string
}

export interface ComfyConvertResult {
  workflow: ComfyApiWorkflow
  mapping: ComfyWorkflowMapping
  nodes: ComfyNodeCandidate[]
  outputNodes: ComfyNodeCandidate[]
  warnings: string[]
  label?: string
  sourceName?: string
}

interface UiInput {
  name?: unknown
  link?: unknown
  widget?: { name?: unknown } | null
  type?: unknown
}

interface UiNode {
  id?: unknown
  type?: unknown
  mode?: unknown
  title?: unknown
  inputs?: unknown
  widgets_values?: unknown
}

interface UiLink {
  originId: string
  originSlot: number
  type: string
}

const OUTPUT_CLASS_RE = /^(SaveImage|PreviewImage|SaveImageKJ|CR Image Output)$/
const SAMPLER_RE = /Sampler/i
const SIZE_CLASS_RE = /Latent|Conditioning|Resolution|Size/i
const CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize'])
const VIRTUAL_CLASSES = new Set([
  'Reroute',
  'SetNode',
  'GetNode',
  'Note',
  'PrimitiveNode',
  'Fast Groups Bypasser (rgthree)',
  'Fast Groups Muter (rgthree)',
])

export function isUiWorkflow(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).nodes))
}

/** UI JSON 或已导出的 API JSON 都能导入 */
export function convertWorkflow(
  raw: unknown,
  objectInfo: ComfyObjectInfo,
  options: { label?: string; sourceName?: string } = {},
): ComfyConvertResult {
  if (isUiWorkflow(raw)) return convertUiWorkflow(raw, objectInfo, options)

  const workflow = parseApiWorkflow(raw, options.label || 'imported')
  const titles: Record<string, string> = {}
  for (const [id, node] of Object.entries(workflow)) {
    const meta = (raw as Record<string, Record<string, unknown>>)?.[id]?._meta
    if (meta && typeof meta === 'object' && typeof (meta as Record<string, unknown>).title === 'string') {
      titles[id] = String((meta as Record<string, unknown>).title).slice(0, 100)
    }
  }
  const outputIds = findOutputIds(workflow, objectInfo, titles)
  if (!outputIds.length) {
    throw new ApiError('UPSTREAM_INVALID', '这个 API 工作流没有可识别的图片输出节点', 400)
  }
  const pruned = pruneWorkflow(workflow, outputIds)
  const warnings = missingClassWarnings(pruned, objectInfo)
  const mapping = suggestMapping(pruned, objectInfo, titles)
  const nodes = buildCandidates(pruned, objectInfo, titles)
  return {
    workflow: pruned,
    mapping,
    nodes,
    outputNodes: nodes.filter(node => node.output),
    warnings,
    label: options.label,
    sourceName: options.sourceName,
  }
}

function convertUiWorkflow(
  raw: unknown,
  objectInfo: ComfyObjectInfo,
  options: { label?: string; sourceName?: string },
): ComfyConvertResult {
  const root = raw as Record<string, unknown>
  const rawNodes = Array.isArray(root.nodes) ? root.nodes : []
  const rawLinks = Array.isArray(root.links) ? root.links : []
  if (rawNodes.length > 500) throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 工作流节点超过 500 个', 400)
  if (rawLinks.length > 2000) throw new ApiError('UPSTREAM_INVALID', 'ComfyUI 工作流连线超过 2000 条', 400)

  const nodes = new Map<string, UiNode>()
  const titles: Record<string, string> = {}
  for (const entry of rawNodes) {
    const node = entry as UiNode
    const id = node && node.id !== undefined ? String(node.id) : ''
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(id)) continue
    nodes.set(id, node)
    if (typeof node.title === 'string' && node.title.trim()) titles[id] = node.title.trim().slice(0, 100)
  }

  const links = new Map<number, UiLink>()
  for (const entry of rawLinks) {
    if (!Array.isArray(entry) || entry.length < 6) continue
    const id = Number(entry[0])
    const originId = String(entry[1] ?? '')
    const originSlot = Number(entry[2] ?? 0)
    const type = String(entry[5] ?? '')
    if (!Number.isFinite(id) || !originId || !Number.isFinite(originSlot)) continue
    links.set(id, { originId, originSlot, type })
  }

  const warnings: string[] = []
  const api: ComfyApiWorkflow = {}
  for (const [id, node] of nodes) {
    const classType = typeof node.type === 'string' ? node.type.trim() : ''
    if (!classType || VIRTUAL_CLASSES.has(classType)) continue
    const mode = Number(node.mode)
    if (mode === 2 || mode === 4) continue
    const compiled = compileNode(node, classType, objectInfo, nodes, links, warnings)
    if (compiled) api[id] = compiled
  }

  const outputIds = findOutputIds(api, objectInfo, titles)
  if (!outputIds.length) {
    throw new ApiError('UPSTREAM_INVALID', '没有找到图片输出节点（SaveImage / PreviewImage）', 400)
  }
  const workflow = pruneWorkflow(api, outputIds)
  const missingWarnings = missingClassWarnings(workflow, objectInfo)
  const allWarnings = [...new Set([...warnings, ...missingWarnings])]
  const mapping = suggestMapping(workflow, objectInfo, titles)
  const candidates = buildCandidates(workflow, objectInfo, titles)
  return {
    workflow,
    mapping,
    nodes: candidates,
    outputNodes: candidates.filter(node => node.output),
    warnings: allWarnings,
    label: options.label,
    sourceName: options.sourceName,
  }
}

function compileNode(
  node: UiNode,
  classType: string,
  objectInfo: ComfyObjectInfo,
  nodes: Map<string, UiNode>,
  links: Map<number, UiLink>,
  warnings: string[],
): { class_type: string; inputs: Record<string, ComfyInputValue> } | null {
  const definition = objectInfo[classType]
  const schemaRequired = definition?.input?.required ?? {}
  const schemaOptional = definition?.input?.optional ?? {}
  const schemaKnown = Boolean(definition)
  const uiInputs = Array.isArray(node.inputs) ? (node.inputs as UiInput[]) : []
  const widgetValues = Array.isArray(node.widgets_values) ? node.widgets_values : []
  let valueIndex = 0
  let lastValue: unknown
  const inputs: Record<string, ComfyInputValue> = {}

  for (const input of uiInputs) {
    const name = typeof input.name === 'string' ? input.name : ''
    if (!input.widget || !name) continue
    if (schemaKnown && !(name in schemaRequired) && !(name in schemaOptional)) continue
    const spec = schemaRequired[name] ?? schemaOptional[name]
    let value = widgetValues[valueIndex]
    valueIndex += 1
    if (shouldSkipControl(value, spec, schemaKnown, lastValue) && valueIndex < widgetValues.length) {
      lastValue = value
      value = widgetValues[valueIndex]
      valueIndex += 1
    }
    lastValue = value
    const linkId = typeof input.link === 'number' ? input.link : Number(input.link)
    if (Number.isFinite(linkId) && linkId > 0) {
      const resolved = resolveLink(linkId, nodes, links, warnings, new Set())
      if (resolved !== null) inputs[name] = resolved
    } else if (value !== undefined) {
      inputs[name] = cleanValue(value)
    }
  }

  // 非 widget 的连线输入（MODEL / CLIP / CONDITIONING / image 等）
  for (const input of uiInputs) {
    const name = typeof input.name === 'string' ? input.name : ''
    if (!name || input.widget) continue
    const linkId = typeof input.link === 'number' ? input.link : Number(input.link)
    if (!Number.isFinite(linkId) || linkId <= 0) continue
    const resolved = resolveLink(linkId, nodes, links, warnings, new Set())
    if (resolved !== null) inputs[name] = resolved
  }

  return { class_type: classType, inputs }
}

function resolveLink(
  linkId: number,
  nodes: Map<string, UiNode>,
  links: Map<number, UiLink>,
  warnings: string[],
  seen: Set<string>,
): ComfyInputValue | null {
  const link = links.get(linkId)
  if (!link) return null
  return resolveOrigin(link.originId, link.originSlot, link.type, nodes, links, warnings, seen)
}

function resolveOrigin(
  nodeId: string,
  slot: number,
  linkType: string,
  nodes: Map<string, UiNode>,
  links: Map<number, UiLink>,
  warnings: string[],
  seen: Set<string>,
): ComfyInputValue | null {
  const key = `${nodeId}:${slot}`
  if (seen.has(key)) {
    warnings.push(`连线出现循环：${key}`)
    return null
  }
  seen.add(key)
  const node = nodes.get(nodeId)
  if (!node) return null
  const type = typeof node.type === 'string' ? node.type : ''
  const mode = Number(node.mode)

  if (type === 'PrimitiveNode') {
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : []
    return values[0] === undefined ? null : cleanValue(values[0])
  }
  if (type === 'GetNode') {
    const keyValue = Array.isArray(node.widgets_values) ? node.widgets_values[0] : ''
    for (const [candidateId, candidate] of nodes) {
      if (candidate.type !== 'SetNode') continue
      const values = Array.isArray(candidate.widgets_values) ? candidate.widgets_values : []
      if (String(values[0] ?? '') !== String(keyValue ?? '')) continue
      return resolveFirstInput(candidateId, candidate, nodes, links, warnings, seen)
    }
    warnings.push(`GetNode「${keyValue || nodeId}」找不到对应的 SetNode`)
    return null
  }
  if (type === 'SetNode' || type === 'Reroute') {
    return resolveFirstInput(nodeId, node, nodes, links, warnings, seen)
  }
  if (type === 'Note' || type === 'Fast Groups Bypasser (rgthree)' || type === 'Fast Groups Muter (rgthree)') {
    return null
  }
  if (mode === 2) return null
  if (mode === 4) {
    const inputs = Array.isArray(node.inputs) ? (node.inputs as UiInput[]) : []
    const linked = inputs.filter(input => input.link != null)
    const sameType = linked.find(input => (typeof input.type === 'string' ? input.type : '') === linkType)
    const chosen = sameType ?? linked[0]
    if (!chosen) {
      warnings.push(`旁路节点 ${nodeId} 没有可透传的输入`)
      return null
    }
    const linkId = typeof chosen.link === 'number' ? chosen.link : Number(chosen.link)
    return Number.isFinite(linkId) && linkId > 0
      ? resolveLink(linkId, nodes, links, warnings, seen)
      : null
  }

  return [nodeId, Number.isFinite(slot) ? slot : 0]
}

function resolveFirstInput(
  nodeId: string,
  node: UiNode,
  nodes: Map<string, UiNode>,
  links: Map<number, UiLink>,
  warnings: string[],
  seen: Set<string>,
): ComfyInputValue | null {
  const inputs = Array.isArray(node.inputs) ? (node.inputs as UiInput[]) : []
  const input = inputs.find(item => item.link != null)
  if (!input) return null
  const linkId = typeof input.link === 'number' ? input.link : Number(input.link)
  if (!Number.isFinite(linkId) || linkId <= 0) return null
  return resolveLink(linkId, nodes, links, warnings, seen)
}

function shouldSkipControl(
  value: unknown,
  spec: [unknown, ...unknown[]] | undefined,
  schemaKnown: boolean,
  previous: unknown,
): boolean {
  if (typeof value !== 'string' || !CONTROL_VALUES.has(value)) return false
  if (!schemaKnown || !spec) return typeof previous === 'number'
  const kind = Array.isArray(spec[0]) ? 'COMBO' : String(spec[0] ?? '')
  if (kind === 'COMBO') return !(spec[0] as unknown[]).includes(value)
  return kind !== 'STRING'
}

function cleanValue(value: unknown): ComfyInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (Array.isArray(value)) return value.map(cleanValue)
  if (value && typeof value === 'object') {
    const result: Record<string, ComfyInputValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue
      result[key] = cleanValue(item)
    }
    return result
  }
  return ''
}

function findOutputIds(
  workflow: ComfyApiWorkflow,
  objectInfo: ComfyObjectInfo,
  titles: Record<string, string>,
): string[] {
  const ids = Object.keys(workflow).filter(id => isOutputNode(workflow[id], objectInfo, titles[id]))
  return ids.sort((a, b) => {
    const aSave = /SaveImage/i.test(workflow[a]?.class_type ?? '') ? 0 : 1
    const bSave = /SaveImage/i.test(workflow[b]?.class_type ?? '') ? 0 : 1
    return aSave - bSave || numericId(a) - numericId(b)
  })
}

function isOutputNode(
  node: { class_type: string } | undefined,
  objectInfo: ComfyObjectInfo,
  title?: string,
): boolean {
  if (!node) return false
  if (OUTPUT_CLASS_RE.test(node.class_type)) return true
  const definition = objectInfo[node.class_type]
  const outputs = Array.isArray(definition?.output) ? definition.output : []
  const outputsImage = outputs.some(item => typeof item === 'string' && item.toUpperCase().includes('IMAGE'))
  if (definition?.output_node === true && outputsImage) return true
  return Boolean(title && /save|output|result/i.test(title)) && outputsImage
}

function pruneWorkflow(workflow: ComfyApiWorkflow, outputIds: string[]): ComfyApiWorkflow {
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
  const result: ComfyApiWorkflow = {}
  for (const id of Object.keys(workflow)) {
    if (keep.has(id)) result[id] = workflow[id]!
  }
  return result
}

function isNodeRef(value: ComfyInputValue | undefined): value is [string, number] {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string' && typeof value[1] === 'number'
}

function missingClassWarnings(workflow: ComfyApiWorkflow, objectInfo: ComfyObjectInfo): string[] {
  const missing = new Set<string>()
  for (const node of Object.values(workflow)) {
    if (!objectInfo[node.class_type]) missing.add(node.class_type)
  }
  return missing.size ? [`当前 ComfyUI 缺少这些节点类：${[...missing].slice(0, 8).join('、')}`] : []
}

function suggestMapping(
  workflow: ComfyApiWorkflow,
  objectInfo: ComfyObjectInfo,
  titles: Record<string, string>,
): ComfyWorkflowMapping {
  const mapping = emptyMapping()
  const samplerIds = Object.keys(workflow).filter(id => SAMPLER_RE.test(workflow[id]?.class_type ?? ''))
  const promptRefs = findPromptRefs(workflow, samplerIds, 'positive')
  if (promptRefs.length) mapping.prompt = promptRefs
  else {
    const promptRef = findLongestTextRef(workflow, objectInfo)
    if (promptRef) mapping.prompt = [promptRef]
  }

  const negativeRefs = findPromptRefs(workflow, samplerIds, 'negative')
  mapping.negative = negativeRefs.filter(ref => !mapping.prompt.some(prompt => sameRef(ref, prompt)))

  for (const [id, node] of Object.entries(workflow)) {
    const hasWidth = 'width' in node.inputs
    const hasHeight = 'height' in node.inputs
    if (hasWidth && hasHeight && SIZE_CLASS_RE.test(node.class_type)) {
      mapping.width.push({ node: id, input: 'width' })
      mapping.height.push({ node: id, input: 'height' })
    }
    if ('seed' in node.inputs && (SAMPLER_RE.test(node.class_type) || /SeedVR2/i.test(node.class_type))) {
      mapping.seed.push({ node: id, input: 'seed' })
    }
    if ('batch_size' in node.inputs) mapping.batch.push({ node: id, input: 'batch_size' })
    if (node.class_type === 'LoadImage' && 'image' in node.inputs) {
      mapping.references.push({ node: id, input: 'image' })
    }
  }

  // 宽高有时由 INTConstant 直接喂给 Latent 节点；没找到宽高节点时退一步映射常量
  if (!mapping.width.length || !mapping.height.length) {
    for (const node of Object.values(workflow)) {
      if (!SIZE_CLASS_RE.test(node.class_type)) continue
      const widthSource = refSource(node.inputs.width)
      const heightSource = refSource(node.inputs.height)
      if (widthSource && workflow[widthSource]?.inputs.value !== undefined) {
        mapping.width.push({ node: widthSource, input: 'value' })
      }
      if (heightSource && workflow[heightSource]?.inputs.value !== undefined) {
        mapping.height.push({ node: heightSource, input: 'value' })
      }
    }
  }

  const outputs = findOutputIds(workflow, objectInfo, titles)
  const firstOutput = outputs[0]
  mapping.output = firstOutput ? [firstOutput] : []
  mapping.appendRatioHint = !mapping.width.length || !mapping.height.length
  return mapping
}

function findPromptRefs(
  workflow: ComfyApiWorkflow,
  samplerIds: string[],
  inputName: 'positive' | 'negative',
): ComfyInputRef[] {
  const refs: ComfyInputRef[] = []
  const seen = new Set<string>()
  for (const samplerId of samplerIds) {
    const source = refSource(workflow[samplerId]?.inputs[inputName])
    if (!source) continue
    const found = findPromptInBranch(workflow, source, new Set(), 0)
    if (!found) continue
    const key = `${found.node}.${found.input}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(found)
  }
  return refs
}

function findPromptInBranch(
  workflow: ComfyApiWorkflow,
  nodeId: string,
  seen: Set<string>,
  depth: number,
): ComfyInputRef | null {
  if (depth > 30 || seen.has(nodeId)) return null
  seen.add(nodeId)
  const node = workflow[nodeId]
  if (!node) return null
  for (const name of ['text', 'prompt', 'user_prompt', 'value']) {
    if (name in node.inputs && isPromptTextNode(node.class_type, name)) return { node: nodeId, input: name }
  }
  for (const value of Object.values(node.inputs)) {
    if (!isNodeRef(value)) continue
    const found = findPromptInBranch(workflow, value[0], seen, depth + 1)
    if (found) return found
  }
  return null
}

function findLongestTextRef(
  workflow: ComfyApiWorkflow,
  objectInfo: ComfyObjectInfo,
): ComfyInputRef | null {
  let best: { ref: ComfyInputRef; length: number } | null = null
  for (const [id, node] of Object.entries(workflow)) {
    for (const name of ['text', 'prompt', 'user_prompt', 'value']) {
      if (!(name in node.inputs) || !isPromptTextNode(node.class_type, name)) continue
      const value = node.inputs[name]
      if (typeof value !== 'string') continue
      if (!best || value.length > best.length) {
        best = { ref: { node: id, input: name }, length: value.length }
      }
    }
  }
  if (best) return best.ref
  // 有些 API 工作流的提示词已经由上游节点引用，也能从 schema 的 STRING 输入猜一个
  for (const [id, node] of Object.entries(workflow)) {
    const schema = objectInfo[node.class_type]?.input
    if (!schema) continue
    for (const name of Object.keys({ ...schema.required, ...schema.optional })) {
      const spec = schema.required?.[name] ?? schema.optional?.[name]
      if (Array.isArray(spec?.[0]) || spec?.[0] === 'STRING') {
        if (name in node.inputs) return { node: id, input: name }
      }
    }
  }
  return null
}

function isPromptTextNode(classType: string, input: string): boolean {
  if (input === 'text') return /CLIPTextEncode|Text/i.test(classType)
  if (input === 'prompt') return /Prompt|Conditioning|Text/i.test(classType)
  if (input === 'user_prompt') return /Prompt/i.test(classType)
  if (input === 'value') return /PrimitiveString|String/i.test(classType)
  return false
}

function refSource(value: ComfyInputValue | undefined): string | null {
  return isNodeRef(value) ? value[0] : null
}

function sameRef(a: ComfyInputRef, b: ComfyInputRef | null): boolean {
  return Boolean(b && a.node === b.node && a.input === b.input)
}

function buildCandidates(
  workflow: ComfyApiWorkflow,
  objectInfo: ComfyObjectInfo,
  titles: Record<string, string>,
): ComfyNodeCandidate[] {
  return Object.entries(workflow).map(([id, node]) => {
    const previewValue = Object.values(node.inputs).find(value => typeof value === 'string')
    return {
      id,
      classType: node.class_type,
      ...(titles[id] ? { title: titles[id] } : {}),
      output: isOutputNode(node, objectInfo, titles[id]),
      prompt: ['text', 'prompt', 'user_prompt', 'value'].some(
        name => name in node.inputs && isPromptTextNode(node.class_type, name),
      ),
      reference: node.class_type === 'LoadImage' && 'image' in node.inputs,
      inputs: Object.keys(node.inputs).slice(0, 40),
      ...(typeof previewValue === 'string' && previewValue
        ? { preview: previewValue.slice(0, 120) }
        : {}),
    }
  })
}

function numericId(id: string): number {
  const value = Number(id)
  return Number.isFinite(value) ? value : 0
}
