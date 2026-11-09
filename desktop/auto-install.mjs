/**
 * 空闲自动安装助手。
 *
 * 由主进程用 ELECTRON_RUN_AS_NODE 拉起，参数：
 *   installer  NSIS 安装包路径
 *   exePath    画境的 exe，安装完成后用它重新启动
 *   parentPid  主进程 pid，等它退出后再动安装包，避免文件被占用
 *   logFile    桌面端日志，助手不依赖 Electron API，只往这里追加
 *
 * 流程：等主进程退出 → 静默安装（/S）→ 重新拉起画境。
 * 任何一步失败都要保证「至少把画境重新打开」，不能把用户晾在关掉的状态。
 */
import { appendFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const [, , installer, exePath, parentPidRaw, logFile] = process.argv
const parentPid = Number(parentPidRaw)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function log(message) {
  if (!logFile) return
  try {
    appendFileSync(logFile, `[${new Date().toISOString()}] [auto-install] ${message}\n`)
  } catch {}
}

/** 等主进程真正退出；最多等 90 秒，超时就放弃安装，别硬覆盖正在运行的程序 */
async function waitForParentExit() {
  for (let i = 0; i < 180; i += 1) {
    try {
      process.kill(parentPid, 0)
    } catch {
      return true
    }
    await sleep(500)
  }
  return false
}

function runInstaller(file) {
  return new Promise(resolve => {
    const child = spawn(file, ['/S'], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      log('安装器 10 分钟未退出，继续尝试重新启动应用')
      resolve({ code: -1, timedOut: true })
    }, 10 * 60 * 1000)
    child.on('error', error => {
      clearTimeout(timer)
      log(`启动安装器失败：${error.message}`)
      resolve({ code: -1, error })
    })
    child.on('exit', code => {
      clearTimeout(timer)
      resolve({ code })
    })
  })
}

async function main() {
  if (!installer || !exePath || !Number.isFinite(parentPid)) {
    log('参数不完整，放弃自动安装')
    return
  }
  if (!existsSync(installer)) {
    log(`安装包不存在：${installer}`)
  }

  log(`等待主进程 ${parentPid} 退出`)
  const exited = await waitForParentExit()
  if (!exited) {
    log('主进程 90 秒内没有退出，取消本次自动安装')
    return
  }

  // 再等半秒，让 Windows 释放 exe / 安装目录的句柄
  await sleep(600)
  const result = await runInstaller(installer)
  log(`安装器退出：code=${result.code}${result.timedOut ? '（超时）' : ''}`)

  // 给安装器收尾一点时间，然后重新拉起应用
  await sleep(1500)
  try {
    if (existsSync(exePath)) {
      const app = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false })
      app.unref()
      log('已重新启动画境')
    } else {
      log(`找不到应用可执行文件：${exePath}`)
    }
  } catch (error) {
    log(`重新启动失败：${error.message}`)
  }
}

main().catch(error => {
  log(`自动安装异常：${error?.stack || error}`)
})
