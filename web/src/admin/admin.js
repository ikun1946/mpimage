import {
  approveRegistration,
  createAdminUser,
  deleteAdminUser,
  fetchAdminFeedback,
  fetchAdminStats,
  fetchAdminTrend,
  fetchAdminUsers,
  fetchCurrentUser,
  getConcurrency,
  getMonitor,
  getRateLimit,
  getRegistrations,
  getUpstream,
  logout,
  rejectRegistration,
  saveConcurrency,
  saveRateLimit,
  saveUpstream,
  testUpstream,
  updateAdminUser,
  updateFeedbackStatus,
} from '../lib/api.js'
import { escapeHtml, formatDateTime } from '../lib/dom.js'
import { setupAvatarMenu } from '../lib/avatar-menu.js'
import { activateOverlay } from '../lib/overlay.js'

setupAvatarMenu()

const dom = {
  adminUser: document.querySelector('#admin-user'),
  avatar: document.querySelector('#user-avatar'),
  logoutButton: document.querySelector('#logout-button'),
  newUserButton: document.querySelector('#new-user-button'),
  refreshButton: document.querySelector('#refresh-button'),
  feedbackBody: document.querySelector('#feedback-body'),
  feedbackFilter: document.querySelector('#feedback-filter'),
  feedbackPending: document.querySelector('#feedback-pending'),
  usersBody: document.querySelector('#users-body'),
  statsBody: document.querySelector('#stats-body'),
  recentBody: document.querySelector('#recent-body'),
  statTotal: document.querySelector('#stat-total'),
  statAccounts: document.querySelector('#stat-accounts'),
  statBytes: document.querySelector('#stat-bytes'),
  registrationCount: document.querySelector('#registration-count'),
  registrationMsg: document.querySelector('#registration-msg'),
  registrationsBody: document.querySelector('#registrations-body'),
  rateLimitForm: document.querySelector('#rate-limit-form'),
  rateLimitEnabled: document.querySelector('#rate-limit-enabled'),
  rateLimitWindow: document.querySelector('#rate-limit-window'),
  rateLimitMax: document.querySelector('#rate-limit-max'),
  rateLimitState: document.querySelector('#rate-limit-state'),
  rateLimitSave: document.querySelector('#rate-limit-save'),
  rateLimitMsg: document.querySelector('#rate-limit-msg'),
  concurrencyForm: document.querySelector('#concurrency-form'),
  concurrencyLimit: document.querySelector('#concurrency-limit'),
  concurrencyState: document.querySelector('#concurrency-state'),
  concurrencySave: document.querySelector('#concurrency-save'),
  concurrencyMsg: document.querySelector('#concurrency-msg'),
  upstreamForm: document.querySelector('#upstream-form'),
  upstreamBaseUrl: document.querySelector('#upstream-base-url'),
  upstreamSource: document.querySelector('#upstream-source'),
  upstreamModel: document.querySelector('#upstream-model'),
  upstreamSave: document.querySelector('#upstream-save'),
  upstreamTest: document.querySelector('#upstream-test'),
  upstreamMsg: document.querySelector('#upstream-msg'),
  trafficRequests: document.querySelector('#traffic-requests'),
  trafficBytes: document.querySelector('#traffic-bytes'),
  trafficUptime: document.querySelector('#traffic-uptime'),
  trafficRate: document.querySelector('#traffic-rate'),
  trafficMsg: document.querySelector('#traffic-msg'),
  modal: document.querySelector('#user-modal'),
  modalTitle: document.querySelector('#modal-title'),
  form: document.querySelector('#user-form'),
  username: document.querySelector('#modal-username'),
  displayName: document.querySelector('#modal-display-name'),
  password: document.querySelector('#modal-password'),
  passwordHint: document.querySelector('#modal-password-hint'),
  role: document.querySelector('#modal-role'),
  error: document.querySelector('#modal-error'),
  save: document.querySelector('#modal-save'),
  cancel: document.querySelector('#modal-cancel'),
}

let currentUser = null
let editingId = ''
let stats = null
let modalOverlay = null

