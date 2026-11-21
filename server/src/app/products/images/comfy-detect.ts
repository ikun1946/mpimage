/**
 * 自动识别 ComfyUI 安装位置。
 *
 * 只在浅层做有限扫描：用户目录、桌面、文档、下载、各盘符根目录，
 * 以及名字像 ComfyUI 的目录往下再看一层。不做全盘递归。
 *
 * 全部异步：Windows 上离线的映射网络盘、没插的移动盘做 stat/readdir
 * 会卡十几秒，同步调用会把整个 Fastify 事件循环一起冻住。
 * 每个路径都带超时，慢盘最多拖住单次检测，不影响正在进行的生图请求。
 */
import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export interface ComfyInstallCandidate {
  /** 传给启动配置的安装目录：便携包根目录，或含 main.py 的 ComfyUI 目录 */
  installDir: string
  pythonPath: string
  entryScript: string
  portable: boolean
}

const CACHE_MS = 30_000
const MAX_ROOT_ENTRIES = 400
const MAX_CHILD_ENTRIES = 200
const STAT_TIMEOUT_MS = 400
const LIST_TIMEOUT_MS = 1500
const CHECK_TIMEOUT_MS = 800
const DEEP_DIR_RE = /comfy|stable|diffusion|^sd$|^ai$|^tools$|^projects$|^apps?$/i

let cache: { at: number; value: ComfyInstallCandidate[] } | null = null
let inflight: Promise<ComfyInstallCandidate[]> | null = null

