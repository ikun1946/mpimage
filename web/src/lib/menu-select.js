/**
 * 把原生 <select> 包装成 Claude 风格的圆角下拉面板。
 * 原生 select 保留为唯一状态源：外部代码继续设置 value / innerHTML，
 * 这里只负责同步触发器文字和菜单项，并在选中时派发 change。
 */
const registry = new WeakMap()
let openWrap = null

/** 模型菜单的悬停说明气泡：挂在 body 上，避免被菜单的 overflow 裁掉 */
let descriptionTip = null
/** 气泡当前跟随的菜单与选项；页面布局变化时要重新量 */
let tipAnchor = null
let tipTimer = 0

function ensureDescriptionTip() {
  if (descriptionTip) return descriptionTip
  descriptionTip = document.createElement('div')
  descriptionTip.className = 'menu-select-tip'
  descriptionTip.setAttribute('role', 'tooltip')
  descriptionTip.hidden = true
  document.body.appendChild(descriptionTip)
  return descriptionTip
}

/**
 * 按菜单与选项当前的位置摆放气泡。
 * 横向贴菜单外沿，纵向跟随当前选项：只靠 item.right 会压进菜单的
 * 内边距/滚动条，看起来像叠在一起。
 */
function placeDescriptionTip() {
  const tip = descriptionTip
  if (!tip || tip.hidden || !tipAnchor) return
  const { menu, item } = tipAnchor
  // 菜单被重新渲染或关掉后，旧坐标没有意义
  if (!menu.isConnected || !item.isConnected) {
    hideDescriptionTip()
    return
  }

  // 全部用 offset 坐标（文档布局坐标）摆放，不再混用视口矩形：
  // 窗口缩放、视觉视口偏移或页面滚动时，气泡和菜单不会各走各的。
  const gap = 8
  const tipWidth = tip.offsetWidth
  const menuBox = documentOffset(menu)
  const itemBox = documentOffset(item)
  const menuWidth = menu.offsetWidth

  // 右侧放不下就翻到菜单左侧
  let left = menuBox.x + menuWidth + gap
  if (left - window.scrollX + tipWidth > document.documentElement.clientWidth - 8) {
    left = menuBox.x - tipWidth - gap
  }

  // 纵向用「选项中心 + translateY(-50%)」对齐：不依赖气泡自身高度，
  // 文案换行数变化时也不会偏半截。
  const top = itemBox.y - menu.scrollTop + item.offsetHeight / 2
  // offsetLeft/Top 累加出来的就是文档坐标，absolute 也用文档坐标，
  // 不能再加 scrollX/Y，否则页面滚动后气泡会被多推一个屏幕的距离。
  tip.style.left = `${Math.round(left)}px`
  tip.style.top = `${Math.round(top)}px`
  tip.style.transform = 'translateY(-50%)'
}

/** 累加 offsetLeft/offsetTop 得到元素在文档里的布局坐标（不含 transform） */
function documentOffset(element) {
  let x = 0
  let y = 0
  let node = element
  while (node) {
    x += node.offsetLeft || 0
    y += node.offsetTop || 0
    node = node.offsetParent
  }
  return { x, y }
}

function hideDescriptionTip() {
  tipAnchor = null
  if (tipTimer) {
    clearInterval(tipTimer)
    tipTimer = 0
  }
  if (descriptionTip) descriptionTip.hidden = true
}

function showDescriptionTip(menu, item, text) {
  if (!text) {
    hideDescriptionTip()
    return
  }
  // 以选项所在的菜单为准，避免调用方传错节点时把气泡摆到别的菜单旁边
  const owner = item.closest('.menu-select-menu') || menu
  if (!owner || !owner.isConnected || owner.hidden || !owner.getClientRects().length) {
    hideDescriptionTip()
    return
  }

  const tip = ensureDescriptionTip()
  tip.textContent = text
  tip.hidden = false
  tipAnchor = { menu: owner, item }
  placeDescriptionTip()
  // 生成完成、参考图出现、布局切换都会让菜单在悬停期间挪位置；
  // 只在鼠标进出时量一次，气泡会停在旧坐标上，离菜单越来越远。
  if (!tipTimer) tipTimer = setInterval(placeDescriptionTip, 80)
}

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
    hideDescriptionTip()
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
      // 只走自定义气泡：不能再设原生 title，否则浏览器会再弹一个，
      // 两个气泡一左一右同时出现。
      const description = option.getAttribute('data-description') || ''
      if (description) {
        item.dataset.description = description
        item.classList.add('has-description')
      }
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
    hideDescriptionTip()
    if (openWrap === wrap) openWrap = null
  }

  const open = () => {
    closeOpen(wrap)
    sync()
    menu.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    openWrap = wrap
  }

  // 滚轮在菜单上时只允许菜单自己滚，不能把后面的页面/输入框一起带着滚
  menu.addEventListener('wheel', event => {
    event.stopPropagation()
  }, { passive: true })
  menu.addEventListener('scroll', hideDescriptionTip, { passive: true })

  // 模型菜单项悬停/键盘聚焦时显示介绍气泡
  menu.addEventListener('mouseover', event => {
    const item = event.target.closest('.menu-select-item[data-description]')
    if (item) showDescriptionTip(menu, item, item.dataset.description)
  })
  // 菜单项之间移动时 relatedTarget 还在菜单里，这时不隐藏，避免来回闪
  menu.addEventListener('mouseout', event => {
    if (!event.target.closest('.menu-select-item[data-description]')) return
    if (menu.contains(event.relatedTarget)) return
    hideDescriptionTip()
  })
  menu.addEventListener('mouseleave', hideDescriptionTip)
  menu.addEventListener('focusin', event => {
    const item = event.target.closest('.menu-select-item[data-description]')
    if (item) showDescriptionTip(menu, item, item.dataset.description)
  })
  menu.addEventListener('focusout', event => {
    if (menu.contains(event.relatedTarget)) return
    hideDescriptionTip()
  })
  // 气泡是 fixed 定位：页面滚动或窗口尺寸变化后旧坐标会失真，直接收起
  window.addEventListener('resize', hideDescriptionTip)
  window.addEventListener('scroll', hideDescriptionTip, { capture: true, passive: true })

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
