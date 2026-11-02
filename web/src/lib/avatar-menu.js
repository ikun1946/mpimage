/**
 * 头像菜单：悬停/聚焦展开，点击头像切换，点菜单项或点空白处收起。
 *
 * 收起后要一直保持“已收起”，直到用户重新指向或点头像：
 * 弹层关闭时会把焦点还给菜单里的按钮，若此时还按 :focus-within 展开，
 * 菜单就会在弹窗关掉的一瞬间自己弹出来。dismissed 这个标记专门挡这件事，
 * 同时用 .is-dismissed 盖住 :hover / :focus-within 的展开样式。
 */
export function setupAvatarMenu({ shouldIgnoreOutsideClick } = {}) {
  const avatar = document.querySelector('#user-avatar')
  if (!avatar) return { close() {} }

  let dismissed = false

  const isOpen = () => avatar.classList.contains('is-open')

  const syncExpanded = () => {
    const expanded = !dismissed && (
      isOpen()
      || avatar.matches(':hover')
      || avatar.contains(document.activeElement)
    )
    avatar.setAttribute('aria-expanded', String(expanded))
  }

  const applyState = () => {
    avatar.classList.toggle('is-open', isOpen())
    avatar.classList.toggle('is-dismissed', dismissed)
    syncExpanded()
  }

  /** 收起菜单；dismiss 为真时连悬停/聚焦也不再让它自己展开 */
  const close = (dismiss = true) => {
    avatar.classList.remove('is-open')
    if (dismiss) dismissed = true
    applyState()
  }

  avatar.addEventListener('pointerenter', () => {
    // 用户重新指过来才算“重新打开”，程序化换焦点不算
    if (!dismissed) return
    dismissed = false
    applyState()
  })
  avatar.addEventListener('pointerleave', syncExpanded)
  avatar.addEventListener('focusin', syncExpanded)
  avatar.addEventListener('focusout', event => {
    if (avatar.contains(event.relatedTarget)) return
    avatar.classList.remove('is-open')
    syncExpanded()
  })

  // 菜单项在捕获阶段先收起菜单：业务处理函数里的 stopPropagation 拦不到这一步
  avatar.addEventListener('click', event => {
    if (!event.target.closest?.('#avatar-menu [role="menuitem"], #avatar-menu button, #avatar-menu a')) return
    close(true)
  }, true)

  avatar.addEventListener('click', event => {
    event.stopPropagation()
    if (event.target.closest('#avatar-menu')) return
    if (isOpen() && !dismissed) close(true)
    else {
      dismissed = false
      avatar.classList.add('is-open')
      applyState()
    }
  })

  avatar.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    close(true)
    avatar.focus()
  })

  document.addEventListener('click', event => {
    if (shouldIgnoreOutsideClick?.(event)) return
    if (avatar.getAttribute('aria-expanded') === 'true') close(true)
  })

  applyState()
  return { close }
}
