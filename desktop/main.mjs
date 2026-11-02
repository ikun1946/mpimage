import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import { basename, join } from 'node:path'
import { appRoot, dataRoot } from './paths.mjs'
import { loadConfig } from './config.mjs'
import { desktopToken, initServer, restartServer, serverState, startServer, stopServer, waitForServer } from './server.mjs'
import { checkForUpdate, downloadInstaller, findReadyInstaller, launchInstaller } from './updater.mjs'

/* ===== 基础路径：数据一律写在数据根，绝不碰安装目录 ===== */
const ROOT = appRoot()
const DATA = dataRoot()
const LOG_DIR = join(DATA, 'logs')
const MAIN_LOG = join(LOG_DIR, 'desktop.log')
const LOG_READ_LIMIT = 256 * 1024

// userData 指到固定的 huajing 目录，不随 productName 变化
app.setPath('userData', DATA)

for (const dir of [DATA, LOG_DIR, join(DATA, 'generated'), join(DATA, 'styles'), join(DATA, 'data')]) {
  try { mkdirSync(dir, { recursive: true }) } catch {}
}

const config = loadConfig(DATA)
const SERVER_PORT = Number(config.PORT) || 8787
const SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`
const CLIENT_URL = `${SERVER_ORIGIN}/batch.html`
const CLIENT_LOGIN_URL = `${SERVER_ORIGIN}/login.html`

let mainWindow = null
let tray = null
let quitting = false
let serviceRunning = false
let updateCheckBusy = false
let updateBusy = false

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try { appendFileSync(MAIN_LOG, line) } catch {}
  if (!app.isPackaged) process.stdout.write(line)
}

initServer({ root: ROOT, data: DATA, logDir: LOG_DIR, config, log })

function iconPath() {
  const file = join(app.getAppPath(), 'build', 'icon.png')
  return existsSync(file) ? file : undefined
}

async function authNeedsSetup() {
  try {
    const response = await fetch(`${SERVER_ORIGIN}/api/auth/status`, { signal: AbortSignal.timeout(2000) })
    return Boolean((await response.json())?.needsSetup)
  } catch {
    return false
  }
}

/* ===== 主窗口：桌面控制台（本地页面）。客户端只在浏览器里用 ===== */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 760,
    minHeight: 560,
    title: '画境 · 服务控制台',
    backgroundColor: '#f4f0e6',
    icon: iconPath(),
    show: false,
    webPreferences: {
      preload: join(app.getAppPath(), 'desktop', 'panel-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.loadFile(join(app.getAppPath(), 'desktop', 'panel.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.on('did-finish-load', () => {
    void pushPanelState(true)
    startPanelTimer()
  })
  mainWindow.on('close', event => {
    if (!quitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })

  // 控制台是本地页面：页面里的外链一律交给系统浏览器，应用内不做任何导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/* ===== 控制台：状态推送 + 管理接口代理 ===== */
let panelTimer = null
let panelPushing = false
let panelBusy = false

function startPanelTimer() {
  if (panelTimer) return
  panelTimer = setInterval(() => { void pushPanelState() }, 2000)
}

/** 管理接口一律由主进程代发，凭据（desktop token）不进渲染进程 */
ipcMain.handle('panel:api', async (_event, path, init = {}) => {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    return { status: 0, ok: false, data: null, error: '接口路径无效' }
  }
  const method = String(init?.method || 'GET').toUpperCase()
  const headers = { 'x-desktop-token': desktopToken(), accept: 'application/json' }
  let body
  if (init?.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.body)
  }
  try {
    // 这是本机回环请求：用 Node 自带的 fetch 直连，别走 net.fetch——
    // 系统代理可能把 127.0.0.1 也代理出去，反而连不上
    const response = await fetch(`${SERVER_ORIGIN}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(20000),
    })
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    return {
      status: response.status,
      ok: response.ok,
      data,
      error: response.ok ? null : (data?.error || `HTTP ${response.status}`),
    }
  } catch (error) {
    return { status: 0, ok: false, data: null, error: error.message || '请求失败' }
  }
})