init()

async function init() {
  try {
    const result = await fetchCurrentUser()
    currentUser = result?.user
    if (!currentUser) throw new Error('未登录')
  } catch (error) {
    if (error?.code === 'AUTH_REQUIRED' || error?.status === 401 || error?.status === 403) {
      window.location.replace('/login.html')
    }
    return
  }

  if (currentUser.role !== 'admin') {
    window.location.replace('/')
    return
  }

  dom.adminUser.textContent = `${currentUser.displayName}（${currentUser.username}）`
  const letter = document.querySelector('#avatar-letter')
  if (letter) {
    const source = currentUser.displayName || currentUser.username || '管'
    letter.textContent = Array.from(source)[0] || '管'
  }
  // 先拿统计，再渲染账号表，这样表里能显示每个账号的生图数
  await loadStats()
  await loadUsers()
  // 审核、限流并发、上游、流量彼此独立，并行加载且各自容错，单块失败不影响整页
  await Promise.all([
    loadFeedback(),
    loadRegistrations(),
    loadRateLimit(),
    loadConcurrency(),
    loadUpstream(),
    loadTraffic(),
  ])
}

dom.logoutButton.addEventListener('click', async () => {
  await logout().catch(() => {})
  window.location.replace('/login.html')
})

dom.refreshButton.addEventListener('click', async () => {
  await Promise.all([loadStats(), loadTraffic()])
})

dom.newUserButton.addEventListener('click', () => {
  openModal()
})

dom.cancel.addEventListener('click', closeModal)

dom.modal.addEventListener('click', event => {
  if (event.target === dom.modal) closeModal()
})

dom.form.addEventListener('submit', async event => {
  event.preventDefault()
  clearError()

  const username = dom.username.value.trim()
  const displayName = dom.displayName.value.trim()
  const password = dom.password.value
  const role = dom.role.value

  if (!username) {
    showError('用户名不能为空')
    return
  }

  dom.save.disabled = true
  dom.save.textContent = '保存中…'

  try {
    if (editingId) {
      const patch = { displayName }
      if (password) patch.password = password
      await updateAdminUser(editingId, patch)
    } else {
      if (!password) {
        throw new Error('请设置密码')
      }
      await createAdminUser({ username, displayName, password, role })
    }
    closeModal()
    await loadStats()
    await loadUsers()
  } catch (error) {
    showError(error.message || '保存失败')
  } finally {
    dom.save.disabled = false
    dom.save.textContent = '保存'
  }
})

function openModal(user) {
  editingId = user?.id || ''
  dom.modalTitle.textContent = user ? `编辑账号 · ${user.username}` : '新建账号'
  dom.username.value = user?.username || ''
  dom.username.disabled = Boolean(user)
  dom.displayName.value = user?.displayName || ''
  dom.password.value = ''
  dom.passwordHint.textContent = user ? '留空表示不修改密码' : '至少 6 位'
  dom.role.value = user?.role || 'user'
  dom.role.disabled = Boolean(user)
  clearError()
  dom.modal.hidden = false
  // 显隐仍由本页决定，overlay 只接管 ESC / 焦点陷阱 / 滚动锁
  modalOverlay?.release()
  modalOverlay = activateOverlay(dom.modal, {
    onRequestClose: closeModal,
    initialFocus: dom.username.disabled ? dom.displayName : dom.username,
  })
}

function closeModal() {
  modalOverlay?.release()
  modalOverlay = null
  dom.modal.hidden = true
  editingId = ''
}

function showError(message) {
  dom.error.textContent = message
  dom.error.hidden = false
}

function clearError() {
  dom.error.textContent = ''
  dom.error.hidden = true
}

