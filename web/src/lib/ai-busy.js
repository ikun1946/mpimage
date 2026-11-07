/**
 * AI 执行中的字段动画（方案一）。
 *
 * 用法：
 *   const busy = startAiBusy(document.querySelector('#free-prompt-shell'), {
 *     pool: 'optimize', action: '优化',
 *   })
 *   try { ... } finally { busy.stop() }
 *
 * 同一个输入框可能被多个请求占用（优化还没回来又点了改写），用引用计数合并，
 * 最后一个 stop 才撤掉动画。动画层 pointer-events: none，不影响继续编辑。
 */

const PHRASES = {
  optimize: [
    '正在疯狂思考',
    '正在读你的画面',
    '正在给风格上锁',
    '正在重写提示词',
    '正在补齐光影细节',
    '正在防止跑偏',
    '正在和画风较劲',
    '正在检查约束',
    '正在琢磨构图',
    '快好了，再等等',
  ],
  refine: [
    '正在疯狂思考',
    '正在读你点名的部分',
    '正在保留其余设定',
    '正在重写这一栏',
    '正在收束措辞',
    '正在核对负面词',
    '正在防止改过头',
    '正在对照角色分析',
    '快好了，再等等',
  ],
}

const SPARKLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7z"></path><path d="M18.6 15.4l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"></path></svg>'

const STATES = new WeakMap()

function refill(state) {
  const list = PHRASES[state.pool] || PHRASES.optimize
  const queue = list.slice()
  for (let i = queue.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[queue[i], queue[j]] = [queue[j], queue[i]]
  }
  // 新一轮的第一句不能和上一轮的最后一句相同，避免连着重复
  if (queue.length > 1 && queue[0] === state.last) {
    ;[queue[0], queue[1]] = [queue[1], queue[0]]
  }
  state.queue = queue
}

function pick(state) {
  if (!state.queue.length) refill(state)
  state.last = state.queue.shift()
  return state.last
}

function phraseText(state) {
  const phrase = state.current || pick(state)
  return state.still ? `AI 仍在${state.action} · ${phrase}` : `AI ${phrase}`
}

function paint(state) {
  if (!state.textEl) return
  state.textEl.textContent = phraseText(state)
}

function rotate(state) {
  state.current = pick(state)
  if (!state.textEl) return
  state.textEl.classList.add('is-swapping')
  setTimeout(() => {
    paint(state)
    state.textEl.classList.remove('is-swapping')
  }, 170)
}

function buildLayer(target, state) {
  const layer = document.createElement('div')
  layer.className = 'ai-busy-layer'
  layer.setAttribute('aria-hidden', 'true')
  layer.innerHTML = `<span class="ai-busy-pill">${SPARKLE}<span class="ai-busy-text"></span><span class="ai-busy-dots"><i></i><i></i><i></i></span></span>`
  target.appendChild(layer)
  state.layer = layer
  state.textEl = layer.querySelector('.ai-busy-text')
}

function release(target, state) {
  state.refs -= 1
  if (state.refs > 0) return
  clearInterval(state.timer)
  state.layer?.remove()
  target.classList.remove('is-ai-busy')
  STATES.delete(target)
}

/**
 * @param {Element} target 提示词框的包裹层（position: relative）
 * @param {{ pool?: 'optimize'|'refine', action?: string, still?: boolean }} options
 *   still=true 用于「关闭弹窗后仍在后台跑」：文案变成「AI 仍在改写 · 正在…」
 * @returns {{ stop: () => void }}
 */
export function markAiBusyStill(target, action = '改写') {
  const state = STATES.get(target)
  if (!state) return
  state.still = true
  state.action = action
  paint(state)
}

export function startAiBusy(target, options = {}) {
  if (!target) return { stop() {} }

  let state = STATES.get(target)
  if (!state) {
    state = {
      refs: 0,
      pool: options.pool || 'optimize',
      action: options.action || '优化',
      still: Boolean(options.still),
      current: '',
      last: '',
      queue: [],
      timer: 0,
      layer: null,
      textEl: null,
    }
    buildLayer(target, state)
    target.classList.add('is-ai-busy')
    state.current = pick(state)
    paint(state)
    state.timer = setInterval(() => rotate(state), 2600)
    STATES.set(target, state)
  } else {
    if (options.pool) state.pool = options.pool
    if (options.action) state.action = options.action
    if (options.still) state.still = true
    paint(state)
  }

  state.refs += 1
  return { stop: () => release(target, state) }
}