async function runPanelServiceAction(label, action) {
  if (panelBusy) return { ok: false, message: '上一个操作还没结束' }
  panelBusy = true
  try {
    const result = await action()
    // stopServer 用布尔值报告结果：false 表示端口还在监听
    if (result === false) throw new Error('服务没有停下，端口仍在监听，请查看日志')
    await refreshServiceState()
    await pushPanelState(true)
    log(`${label}完成，服务${serviceStatusLabel()}`)
    return { ok: true, message: `${label}完成` }
  } catch (error) {
    log(`${label}失败：${error.message}`)
    await pushPanelState(true)
    return { ok: false, message: error.message || `${label}失败` }
  } finally {
    panelBusy = false
  }
}

ipcMain.handle('panel:action', async (_event, name) => {
  switch (name) {
    case 'start':
      return runPanelServiceAction('启动服务', startServer)
    case 'stop':
      return runPanelServiceAction('停止服务', stopServer)
    case 'restart':
      return runPanelServiceAction('重启服务', restartServer)
    case 'open-client':
      await openClientInBrowser()
      return { ok: true, message: '' }
    case 'copy-lan': {
      const address = lanAddress() || CLIENT_URL
      clipboard.writeText(address)
      return { ok: true, message: `已复制客户端地址：${address}` }
    }
    case 'copy-key': {
      const key = config.ADMIN_SETUP_KEY || ''
      clipboard.writeText(key)
      return { ok: true, message: key ? '管理密钥已复制' : '配置里没有管理密钥' }
    }
    case 'open-data':
      await shell.openPath(DATA)
      return { ok: true, message: '' }
    case 'open-logs':
      await shell.openPath(LOG_DIR)
      return { ok: true, message: '' }
    case 'open-log-window':
      openLogWindow()
      return { ok: true, message: '' }
    case 'check-update':
      void checkUpdates()
      return { ok: true, message: '正在检查更新…' }
    case 'quit':
      await quitApp()
      return { ok: true, message: '' }
    default:
      return { ok: false, message: `未知操作：${name}` }
  }
})

/** 状态每 2 秒推一次：启停可能由托盘或服务自身引起，页面不能只信自己的操作结果 */
async function pushPanelState(force = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (panelPushing && !force) return
  panelPushing = true
  try {
    const alive = await waitForServer(600)
    if (alive !== serviceRunning) {
      serviceRunning = alive
      trayTooltip(`画境 · 服务${serviceStatusLabel()}`)
      refreshMenus()
    }
    const state = serverState()
    mainWindow.webContents.send('panel:state', {
      running: alive,
      pid: state.pid ?? null,
      port: SERVER_PORT,
      uptimeMs: alive && state.startedAt ? Date.now() - state.startedAt : 0,
      lanUrl: lanAddress(),
      clientUrl: CLIENT_URL,
      loginUrl: CLIENT_LOGIN_URL,
      needsSetup: alive ? await authNeedsSetup() : false,
      version: app.getVersion(),
    })
  } catch {
    // 探测失败按「没在跑」处理即可，页面下一轮会自己刷新
  } finally {
    panelPushing = false
  }
}

/* ===== 运行日志窗口：直接读 LOG_DIR 下的 .log，不经服务端 ===== */
let logWindow = null

function resolveLogFile(name) {
  if (typeof name !== 'string' || !name) return ''
  if (name !== basename(name) || name.includes('..') || /[/\\]/.test(name)) return ''
  if (!name.endsWith('.log')) return ''
  return join(LOG_DIR, name)
}

ipcMain.handle('logs:list', async () => {
  let names = []
  try { names = await readdir(LOG_DIR) } catch { return [] }
  const files = []
  for (const name of names) {
    if (!name.endsWith('.log')) continue
    try {
      const info = await stat(join(LOG_DIR, name))
      if (info.isFile()) files.push({ name, size: info.size, mtime: info.mtimeMs })
    } catch {}
  }
  // 最近写入的在前：日期文件和 desktop.log 混在一起排，页面再自己优先挑日期文件
  return files.sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0))
})