async function loadUsers() {
  try {
    const result = await fetchAdminUsers()
    const users = result?.users || []
    const counts = new Map()
    for (const account of stats?.accounts || []) {
      counts.set(account.userId, account.count)
    }

    if (!users.length) {
      dom.usersBody.innerHTML = '<tr class="empty-row"><td colspan="6">还没有账号</td></tr>'
      return
    }

    dom.usersBody.innerHTML = users
      .map(user => {
        const count = counts.get(user.id) ?? 0
        const roleTag =
          user.role === 'admin'
            ? '<span class="role-tag admin">管理员</span>'
            : '<span class="role-tag user">普通用户</span>'
        const statusTag = user.disabled
          ? '<span class="status-tag off">已停用</span>'
          : '<span class="status-tag on">正常</span>'
        const toggleLabel = user.disabled ? '启用' : '停用'
        const isSelf = user.id === currentUser.id

        return `<tr>
          <td title="创建于 ${formatDateTime(user.createdAt)}｜最近登录 ${user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}">${escapeHtml(user.username)}</td>
          <td>${escapeHtml(user.displayName)}</td>
          <td>${roleTag}</td>
          <td>${statusTag}</td>
          <td>${count}</td>
          <td>
            <div class="row-actions">
              <button class="button ghost sm" data-action="edit" data-id="${escapeHtml(user.id)}">编辑</button>
              ${
                isSelf
                  ? ''
                  : `<button class="button ghost sm" data-action="toggle" data-id="${escapeHtml(user.id)}" data-disabled="${user.disabled}">${toggleLabel}</button>
                     <button class="button danger sm" data-action="delete" data-id="${escapeHtml(user.id)}">删除</button>`
              }
            </div>
          </td>
        </tr>`
      })
      .join('')
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      window.location.replace('/login.html')
      return
    }
      dom.usersBody.innerHTML = `<tr class="empty-row"><td colspan="6">读取失败：${escapeHtml(error.message)}</td></tr>`
  }
}

async function loadStats() {
  try {
    stats = await fetchAdminStats()
    dom.statTotal.textContent = String(stats.totalImages || 0)
    dom.statAccounts.textContent = String(stats.accountCount || 0)
    dom.statBytes.textContent = ((stats.totalBytes || 0) / 1024 / 1024).toFixed(1)

    const accounts = stats.accounts || []
    if (!accounts.length) {
      dom.statsBody.innerHTML = '<tr class="empty-row"><td colspan="5">还没有生图记录</td></tr>'
    } else {
      const max = Math.max(...accounts.map(item => item.count), 1)
      dom.statsBody.innerHTML = accounts
        .map(item => {
          const percent = ((item.count / (stats.totalImages || 1)) * 100).toFixed(1)
          return `<tr>
            <td>${escapeHtml(item.username)}</td>
            <td>${item.count}</td>
            <td>${(item.bytes / 1024 / 1024).toFixed(1)} MB</td>
            <td>${item.lastGeneratedAt ? formatDateTime(item.lastGeneratedAt) : '—'}</td>
            <td class="bar-cell">
              ${percent}%
              <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, (item.count / max) * 100).toFixed(1)}%"></div></div>
            </td>
          </tr>`
        })
        .join('')
    }

    const recent = stats.recent || []
    if (!recent.length) {
      dom.recentBody.innerHTML = '<tr class="empty-row"><td colspan="7">还没有生图记录</td></tr>'
    } else {
      dom.recentBody.innerHTML = recent
        .map(item => `<tr>
          <td>${formatDateTime(item.createdAt)}</td>
          <td>${escapeHtml(item.username)}</td>
          <td>${escapeHtml(item.category)}</td>
          <td>${escapeHtml(item.name || '—')}</td>
          <td>${escapeHtml(item.ratio)}</td>
          <td>${item.width} × ${item.height}</td>
          <td>${(item.bytes / 1024 / 1024).toFixed(1)} MB</td>
        </tr>`)
        .join('')
    }

    await renderTrend()
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      window.location.replace('/login.html')
      return
    }
    console.error(error)
  }
}

// ---------- 用户反馈 ----------

const FEEDBACK_CATEGORY_LABEL = { bug: '缺陷', suggestion: '建议', other: '其他' }

let feedbackStatus = 'all'

