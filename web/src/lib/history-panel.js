import { fetchHistory } from './api.js'
import { escapeAttr, escapeHtml, formatDateTime, qs } from './dom.js'

/* 滚轮边界守卫：滚动本身交回浏览器原生处理（方向、速度、系统的反向滚动设置都照旧），
   只在「已经到顶/到底还继续往外滚」时拦下事件，避免把滚动传给后面的页面。
   指针落在滚动容器之外、但仍在同一块面板上时（标题、搜索框），把滚动转交给容器。 */
const LINE_HEIGHT = 16

function wheelDelta(scroller, event) {
  if (event.deltaMode === 1) return event.deltaY * LINE_HEIGHT
  if (event.deltaMode === 2) return event.deltaY * scroller.clientHeight
  return event.deltaY
}

function isScrollable(element) {
  return element.scrollHeight - element.clientHeight > 1
}

function isAtEdge(scroller, delta) {
  return delta < 0
    ? scroller.scrollTop <= 0
    : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
}

function guardWheel(scroller, host = scroller.parentElement) {
  ;(host || scroller).addEventListener('wheel', event => {
    if (event.ctrlKey) return            // 保留 Ctrl+滚轮 缩放
    if (!isScrollable(scroller)) return  // 容器自己不可滚，交给页面
    const delta = wheelDelta(scroller, event)
    if (!Number.isFinite(delta) || delta === 0) return

    if (isAtEdge(scroller, delta)) {
      event.preventDefault()             // 到边界：拦住，不再外溢到页面
      return
    }
    if (!scroller.contains(event.target)) {
      event.preventDefault()
      scroller.scrollBy(0, delta)
    }
  }, { passive: false })
}

/** 进出场动画时长，和 history-panel.css 里的动画保持一致 */
const LEAVE_MS = 140
/* 已加载过的面板在这么短时间内重复打开不再发刷新请求：
   连续开关不该把记录接口打成热点；生成成功后由业务侧调用 invalidate() 主动失效。 */
const REFRESH_INTERVAL_MS = 5000

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/**
 * 生成记录面板：挂在页面右上角头像菜单下，
 * 调用 setupHistoryPanel() 即可接入，入口按钮需自带 id="history-button"。
 * 面板结构与样式见 history-panel.css。
 *
 * @returns {{ open: () => void, close: () => void, invalidate: () => void }}
 *   invalidate 供业务代码在生成成功后调用：丢掉在途请求，缓存标脏，下次打开/当前打开立即刷新。
 */