ipcMain.handle('logs:read', async (_event, name, offset) => {
  const file = resolveLogFile(name)
  if (!file) return { chunk: '', offset: 0, size: 0 }

  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return { chunk: '', offset: 0, size: 0 }
  }

  try {
    const info = await handle.stat()
    const start = Math.min(Math.max(Number(offset) || 0, 0), info.size)
    const length = Math.min(LOG_READ_LIMIT, info.size - start)
    if (length <= 0) return { chunk: '', offset: start, size: info.size }
    // 按窗口读，字节原样交给渲染层：多字节字符要靠 TextDecoder 跨块拼接，主进程先截断就会变成乱码
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return { chunk: buffer.subarray(0, bytesRead), offset: start + bytesRead, size: info.size }
  } catch {
    return { chunk: '', offset: 0, size: 0 }
  } finally {
    await handle.close().catch(() => {})
  }
})

ipcMain.handle('logs:open-dir', () => shell.openPath(LOG_DIR))

function openLogWindow() {
  if (logWindow) {
    if (logWindow.isMinimized()) logWindow.restore()
    logWindow.show()
    logWindow.focus()
    return
  }

  logWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    title: '画境 · 运行日志',
    backgroundColor: '#f4f0e6',
    icon: iconPath(),
    webPreferences: {
      preload: join(app.getAppPath(), 'desktop', 'logs-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  logWindow.loadFile(join(app.getAppPath(), 'desktop', 'logs.html'))
  logWindow.on('closed', () => { logWindow = null })
}

/* ===== 更新窗口：检查、下载、安装都在这一个窗口里 ===== */
let updateWindow = null
let updateTarget = { url: '', name: '', version: '', pageUrl: '', expectedSize: null }
let updateController = null
let updateTimer = 0
let updateDirty = false
let updateState = {
  phase: 'checking',
  currentVersion: '',
  latestVersion: '',
  version: '',
  notes: '',
  pageUrl: '',
  publishedAt: '',
  checkedAt: '',
  expectedSize: null,
  fileName: '',
  received: 0,
  total: 0,
  speed: 0,
  etaSeconds: null,
  connections: 1,
  mirror: false,
  message: '',
  filePath: '',
  hasUpdate: false,
  canRetryDownload: false,
  disabled: false,
}

function updateView() {
  return updateWindow && !updateWindow.isDestroyed() ? updateWindow.webContents : null
}

/** 托盘和任务栏共用这一份真实状态，不自己编数字 */
function updateIndicatorLabel() {
  switch (updateState.phase) {
    case 'checking': return '画境 · 正在检查更新…'
    case 'available': return updateState.latestVersion ? `画境 · 有新版本 ${updateState.latestVersion}` : '画境 · 有新版本'
    case 'latest': return '画境 · 已是最新版本'
    case 'done': return '画境 · 更新已下载，可以安装'
    case 'cancel': return '画境 · 更新下载已取消'
    case 'error': return '画境 · 更新出错'
    default: return ''
  }
}

/** 进度每 120ms 才推一次：下载每个 chunk 都来一条，直接转发会把渲染进程压垮 */
function paintUpdate(patch) {
  updateState = { ...updateState, ...patch }
  const downloading = updateState.phase === 'download' || updateState.phase === 'resolve'
  if (mainWindow) {
    if (!downloading) mainWindow.setProgressBar(-1)
    else if (updateState.total > 0) mainWindow.setProgressBar(Math.min(1, updateState.received / updateState.total))
    else mainWindow.setProgressBar(2)
  }
  if (downloading) {
    trayTooltip(updateState.total > 0
      ? `画境 · 更新 ${Math.round((updateState.received / updateState.total) * 100)}%`
      : `画境 · 已下载 ${(updateState.received / 1048576).toFixed(1)} MB`)
  } else {
    const label = updateIndicatorLabel()
    if (label) trayTooltip(label)
  }
  updateDirty = true
  if (updateTimer) return
  updateTimer = setTimeout(() => {
    updateTimer = 0
    if (!updateDirty) return
    updateDirty = false
    updateView()?.send('update:state', updateState)
  }, 120)
}

function openUpdateWindow() {
  if (updateWindow && !updateWindow.isDestroyed()) {
    if (updateWindow.isMinimized()) updateWindow.restore()
    updateWindow.show()
    updateWindow.focus()
    return
  }

  updateWindow = new BrowserWindow({
    width: 520,
    height: 320,
    minWidth: 420,
    minHeight: 240,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    title: '画境 · 更新',
    backgroundColor: '#f4f0e6',
    icon: iconPath(),
    show: false,
    webPreferences: {
      preload: join(app.getAppPath(), 'desktop', 'update-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  updateWindow.loadFile(join(app.getAppPath(), 'desktop', 'update.html'))
  updateWindow.once('ready-to-show', () => updateWindow?.show())
  updateWindow.webContents.on('did-finish-load', () => updateView()?.send('update:state', updateState))
  // 关窗口只是收起来，任务照跑：要停请点「取消」，别让误触丢掉已经下好的进度
  updateWindow.on('close', event => {
    if (quitting) return
    event.preventDefault()
    updateWindow?.hide()
  })
  updateWindow.on('closed', () => { updateWindow = null })
}

async function startUpdateDownload() {
  if (!updateTarget.url) {
    paintUpdate({ phase: 'error', message: '没有可下载的安装包，请先检查更新' })
    openUpdateWindow()
    return
  }
  if (updateBusy) return
  updateBusy = true
  updateController = new AbortController()
  openUpdateWindow()
  paintUpdate({
    phase: 'resolve',
    version: updateTarget.version,
    fileName: updateTarget.name,
    received: 0,
    total: updateTarget.expectedSize || 0,
    speed: 0,
    etaSeconds: null,
    connections: 1,
    mirror: Boolean(config.UPDATE_DOWNLOAD_MIRROR),
    message: '',
    filePath: '',
    canRetryDownload: true,
  })

  try {
    const result = await downloadInstaller({
      url: updateTarget.url,
      name: updateTarget.name,
      signal: updateController.signal,
      expectedSize: updateTarget.expectedSize,
      version: updateTarget.version,
      // 探测阶段也是「还没开始下」，页面上归到 resolve 态
      onProgress: event => paintUpdate(event.phase === 'probe' ? { ...event, phase: 'resolve' } : event),
    })
    paintUpdate({
      phase: 'done',
      filePath: result.file,
      fileName: basename(result.file),
      received: result.size,
      total: result.size,
      connections: result.connections,
      etaSeconds: 0,
      message: '下载完成，可以安装',
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      log('更新下载已取消')
      paintUpdate({ phase: 'cancel', message: '已取消下载，已下好的部分留着，重试会接着下' })
    } else {
      log(`下载安装包失败：${error?.message || error}`)
      paintUpdate({ phase: 'error', message: error?.message || '下载失败' })
    }
    openUpdateWindow()
  } finally {
    updateController = null
    updateBusy = false
  }
}

ipcMain.handle('update:cancel', () => {
  updateController?.abort()
  return { ok: true }
})

ipcMain.handle('update:check', () => {
  void checkUpdates()
  return { ok: true }
})

ipcMain.handle('update:download', () => {
  void startUpdateDownload()
  return { ok: true }
})

ipcMain.handle('update:retry', () => {
  if (updateBusy) return { ok: false, message: '下载正在进行中' }
  // 重试只针对已经定下来的下载目标，没有目标就别硬来
  if (!updateTarget.url) return { ok: false, message: '没有可重试的下载，请先检查更新' }
  void startUpdateDownload()
  return { ok: true }
})

/** 更新窗口按内容调高度：说明越长窗口越高，但不许高过屏幕 */
ipcMain.handle('update:resize', (_event, height) => {
  if (!updateWindow || updateWindow.isDestroyed()) return { ok: false }
  const value = Number(height)
  if (!Number.isFinite(value)) return { ok: false }
  const next = Math.round(Math.min(Math.max(value, 240), 900))
  updateWindow.setSize(updateWindow.getSize()[0], next)
  return { ok: true }
})

ipcMain.handle('update:install', async () => {
  const file = updateState.filePath
  if (!file) return { ok: false, message: '安装包还没下载好' }
  try {
    await launchInstaller(file)
  } catch (error) {
    log(`打开安装包失败：${error.message}`)
    // 安装失败回到可重试的错误状态，文件还在，可以再试一次
    paintUpdate({ phase: 'error', message: error.message })
    return { ok: false, message: error.message }
  }
  // 安装器接管后本进程就该退了，留一点时间让窗口显示「正在启动安装程序」
  setTimeout(() => { void quitApp() }, 1200)
  return { ok: true }
})

ipcMain.handle('update:open-folder', () => {
  if (updateState.filePath) shell.showItemInFolder(updateState.filePath)
})

ipcMain.handle('update:open-page', () => {
  if (updateTarget.pageUrl) void shell.openExternal(updateTarget.pageUrl)
})

async function openClientInBrowser() {
  try {
    // 账号库为空时先给初始化页，否则直接进工作台
    const status = await fetch(`${SERVER_ORIGIN}/api/auth/status`, { signal: AbortSignal.timeout(2000) })
    const needsSetup = Boolean((await status.json())?.needsSetup)
    await shell.openExternal(needsSetup ? CLIENT_LOGIN_URL : CLIENT_URL)
  } catch {
    await shell.openExternal(CLIENT_URL)
  }
}

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) {
        return `http://${entry.address}:${SERVER_PORT}/batch.html`
      }
    }
  }
  return ''
}

async function copyLanAddress() {
  const address = lanAddress()
  if (!address) {
    await dialog.showMessageBox({
      type: 'warning',
      title: '复制局域网地址',
      message: '没有找到可用的局域网地址',
      detail: '请确认本机已连接到局域网（或手动查一下本机 IP）。',
    })
    return
  }
  clipboard.writeText(address)
  await dialog.showMessageBox({
    type: 'info',
    title: '局域网地址已复制',
    message: address,
    detail: '同一局域网内的其他设备用它打开同一套工作台。',
  })
}

function showAdminKey() {
  const key = config.ADMIN_SETUP_KEY || ''
  clipboard.writeText(key)
  dialog.showMessageBox({
    type: 'info',
    title: '管理密钥',
    message: '首次使用时用它创建管理员账号',
    detail: `密钥已复制到剪贴板：${key}\n\n在登录页的初始化向导里粘贴即可。\n配置文件：${join(DATA, 'config.env')}`,
  })
}

/* ===== 菜单 / 托盘 ===== */
function serviceStatusLabel() {
  return serviceRunning ? '运行中' : '已停止'
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '画境',
      submenu: [
        { label: '显示主窗口', accelerator: 'CmdOrCtrl+1', click: showMainWindow },
        { label: '在浏览器打开客户端', click: openClientInBrowser },
        { label: '复制局域网地址', click: copyLanAddress },
        { type: 'separator' },
        { label: '打开数据目录', click: () => shell.openPath(DATA) },
        { label: '运行日志…', click: openLogWindow },
        { label: '打开日志目录', click: () => shell.openPath(LOG_DIR) },
        { label: '复制管理密钥', click: showAdminKey },
        { type: 'separator' },
        { label: '检查更新…', click: () => { void checkUpdates() } },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { void quitApp() } },
      ],
    },
    {
      label: '服务',
      submenu: [
        { label: `状态：${serviceStatusLabel()}`, enabled: false },
        { type: 'separator' },
        { label: '启动服务', enabled: !serviceRunning, click: () => { void runServiceAction('启动服务', startServer) } },
        { label: '停止服务', enabled: serviceRunning, click: () => { void runServiceAction('停止服务', stopServer) } },
        { label: '重启服务', click: () => { void runServiceAction('重启服务', restartServer) } },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ])
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { label: '在浏览器打开客户端', click: openClientInBrowser },
    { label: '复制局域网地址', click: copyLanAddress },
    { type: 'separator' },
    { label: `状态：${serviceStatusLabel()}`, enabled: false },
    { label: '启动服务', enabled: !serviceRunning, click: () => { void runServiceAction('启动服务', startServer) } },
    { label: '停止服务', enabled: serviceRunning, click: () => { void runServiceAction('停止服务', stopServer) } },
    { label: '重启服务', click: () => { void runServiceAction('重启服务', restartServer) } },
    { type: 'separator' },
    { label: '检查更新…', click: () => { void checkUpdates() } },
    { label: '运行日志…', click: openLogWindow },
    { label: '打开数据目录', click: () => shell.openPath(DATA) },
    { type: 'separator' },
    { label: '退出', click: () => { void quitApp() } },
  ])
}

