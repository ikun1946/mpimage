/**
 * 生成中的画布动画。
 *
 * 六套视觉：
 *   ink    显影      色块从雾里浮出来，中间金色进度环
 *   scan   扫描取景  取景框 + 来回扫描的金线
 *   layers 叠卡循环  三张卡叠放，按阶段抽起翻转
 *   tiles  像素显影  14×14 马赛克从中心向外亮
 *   orbit  粒子汇聚  金色 / 苔绿粒子环绕呼吸
 *   water  水位上涨  WebGL 拟真水体从底部涨上来
 *
 * 每次生成随机挑一套；进度、阶段文案都由 batch.js 的真实进度驱动。
 * 用法：
 *   const anim = mountGenerationAnimation(previewEl, pickGenerationVariant())
 *   anim.setProgress(46)
 *   anim.finish()
 */

const VARIANTS = ['ink', 'scan', 'layers', 'tiles', 'orbit', 'water']

const VARIANT_CLASS = {
  ink: 'v1',
  scan: 'v2',
  layers: 'v3',
  tiles: 'v4',
  orbit: 'v5',
  water: 'v6',
}

/* 与左侧进度条的阶段文案保持一致，避免两边说法不一样 */
const STAGES = [
  [0, '正在理解画面'],
  [18, '正在搭建构图'],
  [42, '正在细化光影'],
  [68, '正在完成渲染'],
  [88, '正在接收图像'],
]

function stageOf(percent) {
  let label = STAGES[0][1]
  for (const [threshold, text] of STAGES) {
    if (percent >= threshold) label = text
  }
  return label
}

let lastVariant = ''

/** 随机挑一套，尽量不和上一次重复 */
export function pickGenerationVariant() {
  const pool = VARIANTS.filter(variant => variant !== lastVariant)
  const picked = pool[Math.floor(Math.random() * pool.length)] || VARIANTS[0]
  lastVariant = picked
  return picked
}

/* ===== 各方案的结构 ===== */

function variantMarkup(variant) {
  if (variant === 'ink') {
    return `
      <div class="gen-ink"></div>
      <div class="gen-grain"></div>
      <div class="gen-core">
        <span class="gen-ring"></span>
        <strong>正在生成</strong>
        <span class="gen-stage">正在理解画面</span>
      </div>
    `
  }
  if (variant === 'scan') {
    return `
      <div class="gen-grid"></div>
      <div class="gen-draft"></div>
      <div class="gen-scanline"></div>
      <div class="gen-corners"><span></span><span></span><span></span><span></span></div>
      <span class="gen-pct">0%</span>
      <div class="gen-chip"><i class="dot"></i><span class="gen-stage">正在理解画面</span></div>
    `
  }
  if (variant === 'layers') {
    return `
      <div class="gen-layers">
        <div class="gen-layer">构 图</div>
        <div class="gen-layer">光 影</div>
        <div class="gen-layer">细 节</div>
      </div>
      <span class="gen-pct gen-pct-big">0%</span>
      <div class="gen-chip"><i class="dot"></i><span class="gen-stage">正在理解画面</span></div>
    `
  }
  if (variant === 'tiles') {
    return `
      <div class="gen-tiles"></div>
      <span class="gen-pct">0%</span>
      <div class="gen-chip"><i class="dot"></i><span class="gen-stage">正在理解画面</span></div>
    `
  }
  if (variant === 'orbit') {
    return `
      <div class="gen-orbit a"></div>
      <div class="gen-orbit b"></div>
      <div class="gen-halo"><span></span><span></span></div>
      <div class="gen-seed">
        <span class="gen-num">0%</span>
        <span class="gen-seed-label">正在汇聚</span>
      </div>
      <div class="gen-chip"><i class="dot"></i><span class="gen-stage">正在理解画面</span></div>
    `
  }
  return `
    <canvas class="gen-water-gl"></canvas>
    <canvas class="gen-water-fx"></canvas>
    <div class="gen-ruler">
      <span style="--h: 25%">25</span>
      <span style="--h: 50%">50</span>
      <span style="--h: 75%">75</span>
    </div>
    <span class="gen-pct">0%</span>
    <div class="gen-chip"><i class="dot"></i><span class="gen-stage">正在理解画面</span></div>
  `
}

