import { ApiRequestError, login, request } from '../lib/api.js'

const $ = selector => document.querySelector(selector)

const tabs = $('#auth-tabs')
const loginForm = $('#login-form')
const registerForm = $('#register-form')
const registerDone = $('#register-done')
const setupPanel = $('#setup-panel')
const cardTitle = $('#card-title')
const cardLede = $('#card-lede')

const loginSubmit = $('#login-submit')
const usernameInput = $('#username')
const passwordInput = $('#password')
const loginError = $('#login-error')

const regUsername = $('#reg-username')
const regDisplayName = $('#reg-display-name')
const regPassword = $('#reg-password')
const regPasswordConfirm = $('#reg-password-confirm')
const registerSubmit = $('#register-submit')
const registerError = $('#register-error')

const setupForm = $('#setup-form')
const setupSubmit = $('#setup-submit')
const setupError = $('#setup-error')
const setupKeyInput = $('#setup-key')
const setupUsernameInput = $('#setup-username')
const setupPasswordInput = $('#setup-password')

/* 与服务端一致的规则：前端先拦一遍，少走一次往返 */
const USERNAME_PATTERN = /^[A-Za-z0-9_.\-\u4e00-\u9fa5]{3,24}$/
const PASSWORD_MIN = 6

const COPY = {
  login: {
    title: '登录工作台',
    lede: '用已有账号进入生图工作台；还没有账号可以提交申请，管理员审核通过后即可登录。',
  },
  register: {
    title: '申请账号',
    lede: '填写用户名和密码提交申请。管理员在服务端控制台审核通过后，账号才能登录。',
  },
}

/* ---------- 提示位：没有错误时回到默认引导语，出错时原地变红 ---------- */
function setMessage(box, message, tone = 'err') {
  box.textContent = message || box.dataset.hint || ''
  box.classList.toggle('err', Boolean(message) && tone === 'err')
  box.classList.toggle('ok', Boolean(message) && tone === 'ok')
}

function clearMessage(box) {
  setMessage(box, '')
}

function invalidate(input, invalid) {
  if (invalid) input.setAttribute('aria-invalid', 'true')
  else input.removeAttribute('aria-invalid')
}

/* ---------- 登录 / 申请 切换 ---------- */
function setMode(mode) {
  const isRegister = mode === 'register'

  for (const tab of tabs.querySelectorAll('.tab')) {
    const active = tab.dataset.mode === mode
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', active ? 'true' : 'false')
    tab.tabIndex = active ? 0 : -1
  }

  loginForm.hidden = isRegister
  registerForm.hidden = !isRegister
  registerDone.hidden = true
  tabs.hidden = false
  cardTitle.textContent = COPY[mode].title
  cardLede.textContent = COPY[mode].lede

  clearMessage(loginError)
  clearMessage(registerError)
  invalidate(usernameInput, false)
  invalidate(passwordInput, false)
  invalidate(regUsername, false)
  invalidate(regPassword, false)
  invalidate(regPasswordConfirm, false)

  // 提交中切走再切回来时，按钮别停在加载态
  loginSubmit.disabled = false
  loginSubmit.textContent = '登录'
  registerSubmit.disabled = false
  registerSubmit.textContent = '提交申请'

  ;(isRegister ? regUsername : usernameInput).focus()
}

tabs.addEventListener('click', event => {
  const tab = event.target.closest('.tab')
  if (tab) setMode(tab.dataset.mode)
})

// 方向键在标签间移动，符合 tablist 的键盘习惯
tabs.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  setMode(document.querySelector('.tab.active')?.dataset.mode === 'login' ? 'register' : 'login')
})

/* ---------- 密码可见性 ---------- */
document.addEventListener('click', event => {
  const eye = event.target.closest('.eye')
  if (!eye) return
  const input = document.getElementById(eye.dataset.eye)
  if (!input) return
  const show = input.type === 'password'
  input.type = show ? 'text' : 'password'
  eye.setAttribute('aria-pressed', show ? 'true' : 'false')
  eye.setAttribute('aria-label', show ? '隐藏密码' : '显示密码')
  input.focus()
})

/* ---------- 登录 ---------- */
loginForm.addEventListener('submit', async event => {
  event.preventDefault()
  clearMessage(loginError)

  const username = usernameInput.value.trim()
  const password = passwordInput.value
  invalidate(usernameInput, false)
  invalidate(passwordInput, false)
  if (!username || !password) {
    invalidate(usernameInput, !username)
    invalidate(passwordInput, !password)
    setMessage(loginError, '请填写用户名和密码')
    ;(!username ? usernameInput : passwordInput).focus()
    return
  }

  loginSubmit.disabled = true
  loginSubmit.textContent = '正在登录…'

  try {
    const result = await login(username, password)
    if (!result?.user) throw new Error('登录失败，请重试')
    window.location.replace('/batch.html')
  } catch (error) {
    setMessage(loginError, error.message || '登录失败，请重试')
    loginSubmit.disabled = false
    loginSubmit.textContent = '登录'
    passwordInput.value = ''
    passwordInput.focus()
  }
})

