/**
 * 页签组公共行为：点击切换、方向键 / Home / End 循环切换、roving tabindex、
 * aria-selected 与面板 hidden 同步，并默认把当前页签写进 location.hash。
 *
 * 约定：root 内的 [role="tab"] 用 aria-controls 指向对应的 [role="tabpanel"]；
 * 页签标识优先取 data-tab（batch.html），否则取去掉 tab- 前缀的 id（后台页）。
 *
 * 用法：
 *   const tabs = setupTablist(document.querySelector('.section-nav'), {
 *     onChange: id => {
 *       if (id === 'data') redrawTrend()
 *     },
 *   })
 *   tabs.activate('config')
 *
 * onChange 只在用户切换时触发，初始化定位（含 hash 直链）不触发，
 * 这样页面不必重复渲染首屏那一组。
 *
 * 两个可选项：hash=false 不读写 location.hash，click=false 不接管点击——
 * batch 页的点击已经由它自己的 [data-tab] 分发走 switchTab，再接一次就会重复渲染。
 */

/** 页签标识：优先 data-tab，其次 id 去掉 tab- 前缀，hash 才短得能看 */
function tabIdOf(tab) {
  return tab.dataset.tab || tab.id.replace(/^tab-/, '')
}

export function setupTablist(root, { onChange, initialId, hash = true, click = true } = {}) {
  if (!root) return { activate() {}, current: () => '' }

  const items = [...root.querySelectorAll('[role="tab"]')]
    .map(tab => ({
      tab,
      id: tabIdOf(tab),
      panel: document.getElementById(tab.getAttribute('aria-controls') || ''),
    }))
    .filter(item => item.panel)

  let currentId = ''

  /**
   * 以 DOM 上的 aria-selected 为准判断「本来就在这一页」：
   * batch 的页签状态由它自己的 renderTabs 维护，这里的快照可能已经过期。
   */
  function activate(id, silent = false) {
    const next = items.find(item => item.id === id)
    if (!next) return
    const already = next.tab.getAttribute('aria-selected') === 'true'

    items.forEach(item => {
      const active = item === next
      item.tab.setAttribute('aria-selected', String(active))
      item.tab.tabIndex = active ? 0 : -1
      item.panel.hidden = !active
    })
    currentId = next.id
    if (hash) window.history.replaceState(null, '', `#${currentId}`)
    if (!silent && !already) onChange?.(currentId, next.tab)
  }

  if (click) {
    root.addEventListener('click', event => {
      const tab = event.target.closest('[role="tab"]')
      if (!tab || tab.disabled) return
      activate(tabIdOf(tab))
    })
  }

  root.addEventListener('keydown', event => {
    const tab = event.target.closest('[role="tab"]')
    if (!tab) return
    const tabs = items.map(item => item.tab).filter(item => !item.disabled)
    const index = tabs.indexOf(tab)
    if (index === -1) return

    let next = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = tabs[(index + 1) % tabs.length]
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = tabs[(index - 1 + tabs.length) % tabs.length]
    else if (event.key === 'Home') next = tabs[0]
    else if (event.key === 'End') next = tabs[tabs.length - 1]
    if (!next) return

    event.preventDefault()
    next.focus()
    activate(tabIdOf(next))
  })

  // hash 里不是本组页签就当没写，直接落到首组
  const hashId = hash ? window.location.hash.slice(1) : ''
  const startId = [initialId, hashId].find(id => id && items.some(item => item.id === id)) || items[0]?.id
  if (startId) activate(startId, true)

  return {
    activate: id => activate(id),
    current: () => currentId,
  }
}