/** 超时后返回兜底值；底层的 stat/readdir 继续挂着也无所谓，不阻塞事件循环 */
async function withTimeout<T>(task: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, ms)
    timer.unref?.()
    task.then(
      value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

async function exists(path: string): Promise<boolean> {
  return withTimeout(
    stat(path).then(() => true).catch(() => false),
    CHECK_TIMEOUT_MS,
    false,
  )
}

async function isDirectory(path: string): Promise<boolean> {
  return withTimeout(
    stat(path).then(value => value.isDirectory()).catch(() => false),
    STAT_TIMEOUT_MS,
    false,
  )
}

async function readDirs(dir: string, limit: number): Promise<string[]> {
  const entries = await withTimeout(
    readdir(dir, { withFileTypes: true }).catch(() => []),
    LIST_TIMEOUT_MS,
    [] as Dirent[],
  )
  return entries
    // 目录 junction / 符号链接的 isDirectory() 是 false，但 stat 能正常进去
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .slice(0, limit)
    .map(entry => join(dir, entry.name))
}

/** ComfyUI 源码特征：防止把「名字里带 comfy 的普通 Python 项目」当成 ComfyUI 启动 */
async function looksLikeComfy(dir: string): Promise<boolean> {
  const markers = ['comfy', 'nodes.py', 'folder_paths.py', 'comfyui_version.py', 'execution.py']
  for (const marker of markers) {
    if (await exists(join(dir, marker))) return true
  }
  return false
}

async function firstExisting(paths: string[]): Promise<string> {
  for (const path of paths) {
    if (path && (await exists(path))) return path
  }
  return ''
}

/** 从一个目录判断它是不是 ComfyUI 安装目录 */
async function candidateFromDir(dir: string): Promise<ComfyInstallCandidate | null> {
  // 便携包：<root>/python_embeded/python.exe + <root>/ComfyUI/main.py
  const portablePython = join(dir, 'python_embeded', 'python.exe')
  const portableEntry = join(dir, 'ComfyUI', 'main.py')
  if ((await exists(portablePython)) && (await exists(portableEntry))) {
    if (await looksLikeComfy(dirname(portableEntry))) {
      return { installDir: dir, pythonPath: portablePython, entryScript: portableEntry, portable: true }
    }
  }

  // 标准安装：<root>/main.py + <root>/venv 或 .venv
  const entry = join(dir, 'main.py')
  if (await exists(entry)) {
    if (!(await looksLikeComfy(dir))) return null
    const python = await firstExisting([
      join(dir, 'venv', 'Scripts', 'python.exe'),
      join(dir, '.venv', 'Scripts', 'python.exe'),
      join(dir, 'venv', 'bin', 'python'),
      join(dir, '.venv', 'bin', 'python'),
    ])
    if (python) {
      return { installDir: dir, pythonPath: python, entryScript: entry, portable: false }
    }
    // 只有 ComfyUI 目录、解释器在上一级（便携包或自建 venv）
    const parent = dirname(dir)
    const parentPython = await firstExisting([
      join(parent, 'python_embeded', 'python.exe'),
      join(parent, 'venv', 'Scripts', 'python.exe'),
      join(parent, '.venv', 'Scripts', 'python.exe'),
    ])
    if (parentPython) {
      return {
        installDir: parent,
        pythonPath: parentPython,
        entryScript: entry,
        portable: /python_embeded/i.test(parentPython),
      }
    }
  }
  return null
}

async function searchRoots(): Promise<string[]> {
  const home = homedir()
  const roots = [
    home,
    join(home, 'Desktop'),
    join(home, 'OneDrive', 'Desktop'),
    join(home, 'Documents'),
    join(home, 'OneDrive', 'Documents'),
    join(home, 'Downloads'),
    join(home, 'AppData', 'Local', 'Programs'),
  ]
  if (process.platform === 'win32') {
    for (const letter of 'CDEFG') roots.push(`${letter}:\\`)
  } else {
    roots.push('/opt', '/usr/local')
  }
  const unique = roots.filter((root, index) => roots.indexOf(root) === index)
  // 并行判断，离线盘只会拖自己的超时，不影响其他根目录
  const flags = await Promise.all(unique.map(root => isDirectory(root)))
  return unique.filter((_root, index) => flags[index])
}

function isUserRoot(root: string): boolean {
  return root.toLowerCase().startsWith(homedir().toLowerCase())
}

/** 名字像 ComfyUI 的目录，以及它下面一层（例如 ComfyUI/ComfyUI_windows_portable） */
async function collectCandidateDirs(root: string): Promise<string[]> {
  const out: string[] = []
  const children = await readDirs(root, MAX_ROOT_ENTRIES)
  await Promise.all(
    children.map(async child => {
      const name = basename(child)
      if (/comfy/i.test(name)) {
        out.push(child, ...(await readDirs(child, MAX_CHILD_ENTRIES)))
        return
      }
      // 用户目录里再往下看一层：AI/ComfyUI、tools/ComfyUI_windows_portable 这类布局。
      // 只钻进名字像 AI/工具目录的文件夹，别把整个主目录翻一遍。
      if (isUserRoot(root) && DEEP_DIR_RE.test(name) && !name.startsWith('.')) {
        const grands = await readDirs(child, MAX_CHILD_ENTRIES)
        for (const grand of grands) {
          if (!/comfy/i.test(basename(grand))) continue
          out.push(grand, ...(await readDirs(grand, 50)))
        }
      }
    }),
  )
  return out
}

async function scan(): Promise<ComfyInstallCandidate[]> {
  const roots = await searchRoots()
  const dirLists = await Promise.all(roots.map(root => collectCandidateDirs(root)))
  // 去重时只用小写做键，真正去读目录仍用原始路径（Linux 区分大小写）
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const dir of dirLists.flat()) {
    const key = dir.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    dirs.push(dir)
  }
  const candidates = await Promise.all(dirs.map(dir => candidateFromDir(dir)))
  return [...new Map(
    candidates
      .filter((candidate): candidate is ComfyInstallCandidate => Boolean(candidate))
      .map(candidate => [candidate.installDir.toLowerCase(), candidate]),
  ).values()]
    .sort((a, b) => Number(b.portable) - Number(a.portable) || a.installDir.length - b.installDir.length)
    .slice(0, 10)
}

/**
 * 扫描常见位置。带 30 秒缓存；缓存里的入口不存在时会自动重扫。
 * 同一次扫描共享同一个 Promise，避免面板自动检测和生图请求同时翻盘。
 */
export async function detectComfyInstalls(options: { refresh?: boolean } = {}): Promise<ComfyInstallCandidate[]> {
  if (!options.refresh && cache && Date.now() - cache.at < CACHE_MS) {
    // 缓存里的入口已经不存在（被移动/改名）就重扫，别拿旧路径去启动
    const first = cache.value[0]
    if (!first || (await exists(first.entryScript))) return cache.value
    cache = null
  }
  if (inflight) return inflight

  const task = scan()
    .then(value => {
      cache = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      if (inflight === task) inflight = null
    })
  inflight = task
  return task
}