function refreshMenus() {
  Menu.setApplicationMenu(buildMenu())
  if (tray) tray.setContextMenu(buildTrayMenu())
}

function trayTooltip(text) {
  tray?.setToolTip(text)
}

function createTray() {
  const image = iconPath() ? nativeImage.createFromPath(iconPath()) : nativeImage.createEmpty()
  tray = new Tray(image)
  trayTooltip(`画境 · 服务${serviceStatusLabel()}`)
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', showMainWindow)
}

/** 读一次服务实况再刷新菜单：子进程可能自己退出，光看内存里的标记不准 */
async function refreshServiceState() {
  const running = await waitForServer(800)
  if (running === serviceRunning) return
  serviceRunning = running
  trayTooltip(`画境 · 服务${serviceStatusLabel()}`)
  refreshMenus()
}

async function runServiceAction(label, action) {
  try {
    const result = await action()
    // stopServer 用布尔值报告结果：false 表示端口还在监听
    if (result === false) throw new Error('服务没有停下，端口仍在监听，请查看日志')
    await refreshServiceState()
    log(`${label}完成，服务${serviceStatusLabel()}`)
    // 控制台是本地页面，不用随服务状态换页面，推一次状态即可
    await pushPanelState(true)
  } catch (error) {
    log(`${label}失败：${error.message}`)
    await refreshServiceState()
    await dialog.showMessageBox({
      type: 'error',
      title: label,
      message: error.message,
      detail: `日志：${MAIN_LOG}`,
    })
  }
}