dom.feedbackFilter?.addEventListener('click', async event => {
  const tab = event.target.closest('[data-status]')
  if (!tab || tab.dataset.status === feedbackStatus) return

  feedbackStatus = tab.dataset.status
  dom.feedbackFilter.querySelectorAll('.trend-tab').forEach(item => {
    item.classList.toggle('active', item === tab)
  })
  await loadFeedback()
})

dom.feedbackBody.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]')
  if (!target) return

  // 长内容默认单行省略，点一下就地展开 / 收起（完整文本同时也放 title 里）
  if (target.dataset.action === 'expand') {
    const expanded = target.classList.toggle('expanded')
    target.setAttribute('aria-expanded', String(expanded))
    return
  }

  if (target.dataset.action === 'toggle-status') {
    const next = target.dataset.status === 'resolved' ? 'new' : 'resolved'
    target.disabled = true
    try {
      await updateFeedbackStatus(target.dataset.id, next)
      await loadFeedback()
    } catch (error) {
      target.disabled = false
      alert(error.message || '操作失败')
    }
  }
})

async function loadFeedback() {
  try {
    // 固定拉 200 条：筛选与角标都基于同一份结果，避免切换时数字跳动
    const result = await fetchAdminFeedback(feedbackStatus, 200)
    renderFeedback(result?.feedback || [], result?.counts || {})
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      window.location.replace('/login.html')
      return
    }
    dom.feedbackBody.innerHTML = `<tr class="empty-row"><td colspan="7">读取失败：${escapeHtml(error.message)}</td></tr>`
  }
}

function renderFeedback(items, counts) {
  const pending = Number(counts.new || 0)
  dom.feedbackPending.textContent = `未处理 ${pending}`
  dom.feedbackPending.classList.toggle('has-pending', pending > 0)

  if (!items.length) {
    const message = feedbackStatus === 'new' ? '没有待处理的反馈' : '还没有反馈'
    dom.feedbackBody.innerHTML = `<tr class="empty-row"><td colspan="7">${message}</td></tr>`
    return
  }

  dom.feedbackBody.innerHTML = items
    .map(item => {
      const account = item.displayName
        ? `${item.displayName}（${item.username}）`
        : item.username
      const category = FEEDBACK_CATEGORY_LABEL[item.category] || item.category
      const resolved = item.status === 'resolved'
      const statusPill = resolved
        ? '<span class="status-pill done">已处理</span>'
        : '<span class="status-pill queued">未处理</span>'
      const timeTitle = item.appVersion ? `客户端版本 ${item.appVersion}` : ''

      return `<tr>
        <td${timeTitle ? ` title="${escapeHtml(timeTitle)}"` : ''}>${formatDateTime(item.createdAt)}</td>
        <td>${escapeHtml(account)}</td>
        <td><span class="badge">${escapeHtml(category)}</span></td>
        <td class="feedback-content-cell">
          <button class="feedback-content" type="button" data-action="expand" aria-expanded="false" title="${escapeHtml(item.content)}">${escapeHtml(item.content)}</button>
        </td>
        <td>${escapeHtml(item.page || '—')}</td>
        <td>${statusPill}</td>
        <td>
          <div class="row-actions">
            <button class="button ghost sm" data-action="toggle-status" data-id="${escapeHtml(item.id)}" data-status="${resolved ? 'resolved' : 'new'}">${resolved ? '标记未处理' : '标记已处理'}</button>
          </div>
        </td>
      </tr>`
    })
    .join('')
}

// ---------- 待审核账号 / 限流并发 / 上游设置 / 流量 ----------

function isAuthError(error) {
  return error?.status === 401 || error?.status === 403
}

/** 提示统一走 ui/components.css 的 .form-msg：ok / err 两种语气 */
function setNotice(element, text, tone) {
  if (!element) return
  element.textContent = text
  element.classList.toggle('ok', tone === 'ok')
  element.classList.toggle('err', tone === 'err')
}