export function setupHistoryPanel() {
  const panel = qs('#history-panel')
  const button = qs('#history-button')
  if (!panel || !button) return { open() {}, close() {}, invalidate() {} }

  const list = qs('#history-list', panel)
  const searchInput = qs('#history-search', panel)
  const closeButton = qs('#history-close', panel)
  const meta = qs('#history-meta', panel)

  let records = []
  let keyword = ''
  let loaded = false          // 已经成功拉到过一次数据
  let errorText = ''
  let inFlight = null         // 在途请求：重复的 load 合并到同一个 Promise
  let lastLoadedAt = 0        // 上次成功拉取的时间，用来压掉连续开关引发的重复刷新
  let generation = 0          // 关闭/失效后递增，迟到的响应直接丢弃
  let closeTimer = 0
  let savedScrollTop = 0

  function open() {
    if (closeTimer) {
      window.clearTimeout(closeTimer)
      closeTimer = 0
    }
    panel.classList.remove('is-closing')
    panel.classList.add('visible')

    // 搜索词和滚动位置在关闭期间都留着，重新打开回到原处
    if (searchInput && searchInput.value !== keyword) searchInput.value = keyword
    if (list) list.scrollTop = savedScrollTop
    // 上次关闭时可能停在“刷新中…”，先按手里的数据写回正常文案
    if (meta && records.length) meta.textContent = `共 ${records.length} 条`

    if (loaded) load({ silent: true })
    else load({ silent: false })
  }

  function close() {
    if (!panel.classList.contains('visible') && !panel.classList.contains('is-closing')) return
    savedScrollTop = list?.scrollTop || 0
    // 关闭后不再采纳还在路上的响应：它们要么属于旧的关键词，要么已经把状态刷旧了。
    // 同时放开 inFlight，重新打开时能立刻发自己的请求，不用等旧请求超时。
    generation += 1
    inFlight = null
    if (prefersReducedMotion()) {
      hideNow()
      return
    }
    panel.classList.add('is-closing')
    panel.classList.remove('visible')
    window.clearTimeout(closeTimer)
    closeTimer = window.setTimeout(hideNow, LEAVE_MS)
  }

  function hideNow() {
    window.clearTimeout(closeTimer)
    closeTimer = 0
    panel.classList.remove('visible', 'is-closing')
  }

  function invalidate() {
    generation += 1
    inFlight = null
    lastLoadedAt = 0
    errorText = ''
    if (panel.classList.contains('visible')) load({ silent: loaded, force: true })
  }

  function renderLoading() {
    meta.textContent = '载入中…'
    list.innerHTML = '<li class="history-loading">正在载入生成记录…</li>'
  }

  /**
   * silent = true：手里已经有数据，立即展示旧内容并在后台刷新；
   * silent = false：首次打开或重试，先给加载态。
   */
  function load({ silent = false, force = false } = {}) {
    if (inFlight) return inFlight
    // 刚拉过就再打开：直接用缓存，不再打一次接口
    if (silent && !force && Date.now() - lastLoadedAt < REFRESH_INTERVAL_MS) return Promise.resolve()
    if (!silent) renderLoading()
    else if (meta) meta.textContent = records.length ? `共 ${records.length} 条 · 刷新中…` : '载入中…'

    const token = generation
    const request = fetchHistory(200)
      .then(result => {
        if (token !== generation) return
        records = Array.isArray(result?.entries) ? result.entries : []
        errorText = ''
        loaded = true
        lastLoadedAt = Date.now()
        meta.textContent = `共 ${records.length} 条`
        render()
      })
      .catch(error => {
        if (token !== generation) return
        errorText = error?.message || '载入失败，请稍后重试'
        // 失败不清空旧数据：列表上方挂一条错误，下面继续展示上一次的结果
        meta.textContent = records.length ? `共 ${records.length} 条 · 刷新失败` : '载入失败'
        render()
      })
      .finally(() => {
        if (inFlight === request) inFlight = null
      })

    inFlight = request
    return request
  }

  function filtered() {
    if (!keyword) return records
    const lower = keyword.toLowerCase()
    return records.filter(record =>
      [record.name, record.prompt, record.category]
        .some(field => String(field || '').toLowerCase().includes(lower)))
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '耗时未知'
    if (ms < 1000) return `${ms} 毫秒`
    return `${(ms / 1000).toFixed(1)} 秒`
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return ''
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  }

  function sourceLabel(source) {
    if (source === 'batch') return '批量'
    if (source === 'free') return '自由创作'
    return '单张'
  }

  function render() {
    const rows = filtered()
    const keepTop = list.scrollTop
    const parts = []

    if (errorText) {
      parts.push(`
        <li class="history-error" role="alert">
          <span>${escapeHtml(errorText)}</span>
          <button class="history-retry" type="button" data-action="retry">重试</button>
        </li>
      `)
    }

    if (!rows.length) {
      const empty = records.length ? '没有匹配的记录' : '还没有生成记录'
      parts.push(`<li class="history-empty">${empty}</li>`)
    } else {
      parts.push(rows.map((record, index) => `
        <li class="history-item" data-index="${index}">
          <button class="history-thumb" type="button" data-action="view" title="查看大图">
            <img src="${escapeAttr(record.imageUrl)}" alt="${escapeAttr(record.name || '生成图片')}" loading="lazy" decoding="async">
          </button>
          <div class="history-body">
            <div class="history-title-row">
              <span class="history-name" title="${escapeAttr(record.name)}">${escapeHtml(record.name || '未命名')}</span>
              <span class="history-badge">${escapeHtml(sourceLabel(record.source))} · ${escapeHtml(record.category)}</span>
            </div>
            <p class="history-prompt" title="${escapeAttr(record.prompt)}">${escapeHtml(record.prompt || '（无提示词）')}</p>
            <div class="history-facts">
              <span>${escapeHtml(formatDateTime(record.createdAt))}</span>
              <span>${escapeHtml(formatDuration(record.durationMs))}</span>
              <span>${escapeHtml(record.ratio || '')} · ${record.width || '?'} × ${record.height || '?'}</span>
              <span>${escapeHtml(formatBytes(record.bytes))}</span>
              <span>${escapeHtml(tokensLabel(record))}</span>
            </div>
          </div>
          <div class="history-actions">
            <button class="history-mini" type="button" data-action="view" title="查看大图">查看</button>
            <button class="history-mini" type="button" data-action="download" title="下载原图">下载</button>
          </div>
        </li>
      `).join(''))
    }

    list.innerHTML = parts.join('')
    // render 会重建列表节点，顺便把滚动位置放回去
    if (keepTop) list.scrollTop = Math.min(keepTop, Math.max(0, list.scrollHeight - list.clientHeight))
  }

  // 事件委托：列表内所有按钮 + 大图遮罩
  panel.addEventListener('click', event => {
    if (event.target === panel) {
      close()
      return
    }

    const action = event.target.closest('[data-action]')?.dataset.action
    if (!action) return

    if (action === 'retry') {
      load({ silent: records.length > 0, force: true })
      return
    }

    const item = event.target.closest('.history-item')
    const record = item ? filtered()[Number(item.dataset.index)] : null
    if (!record) return

    if (action === 'view') openLightbox(record)
    else if (action === 'download') download(record)
  })

  closeButton?.addEventListener('click', close)
  button.addEventListener('click', event => {
    event.stopPropagation()
    panel.classList.contains('visible') ? close() : open()
  })

  /* 滚轮交给浏览器原生滚动处理：方向、速度、系统里的「反向滚动」设置都照旧生效，
     我们只在滚到边界时 preventDefault，避免把剩余的滚动传给后面的页面。
     之前是手动 list.scrollTop += delta，方向完全取决于我们算出来的增量——
     一旦归一化和浏览器的增量单位对不上，看起来就会是「滚轮往下、内容往上」。
     原生滚动没有这层换算，方向永远和页面其它地方一致。 */
  guardWheel(list)

  searchInput?.addEventListener('input', () => {
    keyword = searchInput.value.trim()
    render()
  })

  /* 点面板外的空白收起：头像菜单点过来的那一下、面板内部、大图预览都不算"外面" */
  document.addEventListener('pointerdown', event => {
    if (!panel.classList.contains('visible')) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (panel.contains(target)) return
    if (target.closest('#user-avatar')) return
    if (target.closest('#history-lightbox')) return
    close()
  }, true)

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    // 大图打开时 Esc 先关大图，交给他自己的快捷键
    if (qs('#history-lightbox')?.classList.contains('visible')) return
    if (!panel.classList.contains('visible')) return
    event.preventDefault()
    close()
  })

  return { open, close, invalidate }
}

