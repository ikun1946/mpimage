import { requireLogin } from '../lib/guard.js'

const loading = document.querySelector('#face-loading')

function showLoadError(message) {
  document.body.classList.remove('is-booting')
  if (loading) {
    loading.innerHTML = `<div class="face-loading-card">
      <span class="face-loading-mark">境</span>
      <strong>捏脸工作台没能打开</strong>
      <p>${String(message).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))}</p>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn ghost" type="button" onclick="location.reload()">重试</button>
        <a class="btn ghost" href="/batch.html">返回创作台</a>
      </div>
    </div>`
  }
}

void requireLogin()
  .then(async user => {
    window.__FACE_USER_ID__ = String(user.userId || user.id || '')
    if (!window.__FACE_USER_ID__) throw new Error('登录状态异常，请刷新后重试')
    await import('./app.js')
  })
  .catch(error => {
    showLoadError(error?.message || '请检查登录状态后重试')
  })