/* ===== 检查更新：结果一律落到更新窗口，不再用阻塞式系统弹窗 ===== */
/** 出错或源被禁用时别留着上一次的下载目标，免得错误页给出下载旧版本的重试按钮 */
function clearStaleUpdateTarget() {
  if (updateBusy) return false
  updateTarget = { url: '', name: '', version: '', pageUrl: '', expectedSize: null }
  return true
}

async function checkUpdates() {
  // 重复点击不另起一个任务，窗口里显示的就是正在进行的那一次
  if (updateCheckBusy) {
    openUpdateWindow()
    return
  }
  // 解析或下载进行中：只把窗口亮出来，不打断任务也不覆盖下载进度
  if (updateBusy) {
    openUpdateWindow()
    return
  }
  updateCheckBusy = true

  openUpdateWindow()
  paintUpdate({
    phase: 'checking',
    message: '正在检查更新…',
    received: 0,
    total: 0,
    speed: 0,
    etaSeconds: null,
    connections: 1,
  })

  try {
    const info = await checkForUpdate()

    if (!info || typeof info !== 'object') {
      const cleared = clearStaleUpdateTarget()
      paintUpdate({
        phase: 'error',
        message: '检查更新失败：主服务没有返回有效结果',
        ...(cleared ? { filePath: '', fileName: '', canRetryDownload: false } : {}),
      })
      return
    }
    if (info.error) {
      const cleared = clearStaleUpdateTarget()
      paintUpdate({
        phase: 'error',
        message: info.error,
        ...(cleared ? { filePath: '', fileName: '', canRetryDownload: false } : {}),
      })
      return
    }
    if (info.disabled) {
      const cleared = clearStaleUpdateTarget()
      paintUpdate({
        phase: 'error',
        disabled: true,
        currentVersion: info.currentVersion || app.getVersion(),
        message: '未配置更新来源，暂时无法检查新版本',
        ...(cleared ? { filePath: '', fileName: '', canRetryDownload: false } : {}),
      })
      return
    }

    const currentVersion = info.currentVersion || app.getVersion()
    const latestVersion = info.latestVersion || ''
    const expectedSize = Number.isSafeInteger(info.downloadSize) && info.downloadSize > 0
      ? info.downloadSize
      : null
    const base = {
      currentVersion,
      latestVersion,
      version: latestVersion,
      notes: info.releaseNotes || '',
      pageUrl: info.pageUrl || '',
      publishedAt: info.publishedAt || '',
      checkedAt: info.checkedAt || new Date().toISOString(),
      expectedSize,
      hasUpdate: Boolean(info.hasUpdate),
      disabled: false,
      filePath: '',
      canRetryDownload: false,
    }

    if (!info.hasUpdate) {
      clearStaleUpdateTarget()
      paintUpdate({ ...base, phase: 'latest', message: `已是最新版本 ${currentVersion}` })
      return
    }

    updateTarget = {
      url: info.downloadUrl || '',
      name: info.downloadName || '',
      version: latestVersion,
      pageUrl: info.pageUrl || '',
      expectedSize,
    }

    if (!updateTarget.url) {
      paintUpdate({
        ...base,
        phase: 'available',
        message: '这次更新没有提供安装包下载地址，可以去发布页手动下载',
      })
      return
    }

    // 同一版本已经完整下过就直接复用：文件在、大小对得上、版本也对得上
    const ready = await findReadyInstaller({
      url: updateTarget.url,
      name: updateTarget.name,
      version: latestVersion,
      expectedSize,
    })
    if (ready) {
      paintUpdate({
        ...base,
        phase: 'done',
        filePath: ready.file,
        received: ready.size,
        total: ready.size,
        etaSeconds: 0,
        message: '这个版本已经下载好了，可以直接安装',
      })
      return
    }

    paintUpdate({ ...base, phase: 'available', message: '发现新版本，可以下载安装包' })
  } catch (error) {
    const cleared = clearStaleUpdateTarget()
    paintUpdate({
      phase: 'error',
      message: `检查更新失败：${error?.message || error}`,
      ...(cleared ? { filePath: '', fileName: '', canRetryDownload: false } : {}),
    })
  } finally {
    updateCheckBusy = false
  }
}