/* ---------- 申请账号 ---------- */
registerForm.addEventListener('submit', async event => {
  event.preventDefault()
  clearMessage(registerError)

  const username = regUsername.value.trim()
  const displayName = regDisplayName.value.trim()
  const password = regPassword.value
  const confirm = regPasswordConfirm.value

  for (const input of [regUsername, regPassword, regPasswordConfirm]) invalidate(input, false)

  if (!USERNAME_PATTERN.test(username)) {
    invalidate(regUsername, true)
    setMessage(registerError, '用户名需为 3–24 位字母、数字、下划线或汉字')
    regUsername.focus()
    return
  }
  if (password.length < PASSWORD_MIN) {
    invalidate(regPassword, true)
    setMessage(registerError, `密码至少 ${PASSWORD_MIN} 位`)
    regPassword.focus()
    return
  }
  if (password !== confirm) {
    invalidate(regPasswordConfirm, true)
    setMessage(registerError, '两次输入的密码不一致')
    regPasswordConfirm.focus()
    return
  }

  registerSubmit.disabled = true
  registerSubmit.textContent = '正在提交…'

  try {
    await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, displayName, password }),
    })
    // 提交成功后收起表单：账号还没生效，需要等管理员审核
    tabs.hidden = true
    registerForm.hidden = true
    cardTitle.textContent = '申请已提交'
    cardLede.textContent = '这次申请要由管理员审核，通过后就能用刚才设置的密码登录。'
    $('#done-username').textContent = username
    registerDone.hidden = false
    $('#done-back').focus()
  } catch (error) {
    const message = error instanceof ApiRequestError ? error.message : '提交失败，请稍后重试'
    setMessage(registerError, message)
    if (error?.code === 'AUTH_INVALID' && /用户名/.test(message)) invalidate(regUsername, true)
    registerSubmit.disabled = false
    registerSubmit.textContent = '提交申请'
  }
})

// 输入时清掉红框，别让已经改过的字段还挂着错
for (const input of [regUsername, regPassword, regPasswordConfirm, usernameInput, passwordInput]) {
  input.addEventListener('input', () => invalidate(input, false))
}

// 首次部署表单同样：输入即清红框
for (const input of [setupKeyInput, setupUsernameInput, setupPasswordInput]) {
  input.addEventListener('input', () => invalidate(input, false))
}

$('#done-back').addEventListener('click', () => {
  setMode('login')
  usernameInput.value = regUsername.value.trim()
  regPassword.value = ''
  regPasswordConfirm.value = ''
  ;(usernameInput.value ? passwordInput : usernameInput).focus()
})

/* ---------- 首次部署：创建第一个管理员 ---------- */
setupForm.addEventListener('submit', async event => {
  event.preventDefault()
  clearMessage(setupError)

  const setupKey = setupKeyInput.value
  const username = setupUsernameInput.value.trim()
  const displayName = $('#setup-display-name').value.trim()
  const password = setupPasswordInput.value

  for (const input of [setupKeyInput, setupUsernameInput, setupPasswordInput]) invalidate(input, false)
  if (!setupKey || !username || !password) {
    invalidate(setupKeyInput, !setupKey)
    invalidate(setupUsernameInput, !username)
    invalidate(setupPasswordInput, !password)
    setMessage(setupError, '请填写管理密钥、用户名和密码')
    return
  }

  setupSubmit.disabled = true
  setupSubmit.textContent = '正在创建…'

  try {
    await request('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ setupKey, username, displayName, password }),
    })
    await login(username, password)
    window.location.replace('/batch.html')
  } catch (error) {
    setMessage(setupError, error.message || '创建失败')
    setupSubmit.disabled = false
    setupSubmit.textContent = '创建管理员'
  }
})

/* ---------- 首次进入：账号库为空走引导创建，否则按状态决定是否开放申请 ---------- */
fetch('/api/auth/status')
  .then(response => response.json())
  .then(status => {
    if (status?.needsSetup) {
      tabs.hidden = true
      loginForm.hidden = true
      registerForm.hidden = true
      setupPanel.hidden = false
      cardTitle.textContent = '初始化画境'
      cardLede.textContent = '账号库还是空的，先创建一个管理员账号。'
      $('#setup-key').focus()
      return
    }

    if (status?.registrationOpen === false) {
      const registerTab = document.querySelector('.tab[data-mode="register"]')
      if (registerTab) registerTab.hidden = true
    }
    setMode('login')
    usernameInput.focus()
  })
  .catch(() => {
    usernameInput.focus()
  })
