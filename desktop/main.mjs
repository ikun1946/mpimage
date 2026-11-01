import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import { basename, join } from 'node:path'
import { appRoot, dataRoot } from './paths.mjs'
import { loadConfig } from './config.mjs'
import { initServer, restartServer, serverState, startServer, stopServer, waitForServer } from './server.mjs'
import { checkForUpdate, downloadInstaller, launchInstaller } from './updater.mjs'

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

/* ===== 窗口：主窗口就是客户端，浏览器只作为「分享给局域网」的替代入口 ===== */
function isSameOrigin(url) {
  try {
    return new URL(url).origin === SERVER_ORIGIN
  } catch {
    return false
  }
}

function createMainWindow(targetUrl = CLIENT_URL) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: '画境',
    backgroundColor: '#f4f0e6',
    icon: iconPath(),
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  mainWindow.loadURL(targetUrl)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('close', event => {
    if (!quitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })

  // 页面里的外链（比如「新窗口 ↗」）交给系统浏览器，不在应用内开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 只放行主服务同源内的跳转（登录页 → 工作台），别处一律走系统浏览器
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isSameOrigin(url)) return
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
  const wasRunning = serviceRunning
  try {
    const result = await action()
    // stopServer 用布尔值报告结果：false 表示端口还在监听
    if (result === false) throw new Error('服务没有停下，端口仍在监听，请查看日志')
    await refreshServiceState()
    log(`${label}完成，服务${serviceStatusLabel()}`)
    // 窗口在服务停着的时候打开会停在错误页，服务起来后补一次导航
    if (!wasRunning && serviceRunning && mainWindow) mainWindow.loadURL(CLIENT_URL)
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

/* ===== 检查更新 ===== */
function trimNotes(notes) {
  const text = String(notes || '').trim()
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text
}

function publishedLabel(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN')
}

async function checkUpdates() {
  if (updateBusy) return
  updateBusy = true
  trayTooltip('画境 · 正在检查更新…')

  try {
    const info = await checkForUpdate()

    if (info.error) {
      const buttons = info.pageUrl ? ['前往发布页', '关闭'] : ['关闭']
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        title: '检查更新失败',
        message: info.error,
        detail: `当前版本 ${info.currentVersion || app.getVersion()}`,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
      })
      if (info.pageUrl && choice === 0) await shell.openExternal(info.pageUrl)
      return
    }

    if (info.disabled) {
      await dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: '未配置更新来源，暂时无法检查新版本',
        detail: `当前版本 ${info.currentVersion || app.getVersion()}`,
      })
      return
    }

    if (!info.hasUpdate) {
      await dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: `已是最新版本 ${info.currentVersion || app.getVersion()}`,
      })
      return
    }

    const detail = [
      `当前版本：${info.currentVersion || app.getVersion()}`,
      info.publishedAt ? `发布时间：${publishedLabel(info.publishedAt)}` : '',
      info.releaseNotes ? `\n${trimNotes(info.releaseNotes)}` : '',
    ].filter(Boolean).join('\n')

    const choice = dialog.showMessageBoxSync({
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 ${info.latestVersion || ''}`.trim(),
      detail,
      buttons: ['下载安装包', '前往发布页', '稍后'],
      defaultId: 0,
      cancelId: 2,
    })

    if (choice === 1) {
      if (info.pageUrl) await shell.openExternal(info.pageUrl)
      return
    }
    if (choice !== 0) return

    if (!info.downloadUrl) {
      const fallback = dialog.showMessageBoxSync({
        type: 'info',
        title: '暂无安装包',
        message: '这次更新没有提供安装包下载地址',
        detail: '可以去发布页手动下载。',
        buttons: info.pageUrl ? ['前往发布页', '关闭'] : ['关闭'],
        defaultId: 0,
        cancelId: info.pageUrl ? 1 : 0,
      })
      if (info.pageUrl && fallback === 0) await shell.openExternal(info.pageUrl)
      return
    }

    trayTooltip('画境 · 正在下载更新…')
    let lastTick = 0
    let file = ''
    try {
      file = await downloadInstaller({
        url: info.downloadUrl,
        name: info.downloadName,
        onProgress: (received, total) => {
          const now = Date.now()
          if (now - lastTick < 500) return
          lastTick = now
          trayTooltip(total
            ? `画境 · 下载更新 ${Math.round((received / total) * 100)}%`
            : `画境 · 已下载 ${(received / 1024 / 1024).toFixed(1)} MB`)
        },
      })
    } catch (error) {
      log(`下载安装包失败：${error.message}`)
      await dialog.showMessageBox({
        type: 'error',
        title: '下载失败',
        message: error.message,
        detail: info.pageUrl ? `也可以去发布页手动下载：${info.pageUrl}` : '',
      })
      return
    } finally {
      trayTooltip(`画境 · 服务${serviceStatusLabel()}`)
    }

    const install = await dialog.showMessageBox({
      type: 'info',
      title: '下载完成',
      message: '安装包已下载',
      detail: `${file}\n\n安装会关闭画境，装完需要手动重新打开。`,
      buttons: ['立即安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (install.response !== 0) return

    try {
      await launchInstaller(file)
    } catch (error) {
      log(`打开安装包失败：${error.message}`)
      await dialog.showMessageBox({ type: 'error', title: '无法安装', message: error.message })
      return
    }
    await quitApp()
  } finally {
    updateBusy = false
    trayTooltip(`画境 · 服务${serviceStatusLabel()}`)
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

  // 首次使用：账号库还是空的，主窗口直接停在初始化向导，并亮出管理密钥
  const needsSetup = await authNeedsSetup()
  createMainWindow(needsSetup ? CLIENT_LOGIN_URL : CLIENT_URL)

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