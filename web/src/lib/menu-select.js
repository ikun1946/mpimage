/**
 * 把原生 <select> 包装成 Claude 风格的圆角下拉面板。
 * 原生 select 保留为唯一状态源：外部代码继续设置 value / innerHTML，
 * 这里只负责同步触发器文字和菜单项，并在选中时派发 change。
 */
const registry = new WeakMap()
let openWrap = null

function closeOpen(except) {
  if (!openWrap || openWrap === except) return
  const state = registry.get(openWrap)
  state?.close()
  openWrap = null
}

/**
 * @param {HTMLSelectElement} select
 */
export function enhanceMenuSelect(select) {
  if (!select || registry.has(select)) return

  const wrap = document.createElement('span')
  wrap.className = 'menu-select'

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'menu-select-trigger'
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')

  const menu = document.createElement('div')
  menu.className = 'menu-select-menu'
  menu.setAttribute('role', 'listbox')
  menu.hidden = true

  select.parentNode.insertBefore(wrap, select)
  wrap.appendChild(select)
  wrap.appendChild(trigger)
  wrap.appendChild(menu)
  select.classList.add('menu-select-native')
  select.tabIndex = -1

  const compact = select.hasAttribute('data-menu-compact')

  const sync = () => {
    const options = Array.from(select.options)
    const current = options[select.selectedIndex] || options[0] || null
    const label = current ? current.textContent : ''
    // 比例这类选项：菜单里留「16 : 9」便于阅读，触发器收紧成「16:9」
    trigger.textContent = compact ? label.replace(/\s*:\s*/g, ':') : label
    menu.replaceChildren()
    for (const option of options) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'menu-select-item'
      item.setAttribute('role', 'option')
      const selected = option.selected
      item.setAttribute('aria-selected', String(selected))
      item.classList.toggle('is-selected', selected)
      item.textContent = option.textContent
      item.addEventListener('click', () => {
        select.value = option.value
        select.dispatchEvent(new Event('change', { bubbles: true }))
        sync()
        close()
      })
      menu.appendChild(item)
    }
  }

  const close = () => {
    menu.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    if (openWrap === wrap) openWrap = null
  }

  const open = () => {
    closeOpen(wrap)
    sync()
    menu.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    openWrap = wrap
  }

  trigger.addEventListener('click', event => {
    event.stopPropagation()
    if (menu.hidden) open()
    else close()
  })

  select.addEventListener('change', sync)

  // render 函数会重写 select.innerHTML，用 MutationObserver 保持菜单同步
  const observer = new MutationObserver(sync)
  observer.observe(select, { childList: true, subtree: true })

  registry.set(wrap, { sync, close })
  registry.set(select, { sync, close })
  sync()
}

/** 渲染函数改完 options/value 后调用一次，立即刷新触发器文字 */
export function refreshMenuSelect(select) {
  registry.get(select)?.sync()
}

document.addEventListener('click', event => {
  if (openWrap && !openWrap.contains(event.target)) closeOpen(null)
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeOpen(null)
})