async function loadRegistrations() {
  try {
    const result = await getRegistrations()
    renderRegistrations(result?.registrations || [])
  } catch (error) {
    if (isAuthError(error)) {
      window.location.replace('/login.html')
      return
    }
    dom.registrationCount.textContent = '待审 —'
    dom.registrationCount.classList.remove('has-pending')
    dom.registrationsBody.innerHTML = `<tr class="empty-row"><td colspan="4">读取失败：${escapeHtml(error.message)}</td></tr>`
  }
}

function renderRegistrations(items) {
  dom.registrationCount.textContent = `待审 ${items.length}`
  dom.registrationCount.classList.toggle('has-pending', items.length > 0)

  if (!items.length) {
    dom.registrationsBody.innerHTML = '<tr class="empty-row"><td colspan="4">没有待审核的申请</td></tr>'
    return
  }

  dom.registrationsBody.innerHTML = items
    .map(
      item => `<tr>
        <td>${escapeHtml(item.username)}</td>
        <td>${item.displayName ? escapeHtml(item.displayName) : '—'}</td>
        <td>${item.createdAt ? formatDateTime(item.createdAt) : '—'}</td>
        <td>
          <div class="row-actions">
            <button class="button primary sm" data-action="approve" data-id="${escapeHtml(item.id)}">通过</button>
            <button class="button danger sm" data-action="reject" data-id="${escapeHtml(item.id)}">拒绝</button>
          </div>
        </td>
      </tr>`,
    )
    .join('')
}

dom.registrationsBody.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]')
  if (!button) return

  const id = button.dataset.id
  const approved = button.dataset.action === 'approve'
  const username = button.closest('tr')?.querySelector('td')?.textContent?.trim() || ''

  // 同一行两个按钮一起锁住，避免请求还在路上时又点了另一个
  const rowButtons = button.closest('tr')?.querySelectorAll('button') || []
  rowButtons.forEach(item => {
    item.disabled = true
  })
  try {
    if (approved) {
      await approveRegistration(id)
      setNotice(dom.registrationMsg, `已通过「${username}」的申请，该账号现在可以登录`, 'ok')
    } else {
      await rejectRegistration(id)
      setNotice(dom.registrationMsg, `已拒绝并删除「${username}」的申请`, 'ok')
    }
    await loadRegistrations()
    // 通过后账号表会多一行，顺手把它刷出来
    if (approved) await loadUsers()
  } catch (error) {
    if (isAuthError(error)) {
      window.location.replace('/login.html')
      return
    }
    setNotice(dom.registrationMsg, error.message || '操作失败', 'err')
    rowButtons.forEach(item => {
      item.disabled = false
    })
  }
})

// ---------- 限流 ----------

async function loadRateLimit() {
  try {
    const status = await getRateLimit()
    applyRateLimit(status?.config)
  } catch (error) {
    if (isAuthError(error)) {
      window.location.replace('/login.html')
      return
    }
    dom.rateLimitState.textContent = '读取失败'
    setNotice(dom.rateLimitMsg, `读取失败：${error.message}`, 'err')
  }
}

/** 接口给的是 windowMs，界面按秒展示；缺省值退回后端的默认 60 秒 / 60 次 */
function applyRateLimit(config) {
  if (!config) return
  const windowMs = Number(config.windowMs)
  const maxRequests = Number(config.maxRequests)
  dom.rateLimitEnabled.checked = Boolean(config.enabled)
  dom.rateLimitWindow.value = String(windowMs > 0 ? Math.round(windowMs / 1000) : 60)
  dom.rateLimitMax.value = String(maxRequests > 0 ? Math.round(maxRequests) : 60)
  dom.rateLimitState.textContent =
    `当前：${config.enabled ? '已启用' : '未启用'}｜每 ${dom.rateLimitWindow.value} 秒最多 ${dom.rateLimitMax.value} 次`
}