/**
 * token 用量文案：上游返回真实值优先；本地估算值明确标注「估算」，
 * 避免被误解为计费依据。
 */
function tokensLabel(record) {
  const input = Number(record.tokensInput)
  if (!Number.isFinite(input) || input <= 0) return ''
  const output = Number(record.tokensOutput)
  const hasOutput = Number.isFinite(output) && output > 0
  const estimated = record.tokensSource !== 'upstream'
  const value = hasOutput ? `${input} 入 / ${output} 出` : `${input} 入`
  return `token ${value}${estimated ? '（估算）' : ''}`
}

function openLightbox(record) {
  let lightbox = qs('#history-lightbox')
  if (!lightbox) {
    lightbox = document.createElement('div')
    lightbox.id = 'history-lightbox'
    lightbox.className = 'history-lightbox'
    lightbox.innerHTML = `
      <figure class="history-lightbox-stage">
        <img id="history-lightbox-image" alt="生成图片大图">
        <figcaption id="history-lightbox-caption"></figcaption>
        <div class="history-lightbox-prompt">
          <div class="history-lightbox-prompt-head">
            <span>提示词</span>
            <span class="history-lightbox-tokens" id="history-lightbox-tokens"></span>
            <button class="history-prompt-copy" id="history-prompt-copy" type="button" title="复制提示词">复制</button>
          </div>
          <p class="history-lightbox-prompt-text" id="history-lightbox-prompt-text"></p>
        </div>
        <button class="history-lightbox-close" type="button" aria-label="关闭大图">✕</button>
      </figure>
    `
    document.body.append(lightbox)

    // 复制大图下方的提示词
    lightbox.addEventListener('click', async event => {
      const copyButton = event.target.closest('#history-prompt-copy')
      if (copyButton) {
        const text = qs('#history-lightbox-prompt-text', lightbox)?.dataset.raw || ''
        if (!text) return
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          const helper = document.createElement('textarea')
          helper.value = text
          document.body.append(helper)
          helper.select()
          document.execCommand('copy')
          helper.remove()
        }
        copyButton.textContent = '已复制'
        setTimeout(() => { copyButton.textContent = '复制' }, 1500)
        return
      }

      if (event.target === lightbox || event.target.closest('.history-lightbox-close')) {
        lightbox.classList.remove('visible')
      }
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') lightbox.classList.remove('visible')
    })
  }

  // 提示词区可滚动：滚轮只在它内部生效，到边界不外溢
  const promptBlock = qs('#history-lightbox-prompt-text', lightbox)
  if (promptBlock && !promptBlock.dataset.wheelBound) {
    promptBlock.dataset.wheelBound = '1'
    guardWheel(promptBlock, promptBlock.closest('.history-lightbox-prompt') || promptBlock)
  }

  qs('#history-lightbox-image', lightbox).src = record.imageUrl
  qs('#history-lightbox-caption', lightbox).textContent =
    `${record.name || '未命名'} · ${record.ratio || ''} · ${record.width || '?'} × ${record.height || '?'}`
  const promptText = qs('#history-lightbox-prompt-text', lightbox)
  promptText.textContent = record.prompt || '（该记录没有提示词，可能是旧版生成的）'
  promptText.dataset.raw = record.prompt || ''
  const tokenNote = qs('#history-lightbox-tokens', lightbox)
  if (tokenNote) {
    const label = tokensLabel(record)
    tokenNote.textContent = label
  }
  lightbox.classList.add('visible')
}

function download(record) {
  const link = document.createElement('a')
  link.href = record.imageUrl
  link.download = `${record.name || '画境'}.${(record.imageUrl.split('.').pop() || 'png').split('?')[0]}`
  document.body.append(link)
  link.click()
  link.remove()
}