/* ===== 方案三：叠卡 ===== */

const DECK_SLOTS = ['slot-back', 'slot-mid', 'slot-front']

function paintDeck(root) {
  const order = root.__order || []
  order.forEach((el, index) => {
    el.classList.remove(...DECK_SLOTS)
    el.classList.add(DECK_SLOTS[Math.min(index, 2)])
  })
}

function dealCard(root) {
  const order = root.__order
  if (!order || order.length < 2 || root.__dealing) return
  root.__dealing = true
  const back = order[0]
  back.classList.add('lift')
  root.__dealTimer = window.setTimeout(() => {
    root.__order = [...order.slice(1), back]
    back.classList.remove('lift')
    paintDeck(root)
    root.__dealing = false
  }, 430)
}

/* ===== 方案四：像素格 ===== */

function buildTiles(root) {
  const grid = root.querySelector('.gen-tiles')
  if (!grid) return []
  const size = 14
  const cells = []
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      cells.push({ row, col, d: Math.hypot(row - (size - 1) / 2, col - (size - 1) / 2) })
    }
  }
  cells.sort((a, b) => a.d - b.d)
  const palette = [
    'rgba(54, 84, 69, 0.62)',
    'rgba(102, 131, 110, 0.55)',
    'rgba(167, 130, 67, 0.6)',
    'rgba(165, 76, 49, 0.38)',
  ]
  const tiles = []
  for (const cell of cells) {
    const tile = document.createElement('i')
    tile.className = 'gen-tile'
    tile.style.setProperty('--tint', palette[(cell.row * 7 + cell.col * 3) % palette.length])
    grid.appendChild(tile)
    tiles.push(tile)
  }
  return tiles
}

/* ===== 方案五：粒子环 ===== */

function buildOrbits(root) {
  const inner = root.querySelector('.gen-orbit.a')
  const outer = root.querySelector('.gen-orbit.b')
  if (inner) {
    for (let i = 0; i < 16; i += 1) {
      const dot = document.createElement('i')
      dot.style.setProperty('--a', String(i * 22.5 + (i % 3) * 5))
      dot.style.setProperty('--r', `${74 + (i % 4) * 13}px`)
      dot.style.setProperty('--d', `${(i * 0.13).toFixed(2)}s`)
      inner.appendChild(dot)
    }
  }
  if (outer) {
    for (let i = 0; i < 11; i += 1) {
      const dot = document.createElement('i')
      dot.style.setProperty('--a', String(i * 32.7))
      dot.style.setProperty('--r', `${118 + (i % 3) * 11}px`)
      dot.style.setProperty('--d', `${(0.4 + i * 0.17).toFixed(2)}s`)
      outer.appendChild(dot)
    }
  }
}

/* ===== 方案六：WebGL 水体 ===== */

const WATER_VERT = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }'

const WATER_FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_prog;
uniform float u_vel;

