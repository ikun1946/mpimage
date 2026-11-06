import { API_BASE } from './config.js'

export class ApiRequestError extends Error {
  constructor(message, code, status) {
    super(message)
    this.name = 'ApiRequestError'
    this.code = code
    this.status = status
  }
}

export async function request(path, options = {}) {
  const hasBody = options.body !== undefined && options.body !== null
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })

  const isJson = (response.headers.get('content-type') || '').includes('application/json')
  const payload = isJson ? await response.json().catch(() => null) : null

  if (!response.ok) {
    throw new ApiRequestError(
      payload?.error || `请求失败（HTTP ${response.status}）`,
      payload?.code,
      response.status,
    )
  }

  return payload
}

export function generateImage({ prompt, ratio, category, name, source, jobId, referencePath, referencePaths }) {
  return request('/api/images', {
    method: 'POST',
    body: JSON.stringify({ prompt, ratio, category, name, source, jobId, referencePath, referencePaths }),
  })
}

/** 查询生图任务状态：页面刷新后用 jobId 接回仍在后台生成的图片 */
export function fetchGenerationJob(jobId) {
  return request(`/api/images/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' })
}

/**
 * 对话模型扩写提示词：ratio 与参考图张数让模型按实际出图条件写画面；
 * referencePaths 与生图同源，按显示顺序送上游读图。
 */
export function optimizePrompt({ prompt, ratio, referenceCount, referencePaths }) {
  return request('/api/prompts/optimize', {
    method: 'POST',
    body: JSON.stringify({ prompt, ratio, referenceCount, referencePaths }),
  })
}

/**
 * 改写已有提示词：instruction 是用户这次的修改要求。
 * referencePaths 为参考图（参考图/），contextPaths 为已生成的结果图。
 */
export function revisePrompt({ prompt, instruction, ratio, referencePaths, contextPaths }) {
  return request('/api/prompts/revise', {
    method: 'POST',
    body: JSON.stringify({ prompt, instruction, ratio, referencePaths, contextPaths }),
  })
}

/**
 * 捏脸：把角色设定交给对话模型，返回角色分析 + 完整提示词 + 负面提示词。
 * sourceText 为一段人设 / 小说片段，模型会先解析出角色设定再设计。
 */
export function designFace({ age, gender, temperament, identity, framing, background, style, extra, sourceText }) {
  return request('/api/prompts/face-design', {
    method: 'POST',
    body: JSON.stringify({ age, gender, temperament, identity, framing, background, style, extra, sourceText }),
  })
}

/**
 * 捏脸的定向修改：field 为 prompt 或 negative，一次只改这一栏。
 * analysis 与 other 用来让人物设定和另一栏保持一致。
 */
export function refineFaceField({ field, value, instruction, analysis, other }) {
  return request('/api/prompts/face-refine', {
    method: 'POST',
    body: JSON.stringify({ field, value, instruction, analysis, other }),
  })
}

export function fetchServerConfig() {
  return request('/api/config', { method: 'GET' })
}

export function fetchHealth() {
  return request('/api/health', { method: 'GET' })
}

export function fetchStyleLibrary() {
  return request('/api/styles', { method: 'GET' })
}

export function saveStyleLibrary(library) {
  return request('/api/styles', {
    method: 'PUT',
    body: JSON.stringify(library),
  })
}

// ---------- 认证 ----------

export function login(username, password) {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

/** 自助修改显示名（登录用的用户名不变） */
export function updateMyProfile(payload) {
  return request('/api/auth/me', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function logout() {
  return request('/api/auth/logout', { method: 'POST' })
}

export function fetchCurrentUser() {
  return request('/api/auth/me', { method: 'GET' })
}

// ---------- 管理端 ----------

export function fetchAdminUsers() {
  return request('/api/admin/users', { method: 'GET' })
}

export function createAdminUser({ username, displayName, password, role }) {
  return request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username, displayName, password, role }),
  })
}

export function updateAdminUser(id, patch) {
  return request(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteAdminUser(id) {
  return request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function fetchAdminStats() {
  return request('/api/admin/stats', { method: 'GET' })
}

export function fetchAdminTrend(range) {
  return request(`/api/admin/stats/trend?range=${encodeURIComponent(range)}`, { method: 'GET' })
}
// ---------- 项目 ----------

export function fetchProjects() {
  return request('/api/projects', { method: 'GET' })
}

export function fetchProject(id) {
  return request(`/api/projects/${encodeURIComponent(id)}`, { method: 'GET' })
}

export function createProject(payload) {
  return request('/api/projects', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

export function updateProject(id, patch) {
  return request(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteProject(id) {
  return request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function activateProject(id) {
  return request(`/api/projects/${encodeURIComponent(id)}/activate`, { method: 'POST' })
}

// ---------- 角色面部参考图 ----------

/** 上传角色面部参考图：dataUrl 为 data:image/(png|jpeg|webp);base64,... */
export function uploadReferenceImage({ name, dataUrl }) {
  return request('/api/reference-images', {
    method: 'POST',
    body: JSON.stringify({ name, dataUrl }),
  })
}

// ---------- 生成记录 ----------

export function fetchHistory(limit = 200) {
  return request(`/api/history?limit=${encodeURIComponent(limit)}`, { method: 'GET' })
}

// ---------- 意见反馈 ----------

/** 客户端提交一条反馈：category 为 bug / suggestion / other */
export function submitFeedback({ category, content, page, appVersion }) {
  return request('/api/feedback', {
    method: 'POST',
    body: JSON.stringify({ category, content, page, appVersion }),
  })
}

export function fetchMyFeedback(limit = 20) {
  return request(`/api/feedback/mine?limit=${encodeURIComponent(limit)}`, { method: 'GET' })
}

export function fetchAdminFeedback(status = 'all', limit = 200) {
  const params = new URLSearchParams({ status, limit: String(limit) })
  return request(`/api/admin/feedback?${params.toString()}`, { method: 'GET' })
}

export function updateFeedbackStatus(id, status) {
  return request(`/api/admin/feedback/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

// ---------- 版本更新 ----------

/** force=true 时绕过服务端的检查缓存，其余情况沿用最近一次结果 */
export function getUpdateStatus(force = false) {
  return request(`/api/update/status${force ? '?force=1' : ''}`, { method: 'GET' })
}

// ---------- 后台管理 ----------

export function getRegistrations() {
  return request('/api/admin/registrations', { method: 'GET' })
}

export function approveRegistration(id) {
  return request(`/api/admin/registrations/${encodeURIComponent(id)}/approve`, { method: 'POST' })
}

export function rejectRegistration(id) {
  return request(`/api/admin/registrations/${encodeURIComponent(id)}/reject`, { method: 'POST' })
}

export function getRateLimit() {
  return request('/api/admin/rate-limit', { method: 'GET' })
}

export function saveRateLimit(payload) {
  return request('/api/admin/rate-limit', {
    method: 'PUT',
    body: JSON.stringify(payload || {}),
  })
}

export function getConcurrency() {
  return request('/api/admin/concurrency', { method: 'GET' })
}

export function saveConcurrency(limit) {
  return request('/api/admin/concurrency', {
    method: 'PUT',
    body: JSON.stringify({ limit }),
  })
}

export function getUpstream() {
  return request('/api/admin/upstream', { method: 'GET' })
}

export function saveUpstream(baseUrl) {
  return request('/api/admin/upstream', {
    method: 'PUT',
    body: JSON.stringify({ baseUrl }),
  })
}

export function testUpstream(baseUrl) {
  return request('/api/admin/upstream/test', {
    method: 'POST',
    body: JSON.stringify({ baseUrl }),
  })
}

export function getMonitor() {
  return request('/api/admin/monitor', { method: 'GET' })
}