/* ===== 退出：先让服务把数据写完，再退进程 ===== */
async function quitApp() {
  quitting = true
  try {
    await stopServer()
  } catch (error) {
    log(`停止服务失败：${error.message}`)
  }
  log('桌面端退出')
  app.exit(0)
}

/* ===== 启动 ===== */
async function bootstrap() {
  log(`启动：packaged=${app.isPackaged} root=${ROOT} data=${DATA}`)

  try {
    const result = await startServer()
    log(result.adopted ? '已接管正在运行的主服务' : `主服务已启动 pid=${serverState().pid}`)
  } catch (error) {
    log(`启动失败：${error.message}`)
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: '启动失败',
      message: error.message,
      detail: `日志：${MAIN_LOG}\n配置：${join(DATA, 'config.env')}`,
      buttons: ['打开日志目录', '退出'],
      defaultId: 0,
    })
    if (choice === 0) shell.openPath(LOG_DIR)
    quitting = true
    app.exit(1)
    return
  }

  // 首次使用：账号库还是空的，控制台里会提示「先去浏览器初始化」并亮出管理密钥
  const needsSetup = await authNeedsSetup()
  createMainWindow()

  await refreshServiceState()
  createTray()
  refreshMenus()

  if (needsSetup) {
    log('账号库为空：在登录页走初始化向导')
    showAdminKey()
  }

  // 冒烟自检：HUAJING_DESKTOP_SMOKE_ACTION=start|stop|restart 时走一遍对应的原生动作
  const smokeAction = process.env.HUAJING_DESKTOP_SMOKE_ACTION
  if (smokeAction) {
    const actions = { start: startServer, stop: stopServer, restart: restartServer }
    const action = actions[smokeAction]
    if (action) {
      try {
        await action()
        log(`冒烟动作 ${smokeAction}: 完成 running=${serverState().running}`)
      } catch (error) {
        log(`冒烟动作 ${smokeAction} 失败: ${error.message}`)
      }
    }
  }

  // 菜单/托盘里的服务状态每 5 秒跟一次，避免点了才发现状态不对
  setInterval(() => { void refreshServiceState() }, 5000)

  // 冒烟自检用：设置 HUAJING_DESKTOP_SMOKE=<毫秒> 时，启动完成后自动走一遍退出流程
  const smokeMs = Number(process.env.HUAJING_DESKTOP_SMOKE || 0)
  if (smokeMs > 0) {
    log(`冒烟模式：${smokeMs}ms 后自动退出`)
    setTimeout(() => { void quitApp() }, smokeMs)
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)

  app.whenReady().then(() => {
    bootstrap().catch(error => {
      log(`未捕获的启动异常：${error?.stack || error}`)
      dialog.showErrorBox('画境启动失败', String(error?.message || error))
      app.exit(1)
    })
  })

  // 关掉所有窗口不收摊：托盘常驻、服务继续跑
  app.on('window-all-closed', () => {})

  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    void quitApp()
  })

  process.on('uncaughtException', error => {
    log(`uncaughtException：${error?.stack || error}`)
  })
  process.on('unhandledRejection', reason => {
    log(`unhandledRejection：${reason?.stack || reason}`)
  })
}