dom.rateLimitForm.addEventListener('submit', async event => {
  event.preventDefault()

  const seconds = Number(dom.rateLimitWindow.value)
  const maxRequests = Number(dom.rateLimitMax.value)
  if (!Number.isInteger(seconds) || seconds < 1) {
    setNotice(dom.rateLimitMsg, '窗口秒数必须是正整数', 'err')
    return
  }
  if (!Number.isInteger(maxRequests) || maxRequests < 1) {
    setNotice(dom.rateLimitMsg, '每窗口最大请求数必须是正整数', 'err')
    return
  }

  dom.rateLimitSave.disabled = true
  dom.rateLimitSave.textContent = '保存中…'
  try {
    const result = await saveRateLimit({
      enabled: dom.rateLimitEnabled.checked,
      windowMs: seconds * 1000,
      maxRequests,
    })
    // 以后端回传的配置为准回显，避免前端算的和实际生效值不一致
    applyRateLimit(result?.config)
    setNotice(dom.rateLimitMsg, '已保存，当前生效值如上', 'ok')
    loadTraffic()
  } catch (error) {
    if (isAuthError(error)) {
      window.location.replace('/login.html')
      return
    }
    setNotice(dom.rateLimitMsg, error.message || '保存失败', 'err')
  } finally {
    dom.rateLimitSave.disabled = false
    dom.rateLimitSave.textContent = '保存'
  }
})

// ---------- 生图并发 ----------

async function loadConcurrency() {
  try {
    renderConcurrency(await getConcurrency())
  } catch (error) {
    if (isAuthError(error)) {
      window.location.replace('/login.html')
      return
    }
    dom.concurrencyState.textContent = '读取失败'
    setNotice(dom.concurrencyMsg, error.message || '读取失败', 'err')
  }
}

function renderConcurrency(status) {
  if (!status) return
  const limit = Number(status.limit)
  dom.concurrencyLimit.value = String(limit > 0 ? limit : 1)
  dom.concurrencyState.textContent =
    `当前生效 ${limit}｜进行中 ${Number(status.active || 0)}｜排队 ${Number(status.waiting || 0)}`
}

dom.concurrencyForm.addEventListener('submit', async event => {
  event.preventDefault()

  const limit = Number(dom.concurrencyLimit.value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) {
    setNotice(dom.concurrencyMsg, '并发上限必须是 1–8 之间的整数', 'err')
    return
  }

  dom.concurrencySave.disabled = true
  dom.concurrencySave.textContent = '保存中…'
  try {
    renderConcurrency(await saveConcurrency(limit))
    setNotice(dom.concurrencyMsg, '已保存，新的并发上限立即生效', 'ok')
    loadTraffic()
  } catch (error) {
    if (isAuthError(error)) {
      window.location.replace('/login.html')
      return
    }
    setNotice(dom.concurrencyMsg, error.message || '保存失败', 'err')
  } finally {
    dom.concurrencySave.disabled = false
    dom.concurrencySave.textContent = '保存'
  }
})

// ---------- 上游设置 ----------

async function loadUpstream() {
  try {
    const data = await getUpstream()
    dom.upstreamBaseUrl.value = data?.baseUrl || ''
    dom.upstreamModel.textContent = data?.model || '—'
    const custom = Boolean(data?.fromSettings)
    dom.upstreamSource.textContent = custom ? '已自定义' : '来自配置'
    dom.upstreamSource.classList.toggle('on', custom)
  } catch (error) {
    if (isAuthError(error)) {
      window.location.replace('/login.html')
      return
    }
    dom.upstreamSource.textContent = '读取失败'
    dom.upstreamSource.classList.remove('on')
    setNotice(dom.upstreamMsg, `读取失败：${error.message}`, 'err')
  }
}

dom.upstreamTest.addEventListener('click', async () => {
  const baseUrl = dom.upstreamBaseUrl.value.trim()
  if (!baseUrl) {
    setNotice(dom.upstreamMsg, '先填写上游地址再测试', 'err')
    return
  }

  dom.upstreamTest.disabled = true
  dom.upstreamTest.textContent = '测试中…'
  try {
    const result = await testUpstream(baseUrl)
    // 后端连通性测试没有 HTTP 状态码时返回 null，这时只报可达性和明细
    const statusText = typeof result?.status === 'number' ? `（状态 ${result.status}）` : ''
    const detail = result?.detail ? `：${result.detail}` : ''
    setNotice(
      dom.upstreamMsg,
      `${result?.reachable ? '可达' : '不可达'}${statusText}${detail}`,
      result?.reachable ? 'ok' : 'err',
    )
  } catch (error) {
    if (isAuthError(error)) {
      window.location.replace('/login.html')
      return
    }
    setNotice(dom.upstreamMsg, error.message || '测试失败', 'err')
  } finally {
    dom.upstreamTest.disabled = false
    dom.upstreamTest.textContent = '测试连通'
  }
})