float hash(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm3(vec2 p){
  float v = 0.0, a = 0.55;
  for(int i = 0; i < 3; i++){
    v += a * noise(p);
    p = p * 2.03 + vec2(11.7, 5.3);
    a *= 0.5;
  }
  return v;
}

// 不规则水面：低频涌浪 + 几列不同波长/速度的行波 + 噪声相位，看不出周期
float waveAt(float x, float t){
  float gust = 0.58 + 0.42 * noise(vec2(x * 2.7 + 4.0, t * 0.22));
  float ph = noise(vec2(x * 4.5 - t * 0.30, t * 0.18)) * 6.2831;
  float h = 1.10 * (noise(vec2(x * 3.4 - t * 0.20, t * 0.30)) - 0.5) * 2.0;
  h += 0.85 * sin(x * 5.0  + t * 0.70 + ph * 0.55);
  h += 0.50 * sin(x * 13.0 - t * 1.30 + ph * 1.15 + 1.7);
  h += 0.30 * sin(x * 24.0 + t * 2.05 + ph * 1.85 + 3.1);
  h += 0.15 * sin(x * 41.0 - t * 3.10 + ph * 2.40 + 0.6);
  h += 0.08 * sin(x * 67.0 + t * 4.20 + 2.2);
  return h * gust / 1.9;
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  float t = u_time;

  float amp = mix(0.042, 0.085, clamp(u_vel, 0.0, 1.0));
  float edge = u_prog + waveAt(uv.x, t) * amp + 0.004 * sin(t * 0.9) * (0.4 + 0.6 * u_vel);
  if(u_prog <= 0.001) edge = -0.05;
  edge = clamp(edge, -0.05, 1.03);
  float d = edge - uv.y;
  float dxp = max(d, 0.0) * u_res.y;

  float sheen = 0.5 + 0.5 * sin((uv.x * 0.9 + uv.y) * 24.0);
  vec3 bg = mix(vec3(0.972, 0.963, 0.941), vec3(0.910, 0.902, 0.874), sheen * 0.30);
  bg += (hash(uv * u_res * 0.5) - 0.5) * 0.014;
  vec3 col = bg;

  if(d > 0.0){
    float lens = smoothstep(0.06, 0.0, d);
    vec2 warp = vec2(
      noise(uv * vec2(8.0, 22.0) + vec2(0.0, -t * 1.2)),
      noise(uv * vec2(8.0, 22.0) + vec2(5.2, -t * 1.2) + 7.3)) - 0.5;

    vec3 topC = vec3(0.64, 0.80, 0.74);
    vec3 botC = vec3(0.16, 0.32, 0.29);
    vec3 water = mix(topC, botC, smoothstep(0.0, 0.62, d));
    water = mix(water, water * 1.08 + vec3(0.035), smoothstep(0.10, 0.0, d) * 0.30);
    water += vec3(0.02, 0.05, 0.04) * (warp.x + warp.y) * lens;
    water += vec3(0.60, 0.76, 0.68) * exp(-d * 26.0) * 0.22;

    float ca  = fbm3(uv * vec2(10.0, 26.0) + vec2(t * 0.25, -t * 0.70));
    float ca2 = fbm3(uv * vec2(17.0, 44.0) + vec2(-t * 0.40, t * 1.00) + 3.7);
    float fil = pow(smoothstep(0.56, 0.88, ca), 2.0)
              + 0.60 * pow(smoothstep(0.60, 0.90, ca2), 2.4);
    water += vec3(0.88, 0.80, 0.58) * fil * 0.34 * (0.25 + 0.65 * exp(-d * 1.8));

    float ray = noise(vec2(uv.x * 13.0 + 0.8, uv.y * 1.6 - t * 0.12));
    water += vec3(0.42, 0.40, 0.24) * pow(ray, 3.0) * smoothstep(0.6, 0.0, d) * 0.24;

    water *= 1.0 + sin(uv.y * 84.0 - t * 2.8 + warp.x * 9.0) * 0.009;

    float fz = smoothstep(0.022, 0.0, d);
    float fn = noise(vec2(uv.x * 160.0 - t * 3.2, uv.y * 120.0));
    float foam = clamp(fz * (0.22 + 0.95 * smoothstep(0.45, 0.75, fn)), 0.0, 1.0);
    water = mix(water, vec3(0.972, 0.958, 0.902), foam * 0.62);

    water += vec3(0.988, 0.968, 0.900) * exp(-dxp * 0.85) * 0.58;
    water -= vec3(0.06, 0.13, 0.12) * exp(-pow((d - 0.020) * 150.0, 2.0)) * 0.55;

    float cyl = smoothstep(0.0, 0.07, uv.x) * smoothstep(1.0, 0.93, uv.x);
    water *= 0.86 + 0.14 * cyl;
    col = water;
  }

  gl_FragColor = vec4(col, 1.0);
}`

function createWaterTank(glCanvas, fxCanvas) {
  const gl = glCanvas.getContext('webgl', { antialias: false, alpha: false })
  const ctx = fxCanvas.getContext('2d')
  let uni = null
  let W = 1
  let H = 1
  let dpr = 1
  let bubbles = []
  let sprite = null
  let lastNow = performance.now()
  let level = 0
  let levelVel = 0
  let smoothVel = 0

  function compile(type, src) {
    if (!gl) return null
    const shader = gl.createShader(type)
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader))
      return null
    }
    return shader
  }

  let ok = false
  if (gl) {
    const vs = compile(gl.VERTEX_SHADER, WATER_VERT)
    const fs = compile(gl.FRAGMENT_SHADER, WATER_FRAG)
    if (vs && fs) {
      const program = gl.createProgram()
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      gl.linkProgram(program)
      if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.useProgram(program)
        const buffer = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
        const loc = gl.getAttribLocation(program, 'p')
        gl.enableVertexAttribArray(loc)
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
        uni = {}
        for (const name of ['u_res', 'u_time', 'u_prog', 'u_vel']) {
          uni[name] = gl.getUniformLocation(program, name)
        }
        ok = true
      }
    }
  }

  function resize() {
    W = Math.max(1, glCanvas.clientWidth)
    H = Math.max(1, glCanvas.clientHeight)
    let scale = Math.min(1.5, window.devicePixelRatio || 1)
    const budget = 300000
    if (W * H * scale * scale > budget) scale = Math.sqrt(budget / (W * H))
    dpr = Math.max(0.75, scale)
    for (const canvas of [glCanvas, fxCanvas]) {
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
    }
    if (ok) gl.viewport(0, 0, glCanvas.width, glCanvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function bubbleSprite() {
    if (sprite) return sprite
    const canvas = document.createElement('canvas')
    canvas.width = 48
    canvas.height = 48
    const c = canvas.getContext('2d')
    const g = c.createRadialGradient(17, 16, 3, 24, 24, 22)
    g.addColorStop(0, 'rgba(255,252,243,.90)')
    g.addColorStop(0.35, 'rgba(228,238,228,.18)')
    g.addColorStop(0.85, 'rgba(202,216,204,.10)')
    g.addColorStop(1, 'rgba(236,240,228,.46)')
    c.fillStyle = g
    c.beginPath()
    c.arc(24, 24, 22, 0, 7)
    c.fill()
    c.strokeStyle = 'rgba(255,253,246,.32)'
    c.lineWidth = 1
    c.beginPath()
    c.arc(24, 24, 21, 0, 7)
    c.stroke()
    sprite = canvas
    return canvas
  }

  function drawBubbles(dt, prog) {
    ctx.clearRect(0, 0, W, H)
    if (prog <= 0.002) return
    const surfaceY = H * (1 - prog)
    const sheet = bubbleSprite()

    if (Math.random() < 0.09 && bubbles.length < 30) {
      bubbles.push({
        x: Math.random() * W,
        y: H - 4,
        r: 1.4 + Math.random() * 3.2,
        vy: 16 + Math.random() * 24,
        phase: Math.random() * 6.28,
        wspd: 2 + Math.random() * 4,
        wamp: 4 + Math.random() * 8,
      })
    }

    for (let i = bubbles.length - 1; i >= 0; i -= 1) {
      const bubble = bubbles[i]
      bubble.phase += dt * bubble.wspd
      bubble.x += Math.sin(bubble.phase) * bubble.wamp * dt
      bubble.y -= bubble.vy * dt
      if (bubble.y < surfaceY + 2 || bubble.x < -20 || bubble.x > W + 20) {
        bubbles.splice(i, 1)
        continue
      }
      ctx.drawImage(sheet, bubble.x - bubble.r, bubble.y - bubble.r, bubble.r * 2, bubble.r * 2)
    }
  }

  function drawFallback(prog) {
    if (prog <= 0.002) return
    const surfaceY = H * (1 - prog)
    const t = performance.now() / 1000
    const grad = ctx.createLinearGradient(0, surfaceY, 0, H)
    grad.addColorStop(0, '#a9c8b8')
    grad.addColorStop(1, '#2f4f45')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.moveTo(0, H)
    for (let x = 0; x <= W; x += 8) {
      const y = surfaceY + Math.sin(x * 0.05 + t * 2) * 4 + Math.sin(x * 0.11 - t * 3) * 2
      ctx.lineTo(x, y)
    }
    ctx.lineTo(W, H)
    ctx.closePath()
    ctx.fill()
  }

  function render(t, progTarget) {
    const now = performance.now()
    const dt = Math.min(0.05, Math.max(0.001, (now - lastNow) / 1000))
    lastNow = now

    levelVel += ((progTarget - level) * 30 - levelVel * 10) * dt
    level += levelVel * dt
    if (level < -0.03) { level = -0.03; levelVel = 0 }
    if (level > 1.02) { level = 1.02; levelVel = 0 }
    const targetVel = Math.min(1, Math.abs(progTarget - level) * 22)
    smoothVel += (targetVel - smoothVel) * Math.min(1, dt * 3.5)

    if (ok && gl) {
      gl.uniform2f(uni.u_res, glCanvas.width, glCanvas.height)
      gl.uniform1f(uni.u_time, t)
      gl.uniform1f(uni.u_prog, level)
      gl.uniform1f(uni.u_vel, smoothVel)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    } else {
      ctx.clearRect(0, 0, W, H)
      drawFallback(level)
    }
    drawBubbles(dt, level)
  }

  function destroy() {
    bubbles = []
  }

  resize()
  render(0, 0)
  return { resize, render, destroy }
}

/* ===== 挂载 ===== */

export function mountGenerationAnimation(host, variant) {
  const kind = VARIANTS.includes(variant) ? variant : pickGenerationVariant()
  const root = document.createElement('div')
  root.className = `gen-anim ${VARIANT_CLASS[kind]}`
  root.dataset.genAnim = kind
  root.innerHTML = variantMarkup(kind)
  host.append(root)
  host.classList.add('is-generating')

  const pctEls = [...root.querySelectorAll('.gen-pct, .gen-num')]
  const stageEls = [...root.querySelectorAll('.gen-stage')]
  let waterTarget = 0
  let waterTank = null
  let waterRaf = 0
  let waterObserver = null
  let destroyed = false
  let finishTimer = 0
  let tiles = []

  if (kind === 'layers') {
    root.__order = [...root.querySelectorAll('.gen-layer')]
    root.__dealt = 0
    paintDeck(root)
  }

  if (kind === 'tiles') tiles = buildTiles(root)
  if (kind === 'orbit') buildOrbits(root)

  if (kind === 'water') {
    const glCanvas = root.querySelector('.gen-water-gl')
    const fxCanvas = root.querySelector('.gen-water-fx')
    if (glCanvas && fxCanvas) {
      waterTank = createWaterTank(glCanvas, fxCanvas)
      if ('ResizeObserver' in window) {
        waterObserver = new ResizeObserver(() => waterTank?.resize())
        waterObserver.observe(glCanvas)
      }
      const loop = () => {
        if (destroyed) return
        waterTank.render(performance.now() / 1000, waterTarget)
        waterRaf = window.requestAnimationFrame(loop)
      }
      waterRaf = window.requestAnimationFrame(loop)
    }
  }

  function setProgress(percent) {
    if (destroyed) return
    const value = Math.max(0, Math.min(100, Number(percent) || 0))
    root.style.setProperty('--p', String(value / 100))
    for (const el of pctEls) el.textContent = `${Math.round(value)}%`
    const stage = stageOf(value)
    if (stage !== root.__stage) {
      root.__stage = stage
      for (const el of stageEls) el.textContent = stage
      if (kind === 'layers') {
        const index = STAGES.findIndex(([, label]) => label === stage)
        if (index >= 1 && index <= 3 && root.__dealt !== index) {
          root.__dealt = index
          dealCard(root)
        }
      }
    }
    if (tiles.length) {
      const lit = Math.round((value / 100) * tiles.length)
      for (let i = 0; i < tiles.length; i += 1) {
        tiles[i].classList.toggle('on', i < lit)
      }
    }
    if (kind === 'water') waterTarget = value / 100
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    window.clearTimeout(finishTimer)
    window.clearTimeout(root.__dealTimer)
    if (waterRaf) window.cancelAnimationFrame(waterRaf)
    waterObserver?.disconnect()
    waterTank?.destroy()
    root.remove()
    host.classList.remove('is-generating')
  }

  function finish() {
    if (destroyed) return
    setProgress(100)
    root.classList.add('is-done')
    finishTimer = window.setTimeout(destroy, 380)
  }

  setProgress(0)
  return { variant: kind, setProgress, finish, destroy }
}