dom.upstreamForm.addEventListener('submit', async event => {
  event.preventDefault()

  const baseUrl = dom.upstreamBaseUrl.value.trim()
  if (!baseUrl) {
    setNotice(dom.upstreamMsg, '请填写上游地址', 'err')
    return
  }

  dom.upstreamSave.disabled = true
  dom.upstreamSave.textContent = '保存中…'
  try {
    const result = await saveUpstream(baseUrl)
    dom.upstreamBaseUrl.value = result?.baseUrl || baseUrl
    setNotice(dom.upstreamMsg, '已保存，即时生效，无需重启服务', 'ok')
    // 地址保存后「来源」会变成「已自定义」，重新读一次元信息
    loadUpstream()
  } catch (error) {
    if (isAuthError(error)) {
      window.location.replace('/login.html')
      return
    }
    setNotice(dom.upstreamMsg, error.message || '保存失败', 'err')
  } finally {
    dom.upstreamSave.disabled = false
    dom.upstreamSave.textContent = '保存'
  }
})

// ---------- 服务流量 ----------

async function loadTraffic() {
  try {
    const monitor = await getMonitor()
    const total = monitor?.traffic?.total || {}
    dom.trafficRequests.textContent = String(Number(total.requests || 0))
    dom.trafficBytes.textContent = formatBytes(Number(total.bytesIn || 0) + Number(total.bytesOut || 0))
    dom.trafficUptime.textContent = monitor?.uptime?.uptimeText || '—'

    const config = monitor?.rateLimit?.config
    if (!config) {
      dom.trafficRate.textContent = '—'
    } else if (config.enabled) {
      dom.trafficRate.textContent = `开启｜${config.maxRequests} 次 / ${Math.round(Number(config.windowMs) / 1000)} 秒`
    } else {
      dom.trafficRate.textContent = '未启用'
    }

    setNotice(dom.trafficMsg, '')
  } catch (error) {
    if (isAuthError(error)) {
      window.location.replace('/login.html')
      return
    }
    dom.trafficRequests.textContent = '—'
    dom.trafficBytes.textContent = '—'
    dom.trafficUptime.textContent = '—'
    dom.trafficRate.textContent = '—'
    setNotice(dom.trafficMsg, `流量数据读取失败：${error.message}`, 'err')
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${index === 0 ? String(value) : value.toFixed(1)} ${units[index]}`
}

// ---------- 生图趋势折线图 ----------

const trendDom = {
  tabs: document.querySelector('#trend-tabs'),
  total: document.querySelector('#trend-total'),
  chart: document.querySelector('#trend-chart'),
  empty: document.querySelector('#trend-empty'),
}

let trendRange = '7d'

const TREND_LABEL_EVERY = { today: 3, '7d': 1, '30d': 3, '90d': 15, '180d': 30 }

trendDom.tabs?.addEventListener('click', async event => {
  const tab = event.target.closest('[data-range]')
  if (!tab || tab.dataset.range === trendRange) return

  trendRange = tab.dataset.range
  trendDom.tabs.querySelectorAll('.trend-tab').forEach(item => {
    item.classList.toggle('active', item === tab)
  })
  await renderTrend()
})

async function renderTrend() {
  if (!trendDom.chart) return

  let payload
  try {
    payload = await fetchAdminTrend(trendRange)
  } catch (error) {
    console.error(error)
    return
  }

  const buckets = payload?.buckets || []
  trendDom.total.textContent = `本范围共 ${payload.total || 0} 张`

  if (!buckets.some(bucket => bucket.count > 0)) {
    trendDom.empty.hidden = false
    trendDom.chart.innerHTML = ''
    return
  }
  trendDom.empty.hidden = true

  drawTrendChart(buckets)
}

/**
 * 手写 SVG 折线图：零依赖，宽度自适应容器。
 * 数据点带悬停提示，横轴按范围抽稀标注。
 */
function drawTrendChart(buckets) {
  const width = Math.max(trendDom.chart.clientWidth || 600, 320)
  const height = 220
  const pad = { top: 16, right: 16, bottom: 28, left: 36 }
  const innerWidth = width - pad.left - pad.right
  const innerHeight = height - pad.top - pad.bottom

  const maxCount = Math.max(...buckets.map(bucket => bucket.count), 1)
  const stepX = buckets.length > 1 ? innerWidth / (buckets.length - 1) : 0
  const xAt = index => pad.left + index * stepX
  const yAt = count => pad.top + innerHeight - (count / maxCount) * innerHeight

  const points = buckets.map((bucket, index) => ({ ...bucket, x: xAt(index), y: yAt(bucket.count) }))
  const linePath = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${(pad.top + innerHeight).toFixed(1)} L${points[0].x.toFixed(1)},${(pad.top + innerHeight).toFixed(1)} Z`

  // 横轴网格线：取不超过 4 条的整刻度
  const gridLines = []
  const gridSteps = 4
  for (let i = 1; i <= gridSteps; i += 1) {
    const value = Math.round((maxCount * i) / gridSteps)
    const y = yAt(value)
    gridLines.push(`
      <line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${(width - pad.right).toFixed(1)}" y2="${y.toFixed(1)}" class="trend-grid"></line>
      <text x="${pad.left - 6}" y="${(y + 4).toFixed(1)}" class="trend-axis-label" text-anchor="end">${value}</text>
    `)
  }

  // 横轴标注：按范围抽稀，避免重叠
  const every = TREND_LABEL_EVERY[trendRange] || 1
  const axisLabels = points
    .filter((point, index) => index % every === 0 || index === points.length - 1)
    .map(point => `
      <text x="${point.x.toFixed(1)}" y="${height - 8}" class="trend-axis-label" text-anchor="middle">${escapeHtml(point.label)}</text>
    `)
    .join('')

  const dots = points
    .map(point => `
      <g class="trend-dot">
        <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3"></circle>
        <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="12" class="trend-dot-hit"></circle>
        <title>${escapeHtml(point.label)}：${point.count} 张</title>
      </g>
    `)
    .join('')

  trendDom.chart.setAttribute('viewBox', `0 0 ${width} ${height}`)
  trendDom.chart.innerHTML = `
    ${gridLines.join('')}
    <path d="${areaPath}" class="trend-area"></path>
    <path d="${linePath}" class="trend-line"></path>
    ${dots}
    ${axisLabels}
  `
}

window.addEventListener('resize', debounce(() => {
  if (trendDom.chart?.innerHTML) renderTrend()
}, 200))

function debounce(fn, wait) {
  let timer = 0
  return (...args) => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => fn(...args), wait)
  }
}

dom.usersBody.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]')
  if (!button) return

  const id = button.dataset.id
  const action = button.dataset.action

  if (action === 'edit') {
    const users = (await fetchAdminUsers().catch(() => null))?.users || []
    const user = users.find(item => item.id === id)
    if (user) openModal(user)
    return
  }

  if (action === 'toggle') {
    const disabled = button.dataset.disabled === 'true'
    try {
      await updateAdminUser(id, { disabled: !disabled })
      await loadStats()
      await loadUsers()
    } catch (error) {
      alert(error.message || '操作失败')
    }
    return
  }

  if (action === 'delete') {
    if (!window.confirm('删除该账号？该账号的生图记录仍会保留在统计中。')) return
    try {
      await deleteAdminUser(id)
      await loadStats()
      await loadUsers()
    } catch (error) {
      alert(error.message || '删除失败')
    }
  }
})
