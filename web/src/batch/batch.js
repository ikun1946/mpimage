/**
 * 批量工作台（batch.html）页面脚本。
 *
 * 目录（自上而下 12 个区块）：
 *   1. 状态与存储 —— 常量、state、DOM 引用、本地快照恢复与去抖持久化
 *   2. 项目       —— 项目抽屉、项目列表与切换/保存
 *   3. 导入解析   —— 资产 JSON 导入与字段解析
 *   4. 提示词与风格 —— 提示词拼装、风格库编辑/导入导出、面部参考图
 *   5. 渲染       —— 页签、工具栏、资产表格与各单元格
 *   6. 分组动画   —— 分组展开/收起的过渡动画
 *   7. 队列       —— 批量生成队列与单条进度模拟
 *   8. 弹层与灯箱 —— 资产详情弹窗、灯箱、改名弹窗
 *   9. 下载与结果 —— 生成历史回填与图片下载
 *  10. 自由创作   —— 自由创作页签、断线恢复与提示词编辑器
 *  11. 启动       —— 事件接线、委托点击分发与 boot()
 *  12. 反馈       —— 意见反馈弹窗、提交与本人反馈状态
 */

import {
  ApiRequestError,
  activateProject,
  createProject,
  deleteProject,
  designFace,
  fetchGenerationJob,
  fetchHistory,
  fetchMyFeedback,
  fetchProject,
  fetchProjects,
  fetchServerConfig,
  fetchStyleLibrary,
  generateImage,
  getUpdateStatus,
  logout,
  optimizePrompt,
  revisePrompt,
  updateMyProfile,
  saveStyleLibrary,
  submitFeedback,
  updateProject,
  uploadReferenceImage,
} from '../lib/api.js'
import {
  escapeAttr,
  escapeHtml,
  formatDateTime,
  getImageExtension,
  randomId,
  shorten,
  sleep,
  timestamp,
} from '../lib/dom.js'
import { groupAssets, groupedAssetInfo } from '../lib/asset-groups.js'
import { API_BASE } from '../lib/config.js'
import { setupHistoryPanel } from '../lib/history-panel.js'
import { buildStyleExport, parseStyleFile, planStyleImport } from '../lib/style-transfer.js'
import { requireLogin } from '../lib/guard.js'
import { setupAvatarMenu } from '../lib/avatar-menu.js'
import { HISTORY_LIMIT, assetFilename, assetHistory, primaryEntry, primaryFilename, primaryImageOf } from '../lib/format.js'
import { activateOverlay } from '../lib/overlay.js'
import { ratioOptions } from '../lib/ratio.js'
import { setupTablist } from '../lib/tabs.js'

    /* ===== 状态与存储 ===== */

    const TYPE_META = {
      role: {
        label: '角色资产',
        singular: '角色',
        defaultRatio: '3:4',
        nameLabels: ['姓名', '群像', '角色名称'],
        summaryLabels: ['颜值定位', '人设描述'],
      },
      scene: {
        label: '场景资产',
        singular: '场景',
        defaultRatio: '16:9',
        nameLabels: ['场景名称'],
        summaryLabels: ['空间定位', '空间结构', '光源'],
      },
      prop: {
        label: '道具资产',
        singular: '道具',
        defaultRatio: '1:1',
        nameLabels: ['道具名称'],
        summaryLabels: ['道具类别', '美学定位', '外形'],
      },
    }

    /* 本地快照按账号隔离：同一个浏览器换账号后，不能再看到上一个人的
       草稿、上次生成的图片与导入的资产。key 里带 userId，退出登录不清理
       （各账号各留一份，回来还在）；v1 是旧的全局 key，只在能证明归属时迁移。 */
    const LEGACY_STORAGE_KEY = 'moying.assetStudio.v1'
    const LEGACY_PENDING_JOB_KEY = 'moying.pendingJob.v1'
    let currentUserId = ''
    const storageKey = () => `moying.assetStudio.v2.${currentUserId}`
    const pendingJobKey = () => `moying.pendingJob.v2.${currentUserId}`
    /* 断线恢复相关的定时器必须在初始化调用之前声明，
       否则函数被提前调用时会撞上暂时性死区（TDZ）而静默失败 */
    let resumeTimer = 0

    const STATUS_TEXT = {
      idle: '未生成',
      queued: '排队中',
      generating: '生成中',
      done: '已完成',
      error: '失败',
    }

    let historyEntriesCache = null
    let historyEntriesPromise = null

    const NON_VISUAL_FIELDS = new Set(['声线类型'])

    const STYLE_DEFAULTS = {
      role: {
        id: 'style-role-painting',
        name: '工笔重彩·角色',
        description: '东方工笔重彩人物设定图，线条细腻，设色饱满，服装与发饰材质清晰，光影柔和，整体呈古典叙事质感。',
        updatedAt: '',
      },
      scene: {
        id: 'style-scene-cinema',
        name: '电影写实·场景',
        description: '电影级写实场景，考究空间结构、陈设和陈旧材质，光线有明确来源，色彩克制，氛围真实。',
        updatedAt: '',
      },
      prop: {
        id: 'style-prop-craft',
        name: '器物考据·道具',
        description: '器物考据式道具图，工艺细节清晰，材质纹理真实，色彩与使用痕迹自然，呈现可信的年代感。',
        updatedAt: '',
      },
    }

    const state = {
      fileName: '',
      importedAt: '',
      assets: [],
      styles: { role: [], scene: [], prop: [] },
      defaultStyle: { role: '', scene: '', prop: '' },
      activeTab: 'import',
      selected: new Set(),
      search: { role: '', scene: '', prop: '' },
      page: { role: 1, scene: 1, prop: 1 },
      pageSize: 20,
      // 角色分组里被收起的角色名，默认全部展开
      collapsedGroups: new Set(),
      // 参考图上传：目标角色名与上传中的角色名（防止重复触发）
      refTarget: '',
      refUploading: '',
      queue: [],
      // 并行生成数：默认 5（实测上游约 5 个并发槽），可在批量工具栏调整；服务端另有上限
      concurrency: 5,
      // 用户是否手动改过并行数：改过才在刷新后沿用，否则跟随默认值
      concurrencyCustom: false,
      processing: false,
      stopRequested: false,
      queueTotal: 0,
      queueDone: 0,
      batchLabel: '',
      modalId: '',
      freeBusy: false,
      freeImageUrl: '',
      freeImageExtension: 'png',
      // 自由创作的画面比例与提示词草稿，刷新后保持
      freeRatio: '1:1',
      freePrompt: '',
      // 自由创作的参考图（可多张）：只存相对路径与可预览地址，快照里不塞 base64
      freeReferences: [],
      freeRefUploading: false,
      // 捏脸页：表单、三块结果与最近一次定妆照，刷新后保持
      face: {
        age: '25 岁',
        gender: '女性',
        temperament: '成熟清冷',
        identity: '',
        framing: '胸像特写',
        background: '浅灰纯色背景',
        style: '真人写实',
        extra: '',
        analysis: '',
        prompt: '',
        negativePrompt: '',
        imageUrl: '',
      },
      styleType: 'role',
      styleEditingId: '',
      styleDirty: false,
      // 工具栏上的批量比例/风格选择，刷新后保持
      bulkParams: { role: {}, scene: {}, prop: {} },
      // 项目列表：每个项目是一份独立的资产数据
      projects: [],
      activeProjectId: '',
      projectPanelVisible: false,
      // 导入进行中：阻止项目列表刷新覆盖正在编辑的数据
      importing: false,
    }

    // 每条资产独立的生成进度
    const PROGRESS_STAGES = [
      [0, '排队中'],
      [8, '正在理解画面'],
      [26, '正在搭建构图'],
      [52, '正在细化光影'],
      [76, '正在完成渲染'],
      [92, '正在接收图像'],
      [97, '即将完成'],
    ]
    const progressTimers = new Map()

    // 画面比例由后端 /api/config 统一定义，此处仅作离线兜底
    let serverConfig = null

    const dom = {
      fileInput: document.querySelector('#file-input'),
      refFile: document.querySelector('#ref-file'),
      styleImport: document.querySelector('#style-import'),
      headerImport: document.querySelector('#header-import'),
      headerProjects: document.querySelector('#header-projects'),
      projectsBackdrop: document.querySelector('#projects-backdrop'),
      projectsDrawer: document.querySelector('#projects-drawer'),
      projectsClose: document.querySelector('#projects-close'),
      projectsList: document.querySelector('#projects-list'),
      projectsNew: document.querySelector('#projects-new'),
      projectsImport: document.querySelector('#projects-import'),
      dropzone: document.querySelector('#dropzone'),
      datasetBar: document.querySelector('#dataset-bar'),
      datasetName: document.querySelector('#dataset-name'),
      datasetMeta: document.querySelector('#dataset-meta'),
      panels: {
        import: document.querySelector('[data-panel="import"]'),
        role: document.querySelector('[data-panel="role"]'),
        scene: document.querySelector('[data-panel="scene"]'),
        prop: document.querySelector('[data-panel="prop"]'),
        style: document.querySelector('[data-panel="style"]'),
        free: document.querySelector('[data-panel="free"]'),
        face: document.querySelector('[data-panel="face"]'),
      },
      queuePanel: document.querySelector('#queue-panel'),
      queueTitle: document.querySelector('#queue-title'),
      queueDetail: document.querySelector('#queue-detail'),
      queueCount: document.querySelector('#queue-count'),
      queueProgress: document.querySelector('#queue-progress'),
      stopQueue: document.querySelector('#stop-queue'),
      modal: document.querySelector('#asset-modal'),
      modalKicker: document.querySelector('#modal-kicker'),
      modalTitle: document.querySelector('#modal-title'),
      modalFields: document.querySelector('#modal-fields'),
      modalPrompt: document.querySelector('#modal-prompt'),
      modalPromptCount: document.querySelector('#modal-prompt-count'),
      modalRatio: document.querySelector('#modal-ratio'),
      modalStyle: document.querySelector('#modal-style'),
      modalGenerate: document.querySelector('#modal-generate'),
      modalRevisePrompt: document.querySelector('#modal-revise-prompt'),
      modalResetPrompt: document.querySelector('#modal-reset-prompt'),
      modalResultThumb: document.querySelector('#modal-result-thumb'),
      modalResultText: document.querySelector('#modal-result-text'),
      modalHistory: document.querySelector('#modal-history'),
      modalHistoryHint: document.querySelector('#modal-history-hint'),
      modalHistoryGrid: document.querySelector('#modal-history-grid'),
      modalClose: document.querySelector('#modal-close'),
      reviseModal: document.querySelector('#revise-modal'),
      reviseCurrent: document.querySelector('#revise-current'),
      reviseInstruction: document.querySelector('#revise-instruction'),
      reviseUseRefs: document.querySelector('#revise-use-refs'),
      reviseUseRefsText: document.querySelector('#revise-use-refs-text'),
      reviseUseResult: document.querySelector('#revise-use-result'),
      reviseUseResultText: document.querySelector('#revise-use-result-text'),
      reviseThumbs: document.querySelector('#revise-thumbs'),
      reviseResultWrap: document.querySelector('#revise-result-wrap'),
      reviseResult: document.querySelector('#revise-result'),
      reviseResultCount: document.querySelector('#revise-result-count'),
      reviseStatus: document.querySelector('#revise-status'),
      reviseRun: document.querySelector('#revise-run'),
      reviseApply: document.querySelector('#revise-apply'),
      reviseClose: document.querySelector('#revise-close'),
      lightbox: document.querySelector('#lightbox'),
      lightboxImage: document.querySelector('#lightbox-image'),
      lightboxClose: document.querySelector('#lightbox-close'),
      toast: document.querySelector('#toast'),
      freeForm: document.querySelector('#free-form'),
      freePrompt: document.querySelector('#free-prompt'),
      freeCount: document.querySelector('#free-count'),
      freeRatio: document.querySelector('#free-ratio'),
      freeSubmit: document.querySelector('#free-submit'),
      freeStatus: document.querySelector('#free-status'),
      freeProgress: document.querySelector('#free-progress'),
      freeProgressLabel: document.querySelector('#free-progress-label'),
      freeProgressBar: document.querySelector('#free-progress-bar'),
      freeElapsed: document.querySelector('#free-elapsed'),
      freePreview: document.querySelector('#free-preview'),
      freeImage: document.querySelector('#free-image'),
      freeDownload: document.querySelector('#free-download'),
      freeMaximize: document.querySelector('#free-maximize'),
      freePromptMaximize: document.querySelector('#free-prompt-maximize'),
      freePromptOptimize: document.querySelector('#free-prompt-optimize'),
      freePromptRevise: document.querySelector('#free-prompt-revise'),
      freePromptCopy: document.querySelector('#free-prompt-copy'),
      freePromptShell: document.querySelector('#free-prompt-shell'),
      freeRefStack: document.querySelector('#free-ref-stack'),
      freeRefFile: document.querySelector('#free-ref-file'),
      freeRefBusy: document.querySelector('#free-ref-busy'),
      faceForm: document.querySelector('#face-form'),
      faceAge: document.querySelector('#face-age'),
      faceGender: document.querySelector('#face-gender'),
      faceTemperament: document.querySelector('#face-temperament'),
      faceIdentity: document.querySelector('#face-identity'),
      faceFraming: document.querySelector('#face-framing'),
      faceBackground: document.querySelector('#face-background'),
      faceStyle: document.querySelector('#face-style'),
      faceExtra: document.querySelector('#face-extra'),
      faceDesignRun: document.querySelector('#face-design-run'),
      faceStatus: document.querySelector('#face-status'),
      faceEmpty: document.querySelector('#face-empty'),
      faceOutput: document.querySelector('#face-output'),
      faceAnalysis: document.querySelector('#face-analysis'),
      facePrompt: document.querySelector('#face-prompt'),
      faceNegative: document.querySelector('#face-negative'),
      faceGenerate: document.querySelector('#face-generate'),
      faceCopyAll: document.querySelector('#face-copy-all'),
      faceGenStatus: document.querySelector('#face-gen-status'),
      facePreview: document.querySelector('#face-preview'),
      faceImage: document.querySelector('#face-image'),
      faceDownload: document.querySelector('#face-download'),
      faceOpen: document.querySelector('#face-open'),
    }

    let toastTimer = 0
    let saveTimer = 0
    let freeProgressTimer = 0
    let freeElapsedTimer = 0
    let freeStartedAt = 0
    let freeProgressValue = 0

    function restoreState() {
      try {
        const raw = localStorage.getItem(storageKey())
        if (!raw) {
          initializeStyles()
          return
        }
        const saved = JSON.parse(raw)
        if (!saved || !Array.isArray(saved.assets)) {
          initializeStyles()
          return
        }

        state.fileName = saved.fileName || ''
        state.importedAt = saved.importedAt || ''
        state.styles = normalizeStyles(saved.styles)
        state.defaultStyle = normalizeDefaultStyles(saved.defaultStyle, state.styles)
        state.assets = saved.assets.map(asset => normalizeAsset(asset))
        state.bulkParams = normalizeBulkParams(saved.bulkParams)
        // 恢复用户手动改过的并行数；没改过就跟随默认值（默认 5 会随版本调整）
        const savedConcurrency = Number(saved.concurrency)
        if (saved.concurrencyCustom === true && Number.isFinite(savedConcurrency) && savedConcurrency >= 1) {
          state.concurrency = Math.floor(savedConcurrency)
          state.concurrencyCustom = true
        }
        // 恢复自由创作的画面比例选择（配合服务端配置渲染后回填）
        if (typeof saved.freeRatio === 'string' && saved.freeRatio) {
          state.freeRatio = saved.freeRatio
        }
        // 恢复自由创作的提示词草稿与上次生成结果，刷新不清空
        if (typeof saved.freePrompt === 'string') {
          state.freePrompt = saved.freePrompt
        }
        // 参考图同样恢复：只认 path + url，坏的直接忽略；老快照里的单张也接进来
        const savedRefs = Array.isArray(saved.freeReferences)
          ? saved.freeReferences
          : (saved.freeReference ? [saved.freeReference] : [])
        state.freeReferences = savedRefs
          .filter(ref => ref && typeof ref.path === 'string' && ref.path)
          .slice(0, 6)
          .map(ref => ({
            path: ref.path,
            url: typeof ref.url === 'string' ? ref.url : '',
            name: typeof ref.name === 'string' ? ref.name : '',
          }))
        if (typeof saved.freeImageUrl === 'string') {
          state.freeImageUrl = saved.freeImageUrl
        }
        if (typeof saved.freeImageExtension === 'string') {
          state.freeImageExtension = saved.freeImageExtension
        }
        // 捏脸页：表单与上一次方案，刷新后保持
        if (saved.face && typeof saved.face === 'object') {
          for (const key of [
            'age', 'gender', 'temperament', 'identity', 'framing', 'background',
            'style', 'extra', 'analysis', 'prompt', 'negativePrompt', 'imageUrl',
          ]) {
            if (typeof saved.face[key] === 'string') state.face[key] = saved.face[key]
          }
        }
        // 分页页码按类型持久化：刷新后回到离开时的那一页。
        // 越界（资产变少、分组数变化）由 renderTable 的 clamp 兜底，不会出现空白页。
        if (saved.page && typeof saved.page === 'object') {
          for (const type of ['role', 'scene', 'prop']) {
            const value = Number(saved.page[type])
            if (Number.isFinite(value) && value >= 1) state.page[type] = Math.floor(value)
          }
        }
        // 自由创作/风格设定不依赖资产，刷新后停留在用户离开的页签；
        // 资产类页签在无资产时回落到导入页
        if (['free', 'style', 'face'].includes(saved.activeTab)) {
          state.activeTab = saved.activeTab
        } else {
          state.activeTab = state.assets.length ? (saved.activeTab && saved.activeTab !== 'import' ? saved.activeTab : 'role') : 'import'
        }
        if (!dom.panels[state.activeTab]) state.activeTab = 'import'
      } catch (error) {
        console.warn('无法恢复上次导入的数据', error)
        if (currentUserId) localStorage.removeItem(storageKey())
        initializeStyles()
      }
    }

    /**
     * 旧版快照（v1）只存了一份、不分账号。升级后不能直接继承——那正是
     * 「换账号看到上一个账号页面」的原因。这里只在**能证明归属**时迁移，
     * 两条证据任一条成立即可：
     *   1) 快照里的 activeProjectId 属于当前账号（查他人项目会 404）
     *   2) 快照里上次生成的图片出现在当前账号的生成记录里
     * 都证明不了就原样留着，绝不猜测。
     */
    async function adoptLegacySnapshotIfOwned() {
      try {
        if (!currentUserId) return
        if (localStorage.getItem(storageKey())) return

        const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
        if (!raw) return

        let saved
        try {
          saved = JSON.parse(raw)
        } catch {
          return
        }
        if (!saved || !Array.isArray(saved.assets)) return

        if (!(await legacySnapshotBelongsToMe(saved))) return

        localStorage.setItem(storageKey(), raw)
        localStorage.removeItem(LEGACY_STORAGE_KEY)
      } catch {
        // 读不到（404）或网络异常：旧键原样保留，不迁移
      }
    }

    /** 只比较路径部分：主机名/协议变化（换 IP 访问）不影响判断 */
    function toLocalPath(url) {
      try {
        return decodeURIComponent(new URL(url, location.origin).pathname)
      } catch {
        return ''
      }
    }

    async function legacySnapshotBelongsToMe(saved) {
      const projectId = typeof saved.activeProjectId === 'string' ? saved.activeProjectId : ''
      if (projectId) {
        try {
          await fetchProject(projectId)
          return true
        } catch {
          // 不是本账号的项目，继续看下一条证据
        }
      }

      const imageUrl = typeof saved.freeImageUrl === 'string' ? saved.freeImageUrl : ''
      if (imageUrl) {
        try {
          const result = await fetchHistory(120)
          const entries = Array.isArray(result?.entries) ? result.entries : []
          const target = toLocalPath(imageUrl)
          if (target && entries.some(entry => toLocalPath(entry.imageUrl || '') === target)) {
            return true
          }
        } catch {
          // 记录取不到就不认领
        }
      }

      return false
    }

    function initializeStyles() {
      state.styles = { role: [], scene: [], prop: [] }
      state.defaultStyle = { role: '', scene: '', prop: '' }
      for (const type of ['role', 'scene', 'prop']) {
        const preset = STYLE_DEFAULTS[type]
        state.styles[type] = [{ ...preset }]
        state.defaultStyle[type] = preset.id
      }
    }

    /** 恢复工具栏的批量比例/风格选择，兼容旧数据（没有这个字段时用空对象）。 */
    function normalizeBulkParams(saved) {
      const result = { role: {}, scene: {}, prop: {} }
      if (!saved || typeof saved !== 'object') return result
      for (const type of ['role', 'scene', 'prop']) {
        const item = saved[type]
        if (item && typeof item === 'object') {
          result[type] = {
            ratio: typeof item.ratio === 'string' ? item.ratio : '',
            styleId: typeof item.styleId === 'string' ? item.styleId : '',
          }
        }
      }
      return result
    }

    function normalizeStyles(saved) {
      const styles = { role: [], scene: [], prop: [] }
      for (const type of ['role', 'scene', 'prop']) {
        const list = Array.isArray(saved?.[type]) ? saved[type] : []
        styles[type] = list
          .filter(style => style && typeof style.id === 'string' && style.id)
          .map(style => ({
            id: style.id,
            name: String(style.name || '未命名风格'),
            description: String(style.description || ''),
            updatedAt: style.updatedAt || '',
          }))
        if (!styles[type].length) styles[type] = [{ ...STYLE_DEFAULTS[type] }]
      }
      return styles
    }

    function normalizeDefaultStyles(saved, styles) {
      const defaults = { role: '', scene: '', prop: '' }
      for (const type of ['role', 'scene', 'prop']) {
        const valid = styles[type].some(style => style.id === saved?.[type])
        defaults[type] = valid ? saved[type] : styles[type][0].id
      }
      return defaults
    }

    function normalizeAsset(asset) {
      const type = ['role', 'scene', 'prop'].includes(asset.type) ? asset.type : 'role'
      const normalized = {
        ...asset,
        type,
        fields: Array.isArray(asset.fields) ? asset.fields : [],
        ratio: asset.ratio || TYPE_META[type].defaultRatio,
        status: asset.status === 'done' || asset.status === 'error' ? asset.status : 'idle',
        styleId: '',
        // 角色面部参考图：存储目录里的相对路径（参考图/<文件名>）
        referencePath: typeof asset.referencePath === 'string' ? asset.referencePath : '',
        // 历史生成图（新→旧，最多 HISTORY_LIMIT 条）与主要图片
        history: (Array.isArray(asset.history) ? asset.history : [])
          .filter(item => item && typeof item.url === 'string' && item.url)
          .map(item => ({
            url: item.url,
            w: Number(item.w) > 0 ? Number(item.w) : 0,
            h: Number(item.h) > 0 ? Number(item.h) : 0,
            at: typeof item.at === 'string' ? item.at : '',
          }))
          .slice(0, HISTORY_LIMIT),
        primaryUrl: typeof asset.primaryUrl === 'string' ? asset.primaryUrl : '',
      }
      normalized.styleId = resolveAssetStyleId(normalized, asset.styleId)
      normalized.prompt = asset.prompt || buildPrompt(normalized)
      return normalized
    }

    function persistSoon() {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(persist, 250)
    }

    function persist() {
      // 身份还没确定时不写盘，避免把临时状态落到别人的 key 上
      if (!currentUserId) return
      try {
        const data = {
          // 记一份归属，方便排查「这份快照是谁的」
          ownerId: currentUserId,
          activeProjectId: state.activeProjectId,
          fileName: state.fileName,
          importedAt: state.importedAt,
          activeTab: state.activeTab,
          concurrency: state.concurrency,
          concurrencyCustom: state.concurrencyCustom,
          freeRatio: state.freeRatio,
          freePrompt: state.freePrompt,
          freeReferences: state.freeReferences.map(ref => ({ path: ref.path, url: ref.url, name: ref.name })),
          freeImageUrl: state.freeImageUrl,
          freeImageExtension: state.freeImageExtension,
          face: { ...state.face },
          page: { ...state.page },
          assets: state.assets,
          styles: state.styles,
          defaultStyle: state.defaultStyle,
          bulkParams: state.bulkParams,
        }
        localStorage.setItem(storageKey(), JSON.stringify(data))
      } catch (error) {
        console.warn('无法保存导入数据', error)
        showToast('浏览器存储空间不足，本次修改可能无法长期保存', true)
      }

      scheduleStyleSync()
      scheduleProjectSync()
    }

    // 风格库同步到后端：去抖后发送，避免频繁请求
    let styleSyncTimer = 0
    function scheduleStyleSync() {
      window.clearTimeout(styleSyncTimer)
      styleSyncTimer = window.setTimeout(persistStylesToServer, 600)
    }

    // 项目同步到后端：去抖后发送，避免每次勾选都打一次接口
    let projectSyncTimer = 0
    function scheduleProjectSync() {
      window.clearTimeout(projectSyncTimer)
      projectSyncTimer = window.setTimeout(() => saveCurrentProject(), 800)
    }

    function currentAssetType() {
      return ['role', 'scene', 'prop'].includes(state.activeTab) ? state.activeTab : ''
    }

    function countType(type) {
      return state.assets.filter(asset => asset.type === type).length
    }

    function findAsset(id) {
      return state.assets.find(asset => asset.id === id)
    }

    function showToast(message, isError = false, action = null) {
      window.clearTimeout(toastTimer)
      // textContent 赋值同时清掉上一次的按钮，旧回调随节点一起失效，不会残留
      dom.toast.textContent = message
      dom.toast.classList.toggle('error', isError)
      if (action) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'toast-action'
        button.textContent = action.label
        button.addEventListener('click', () => {
          dom.toast.classList.remove('visible')
          action.onClick()
        })
        dom.toast.append(button)
      }
      dom.toast.classList.add('visible')
      toastTimer = window.setTimeout(() => dom.toast.classList.remove('visible'), 3600)
    }

    /* ===== 项目 ===== */

    /** 把某个项目的数据载入当前编辑状态。 */
    function loadProjectIntoState(project) {
      state.fileName = project.fileName || ''
      state.importedAt = project.importedAt || ''
      state.assets = (project.assets || []).map(asset => normalizeAsset(asset))
      state.styles = normalizeStyles(project.styles)
      state.defaultStyle = normalizeDefaultStyles(project.defaultStyle, state.styles)
      state.bulkParams = normalizeBulkParams(project.bulkParams)
      // 自由创作/风格设定不依赖资产，载入项目时保留用户所在页签
      if (!['free', 'style', 'face'].includes(state.activeTab)) {
        state.activeTab = state.assets.length
          ? (state.activeTab && state.activeTab !== 'import' ? state.activeTab : 'role')
          : 'import'
      }
      // 这里只换数据，不碰分页/搜索/勾选/分组收起：
      // 刷新时也会走这条路径，重置它们就等于「一刷新就跳回第 1 页」。
      // 真正切换项目时由 resetViewState() 清空。
      state.activeProjectId = project.id
    }

    /** 切换到另一个项目（或新建）时才重置的视图状态。 */
    function resetViewState() {
      state.selected.clear()
      state.search = { role: '', scene: '', prop: '' }
      state.page = { role: 1, scene: 1, prop: 1 }
      state.collapsedGroups.clear()
    }

    /** 拉取项目列表并载入当前项目。 */
    async function loadProjects(force = false) {
      // 导入过程中不要覆盖正在编辑的数据
      if (state.importing) return
      try {
        const result = await fetchProjects()
        state.projects = Array.isArray(result?.projects) ? result.projects : []

        // 优先用后端记录的当前项目，本地 id 只作兜底
        const wantedId = state.activeProjectId || result?.activeProjectId || ''
        const active = state.projects.find(item => item.id === wantedId) || state.projects[0]
        if (active) {
          // 已经在这个项目里时保留当前编辑状态，避免覆盖未保存的改动
          if (force || active.id !== state.activeProjectId) {
            loadProjectIntoState(active)
          }
        } else {
          state.fileName = ''
          state.importedAt = ''
          state.assets = []
          // 无项目时尊重本地记住的页签：自由创作/风格设定不需要资产
          if (!['free', 'style', 'face'].includes(state.activeTab)) {
            state.activeTab = 'import'
          }
          state.activeProjectId = ''
        }
        renderAll()
      } catch (error) {
        console.warn('无法读取项目列表', error)
      }
    }

    /** 把当前编辑状态写回当前项目。 */
    async function saveCurrentProject(patch) {
      if (!state.activeProjectId) return
      try {
        const payload = {
          assets: state.assets,
          styles: state.styles,
          defaultStyle: state.defaultStyle,
          bulkParams: state.bulkParams,
          ...(patch || {}),
        }

        // 守卫：当前有资产但即将写入空数组时，多半是状态被旧快照覆盖了，不执行这次写入
        if (!payload.assets?.length && state.assets.length) {
          console.warn('跳过项目保存：检测到资产被意外清空')
          return
        }

        const result = await updateProject(state.activeProjectId, {
          ...payload,
        })
        const project = result?.project
        if (project) {
          const index = state.projects.findIndex(item => item.id === project.id)
          if (index >= 0) state.projects[index] = project
        }
      } catch (error) {
        console.warn('无法保存项目到后端', error)
      }
    }

    let projectsOverlayHandle = null

    function openProjectsDrawer() {
      state.projectPanelVisible = true
      renderProjectsList()
      dom.projectsBackdrop.hidden = false
      dom.projectsDrawer.hidden = false
      // ESC / 焦点陷阱 / 滚动锁交给 overlay 公共层，避免重复接线
      projectsOverlayHandle = activateOverlay(dom.projectsDrawer, {
        onRequestClose: closeProjectsDrawer,
      })
    }

    function closeProjectsDrawer() {
      projectsOverlayHandle?.release()
      projectsOverlayHandle = null
      state.projectPanelVisible = false
      dom.projectsBackdrop.hidden = true
      dom.projectsDrawer.hidden = true
    }

    function renderProjectsList() {
      if (!dom.projectsList) return

      if (!state.projects.length) {
        dom.projectsList.innerHTML = '<div class="drawer-empty">还没有项目。<br>导入一个资产 JSON，或新建空项目。</div>'
        return
      }

      dom.projectsList.innerHTML = state.projects
        .map(project => {
          const isActive = project.id === state.activeProjectId
          const assets = project.assets || []
          const roleCount = assets.filter(item => item.type === 'role').length
          const sceneCount = assets.filter(item => item.type === 'scene').length
          const propCount = assets.filter(item => item.type === 'prop').length
          const total = roleCount + sceneCount + propCount

          return [
            '<div class="project-card' + (isActive ? ' active' : '') + '" data-project-id="' + escapeAttr(project.id) + '">',
            '  <div class="project-card-head">',
            '    <p class="project-card-name" title="' + escapeAttr(project.name) + '">' + escapeHtml(project.name) + '</p>',
            isActive ? '    <span class="project-badge">当前</span>' : '',
            '  </div>',
            '  <div class="project-card-meta">' + (project.importedAt ? '导入于 ' + formatDateTime(project.importedAt) : '空项目') + '</div>',
            '  <div class="project-card-stats">',
            '    <span>角色 ' + roleCount + '</span>',
            '    <span>场景 ' + sceneCount + '</span>',
            '    <span>道具 ' + propCount + '</span>',
            '    <span>共 ' + total + '</span>',
            '  </div>',
            '  <div class="project-card-actions">',
            isActive ? '' : '    <button class="button ghost mini" data-project-action="switch">切换到此项目</button>',
            '    <button class="button danger mini" data-project-action="delete">删除项目</button>',
            '  </div>',
            '</div>',
          ].join('\n')
        })
        .join('\n')
    }

    async function handleProjectListClick(event) {
      const button = event.target.closest('[data-project-action]')
      if (!button) return

      const card = button.closest('[data-project-id]')
      const id = card?.dataset.projectId
      if (!id) return

      if (button.dataset.projectAction === 'switch') {
        await switchProject(id)
        return
      }

      if (button.dataset.projectAction === 'delete') {
        const project = state.projects.find(item => item.id === id)
        if (!project) return
        if (!window.confirm('删除项目「' + project.name + '」？\n项目内的资产与生成记录会一并删除，此操作无法撤销。')) return

        try {
          await deleteProject(id)
          state.projects = state.projects.filter(item => item.id !== id)
          if (state.activeProjectId === id) {
            state.activeProjectId = ''
            await loadProjects()
          }
          renderProjectsList()
          renderAll()
          showToast('已删除项目「' + project.name + '」')
        } catch (error) {
          showToast('删除失败：' + (error.message || '未知错误'), true)
        }
      }
    }

    async function switchProject(id) {
      // 先把当前项目的数据存回去，再切换
      await saveCurrentProject()
      await activateProject(id)

      // 从后端取该项目的最新数据，避免用到列表里的旧快照
      let project = state.projects.find(item => item.id === id)
      try {
        const result = await fetchProject(id)
        if (result?.project) {
          project = result.project
          const index = state.projects.findIndex(item => item.id === id)
          if (index >= 0) state.projects[index] = project
        }
      } catch (error) {
        console.warn('无法读取项目详情，使用列表数据', error)
      }
      if (!project) return

      resetViewState()
      loadProjectIntoState(project)
      renderAll()
      renderProjectsList()
      showToast('已切换到项目「' + project.name + '」')
    }

    async function handleNewProject() {
      const name = window.prompt('新项目名称', '新项目')
      if (name === null) return

      try {
        await saveCurrentProject()
        const created = await createProject({ name: name.trim() || '新项目' })
        const project = created?.project
        if (!project) throw new Error('创建失败')

        state.projects.push(project)
        // 新项目沿用当前项目的风格作为起点（先记下再载入，避免被空风格覆盖）
        const inheritedStyles = state.styles
        const inheritedDefaults = state.defaultStyle
        resetViewState()
        loadProjectIntoState(project)
        state.styles = inheritedStyles
        state.defaultStyle = inheritedDefaults
        await saveCurrentProject({
          styles: inheritedStyles,
          defaultStyle: inheritedDefaults,
        })

        closeProjectsDrawer()
        renderAll()
        showToast('已创建项目「' + project.name + '」')
      } catch (error) {
        showToast('创建失败：' + (error.message || '未知错误'), true)
      }
    }

    /* ===== 导入解析 ===== */

    function openFilePicker() {
      dom.fileInput.click()
    }

    async function importFile(file) {
      if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
        showToast('请选择 .json 资产文件', true)
        return
      }

      if (file.size > 8 * 1024 * 1024) {
        showToast('JSON 文件超过 8 MB，无法导入', true)
        return
      }

      state.importing = true
      try {
        const text = await file.text()
        const json = JSON.parse(text)
        const assets = normalizeAssets(json)
        if (!assets.length) {
          throw new Error('没有找到 role、scene 或 prop 资产')
        }

        // 每次导入都新建一个项目，互不影响
        const created = await createProject({ name: file.name.replace(/\.json$/i, ''), fileName: file.name })
        const project = created?.project
        if (!project) throw new Error('创建项目失败')

        state.fileName = file.name
        state.importedAt = new Date().toISOString()
        state.assets = assets
        state.styles = normalizeStyles(state.styles)
        state.defaultStyle = normalizeDefaultStyles(state.defaultStyle, state.styles)
        state.activeProjectId = project.id
        if (!state.projects.some(item => item.id === project.id)) {
          state.projects.push(project)
        }
        resetViewState()
        state.styleType = state.assets.find(asset => ['role', 'scene', 'prop'].includes(asset.type))?.type || 'role'
        state.activeTab = ['role', 'scene', 'prop'].find(type => countType(type) > 0) || 'import'
        // 先把资产写进新项目，再刷新列表（顺序不能反，否则列表会用空数据覆盖）
        await saveCurrentProject({
          name: project.name,
          fileName: file.name,
        })
        persist()
        // 用后端返回的项目数据刷新本地缓存，保持列表与磁盘一致
        const saved = state.projects.find(item => item.id === project.id)
        if (saved) {
          const index = state.projects.findIndex(item => item.id === project.id)
          if (index >= 0) state.projects[index] = saved
        }
        renderAll()
        showToast(`已创建项目「${project.name}」，导入 ${assets.length} 项资产，自动切换到 ${TYPE_META[state.activeTab]?.label || '资产页'}`)
      } catch (error) {
        console.error(error)
        showToast(`导入失败：${error.message || 'JSON 格式无效'}`, true)
      } finally {
        state.importing = false
      }
    }

    function normalizeAssets(json) {
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new Error('顶层必须是包含 role、scene、prop 的对象')
      }

      const assets = []
      for (const type of ['role', 'scene', 'prop']) {
        const source = json[type]
        if (!source || typeof source !== 'object') continue

        const entries = Array.isArray(source)
          ? source.map((value, index) => {
            const name = value?.name || value?.名称 || `${TYPE_META[type].singular}${index + 1}`
            return [name, value]
          })
          : Object.entries(source)

        entries.forEach(([name, raw], index) => {
          const fields = parseFields(raw, type, name)
          const id = `${type}-${index + 1}`
          const asset = {
            id,
            type,
            name: String(name || `${TYPE_META[type].singular}${index + 1}`),
            fields,
            raw: typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2),
            ratio: TYPE_META[type].defaultRatio,
            styleId: state.defaultStyle[type] || '',
            status: 'idle',
            resultUrl: '',
            width: 0,
            height: 0,
            error: '',
            updatedAt: '',
            referencePath: '',
            history: [],
            primaryUrl: '',
          }
          asset.prompt = buildPrompt(asset)
          assets.push(asset)
        })
      }
      return assets
    }

    function parseFields(raw, type, name) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return Object.entries(raw).map(([label, value]) => ({
          label,
          value: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
        }))
      }

      const text = String(raw ?? '')
      const fields = type === 'role' ? parseRoleFields(text) : parseDelimitedFields(text, type)
      if (!fields.length) {
        fields.push({ label: TYPE_META[type].nameLabels[0], value: name })
        if (text.trim()) fields.push({ label: '原始描述', value: text.trim() })
      }
      return fields
    }

    function parseRoleFields(text) {
      const fields = []
      const pattern = /【([^】\n]+)】\s*[：:]\s*([\s\S]*?)(?=\n?【[^】\n]+】\s*[：:]|$)/g
      let match
      while ((match = pattern.exec(text)) !== null) {
        const value = match[2].trim()
        if (value) fields.push({ label: match[1].trim(), value })
      }
      return fields
    }

    function parseDelimitedFields(text, type) {
      const fields = []
      const parts = text.split(/\s*[;；]\s*/).filter(Boolean)
      parts.forEach((part, index) => {
        const colon = part.search(/[：:]/)
        if (colon > 0) {
          const label = part.slice(0, colon).trim()
          const value = part.slice(colon + 1).trim()
          if (label && value) fields.push({ label, value })
          return
        }

        if (index === 0) {
          fields.push({
            label: type === 'scene' ? '场景名称' : '道具名称',
            value: part.trim(),
          })
          return
        }

        if (/^(室内|室外|半室内|半室外)$/u.test(part.trim())) {
          fields.push({ label: '环境', value: part.trim() })
        } else if (part.trim()) {
          fields.push({ label: '补充信息', value: part.trim() })
        }
      })
      return fields
    }

    /* ===== 提示词与风格 ===== */

    function buildPrompt(asset) {
      const meta = TYPE_META[asset.type]
      const visualFields = asset.fields.filter(field => !NON_VISUAL_FIELDS.has(field.label))
      const lines = [
        `${meta.label}设定图。`,
        `资产名称：${asset.name}`,
      ]

      for (const field of visualFields) {
        const line = `${field.label}：${field.value}`
        if (lines.join('\n').length + line.length > 3600) break
        lines.push(line)
      }

      if (asset.type === 'role') {
        const isGroup = asset.fields.some(field => field.label === '群像')
        lines.push(isGroup
          ? '画面要求：以角色群像为主体，完整呈现每位人物的面部、发型、发饰、身材比例与衣着材质；多人全身同框，人物之间保持清晰区分，不添加解释性文字、水印或界面元素。'
          : '画面要求：以角色为主体，完整呈现面部、发型、发饰、身材比例与衣着材质；单人全身，姿态自然，五官清晰，不添加解释性文字、水印或界面元素。')
      } else if (asset.type === 'scene') {
        lines.push('画面要求：以空间、陈设、材质与光线为主体，完整呈现该场景的空间结构和视觉特征；不添加解释性文字、水印或界面元素。')
      } else {
        lines.push('画面要求：以单一道具为主体，完整呈现外形、纹样、工艺、材质、色彩与使用痕迹；主体清晰，不添加解释性文字、水印或界面元素。')
      }
      return lines.join('\n')
    }

    function styleList(type) {
      return state.styles[type] || []
    }

    function findStyle(type, id) {
      return styleList(type).find(style => style.id === id)
    }

    function resolveAssetStyleId(asset, candidate) {
      const list = styleList(asset.type)
      if (list.some(style => style.id === candidate)) return candidate
      if (list.some(style => style.id === state.defaultStyle[asset.type])) return state.defaultStyle[asset.type]
      return list[0]?.id || ''
    }

    function selectedStyle(asset) {
      return findStyle(asset.type, resolveAssetStyleId(asset, asset.styleId)) || null
    }

    /** 有面部参考图时的提示词段落：图像条件之外再加一层文字约束 */
    function faceReferenceBlock(asset) {
      if (asset.type !== 'role' || !referenceForAsset(asset)) return ''
      return [
        '【面部参考图｜最高优先级】',
        '必须与随请求附带的面部参考图是同一个人：脸型、五官比例与形状、眼距、鼻型、唇形、肤色与年龄感保持一致。',
        '只按本条资产的状态改变发型、妆容、服装、伤痕、表情与光线；不要换脸、不要改变人物身份，也不要直接复用参考图的构图与姿势。',
      ].join('\n')
    }

    function composeGenerationPrompt(asset) {
      const style = selectedStyle(asset)
      const reference = faceReferenceBlock(asset)
      if (!style) {
        return [
          asset.prompt,
          reference,
          '【最终画面要求】\n本项必须严格遵循资产内容进行绘制，不要添加解释性文字、水印或界面元素。',
        ].filter(Boolean).join('\n\n')
      }
      return [
        '【风格指令｜最高优先级】',
        `本图唯一采用以下${TYPE_META[asset.type].singular}风格：${style.name}`,
        '风格描述优先级高于资产描述中与之冲突的视觉表达。以下所有画面都必须执行这套风格：',
        style.description,
        '',
        '【资产内容】',
        asset.prompt,
        reference ? `\n${reference}` : '',
      ].join('\n').trimEnd()
    }

    function assetPromptLength(asset) {
      return composeGenerationPrompt(asset).length
    }

    function styleOptions(type, selected) {
      const list = styleList(type)
      if (!list.length) return '<option value="">暂无风格</option>'
      const resolved = list.some(style => style.id === selected) ? selected : state.defaultStyle[type]
      return list.map(style => {
        const isDefault = style.id === state.defaultStyle[type]
        return `<option value="${escapeAttr(style.id)}" ${style.id === resolved ? 'selected' : ''}>${escapeHtml(style.name)}${isDefault ? ' · 默认' : ''}</option>`
      }).join('')
    }

    function handleStyleClick(styleAction) {
      const typeTab = styleAction.closest('[data-style-type]')
      if (typeTab) {
        savePendingStyleIfValid(true)
        state.styleType = typeTab.dataset.styleType
        state.styleEditingId = state.defaultStyle[state.styleType] || styleList(state.styleType)[0]?.id || ''
        state.styleDirty = false
        renderStylePage()
        return
      }

      const styleId = styleAction.dataset.styleId
      if (styleId && styleAction.dataset.styleAction === 'open') {
        savePendingStyleIfValid(true)
        state.styleEditingId = styleId
        state.styleDirty = false
        renderStylePage()
        return
      }

      handleStyleAction(styleAction.dataset.styleAction)
    }

    function handleStyleAction(action) {
      const type = state.styleType
      const list = styleList(type)

      // 「保存风格」按钮：立即保存当前编辑中的风格（校验失败会提示原因）
      if (action === 'save') {
        savePendingStyleIfValid(false)
        return
      }

      // 导出当前项目的三套风格为 JSON
      if (action === 'export') {
        exportStyles()
        return
      }

      // 导入 JSON：先落盘未保存的编辑，再打开文件选择
      if (action === 'import') {
        if (!savePendingStyleIfValid(true)) {
          showToast('当前风格有未填完整的字段，请先修正后再导入', true)
          return
        }
        if (!dom.styleImport) return
        dom.styleImport.value = ''
        dom.styleImport.click()
        return
      }

      if (action === 'create') {
        const style = {
          id: `style-${type}-${randomId()}`,
          name: `新建${TYPE_META[type].singular}风格`,
          description: '',
          updatedAt: '',
        }
        list.push(style)
        state.styleEditingId = style.id
        state.styleDirty = false
        persist()
        renderStylePage()
        document.querySelector('[data-style-field="name"]')?.focus()
        return
      }

      const style = findStyle(type, state.styleEditingId)
      if (!style) return

      if (action === 'delete') {
        if (list.length <= 1) {
          showToast('每种类型至少保留一个风格', true)
          return
        }
        if (!window.confirm(`删除风格「${style.name}」？使用它的资产会自动改用默认风格。`)) return
        state.styles[type] = list.filter(item => item.id !== style.id)
        if (state.defaultStyle[type] === style.id) {
          state.defaultStyle[type] = state.styles[type][0].id
        }
        state.assets.forEach(asset => {
          if (asset.type === type && resolveAssetStyleId(asset, asset.styleId) !== asset.styleId) {
            asset.styleId = resolveAssetStyleId(asset, '')
          }
        })
        state.styleEditingId = state.styles[type][0].id
        state.styleDirty = false
        persist()
        renderStylePage()
        refreshCurrentTable()
        showToast(`已删除风格「${style.name}」`)
        return
      }

      if (action === 'make-default') {
        state.defaultStyle[type] = style.id
        state.assets.forEach(asset => {
          if (asset.type === type) {
            asset.styleId = resolveAssetStyleId(asset, asset.styleId)
          }
        })
        persist()
        renderStylePage()
        refreshCurrentTable()
        showToast(`已将「${style.name}」设为${TYPE_META[type].singular}默认风格`)
      }
    }

    function savePendingStyleIfValid(silentWhenEmpty) {
      const type = state.styleType
      const style = findStyle(type, state.styleEditingId)
      if (!style) return false

      const nameField = document.querySelector('[data-style-field="name"]')
      const descriptionField = document.querySelector('[data-style-field="description"]')
      if (!nameField || !descriptionField) return false

      const name = nameField.value.trim()
      const description = descriptionField.value.trim()
      if (!name || !description) {
        if (!silentWhenEmpty) {
          showToast(!name ? '请填写风格名称' : '请填写风格描述，生成时会以描述为准', true)
        }
        return false
      }

      if (style.name === name && style.description === description) {
        state.styleDirty = false
        return true
      }

      style.name = name
      style.description = description
      style.updatedAt = new Date().toISOString()
      state.styleDirty = false
      persist()
      renderStylePage()
      refreshCurrentTable()
      showToast(`风格「${style.name}」已保存，生成时将以此描述为准`)
      return true
    }

    /** 导出当前项目的三套风格为 JSON 文件 */
    function exportStyles() {
      if (!savePendingStyleIfValid(true)) {
        showToast('当前风格有未填完整的字段，请先修正后再导出', true)
        return
      }

      const payload = buildStyleExport(state.styles, state.defaultStyle)
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `画境-风格库-${timestamp()}.json`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      showToast('已导出三套风格库')
    }

    /** 导入风格 JSON：按名称合并，同名覆盖描述并保留本地 id，不删除现有风格 */
    async function handleStyleImportFile(file) {
      if (!file) return
      if (file.size > 2 * 1024 * 1024) {
        showToast('风格文件不能超过 2 MB', true)
        return
      }

      try {
        const incoming = parseStyleFile(await file.text())
        const plan = planStyleImport(state.styles, state.defaultStyle, incoming)
        if (!plan.added && !plan.updated) {
          showToast('文件里的风格与当前完全一致，无需导入')
          return
        }
        if (!window.confirm(`将新增 ${plan.added} 个、覆盖 ${plan.updated} 个同名风格，导入后立即生效。继续吗？`)) {
          return
        }

        state.styles = plan.styles
        state.defaultStyle = plan.defaultStyle
        state.assets.forEach(asset => {
          asset.styleId = resolveAssetStyleId(asset, asset.styleId)
        })
        if (!findStyle(state.styleType, state.styleEditingId)) {
          state.styleEditingId = state.defaultStyle[state.styleType] || styleList(state.styleType)[0]?.id || ''
        }
        state.styleDirty = false
        persist()
        renderStylePage()
        refreshCurrentTable()
        showToast(`风格导入完成：新增 ${plan.added} 个，覆盖 ${plan.updated} 个`)
      } catch (error) {
        showToast(`导入失败：${error.message || '文件格式无效'}`, true)
      }
    }

    async function loadSharedStyles() {
      try {
        const library = await fetchStyleLibrary()
        if (!library?.styles) return

        const hasServerStyles = Object.values(library.styles || {}).some(list => Array.isArray(list) && list.length)
        if (!hasServerStyles) {
          // 服务端还没有这个账号的风格：把本地风格作为初始值写上去。
          // 本地快照已按账号隔离（storageKey 带 userId），所以这里只会播种
          // 当前账号自己的风格，不会再出现「B 继承 A 的风格」。
          await persistStylesToServer()
          return
        }

        // 当前项目已有自己的风格就以项目为准，全局库只作为新项目的初始模板
        const activeProject = state.projects.find(item => item.id === state.activeProjectId)
        const projectHasStyles = ['role', 'scene', 'prop'].some(type =>
          (activeProject?.styles?.[type] || []).length > 0)
        if (projectHasStyles) return

        state.styles = normalizeStyles(library.styles)
        state.defaultStyle = normalizeDefaultStyles(library.defaultStyle, state.styles)
        persist()
        renderStylePage()
        refreshCurrentTable()
      } catch (error) {
        console.warn('无法读取后端风格库，继续使用本地保存的风格', error)
      }
    }

    async function persistStylesToServer() {
      try {
        await saveStyleLibrary({ styles: state.styles, defaultStyle: state.defaultStyle })
      } catch (error) {
        console.warn('无法把风格库写入后端', error)
      }
    }

    /* ===== 渲染 ===== */

    function renderAll() {
      state.assets.forEach(asset => {
        if (!asset.prompt) asset.prompt = buildPrompt(asset)
      })
      renderTabs()
      renderDatasetBar()
      renderActivePanel()
      renderQueuePanel()
      refreshSelectionLabels()
      renderFreeResult()
      renderFaceResult()
    }

    function renderTabs() {
      document.querySelectorAll('[data-tab]').forEach(button => {
        const type = button.dataset.tab
        const active = type === state.activeTab
        button.classList.toggle('active', active)
        // 页签语义要跟着切：选中项进 Tab 序列，其余由方向键切换（WAI-ARIA tabs 模式）
        button.setAttribute('aria-selected', String(active))
        button.tabIndex = active ? 0 : -1
        if (type === 'role' || type === 'scene' || type === 'prop') {
          button.disabled = countType(type) === 0
        }
      })
      document.querySelectorAll('[data-count]').forEach(element => {
        const type = element.dataset.count
        element.textContent = String(type === 'all' ? state.assets.length : countType(type))
      })
    }

    function renderDatasetBar() {
      dom.datasetBar.hidden = !state.assets.length
      if (!state.assets.length) return
      const activeProject = state.projects.find(item => item.id === state.activeProjectId)
      dom.datasetName.textContent = activeProject?.name || state.fileName || '资产文件'
      dom.datasetMeta.textContent = state.importedAt
        ? `导入于 ${formatDateTime(state.importedAt)} · 项目数据保存在本地`
        : '项目数据保存在本地'
    }

    function renderActivePanel() {
      Object.entries(dom.panels).forEach(([name, panel]) => {
        panel.hidden = name !== state.activeTab
      })

      if (state.activeTab === 'role' || state.activeTab === 'scene' || state.activeTab === 'prop') {
        renderAssetPage(state.activeTab)
      } else if (state.activeTab === 'style') {
        renderStylePage()
      }
    }

    function switchTab(tab) {
      if (!['import', 'free', 'style', 'face'].includes(tab) && countType(tab) === 0) return
      state.activeTab = tab
      persistSoon()
      renderTabs()
      renderActivePanel()
    }

    function renderStylePage() {
      const panel = dom.panels.style
      const type = state.styleType
      const meta = TYPE_META[type]
      const list = styleList(type)

      if (!list.some(style => style.id === state.styleEditingId)) {
        state.styleEditingId = state.defaultStyle[type] || list[0]?.id || ''
      }

      const editing = findStyle(type, state.styleEditingId) || list[0]
      if (!editing) {
        panel.innerHTML = '<p class="empty-table">还没有风格</p>'
        return
      }

      panel.innerHTML = `
        <div class="workspace-head">
          <div>
            <h2>风格设定</h2>
            <p>角色、场景、道具三套风格互不干扰；生成时以所选风格的描述为准，优先级高于资产描述中的视觉表达。</p>
          </div>
          <div class="legend">
            <span class="badge">按类型独立</span>
            <span class="badge">描述即风格</span>
            <span class="badge">生成时自动套用</span>
          </div>
        </div>

        <div class="tabs style-type-tabs" aria-label="风格资产类型">
          ${['role', 'scene', 'prop'].map(styleType => `
            <button class="tab ${styleType === state.styleType ? 'active' : ''}" data-style-type="${styleType}" data-style-action="switch-type" type="button">
              ${TYPE_META[styleType].label} <span class="tab-count">${styleList(styleType).length}</span>
            </button>
          `).join('')}
        </div>

        <div class="style-layout">
          <aside class="style-library">
            <div class="style-library-head">
              <h3>${meta.label}风格库</h3>
              <div class="style-transfer">
                <button class="mini-button" data-style-action="export" type="button" title="把三套风格与默认项导出为 JSON 文件">导出 JSON</button>
                <button class="mini-button" data-style-action="import" type="button" title="从 JSON 文件合并风格（同名覆盖描述）">导入 JSON</button>
              </div>
            </div>
            <div class="style-list">
              ${list.map(style => `
                <button class="style-list-item ${style.id === editing.id ? 'active' : ''}" data-style-action="open" data-style-id="${escapeAttr(style.id)}" type="button">
                  <span class="style-list-copy">
                    <span class="style-list-name">${escapeHtml(style.name)}</span>
                    <span class="style-list-meta">${style.updatedAt ? '更新于 ' + formatDateTime(style.updatedAt) : '尚未修改'}</span>
                  </span>
                  ${style.id === state.defaultStyle[type] ? '<span class="style-default-tag">默认</span>' : ''}
                </button>
              `).join('')}
            </div>
            <button class="button primary style-create-button" data-style-action="create" type="button">＋ 新建${meta.singular}风格</button>
          </aside>

          <section class="style-editor">
            <div class="style-editor-head">
              <div>
                <h3>${escapeHtml(editing.name)}</h3>
                <p>这段描述会作为最高优先级风格指令，拼接在该类型资产生成提示词的最前面。</p>
              </div>
              ${editing.id === state.defaultStyle[type] ? '<span class="style-default-tag">本类型默认</span>' : ''}
            </div>

            <div class="style-form">
              <div>
                <label class="field-label" for="style-name">风格名称</label>
                <input class="input" id="style-name" data-style-field="name" value="${escapeAttr(editing.name)}" maxlength="40" placeholder="例如：电影写实·角色">
              </div>
              <div>
                <label class="field-label" for="style-description">风格描述（生成时以此为准）</label>
                <textarea class="textarea" id="style-description" data-style-field="description" maxlength="3000" placeholder="描述画风、线条、色彩、光影、材质、年代感等所有视觉规范……">${escapeHtml(editing.description)}</textarea>
              </div>

              <div class="style-form-footer">
                <button class="button primary" data-style-action="save" type="button">保存风格</button>
                ${editing.id === state.defaultStyle[type] ? '' : `<button class="button secondary" data-style-action="make-default" type="button">设为默认</button>`}
                <button class="button danger" data-style-action="delete" type="button">删除</button>
                <span class="style-usage">使用中的资产：${state.assets.filter(asset => resolveAssetStyleId(asset, asset.styleId) === editing.id).length} 项</span>
              </div>
            </div>
          </section>
        </div>
      `

      updateStyleFormState()
    }

    function updateStyleFormState() {
      const saveButton = document.querySelector('[data-style-action="save"]')
      if (!saveButton) return
      saveButton.textContent = state.styleDirty ? '保存风格（有未保存修改）' : '保存风格'
    }

    function renderAssetPage(type) {
      const meta = TYPE_META[type]
      const panel = dom.panels[type]
      panel.innerHTML = `
        <div class="workspace-head">
          <div>
            <h2>${meta.label}</h2>
            <p><span data-page-count="${type}"></span> 项资产 · 当前批量比例 ${state.bulkParams[type]?.ratio || meta.defaultRatio}，每行可单独调整</p>
          </div>
          <div class="legend">
            <span class="badge queued">排队中</span>
            <span class="badge generating">生成中</span>
            <span class="badge done">已完成</span>
            <span class="badge error">失败</span>
          </div>
        </div>

        <div class="toolbar">
          <div class="toolbar-row toolbar-row-main">
            <div class="search-wrap">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7"></circle>
                <path d="m20 20-4-4"></path>
              </svg>
              <input class="input" data-search="${type}" value="${escapeAttr(state.search[type])}" placeholder="搜索资产名称或字段内容" aria-label="搜索${meta.label}">
            </div>
            <div class="toolbar-group toolbar-selection" aria-label="选择资产">
              <button class="button secondary" data-action="select-page" type="button">全选本页</button>
              <button class="button secondary" data-action="select-type" type="button">全选本类型</button>
              <button class="button ghost" data-action="clear-selection" type="button">清除选择</button>
            </div>
          </div>
          <div class="toolbar-row toolbar-row-actions">
            <div class="toolbar-group toolbar-params" aria-label="批量生成参数">
              <label class="toolbar-field">
                <span>画幅</span>
                <select class="select" id="bulk-ratio-${type}" aria-label="批量画面比例">
                  ${ratioOptions(state.bulkParams[type]?.ratio || meta.defaultRatio, serverConfig?.ratios)}
                </select>
              </label>
              <label class="toolbar-field toolbar-field-style">
                <span>风格</span>
                <select class="select" id="bulk-style-${type}" aria-label="批量风格">
                  ${styleOptions(type, state.bulkParams[type]?.styleId || state.defaultStyle[type])}
                </select>
              </label>
              <button class="button secondary" data-action="apply-params" type="button">应用到所选 <span data-selected-inline="${type}"></span></button>
            </div>
            <div class="toolbar-group toolbar-generate" aria-label="生成与下载">
              <label class="toolbar-field toolbar-concurrency">
                <span>并行</span>
                ${concurrencySelect(type)}
              </label>
              <button class="button secondary" data-action="download-selected" type="button" data-download-selected>下载所选</button>
              <button class="button secondary" data-action="generate-type" type="button" data-generate-type>生成全部${meta.singular}</button>
              <button class="button primary" data-action="generate-selected" type="button" data-generate-selected>批量生成所选</button>
            </div>
          </div>
        </div>

        <div class="table-shell">
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th class="col-check"><input type="checkbox" data-page-check="${type}" aria-label="选择本页"></th>
                  <th class="col-name">资产</th>
                  ${type === 'role' ? '<th class="col-ref">面部参考</th>' : ''}
                  <th class="col-fields">JSON 字段</th>
                  <th class="col-style">风格</th>
                  <th class="col-prompt">提示词预览</th>
                  <th class="col-ratio">比例</th>
                  <th class="col-status">状态</th>
                  <th class="col-result">结果</th>
                  <th class="col-actions">操作</th>
                </tr>
              </thead>
              <tbody id="asset-table-${type}"></tbody>
            </table>
          </div>
          <div class="table-footer" id="asset-pagination-${type}"></div>
        </div>
      `

      const pageCheck = panel.querySelector(`[data-page-check="${type}"]`)
      pageCheck?.addEventListener('change', () => {
        if (pageCheck.checked) selectVisible(type)
        else {
          visibleAssets(type).forEach(asset => state.selected.delete(asset.id))
          renderTable(type)
          refreshSelectionLabels()
        }
      })

      renderTable(type)
    }

    function renderTable(type) {
      tableRenderSeq[type] = (tableRenderSeq[type] || 0) + 1
      const tbody = document.querySelector(`#asset-table-${type}`)
      const pagination = document.querySelector(`#asset-pagination-${type}`)
      if (!tbody || !pagination) return

      const all = filteredAssets(type)
      const pageList = paginateGroups(type)
      const pages = Math.max(1, pageList.length)
      state.page[type] = Math.min(Math.max(1, state.page[type]), pages)
      const pageGroups = pageList[state.page[type] - 1] || []
      const pageAssets = pageGroups.flatMap(group => group.assets)
      // 分组后每页组数不等，起始序号按前面各页的资产数累计
      const start = pageList
        .slice(0, state.page[type] - 1)
        .reduce((sum, groups) => sum + groups.reduce((count, group) => count + group.assets.length, 0), 0)

      document.querySelectorAll(`[data-page-count="${type}"]`).forEach(element => {
        element.textContent = String(countType(type))
      })

      if (!pageAssets.length) {
        tbody.innerHTML = `<tr><td class="empty-table" colspan="${type === 'role' ? 10 : 9}">${state.search[type] ? '没有匹配的资产' : '这一页暂无资产'}</td></tr>`
      } else {
        tbody.innerHTML = pageGroups.map(group => groupRows(type, group)).join('')
      }

      const pageCheck = document.querySelector(`[data-page-check="${type}"]`)
      if (pageCheck) {
        const allSelected = pageAssets.length > 0 && pageAssets.every(asset => state.selected.has(asset.id))
        pageCheck.checked = allSelected
        pageCheck.indeterminate = !allSelected && pageAssets.some(asset => state.selected.has(asset.id))
      }

      // 整组勾选框：全选 / 半选状态在渲染后补上
      const groupByKey = new Map(pageGroups.filter(group => group.grouped).map(group => [group.key, group]))
      tbody.querySelectorAll('[data-select-group]').forEach(input => {
        const group = groupByKey.get(input.dataset.selectGroup)
        if (!group) return
        const chosen = group.assets.filter(asset => state.selected.has(asset.id)).length
        input.checked = chosen === group.assets.length
        input.indeterminate = chosen > 0 && chosen < group.assets.length
      })

      pagination.innerHTML = `
        <span class="table-summary">显示 ${all.length ? start + 1 : 0}–${start + pageAssets.length}，共 ${all.length} 项${state.search[type] ? '（已筛选）' : ''}</span>
        <div class="pagination">
          <button class="icon-button" data-action="previous-page" type="button" ${state.page[type] <= 1 ? 'disabled' : ''} aria-label="上一页">←</button>
          <span class="page-label">第 ${state.page[type]} / ${pages} 页</span>
          <button class="icon-button" data-action="next-page" type="button" ${state.page[type] >= pages ? 'disabled' : ''} aria-label="下一页">→</button>
        </div>
      `

      refreshSelectionLabels()
    }

    /**
     * 按展示单位输出：分组角色先出父行，再出缩进的各状态子行；
     * 未分组的资产仍是一条普通行。
     */
    function groupRows(type, group) {
      if (!group.grouped) return assetRow(group.assets[0])
      const collapsed = state.collapsedGroups.has(group.key)
      const head = groupRow(type, group, collapsed)
      if (collapsed) return head
      return head + group.items.map(item => assetRow(item.asset, item.state, true, group.key)).join('')
    }

    /** 角色父行：角色名 + 状态标签，展开时下方缩进列出各状态。 */
    function groupRow(type, group, collapsed) {
      const total = group.assets.length
      const done = group.assets.filter(asset => asset.status === 'done').length
      const failed = group.assets.some(asset => asset.status === 'error')
      const busy = group.assets.some(asset => asset.status === 'generating' || asset.status === 'queued')
      const pill = statusPill(busy ? 'generating' : done === total ? 'done' : failed ? 'error' : 'idle')
      const percent = Math.round((done / total) * 100)
      const styleNames = [...new Set(group.assets.map(asset => selectedStyle(asset)?.name || '默认风格'))]
      const ratios = [...new Set(group.assets.map(asset => asset.ratio).filter(Boolean))]
      const stateChips = group.items
        .slice(0, 4)
        .map(item => `<span class="field-chip">${escapeHtml(item.state || item.asset.name)}</span>`)
        .join('')
      const more = group.items.length > 4 ? `<span class="field-chip">+${group.items.length - 4}</span>` : ''
      const keyAttr = escapeAttr(group.key)
      const isRole = type === 'role'
      const reference = isRole ? referenceForAsset(group.assets[0]) : ''
      const unitWord = isRole ? '状态' : '子场景'
      const summaryText = isRole
        ? `同一角色 · ${total} 种状态`
        : `同一场景 · ${total} 个子场景`

      return `
        <tr class="asset-group-row" data-group-row="${keyAttr}">
          <td class="col-check">
            <input type="checkbox" data-select-group="${keyAttr}" data-select-group-type="${type}" aria-label="选择 ${escapeAttr(group.character)} 的全部${unitWord}">
          </td>
          <td class="col-name">
            <div class="group-name">
              <button class="group-toggle" data-group-toggle="${keyAttr}" data-group-type="${type}" type="button" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? '展开' : '收起'} ${escapeAttr(group.character)} 的${unitWord}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
              </button>
              <span class="group-title" title="${escapeAttr(group.character)}">${escapeHtml(group.character)}</span>
            </div>
            <span class="asset-kind">${summaryText}</span>
          </td>
          ${isRole ? `<td class="col-ref">
            ${referenceCell({ character: group.character, path: reference, editable: true })}
          </td>` : ''}
          <td class="col-fields">
            <div class="field-chips">${stateChips}${more}</div>
            <span class="asset-kind">按${unitWord}分别生成</span>
          </td>
          <td class="col-style">
            <span class="group-value" title="${escapeAttr(styleNames.join('、'))}">${escapeHtml(styleNames.length > 1 ? '多种风格' : styleNames[0] || '')}</span>
            <span class="asset-kind">见各${unitWord}行</span>
          </td>
          <td class="col-prompt">
            <span class="group-hint">展开后可逐条查看提示词，可单独生成某一${unitWord}。</span>
          </td>
          <td class="col-ratio">
            <span class="group-value">${ratios.length > 1 ? '多种比例' : escapeHtml(ratios[0] || '')}</span>
          </td>
          <td class="col-status">
            <div class="cell-progress">
              ${pill}
              <div class="cell-progress-track">
                <div class="cell-progress-bar${done === total ? ' done' : ''}" style="width:${percent}%"></div>
              </div>
              <span class="cell-progress-text">已完成 ${done} / ${total}</span>
            </div>
          </td>
          <td class="col-result">
            <span class="group-value" title="生成结果请看各${unitWord}行">—</span>
          </td>
          <td class="col-actions">
            <div class="row-actions">
              <button class="mini-button" data-group-toggle="${keyAttr}" data-group-type="${type}" type="button">${collapsed ? '展开' : '收起'}</button>
            </div>
          </td>
        </tr>
      `
    }

    function assetRow(asset, stateLabel = '', isChild = false, groupKey = '') {
      const selected = state.selected.has(asset.id)
      const summary = fieldSummary(asset)
      const currentStyle = selectedStyle(asset)
      const groupAttr = isChild && groupKey ? ` data-group-child="${escapeAttr(groupKey)}"` : ''
      const chips = asset.fields
        .filter(field => !TYPE_META[asset.type].nameLabels.includes(field.label))
        .slice(0, 3)
        .map(field => `<span class="field-chip">${escapeHtml(field.label)}</span>`)
        .join('')

      return `
        <tr class="${[selected ? 'selected-row' : '', isChild ? 'asset-child-row' : ''].filter(Boolean).join(' ')}"${groupAttr} data-asset-row="${escapeAttr(asset.id)}">
          <td class="col-check">
            <input type="checkbox" data-select-id="${asset.id}" ${selected ? 'checked' : ''} aria-label="选择 ${escapeAttr(asset.name)}">
          </td>
          <td class="col-name">
            ${isChild && stateLabel ? `<span class="state-chip">${escapeHtml(stateLabel)}</span>` : ''}
            <button class="asset-name-button" data-row-action="open" data-id="${asset.id}" title="${escapeAttr(asset.name)}">${escapeHtml(asset.name)}</button>
            <span class="asset-kind">${TYPE_META[asset.type].singular} · ${asset.fields.length} 个字段</span>
          </td>
          ${asset.type === 'role' ? `<td class="col-ref">
            ${referenceCell({ character: characterOf(asset), path: referenceForAsset(asset), editable: !isChild })}
          </td>` : ''}
          <td class="col-fields">
            <div class="field-chips">${chips}</div>
            <span class="asset-kind">${escapeHtml(summary)}</span>
          </td>
          <td class="col-style">
            <select class="row-select style-select" data-row-style="${asset.id}" aria-label="${escapeAttr(asset.name)} 的风格">
              ${styleOptions(asset.type, asset.styleId)}
            </select>
            <span class="asset-kind" title="${escapeAttr(currentStyle?.description || '')}">${currentStyle?.id === state.defaultStyle[asset.type] ? '本类型默认' : '单独指定'}</span>
          </td>
          <td class="col-prompt">
            <span class="prompt-preview">${escapeHtml(composeGenerationPrompt(asset))}</span>
          </td>
          <td class="col-ratio">
            <select class="row-select" data-row-ratio="${asset.id}" aria-label="${escapeAttr(asset.name)} 的画面比例">
              ${ratioOptions(asset.ratio, serverConfig?.ratios)}
            </select>
          </td>
          <td class="col-status">${statusCell(asset)}</td>
          <td class="col-result">${resultCell(asset)}</td>
          <td class="col-actions">
            <div class="row-actions">
              <button class="mini-button primary" data-row-action="generate" data-id="${asset.id}" ${asset.status === 'generating' ? 'disabled' : ''}>生成</button>
              <button class="mini-button" data-row-action="open" data-id="${asset.id}">编辑</button>
            </div>
          </td>
        </tr>
      `
    }

    function resultCell(asset) {
      const url = primaryImageOf(asset)
      if (url) {
        return `<button class="result-thumb" data-row-action="preview" data-id="${asset.id}" title="查看 ${escapeAttr(asset.name)} 的主要图片"><img src="${escapeAttr(url)}" alt="${escapeAttr(asset.name)} 主要图片"></button>`
      }
      if (asset.status === 'error') return '<span class="asset-kind" title="' + escapeAttr(asset.error || '生成失败') + '">无结果</span>'
      return '<button class="result-thumb" type="button" disabled>暂无</button>'
    }

    function statusPill(status) {
      const safe = STATUS_TEXT[status] ? status : 'idle'
      return `<span class="status-pill ${safe}">${STATUS_TEXT[safe]}</span>`
    }

    /**
     * 状态单元格：状态标签 + 该条资产自己的进度条。
     * 排队中 / 生成中 / 失败 / 已完成 都有各自的展示方式。
     */
    function statusCell(asset) {
      const pill = statusPill(asset.status)

      if (asset.status === 'generating') {
        const percent = Math.round(asset.progress || 0)
        return `<div class="cell-progress" data-progress-cell="${escapeAttr(asset.id)}">
          ${pill}
          <div class="cell-progress-track">
            <div class="cell-progress-bar" style="width:${percent}%"></div>
          </div>
          <span class="cell-progress-text">${escapeHtml(asset.progressStage || '生成中')} ${percent}%</span>
        </div>`
      }

      if (asset.status === 'queued') {
        return `<div class="cell-progress queued" data-progress-cell="${escapeAttr(asset.id)}">
          ${pill}
          <div class="cell-progress-track">
            <div class="cell-progress-bar" style="width:0%"></div>
          </div>
          <span class="cell-progress-text">队列第 ${queuePositionOf(asset)} 位 · 等待中</span>
        </div>`
      }

      if (asset.status === 'error') {
        return `<div class="cell-progress failed">
          ${pill}
          <span class="cell-progress-text" title="${escapeAttr(asset.error || '生成失败')}">${escapeHtml(asset.error || '生成失败')}</span>
        </div>`
      }

      if (asset.status === 'done') {
        return `<div class="cell-progress">
          ${pill}
          <div class="cell-progress-track">
            <div class="cell-progress-bar done" style="width:100%"></div>
          </div>
          <span class="cell-progress-text">${asset.width && asset.height ? `${asset.width} × ${asset.height}` : '已完成'}</span>
        </div>`
      }

      return `<div class="cell-progress">${pill}</div>`
    }

    /**
     * 并行数选择：可选项由任务数决定——上限取 min(服务端上限, 本类型任务数)，
     * 服务端 0（不限制）时就是任务数本身；只有一个可选值时不渲染，保持逐张生成。
     */
    function concurrencySelect(type) {
      const tasks = Math.max(1, countType(type))
      const limit = imageConcurrencyLimit()
      const max = limit === 0 ? tasks : limit === null ? 1 : Math.min(limit, tasks)
      if (max <= 1) return ''
      const value = Math.min(Math.max(1, Math.floor(state.concurrency)), max)
      return `<select class="select concurrency-select" data-concurrency aria-label="并行生成数" title="同时生成的数量：调高更快，但上游可能限流或失败">
        ${Array.from({ length: max }, (_, index) => {
          const count = index + 1
          return `<option value="${count}" ${count === value ? 'selected' : ''}>并行 ${count}</option>`
        }).join('')}
      </select>`
    }

    function fieldSummary(asset) {
      const labels = TYPE_META[asset.type].summaryLabels
      const field = labels.map(label => asset.fields.find(item => item.label === label)).find(Boolean)
        || asset.fields[1]
        || asset.fields[0]
      return shorten(field?.value || asset.raw, 62)
    }

    /**
     * 角色、场景按同一主体分组（角色=同一人的不同状态，场景=同一场景的不同区域）；
     * 道具每条资产自成一组。
     * 组内只有一条时仍按普通行展示，不做多余缩进。
     */
    function buildAssetGroups(type) {
      const list = filteredAssets(type)
      if (type === 'prop') {
        return list.map(asset => ({
          key: asset.id,
          character: asset.name,
          assets: [asset],
          items: [{ asset, state: '' }],
          grouped: false,
        }))
      }

      // key 带类型前缀：角色「皇宫」和场景「皇宫」的收起状态互不影响
      return groupAssets(list).map(group => ({ ...group, key: `${type}:${group.key}` }))
    }

    /** 分页以组为单位切分，同一角色的状态不会被拆到两页。 */
    function paginateGroups(type) {
      const pages = []
      let current = []
      let count = 0

      buildAssetGroups(type).forEach(group => {
        if (current.length && count + group.assets.length > state.pageSize) {
          pages.push(current)
          current = []
          count = 0
        }
        current.push(group)
        count += group.assets.length
      })

      if (current.length) pages.push(current)
      return pages.length ? pages : [[]]
    }

    function filteredAssets(type) {
      const query = state.search[type].trim().toLowerCase()
      const assets = state.assets.filter(asset => asset.type === type)
      if (!query) return assets
      return assets.filter(asset => {
        const haystack = `${asset.name}\n${asset.raw}\n${asset.fields.map(field => `${field.label} ${field.value}`).join('\n')}`.toLowerCase()
        return haystack.includes(query)
      })
    }

    function visibleAssets(type) {
      const pageList = paginateGroups(type)
      const index = Math.min(Math.max(1, state.page[type]), Math.max(1, pageList.length))
      return (pageList[index - 1] || []).flatMap(group => group.assets)
    }

    function selectVisible(type) {
      visibleAssets(type).forEach(asset => state.selected.add(asset.id))
      renderTable(type)
      refreshSelectionLabels()
    }

    function selectType(type) {
      state.assets.filter(asset => asset.type === type).forEach(asset => state.selected.add(asset.id))
      renderTable(type)
      refreshSelectionLabels()
    }

    /**
     * 勾选状态跨类型共用（切换页签不丢），所以展示和批量动作都要按类型过滤：
     * 否则在场景页勾过的资产会让角色页的「所选」数字和标题上的资产数对不上。
     */
    function selectedIdsOf(type) {
      if (!type) return []
      const ids = []
      state.selected.forEach(id => {
        const asset = findAsset(id)
        if (asset && asset.type === type) ids.push(id)
      })
      return ids
    }

    function refreshSelectionLabels() {
      document.querySelectorAll('[data-panel]').forEach(panel => {
        const type = panel.dataset.panel
        if (!type || !TYPE_META[type]) return
        const selectedCount = selectedIdsOf(type).length
        panel.querySelectorAll('[data-generate-selected]').forEach(button => {
          button.disabled = selectedCount === 0 || state.processing
          button.textContent = selectedCount ? `批量生成所选 (${selectedCount})` : '批量生成所选'
        })
        panel.querySelectorAll('[data-generate-type]').forEach(button => {
          button.disabled = state.processing
        })
        panel.querySelectorAll('[data-download-selected]').forEach(button => {
          button.disabled = selectedCount === 0
          button.textContent = selectedCount ? `批量下载所选 (${selectedCount})` : '批量下载所选'
        })
        panel.querySelectorAll('[data-selected-inline]').forEach(label => {
          label.textContent = selectedCount ? `(${selectedCount})` : ''
        })
      })
    }

    function applyBulkParams(type) {
      if (!selectedIdsOf(type).length) {
        showToast('请先勾选资产', true)
        return
      }
      const ratio = document.querySelector(`#bulk-ratio-${type}`)?.value
      const styleId = document.querySelector(`#bulk-style-${type}`)?.value
      if (!ratio) return

      // 记住工具栏当前选择，刷新后仍然生效
      state.bulkParams[type] = { ...state.bulkParams[type], ratio, styleId: styleId || '' }

      let changed = 0
      state.assets.forEach(asset => {
        if (asset.type !== type || !state.selected.has(asset.id)) return
        asset.ratio = ratio
        if (styleId) asset.styleId = resolveAssetStyleId(asset, styleId)
        changed += 1
      })
      persistSoon()
      renderTable(type)
      showToast(`已为 ${changed} 项资产应用 ${ratio}${styleId ? ' 与所选风格' : ''}`)
    }

    /** 更新工具栏上方的「当前批量比例」说明。 */
    function refreshBulkSummary(type) {
      const panel = document.querySelector(`[data-panel="${type}"]`)
      if (!panel) return
      const summary = panel.querySelector('.workspace-head p')
      if (!summary) return
      const count = panel.querySelector('[data-page-count]')
      const ratio = state.bulkParams[type]?.ratio || TYPE_META[type].defaultRatio
      summary.textContent = `${count ? count.textContent : countType(type)} 项资产 · 当前批量比例 ${ratio}，每行可单独调整`
    }

    function generateWholeType(type) {
      const assets = state.assets.filter(asset => asset.type === type)
      if (!assets.length) return
      if (!window.confirm(`将按顺序生成 ${assets.length} 项${TYPE_META[type].singular}资产，确认开始吗？`)) return
      startBatch(assets.map(asset => asset.id), `生成全部${TYPE_META[type].singular}`)
    }

    function refreshCurrentTable() {
      const type = currentAssetType()
      if (type) renderTable(type)
    }

    /** 参考图在浏览器里的地址：项目里只存相对路径，主机名现拼 */
    function referenceUrl(path) {
      return `${API_BASE}/api/files/${path.split('/').map(encodeURIComponent).join('/')}`
    }

    /** 该资产所属角色（非角色资产返回空） */
    function characterOf(asset) {
      return asset.type === 'role' ? groupedAssetInfo(asset).group : ''
    }

    /**
     * 资产可用的面部参考图：优先自己的，其次同角色其它状态上的。
     * 这样后导入的新状态不需要重新设置就能继承角色的参考图。
     */
    function referenceForAsset(asset) {
      if (asset.referencePath) return asset.referencePath
      const character = characterOf(asset)
      if (!character) return ''
      const same = state.assets.find(item =>
        item.type === 'role' && item.referencePath && groupedAssetInfo(item).group === character)
      return same?.referencePath || ''
    }

    /** 给某个角色的全部状态写入 / 清除同一个参考图（不受当前搜索过滤影响） */
    function setCharacterReference(character, path) {
      state.assets.forEach(asset => {
        if (asset.type === 'role' && groupedAssetInfo(asset).group === character) {
          asset.referencePath = path
        }
      })
    }

    /**
     * 面部参考图单元格：
     * - 可编辑（角色父行 / 未分组角色行）：上传、替换、清除，点缩略图看大图；
     * - 子行只展示继承来的缩略图，避免误以为是单独设置。
     */
    function referenceCell({ character, path, editable }) {
      const target = escapeAttr(character)
      const url = path ? referenceUrl(path) : ''

      if (!path) {
        return editable
          ? `<button class="ref-empty" type="button" data-ref-action="upload" data-ref-character="${target}" title="上传「${escapeAttr(character)}」的面部参考图">＋ 上传</button>
             <span class="asset-kind">同一角色共用</span>`
          : '<span class="asset-kind">未设置</span>'
      }

      const thumb = `<button class="ref-thumb${editable ? '' : ' inherited'}" type="button" data-ref-action="preview" data-ref-url="${escapeAttr(url)}" data-ref-label="${escapeAttr(character)} 的面部参考图" title="查看参考图大图"><img src="${escapeAttr(url)}" alt="${escapeAttr(character)} 面部参考图"></button>`

      if (!editable) return `${thumb}<span class="asset-kind">随角色</span>`

      return `${thumb}
        <span class="ref-actions">
          <button class="ref-link" type="button" data-ref-action="upload" data-ref-character="${target}">替换</button>
          <button class="ref-link" type="button" data-ref-action="clear" data-ref-character="${target}">清除</button>
        </span>`
    }

    /** 打开文件选择框：记录目标角色，选完由 handleReferenceFile 接手 */
    function startReferenceUpload(character) {
      if (!character || state.refUploading) return
      state.refTarget = character
      if (!dom.refFile) return
      dom.refFile.value = ''
      dom.refFile.click()
    }

    /**
     * 上传选好的参考图：校验类型/大小 → data URL → 服务端保存 → 写回该角色全部状态。
     * 失败只提示，不改动原有参考图。
     */
    async function handleReferenceFile(file) {
      const character = state.refTarget
      state.refTarget = ''
      if (!file || !character) return

      if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
        showToast('参考图仅支持 PNG / JPEG / WebP', true)
        return
      }
      if (file.size > 8 * 1024 * 1024) {
        showToast('参考图不能超过 8 MB', true)
        return
      }

      state.refUploading = character
      showToast(`正在上传「${character}」的面部参考图…`)
      try {
        const dataUrl = await readFileAsDataUrl(file)
        const result = await uploadReferenceImage({ name: character, dataUrl })
        if (!result?.path) throw new Error('上传接口没有返回图片路径')
        setCharacterReference(character, result.path)
        persistSoon()
        showToast(`已设置「${character}」的面部参考图，之后生成的该角色状态都会参考它`)
      } catch (error) {
        showToast(`参考图上传失败：${error.message || '请稍后重试'}`, true)
      } finally {
        state.refUploading = ''
        renderTable('role')
      }
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('读取图片失败'))
        reader.readAsDataURL(file)
      })
    }

    function clearReference(character) {
      if (!character) return
      if (!window.confirm(`清除「${character}」的面部参考图？\n清除后该角色的各状态不再保证同一张脸。`)) return
      setCharacterReference(character, '')
      persistSoon()
      renderTable('role')
      showToast(`已清除「${character}」的面部参考图`)
    }

    /** 带 data-ratio-select 的下拉统一从这里渲染；free-ratio 保留用户上次的选择 */
    function renderRatioSelects() {
      document.querySelectorAll('[data-ratio-select]').forEach(select => {
        const current = select === dom.freeRatio ? state.freeRatio : select.value
        select.innerHTML = ratioOptions(current, serverConfig?.ratios)
      })
    }

    /* ===== 分组动画 ===== */

    const GROUP_EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'
    const GROUP_EASE_IN = 'ease-in'
    const GROUP_OPEN_DURATION = 220
    const GROUP_CLOSE_DURATION = 160
    const GROUP_CASCADE_DURATION = 190
    const GROUP_STAGGER = 18
    const GROUP_STAGGER_MAX = 6

    const tableRenderSeq = { role: 0, scene: 0, prop: 0 }

    function groupMotionAllowed() {
      if (typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') return false
      return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    }

    function groupRowNodes(tbody, key) {
      const rows = [...tbody.querySelectorAll('tr')]
      return {
        rows,
        children: rows.filter(row => row.dataset.groupChild === key),
        parent: rows.find(row => row.dataset.groupRow === key) || null,
      }
    }

    function groupTailRows(rows, children) {
      if (!children.length) return []
      return rows.slice(rows.indexOf(children[children.length - 1]) + 1)
    }

    function groupRowsHeight(rows) {
      return rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0)
    }

    function settleGroupAnimations(animations, onSettled) {
      Promise.all(animations.map(animation => animation.finished.catch(() => {}))).then(() => {
        animations.forEach(animation => animation.cancel())
        if (onSettled) onSettled()
      })
    }

    function clearGroupAnimations(rows) {
      rows.forEach(row => {
        if (typeof row.getAnimations !== 'function') return
        row.getAnimations().forEach(animation => animation.cancel())
      })
    }

    function toggleGroup(key, type) {
      if (!key) return
      const opening = state.collapsedGroups.has(key)
      const seq = tableRenderSeq[type]
      if (opening) state.collapsedGroups.delete(key)
      else state.collapsedGroups.add(key)
      if (!groupMotionAllowed()) {
        renderTable(type)
        return
      }
      if (opening) animateGroupOpen(type, key)
      else animateGroupClose(type, key, seq)
    }

    function animateGroupOpen(type, key) {
      renderTable(type)
      const tbody = document.querySelector(`#asset-table-${type}`)
      if (!tbody) return
      const { rows, children, parent } = groupRowNodes(tbody, key)
      if (!parent || !children.length) return
      const tail = groupTailRows(rows, children)
      const cascade = groupRowsHeight(children)
      const animations = children.map((row, index) => row.animate(
        [
          { opacity: 0, transform: 'translateY(-6px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        {
          duration: GROUP_OPEN_DURATION,
          easing: GROUP_EASE_OUT,
          delay: Math.min(index, GROUP_STAGGER_MAX - 1) * GROUP_STAGGER,
          fill: 'both',
        },
      ))
      if (cascade) {
        tail.forEach(row => {
          animations.push(row.animate(
            [
              { transform: `translateY(-${cascade}px)` },
              { transform: 'translateY(0)' },
            ],
            { duration: GROUP_OPEN_DURATION, easing: GROUP_EASE_OUT, fill: 'both' },
          ))
        })
      }
      settleGroupAnimations(animations)
    }

    function animateGroupClose(type, key, seq) {
      const tbody = document.querySelector(`#asset-table-${type}`)
      const nodes = tbody ? groupRowNodes(tbody, key) : null
      if (!nodes || !nodes.children.length) {
        if (seq === tableRenderSeq[type] && state.collapsedGroups.has(key)) renderTable(type)
        return
      }
      const { rows, children } = nodes
      const toggles = [...tbody.querySelectorAll('[data-group-toggle]')]
        .filter(button => button.dataset.groupToggle === key)
      toggles.forEach(button => button.setAttribute('aria-expanded', 'false'))
      children.forEach(row => {
        row.classList.add('is-group-leaving')
      })
      const tail = groupTailRows(rows, children)
      const cascade = groupRowsHeight(children)
      clearGroupAnimations([...children, ...tail])
      const animations = children.map(row => row.animate(
        [
          { opacity: 1, transform: 'translateY(0)' },
          { opacity: 0, transform: 'translateY(-4px)' },
        ],
        { duration: GROUP_CLOSE_DURATION, easing: GROUP_EASE_IN, fill: 'both' },
      ))
      if (cascade) {
        tail.forEach(row => {
          animations.push(row.animate(
            [
              { transform: 'translateY(0)' },
              { transform: `translateY(-${cascade}px)` },
            ],
            { duration: GROUP_CASCADE_DURATION, easing: GROUP_EASE_IN, fill: 'both' },
          ))
        })
      }
      settleGroupAnimations(animations, () => {
        if (seq !== tableRenderSeq[type]) return
        if (!state.collapsedGroups.has(key)) return
        renderTable(type)
      })
    }

    /* ===== 队列 ===== */

    async function startBatch(ids, label) {
      if (state.processing) {
        showToast('已有批量任务在运行，请等待完成或停止后续任务', true)
        return
      }

      // 没拿到服务端并行上限就先不开批：宁可让用户重试，也不凭感觉限流
      if (!(await ensureImageConcurrency())) return
      // 等配置的这段时间里可能已经有另一批开始了，别把队列清掉重来
      if (state.processing) return

      const unique = [...new Set(ids)]
        .map(findAsset)
        .filter(asset => asset && !state.queue.includes(asset.id))

      if (!unique.length) {
        showToast('没有可加入队列的资产')
        return
      }

      state.queue = unique.map(asset => asset.id)
      state.queueTotal = state.queue.length
      state.queueDone = 0
      state.batchLabel = label
      state.processing = true
      state.stopRequested = false
      unique.forEach(asset => {
        asset.status = 'queued'
        asset.error = ''
      })
      renderQueuePanel()
      refreshCurrentTable()
      refreshSelectionLabels()
      processQueue()
    }

    async function processQueue() {
      // 并行度：服务端给的是上限（0 = 不限制），本批不会超过任务数
      const workers = batchWorkerCount(state.queue.length)

      const runWorker = async () => {
        while (state.queue.length && !state.stopRequested) {
          const id = state.queue.shift()
          const asset = findAsset(id)
          if (!asset) continue

          asset.status = 'generating'
          asset.error = ''
          startAssetProgress(asset)
          renderQueuePanel()
          refreshCurrentTable()
          renderAssetModalState()

          try {
            const result = await generateImage({
              prompt: composeGenerationPrompt(asset),
              ratio: asset.ratio,
              category: TYPE_META[asset.type].singular,
              name: asset.name,
              source: 'batch',
              referencePath: referenceForAsset(asset) || undefined,
            })
            if (!result?.imageUrl) {
              throw new Error('接口没有返回图片地址')
            }

            const finishedAt = new Date().toISOString()
            pushAssetHistory(asset, {
              url: result.imageUrl,
              w: result.width || 0,
              h: result.height || 0,
              at: finishedAt,
            })
            asset.resultUrl = result.imageUrl
            asset.primaryUrl = result.imageUrl
            asset.width = result.width || 0
            asset.height = result.height || 0
            asset.status = 'done'
            asset.progress = 100
            asset.progressStage = '已完成'
            asset.updatedAt = finishedAt
            // 新图已经落库，记录面板下次打开要重新拉一次
            historyPanel.invalidate()
          } catch (error) {
            asset.status = 'error'
            asset.progress = 0
            asset.progressStage = '生成失败'
            asset.error = error.message || '生成失败'
            asset.updatedAt = new Date().toISOString()
          }

          stopAssetProgress(asset.id)
          state.queueDone += 1
          persistSoon()
          renderQueuePanel()
          refreshCurrentTable()
          renderAssetModalState()
          // 给界面一点时间刷新，避免同账号连续请求过密
          if (workers === 1) await sleep(250)
        }
      }

      await Promise.all(Array.from({ length: workers }, runWorker))

      if (state.stopRequested) {
        state.queue.forEach(id => {
          const asset = findAsset(id)
          if (asset && asset.status === 'queued') {
            asset.status = 'idle'
            asset.progress = 0
            asset.progressStage = ''
          }
        })
        state.queue = []
      }

      // 清理所有残留的进度定时器
      progressTimers.forEach(timer => window.clearInterval(timer))
      progressTimers.clear()

      state.processing = false
      state.stopRequested = false
      refreshSelectionLabels()
      renderQueuePanel()
      refreshCurrentTable()
      renderAssetModalState()
      persistSoon()

      if (state.queueDone > 0) {
        // 批次收尾再失效一次：最后几张的落库时间可能晚于中途那次刷新
        historyPanel.invalidate()
        showToast(`批量任务完成：${state.queueDone} / ${state.queueTotal}`)
      }
    }

    /* 并发上限取自 /api/config：0 表示不限制，正整数是硬上限。
       读不到时沿用本会话上一次成功读到的值；一次都没读到就交给开批前的拦截，
       不静默退回某个固定的“安全值”。 */
    const IMAGE_CONCURRENCY_CACHE_KEY = 'huajing.config.imageConcurrency'
    let sessionImageConcurrency = readImageConcurrencyCache()

    function readImageConcurrencyCache() {
      try {
        const raw = sessionStorage.getItem(IMAGE_CONCURRENCY_CACHE_KEY)
        if (raw === null || raw === '') return null
        const value = Number(raw)
        return Number.isInteger(value) && value >= 0 ? value : null
      } catch {
        return null
      }
    }

    function rememberImageConcurrency(value) {
      sessionImageConcurrency = value
      try {
        sessionStorage.setItem(IMAGE_CONCURRENCY_CACHE_KEY, String(value))
      } catch {
        // 隐私模式写不进去，本次会话仍用内存里的值
      }
    }

    /** 当前并行上限：0 = 不限制；null = 本次会话还没拿到过 */
    function imageConcurrencyLimit() {
      const raw = serverConfig?.imageConcurrency
      if (Number.isInteger(raw) && raw >= 0) return raw
      return sessionImageConcurrency
    }

    /** 本批实际并发：不限制时按任务数，正整数取 min(N, 任务数)，至少 1 */
    function batchWorkerCount(taskCount) {
      const tasks = Math.max(1, taskCount)
      const limit = imageConcurrencyLimit()
      const cap = limit === 0 ? tasks : Math.max(1, Math.min(limit ?? 1, tasks))
      const preferred = state.concurrencyCustom ? Math.max(1, Math.floor(state.concurrency)) : cap
      return Math.max(1, Math.min(cap, preferred))
    }

    /**
     * 开批前确认拿得到并行上限。
     * 有本会话缓存就直接用（拉配置失败时已经在 boot 里提示过），
     * 一次都没读到过就拦住这批任务并给一个重试入口。
     */
    async function ensureImageConcurrency() {
      if (imageConcurrencyLimit() !== null) return true
      try {
        const config = await fetchServerConfig()
        serverConfig = config
        const value = config?.imageConcurrency
        if (!Number.isInteger(value) || value < 0) throw new Error('配置里没有可用的并行上限')
        rememberImageConcurrency(value)
        renderActivePanel()
        renderRatioSelects()
        return true
      } catch {
        showToast('没读到服务端并行上限，暂时无法开始批量生成', true, {
          label: '重试',
          onClick: () => {
            ensureImageConcurrency().then(ok => {
              if (ok) showToast('已拿到并行上限，可以开始生成')
            })
          },
        })
        return false
      }
    }

    function stopQueue() {
      if (!state.processing) return
      state.stopRequested = true
      dom.stopQueue.disabled = true
      const running = state.assets.filter(asset => asset.status === 'generating').length
      showToast(running > 1
        ? `将在 ${running} 张在途图片完成后停止后续任务`
        : '将在当前图片完成后停止后续任务')
      renderQueuePanel()
    }

    function renderQueuePanel() {
      const visible = state.processing || state.queue.length > 0 || state.queueDone > 0
      dom.queuePanel.hidden = !visible
      if (!visible) return

      const actives = state.assets.filter(asset => asset.status === 'generating')
      const finished = state.queueDone
      const total = state.queueTotal
      const percent = total ? Math.round((finished / total) * 100) : 0
      const failures = state.assets.filter(asset => asset.updatedAt && asset.status === 'error').length

      dom.queueTitle.textContent = state.batchLabel || '批量任务'
      dom.queueDetail.textContent = state.processing
        ? actives.length
          ? `${actives.length > 1 ? `并行 ${actives.length} 张：` : '正在生成：'}${actives.slice(0, 3).map(asset => `${asset.name} ${Math.round(asset.progress || 0)}%`).join('、')}${actives.length > 3 ? '…' : ''}`
          : '准备下一项'
        : state.stopRequested
          ? `已停止 · ${finished} 项已处理`
          : `已完成 · ${finished} / ${total}${failures ? `，${failures} 项失败` : ''}`
      dom.queueCount.textContent = `${finished} / ${total}`
      dom.queueProgress.style.width = `${percent}%`
      dom.stopQueue.disabled = !state.processing || state.stopRequested
      dom.stopQueue.textContent = state.stopRequested ? '正在停止后续任务…' : '停止后续任务'
    }

    /**
     * 启动单条资产的进度条。
     * 上游生图没有进度回调，所以用分段推进模拟：进度越高代表越接近完成。
     */
    function startAssetProgress(asset) {
      stopAssetProgress(asset.id)
      asset.progress = 1
      asset.progressStage = '正在提交任务'
      asset.progressStartedAt = Date.now()

      const timer = window.setInterval(() => {
        const current = asset.progress || 0
        // 越接近完成推进越慢，模拟真实等待；末段留一点余量给传输与落盘
        const step = current < 30 ? 3.4 : current < 70 ? 1.9 : current < 90 ? 0.75 : 0.35
        const next = Math.min(99, current + step)
        asset.progress = next
        asset.progressStage = stageTextOf(next)

        if (next >= 99) {
          stopAssetProgress(asset.id)
        }
        updateProgressCells()
        renderQueuePanel()
        renderAssetModalState()
      }, 320)

      progressTimers.set(asset.id, timer)
    }

    /**
     * 只更新进度相关的 DOM，不重建整张表。
     * 重建表格会让进度条动画反复从头开始，手感很差。
     */
    function updateProgressCells() {
      document.querySelectorAll('[data-progress-cell]').forEach(cell => {
        const asset = findAsset(cell.dataset.progressCell)
        if (!asset) return

        const bar = cell.querySelector('.cell-progress-bar')
        const text = cell.querySelector('.cell-progress-text')
        const percent = Math.round(asset.progress || 0)

        if (bar && asset.status === 'generating') {
          bar.style.width = `${percent}%`
        }
        if (text && asset.status === 'generating') {
          text.textContent = `${asset.progressStage || '生成中'} ${percent}%`
        }
      })
    }

    function stopAssetProgress(assetId) {
      const timer = progressTimers.get(assetId)
      if (timer) {
        window.clearInterval(timer)
        progressTimers.delete(assetId)
      }
    }

    function stageTextOf(percent) {
      let text = PROGRESS_STAGES[0][1]
      for (const [threshold, label] of PROGRESS_STAGES) {
        if (percent >= threshold) text = label
      }
      return text
    }

    /** 该资产在队列中的位置（1 起），用来告诉用户还要等多久。 */
    function queuePositionOf(asset) {
      const index = state.queue.indexOf(asset.id)
      if (index < 0) return state.queue.length
      return index + 1
    }

    /* ===== 弹层与灯箱 ===== */

    let modalOverlayHandle = null
    let lightboxOverlayHandle = null

    function openAssetModal(id) {
      state.modalId = id
      const asset = findAsset(id)
      if (!asset) return
      dom.modalKicker.textContent = TYPE_META[asset.type].label
      dom.modalTitle.textContent = asset.name
      dom.modalFields.innerHTML = asset.fields.map(field => `
        <div class="detail-field ${NON_VISUAL_FIELDS.has(field.label) ? 'nonvisual' : ''}">
          <dt>${escapeHtml(field.label)}${NON_VISUAL_FIELDS.has(field.label) ? '（仅展示）' : ''}</dt>
          <dd>${escapeHtml(field.value)}</dd>
        </div>
      `).join('')
      dom.modalPrompt.value = asset.prompt
      dom.modalPromptCount.textContent = String(asset.prompt.length)
      dom.modalRatio.value = asset.ratio
      dom.modalStyle.innerHTML = styleOptions(asset.type, asset.styleId)
      dom.modalStyle.value = resolveAssetStyleId(asset, asset.styleId)
      dom.modal.classList.add('visible')
      // ESC / 焦点陷阱 / 滚动锁交给 overlay 公共层；已在打开状态时只刷新内容
      if (!modalOverlayHandle) {
        modalOverlayHandle = activateOverlay(dom.modal, {
          onRequestClose: closeAssetModal,
          initialFocus: dom.modalPrompt,
        })
      }
      renderAssetModalState()
      hydrateAssetHistory(asset).catch(error => console.warn('无法回填历史生成图', error))
    }

    function closeAssetModal() {
      modalOverlayHandle?.release()
      modalOverlayHandle = null
      dom.modal.classList.remove('visible')
      state.modalId = ''
    }

    function renderAssetModalState() {
      if (!dom.modal.classList.contains('visible')) return
      const asset = findAsset(state.modalId)
      if (!asset) return
      dom.modalRatio.value = asset.ratio
      if (dom.modalStyle.options.length) {
        dom.modalStyle.value = resolveAssetStyleId(asset, asset.styleId)
      }
      dom.modalGenerate.disabled = state.processing
      dom.modalGenerate.textContent = state.processing ? '队列运行中…' : '生成这张资产图'

      const primary = primaryImageOf(asset)
      const entry = primary ? primaryEntry(asset) : null

      if (primary) {
        dom.modalResultThumb.innerHTML = `<img src="${escapeAttr(primary)}" alt="${escapeAttr(asset.name)} 主要图片">`
        dom.modalResultText.innerHTML = `<strong>${statusPill(asset.status)} 主要图片</strong>${entry.w && entry.h ? `${entry.w} × ${entry.h} · ` : ''}${entry.at ? formatDateTime(entry.at) : ''}`
      } else if (asset.status === 'error') {
        dom.modalResultThumb.textContent = '失败'
        dom.modalResultText.innerHTML = `<strong><span class="status-pill error">失败</span></strong>${escapeHtml(asset.error || '生成失败')}`
      } else if (asset.status === 'generating' || asset.status === 'queued') {
        const percent = Math.round(asset.progress || 0)
        dom.modalResultThumb.textContent = '生成中'
        dom.modalResultText.innerHTML = `<div class="cell-progress">
          ${statusPill(asset.status)}
          <div class="cell-progress-track">
            <div class="cell-progress-bar" style="width:${percent}%"></div>
          </div>
          <span class="cell-progress-text">${escapeHtml(asset.progressStage || '生成中')} ${percent}%</span>
        </div>`
      } else {
        dom.modalResultThumb.textContent = '暂无图片'
        dom.modalResultText.innerHTML = `<strong>${statusPill(asset.status)}</strong>选择参数后点击生成，结果会与这条资产关联。`
      }

      renderModalHistory(asset)
    }

    /** 编辑弹窗底部的历史图网格 */
    function renderModalHistory(asset) {
      if (!dom.modalHistory || !dom.modalHistoryGrid) return
      const list = assetHistory(asset)
      const primary = primaryImageOf(asset)

      dom.modalHistory.hidden = list.length === 0
      if (!list.length) {
        dom.modalHistoryGrid.innerHTML = ''
        dom.modalHistoryHint.textContent = ''
        return
      }

      dom.modalHistoryHint.textContent = `共 ${list.length} 张 · 批量下载只会取选中的主图`
      dom.modalHistoryGrid.innerHTML = list.map(item => {
        const isPrimary = item.url === primary
        return `
          <div class="history-tile${isPrimary ? ' primary' : ''}">
            <button class="history-preview" type="button" data-history-action="preview" data-url="${escapeAttr(item.url)}" title="查看大图">
              <img src="${escapeAttr(item.url)}" alt="${escapeAttr(asset.name)} 历史生成图" loading="lazy">
            </button>
            <button class="history-pick" type="button" data-history-action="primary" data-url="${escapeAttr(item.url)}" ${isPrimary ? 'disabled' : ''}>${isPrimary ? '主要图片' : '设为主要'}</button>
            <span class="history-meta">${item.w && item.h ? `${item.w} × ${item.h}` : '尺寸未知'}${item.at ? ` · ${formatDateTime(item.at)}` : ''}</span>
          </div>
        `
      }).join('')
    }

    let lightboxSource = null
    let lightboxCloseTimer = 0

    /** 把目标矩形换算成「图片从那里长出来」的 transform */
    function lightboxOriginTransform(target) {
      const image = dom.lightboxImage
      const to = image.getBoundingClientRect()
      if (!target || !to.width || !to.height || !target.width) return ''
      const scale = Math.max(target.width / to.width, target.height / to.height)
      const dx = (target.left + target.width / 2) - (to.left + to.width / 2)
      const dy = (target.top + target.height / 2) - (to.top + to.height / 2)
      return `translate(${dx}px, ${dy}px) scale(${scale})`
    }

    /**
     * 大图预览。传 sourceEl 时做「从那张图长到全屏」的动画，
     * 关闭时再缩回它的位置；不传就是原来的直接显示（点击历史图、资产图等）。
     */
    async function openLightbox(url, label, sourceEl = null) {
      window.clearTimeout(lightboxCloseTimer)
      lightboxSource = sourceEl || null
      const image = dom.lightboxImage

      image.style.transition = 'none'
      image.style.transform = 'none'
      image.style.opacity = '1'
      image.src = url
      image.alt = `${label}大图`
      dom.lightbox.classList.remove('is-closing')
      dom.lightbox.classList.add('visible')

      if (!lightboxOverlayHandle) {
        lightboxOverlayHandle = activateOverlay(dom.lightbox, {
          onRequestClose: closeLightbox,
          initialFocus: dom.lightboxClose,
        })
      }

      if (!lightboxSource) return

      image.style.opacity = '0'
      try {
        await image.decode()
      } catch {}
      const from = lightboxSource.getBoundingClientRect()
      const start = lightboxOriginTransform(from)
      if (start) {
        image.style.transform = start
        image.getBoundingClientRect()
      }
      requestAnimationFrame(() => {
        image.style.transition = 'transform 340ms cubic-bezier(.22, 1.08, .32, 1), opacity 180ms ease'
        image.style.transform = 'translate(0, 0) scale(1)'
        image.style.opacity = '1'
      })
    }

    function closeLightbox() {
      lightboxOverlayHandle?.release()
      lightboxOverlayHandle = null
      window.clearTimeout(lightboxCloseTimer)

      const image = dom.lightboxImage
      const alive = lightboxSource && lightboxSource.isConnected
      if (!alive) {
        dom.lightbox.classList.remove('visible', 'is-closing')
        image.style.transition = 'none'
        image.style.transform = 'none'
        image.style.opacity = '1'
        image.src = ''
        lightboxSource = null
        return
      }

      const back = lightboxOriginTransform(lightboxSource.getBoundingClientRect())
      image.style.transition = 'transform 280ms cubic-bezier(.4, 0, .6, .35), opacity 200ms ease'
      image.style.transform = back || 'scale(.94)'
      image.style.opacity = '0'
      dom.lightbox.classList.add('is-closing')

      lightboxCloseTimer = window.setTimeout(() => {
        dom.lightbox.classList.remove('visible', 'is-closing')
        image.style.transition = 'none'
        image.style.transform = 'none'
        image.style.opacity = '1'
        image.src = ''
        lightboxSource = null
      }, 300)
    }

    let renameOverlayHandle = null

    function openRenameDialog() {
      if (!renameModal) return
      renameInput.value = (document.querySelector('#header-user')?.textContent || '').trim()
      renameMsg.textContent = ''
      renameInput.classList.remove('invalid')
      renameInput.removeAttribute('aria-invalid')
      renameModal.classList.add('visible')
      // ESC、焦点陷阱、滚动锁、关闭后的焦点归还全部交给 overlay，
      // 页面自己不再额外挂 keydown，免得一次 ESC 关两遍
      if (!renameOverlayHandle) {
        renameOverlayHandle = activateOverlay(renameModal, {
          onRequestClose: closeRenameDialog,
          initialFocus: renameInput,
        })
      }
      renameInput.focus()
      renameInput.select()
    }

    function closeRenameDialog() {
      renameOverlayHandle?.release()
      renameOverlayHandle = null
      renameModal?.classList.remove('visible')
    }

    /* ===== 下载与结果 ===== */

    /** 记录一次生成：新图排最前，按 URL 去重，超出上限丢最旧的 */
    function pushAssetHistory(asset, entry) {
      const next = assetHistory(asset).filter(item => item.url !== entry.url)
      asset.history = [entry, ...next].slice(0, HISTORY_LIMIT)
    }

    /**
     * 账号生成记录只拉一次（会话内缓存），用于回填功能上线前的历史图。
     * 失败时静默降级为「只显示本地记录」。
     */
    function loadHistoryEntries() {
      if (historyEntriesCache) return Promise.resolve(historyEntriesCache)
      if (!historyEntriesPromise) {
        historyEntriesPromise = fetchHistory(500)
          .then(result => {
            historyEntriesCache = Array.isArray(result?.entries) ? result.entries : []
            return historyEntriesCache
          })
          .catch(() => {
            historyEntriesCache = []
            return historyEntriesCache
          })
          .finally(() => { historyEntriesPromise = null })
      }
      return historyEntriesPromise
    }

    /** 把账号历史里同名同类、本地还没记录过的图片补进资产历史 */
    async function hydrateAssetHistory(asset) {
      const entries = await loadHistoryEntries()
      const category = TYPE_META[asset.type].singular
      const existing = new Set(assetHistory(asset).map(item => item.url))
      const added = entries
        .filter(entry => entry && entry.imageUrl && entry.name === asset.name && entry.category === category
          && !existing.has(entry.imageUrl))
        .map(entry => ({ url: entry.imageUrl, w: entry.width || 0, h: entry.height || 0, at: entry.createdAt || '' }))
      if (!added.length) return

      asset.history = [...assetHistory(asset), ...added]
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
        .slice(0, HISTORY_LIMIT)
      persistSoon()
      if (state.modalId === asset.id) renderAssetModalState()
      refreshCurrentTable()
    }

    function downloadImage(url, filename, options = {}) {
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.append(link)
      link.click()
      link.remove()
      if (!options.silent) showToast(`下载已开始：${filename}`)
    }

    /** 批量下载所选资产的主图（只下当前类型，没有图的跳过） */
    function downloadSelectedAssets(type) {
      const selected = selectedIdsOf(type).map(findAsset).filter(Boolean)
      const ready = selected
        .map(asset => ({ asset, url: primaryImageOf(asset) }))
        .filter(item => item.url)

      if (!ready.length) {
        showToast(selected.length ? '所选资产还没有生成图片' : '请先勾选资产', true)
        return
      }

      const missing = selected.length - ready.length
      if (!window.confirm(`将下载 ${ready.length} 张主要图片${missing ? `（另有 ${missing} 项还没有图片）` : ''}，继续吗？`)) {
        return
      }

      ready.forEach((item, index) => {
        window.setTimeout(() => {
          downloadImage(item.url, primaryFilename(item.asset), { silent: true })
        }, index * 300)
      })
      showToast(`开始下载 ${ready.length} 张主要图片，浏览器可能询问是否允许下载多个文件`)
    }

    /* ===== 自由创作 ===== */

    /** 提示词最大化编辑器：玻璃卡片，完成时写回输入框（与单张工作台同款） */
    function openFreePromptEditor() {
      let editor = document.querySelector('#free-prompt-editor')
      if (!editor) {
        editor = document.createElement('div')
        editor.id = 'free-prompt-editor'
        editor.className = 'prompt-editor'
        editor.innerHTML = `
          <div class="prompt-editor-card">
            <div class="prompt-editor-head">
              <span>编辑提示词</span>
              <button class="prompt-editor-close" type="button" aria-label="关闭编辑器">✕</button>
            </div>
            <textarea class="prompt-editor-text" id="free-prompt-editor-text"></textarea>
            <div class="prompt-editor-foot">
              <span class="prompt-editor-count"><span id="free-prompt-editor-count">0</span> 字</span>
              <button class="prompt-editor-done" id="free-prompt-editor-done" type="button">完成</button>
            </div>
          </div>
        `
        document.body.append(editor)

        const editorText = editor.querySelector('#free-prompt-editor-text')
        const editorCount = editor.querySelector('#free-prompt-editor-count')

        editorText.addEventListener('input', () => {
          editorCount.textContent = String(editorText.value.length)
        })

        const close = () => {
          dom.freePrompt.value = editorText.value
          state.freePrompt = editorText.value
          dom.freeCount.textContent = String(state.freePrompt.length)
          persistSoon()
          editor.classList.remove('visible')
          dom.freePrompt.focus()
        }

        editor.querySelector('.prompt-editor-close').addEventListener('click', close)
        editor.querySelector('#free-prompt-editor-done').addEventListener('click', close)
        editor.addEventListener('click', event => {
          if (event.target === editor) close()
        })
        document.addEventListener('keydown', event => {
          if (event.key === 'Escape' && editor.classList.contains('visible')) close()
        })
      }

      const editorText = editor.querySelector('#free-prompt-editor-text')
      editorText.value = dom.freePrompt.value
      editor.querySelector('#free-prompt-editor-count').textContent = String(editorText.value.length)
      editor.classList.add('visible')
      editorText.focus()
      editorText.setSelectionRange(editorText.value.length, editorText.value.length)
    }

    /** 只留最近一次优化前的文本：连续优化时撤销退回上一步，不堆栈 */
    let freePromptBeforeOptimize = ''
    /* 在途的参考图上传：优化前必须等它落地，否则会把这张图静默漏掉 */
    let freeRefUploadTask = null
    /* 上一次上传失败的原因：失败后不许直接优化，要先把图重新传上来 */
    let freeRefUploadFailed = ''
    /* 优化请求序号：用户中途改了文本/比例/参考图时，旧响应不能覆盖新状态 */
    let optimizeRequestSeq = 0

    /** 一次优化请求的输入签名：文本、比例、参考图路径（按显示顺序） */
    function freeOptimizeSignature(prompt) {
      return JSON.stringify({
        prompt,
        ratio: dom.freeRatio.value,
        references: state.freeReferences.map(ref => ref.path),
      })
    }

    /** 提示词写回输入框时要同时照顾字数与本地快照，避免刷新后回退 */
    function applyFreePrompt(value) {
      dom.freePrompt.value = value
      state.freePrompt = value
      dom.freeCount.textContent = String(value.length)
      persistSoon()
    }

    /** 优化结果里的约束保护说明：补回 > 保留 > 无 */
    function optimizeKeptNote(result) {
      const locked = Array.isArray(result?.lockedConstraints) ? result.lockedConstraints : []
      const restored = Array.isArray(result?.restoredConstraints) ? result.restoredConstraints : []
      if (restored.length) return `，已补回 ${restored.length} 条被丢掉的风格约束`
      if (locked.length) return `，已保留 ${locked.length} 条风格约束`
      return ''
    }

    /** 用对话模型把一句短描述扩写成完整生图提示词；失败时原样保留用户输入 */
    async function optimizeFreePrompt() {
      let current = dom.freePrompt.value.trim()
      if (!current) {
        showToast('先写一点画面描述，AI 才能帮你扩写')
        return
      }

      // 请求期间锁住按钮，避免连点发起多次付费请求
      dom.freePromptOptimize.disabled = true
      dom.freePromptOptimize.classList.add('is-busy')
      dom.freePromptOptimize.setAttribute('aria-busy', 'true')
      try {
        // 参考图还没传完就先等它：优化要带着这次上传的图一起送模型
        if (freeRefUploadTask) {
          await freeRefUploadTask.catch(() => {})
          current = dom.freePrompt.value.trim()
          if (!current) {
            showToast('先写一点画面描述，AI 才能帮你扩写')
            return
          }
        }
        if (freeRefUploadFailed) {
          const reason = freeRefUploadFailed
          freeRefUploadFailed = ''
          showToast(`参考图上传失败（${reason}），已取消本次优化，请重新上传`, true)
          return
        }

        const referencePaths = state.freeReferences.slice(0, FREE_REF_LIMIT).map(ref => ref.path)
        const signature = freeOptimizeSignature(current)
        const seq = ++optimizeRequestSeq
        const result = await optimizePrompt({
          prompt: current,
          ratio: dom.freeRatio.value,
          referenceCount: referencePaths.length,
          referencePaths,
        })
        const next = (result?.prompt || '').trim()
        if (!next) {
          showToast('提示词优化失败，请稍后重试', true)
          return
        }
        // 响应回来时内容已经变了：旧结果丢弃，不覆盖用户当前输入
        if (seq !== optimizeRequestSeq || freeOptimizeSignature(dom.freePrompt.value.trim()) !== signature) {
          showToast('内容已改动，这次优化结果已丢弃')
          return
        }
        freePromptBeforeOptimize = dom.freePrompt.value
        applyFreePrompt(next)
        // 让用户看见风格约束被保住了：补回条数优先于总数，说明这次确实差点丢
        const keptNote = optimizeKeptNote(result)
        showToast(
          (result?.mode === 'edit' ? '已按参考图改写，只改你指定的地方' : '提示词已优化') + keptNote,
          false,
          {
            label: '撤销',
            onClick: () => applyFreePrompt(freePromptBeforeOptimize),
          },
        )
      } catch (error) {
        showToast(error.message || '提示词优化失败，请稍后重试', true)
      } finally {
        dom.freePromptOptimize.disabled = false
        dom.freePromptOptimize.classList.remove('is-busy')
        dom.freePromptOptimize.removeAttribute('aria-busy')
      }
    }

    /* ===== 改写提示词 =====
       用户说一句「把夜景改成清晨」，模型输出整条新提示词。
       可以带上当前参考图和上一次生成的结果图，让改动接得上画面现状。 */
    let reviseOverlayHandle = null
    let reviseTarget = null
    let reviseBusy = false
    /* 请求代次：关闭弹窗或发起新一次改写都会 +1，迟到的响应据此丢弃 */
    let reviseSeq = 0
    /* 关闭时如果焦点回不到入口按钮（自由创作的按钮只在 hover 时露出），就落回提示词输入框 */
    let reviseFocusFallback = null
    /* 一次改写真送上游的图片上限，与服务端 MAX_REFERENCE_IMAGES 保持一致 */
    const REVISE_MAX_IMAGES = 6

    /** 把 /api/files/<类别>/<文件名> 还原成存储里的相对路径；老版单段 UUID 图没有类别，返回空 */
    function storagePathFromUrl(url) {
      if (!url || typeof url !== 'string') return ''
      try {
        const pathname = decodeURIComponent(new URL(url, location.origin).pathname)
        const prefix = '/api/files/'
        if (!pathname.startsWith(prefix)) return ''
        const relative = pathname.slice(prefix.length)
        return relative.includes('/') ? relative : ''
      } catch {
        return ''
      }
    }

    /** 打开改写弹窗：target = { prompt, ratio, references, resultUrl, apply } */
    function openReviseDialog(target) {
      const prompt = (target?.prompt || '').trim()
      if (!prompt) {
        showToast('先写一条提示词，才能改写')
        return
      }
      reviseTarget = target
      reviseFocusFallback = target.focusAfterClose || null

      dom.reviseCurrent.textContent = prompt
      dom.reviseInstruction.value = ''
      dom.reviseResult.value = ''
      dom.reviseResultCount.textContent = '0'
      dom.reviseResultWrap.hidden = true
      dom.reviseApply.hidden = true
      dom.reviseRun.textContent = '开始改写'
      dom.reviseRun.disabled = false
      dom.reviseRun.classList.remove('is-busy')
      dom.reviseRun.removeAttribute('aria-busy')
      dom.reviseStatus.textContent = '只改你点名的部分，其余保持原样'

      const refs = Array.isArray(target.references) ? target.references : []
      dom.reviseUseRefs.checked = refs.length > 0
      dom.reviseUseRefs.disabled = refs.length === 0
      dom.reviseUseRefsText.textContent = refs.length
        ? `参考当前 ${refs.length} 张参考图`
        : '没有可用的参考图'

      const resultPath = storagePathFromUrl(target.resultUrl)
      dom.reviseUseResult.checked = Boolean(resultPath)
      dom.reviseUseResult.disabled = !resultPath
      dom.reviseUseResultText.textContent = resultPath ? '参考当前已生成图片' : '还没有生成过图片'

      renderReviseThumbs()

      dom.reviseModal.classList.add('visible')
      if (!reviseOverlayHandle) {
        reviseOverlayHandle = activateOverlay(dom.reviseModal, {
          onRequestClose: closeReviseDialog,
          initialFocus: dom.reviseInstruction,
        })
      }
    }

    function closeReviseDialog() {
      // 关闭即作废在途请求：迟到的响应不能再写进下一次打开的弹窗
      reviseSeq += 1
      reviseBusy = false
      const fallback = reviseFocusFallback
      reviseFocusFallback = null

      reviseOverlayHandle?.release()
      reviseOverlayHandle = null
      dom.reviseModal.classList.remove('visible')
      reviseTarget = null

      // 自由创作的入口按钮藏在 hover 才出现的浮动层里，焦点归还不回去就落回输入框
      if (fallback && document.activeElement === document.body) {
        fallback.focus({ preventScroll: true })
      }
    }

    /**
     * 这次实际会送哪几张图：合计最多 6 张，勾了结果图就只带前 5 张参考图。
     * 服务端也是 6 张上限、参考图排在前面，客户端先把预算算好，别让结果图被静默丢掉。
     */
    function reviseImageSelection() {
      if (!reviseTarget) return { references: [], contextPath: '' }
      const refs =
        dom.reviseUseRefs.checked && !dom.reviseUseRefs.disabled
          ? reviseTarget.references || []
          : []
      const contextPath =
        dom.reviseUseResult.checked && !dom.reviseUseResult.disabled
          ? storagePathFromUrl(reviseTarget.resultUrl)
          : ''
      const refBudget = contextPath ? REVISE_MAX_IMAGES - 1 : REVISE_MAX_IMAGES
      return { references: refs.slice(0, refBudget), contextPath }
    }

    /** 勾选哪几张就预览哪几张——而且和实际送出去的张数一致，别多画也别少画 */
    function renderReviseThumbs() {
      if (!reviseTarget) return
      const { references, contextPath } = reviseImageSelection()
      const items = []
      for (const ref of references) {
        const url = ref.url || referenceUrl(ref.path)
        if (url) items.push({ url, label: '参考图' })
      }
      if (contextPath && reviseTarget.resultUrl) {
        items.push({ url: reviseTarget.resultUrl, label: '已生成' })
      }
      dom.reviseThumbs.hidden = items.length === 0
      dom.reviseThumbs.innerHTML = items
        .map(
          item => `<figure class="revise-thumb">
            <img src="${escapeAttr(item.url)}" alt="${escapeAttr(item.label)}" loading="lazy">
            <figcaption>${escapeHtml(item.label)}</figcaption>
          </figure>`,
        )
        .join('')
      // 参考图被预算截掉时写在勾选框文案里，别去覆盖结果状态
      const refTotal = (reviseTarget.references || []).length
      if (refTotal) {
        dom.reviseUseRefsText.textContent =
          refTotal > references.length
            ? `参考当前 ${refTotal} 张参考图（本次送前 ${references.length} 张）`
            : `参考当前 ${refTotal} 张参考图`
      }
    }

    async function runRevise() {
      if (reviseBusy || !reviseTarget) return
      const instruction = dom.reviseInstruction.value.trim()
      if (!instruction) {
        showToast('先说说你想怎么改')
        dom.reviseInstruction.focus()
        return
      }

      const { references, contextPath } = reviseImageSelection()
      const referencePaths = references.map(ref => ref.path)
      const contextPaths = contextPath ? [contextPath] : []
      const seq = ++reviseSeq
      const prompt = reviseTarget.prompt
      const ratio = reviseTarget.ratio

      reviseBusy = true
      dom.reviseRun.disabled = true
      dom.reviseRun.classList.add('is-busy')
      dom.reviseRun.setAttribute('aria-busy', 'true')
      dom.reviseStatus.textContent =
        referencePaths.length || contextPaths.length ? '正在看图并改写…' : '正在改写…'
      try {
        const result = await revisePrompt({
          prompt,
          instruction,
          ratio,
          referencePaths,
          contextPaths,
        })
        // 请求期间弹窗被关掉、或又发起了新一次改写：这次结果作废
        if (seq !== reviseSeq || !reviseTarget) return
        const next = (result?.prompt || '').trim()
        if (!next) throw new Error('模型没有返回改写结果')

        dom.reviseResult.value = next
        dom.reviseResultCount.textContent = String(next.length)
        dom.reviseResultWrap.hidden = false
        dom.reviseApply.hidden = false
        dom.reviseRun.textContent = '重新改写'
        const keptNote = optimizeKeptNote(result)
        dom.reviseStatus.textContent = result?.imageCount
          ? `已参考 ${result.imageCount} 张图片改写${keptNote}，确认后点「应用改写」`
          : `改写完成${keptNote}，确认后点「应用改写」`
        dom.reviseResultWrap.scrollIntoView({ block: 'nearest' })
      } catch (error) {
        if (seq !== reviseSeq) return
        dom.reviseStatus.textContent = error.message || '改写失败，请稍后重试'
        showToast(error.message || '改写失败，请稍后重试', true)
      } finally {
        // 只有最新一次请求能复位按钮，旧请求的 finally 不能把忙碌态清掉
        if (seq === reviseSeq) {
          reviseBusy = false
          dom.reviseRun.disabled = false
          dom.reviseRun.classList.remove('is-busy')
          dom.reviseRun.removeAttribute('aria-busy')
        }
      }
    }

    function applyRevise() {
      if (!reviseTarget) return
      const value = dom.reviseResult.value.trim()
      if (!value) return
      reviseTarget.apply(value)
      closeReviseDialog()
      showToast('提示词已改写')
    }

    /** 自由创作的入口：带当前提示词、画幅、参考图与最近一次的结果图 */
    function openReviseForFree() {
      openReviseDialog({
        prompt: dom.freePrompt.value,
        ratio: dom.freeRatio.value,
        references: state.freeReferences.slice(0, FREE_REF_LIMIT),
        resultUrl: state.freeImageUrl,
        apply: value => applyFreePrompt(value),
        // 浮动按钮只在 hover 时可见，焦点归不回去时落回输入框
        focusAfterClose: dom.freePrompt,
      })
    }

    /** 资产弹窗的入口：带资产自己的提示词、画幅、参考图与主图 */
    function openReviseForAsset() {
      const asset = findAsset(state.modalId)
      if (!asset) return
      openReviseDialog({
        prompt: dom.modalPrompt.value,
        ratio: asset.ratio,
        references: asset.referencePath
          ? [{ path: asset.referencePath, url: referenceUrl(asset.referencePath) }]
          : [],
        resultUrl: primaryImageOf(asset),
        focusAfterClose: dom.modalPrompt,
        apply: value => {
          // 走 input 事件，复用「编辑即保存到本地快照」的那条监听
          dom.modalPrompt.value = value
          dom.modalPrompt.dispatchEvent(new Event('input', { bubbles: true }))
        },
      })
    }

    /* ===== 捏脸页 =====
       一份角色设定 → 骨架 / 配比 / 五官主辅 → 素颜正脸定妆提示词。
       方案存进本地快照，刷新后表单与上次结果都还在。 */
    let faceBusy = false
    let faceGenBusy = false
    let faceGenSeq = 0

    /** 捏脸走的是同一条对话模型通道，没配置时按钮不可用 */
    function faceTextModelAvailable() {
      return Boolean(serverConfig?.promptOptimize?.textModel)
    }

    /** 把 state.face 回填到表单：首次进入与刷新恢复都走这里 */
    function hydrateFaceForm() {
      dom.faceAge.value = state.face.age
      dom.faceGender.value = state.face.gender
      dom.faceTemperament.value = state.face.temperament
      dom.faceIdentity.value = state.face.identity
      dom.faceFraming.value = state.face.framing
      dom.faceBackground.value = state.face.background
      dom.faceStyle.value = state.face.style
      dom.faceExtra.value = state.face.extra
    }

    function readFaceForm() {
      return {
        age: dom.faceAge.value.trim(),
        gender: dom.faceGender.value,
        temperament: dom.faceTemperament.value,
        identity: dom.faceIdentity.value.trim(),
        framing: dom.faceFraming.value,
        background: dom.faceBackground.value,
        style: dom.faceStyle.value,
        extra: dom.faceExtra.value.trim(),
      }
    }

    function persistFaceForm() {
      Object.assign(state.face, readFaceForm())
      persistSoon()
    }

    /** 三块结果与定妆照一起渲染；没有方案时回到空态 */
    function renderFaceResult() {
      const has = Boolean(state.face.prompt)
      dom.faceEmpty.hidden = has
      dom.faceOutput.hidden = !has
      dom.faceGenerate.disabled = !has || faceGenBusy
      if (!has) {
        dom.facePreview.hidden = true
        return
      }
      dom.faceAnalysis.textContent = state.face.analysis || '这次没有单独给出角色分析'
      dom.facePrompt.value = state.face.prompt
      dom.faceNegative.value = state.face.negativePrompt
      if (state.face.imageUrl) {
        dom.faceImage.src = state.face.imageUrl
        dom.facePreview.hidden = false
      } else {
        dom.facePreview.hidden = true
      }
    }

    async function runFaceDesign(event) {
      event?.preventDefault()
      if (faceBusy) return

      const fields = readFaceForm()
      Object.assign(state.face, fields)
      if (!fields.age && !fields.gender && !fields.temperament && !fields.identity) {
        showToast('先给一点角色设定：年龄、性别或气场都可以')
        return
      }

      faceBusy = true
      dom.faceDesignRun.disabled = true
      dom.faceDesignRun.setAttribute('aria-busy', 'true')
      // 方案在途时不允许按旧提示词去出图
      dom.faceGenerate.disabled = true
      dom.faceStatus.textContent = '正在拆骨架、定配比…'
      try {
        const result = await designFace(fields)
        const prompt = (result?.prompt || '').trim()
        if (!prompt) throw new Error('模型没有返回可用的提示词')

        state.face.analysis = (result.analysis || '').trim()
        state.face.prompt = prompt
        state.face.negativePrompt = (result.negativePrompt || '').trim()
        // 新方案先清掉旧图，避免文字换了、图还是上一版
        state.face.imageUrl = ''
        // 作废还在途中的出图：它拍的是上一版方案
        faceGenSeq += 1
        faceGenBusy = false
        dom.faceGenerate.textContent = '生成定妆照'
        dom.faceGenStatus.textContent = ''
        persistSoon()
        renderFaceResult()
        dom.faceStatus.textContent = '方案已生成；可以直接生成定妆照，也可以改设定再试'
      } catch (error) {
        dom.faceStatus.textContent = error.message || '生成失败，请稍后重试'
        showToast(error.message || '生成失败，请稍后重试', true)
      } finally {
        faceBusy = false
        // 配置没读到时不做判断，避免把按钮永久锁死
        dom.faceDesignRun.disabled = serverConfig !== null && !faceTextModelAvailable()
        dom.faceGenerate.disabled = faceGenBusy || !state.face.prompt
        dom.faceDesignRun.removeAttribute('aria-busy')
      }
    }

    /** 上游没有独立的负向字段，把负面词折进正向提示词 */
    function faceGenerationPrompt() {
      const prompt = state.face.prompt.trim()
      const negative = state.face.negativePrompt.trim()
      return negative ? `${prompt}\n\n不要出现：${negative}` : prompt
    }

    async function generateFaceImage() {
      if (faceGenBusy || !state.face.prompt) return
      faceGenBusy = true
      const seq = ++faceGenSeq
      dom.faceGenerate.disabled = true
      dom.faceGenerate.textContent = '生成中…'
      // 出图期间不让改方案，避免图与文字对不上
      dom.faceDesignRun.disabled = true
      dom.faceGenStatus.textContent = '正在生成定妆照…'
      try {
        const result = await generateImage({
          prompt: faceGenerationPrompt(),
          ratio: '3:4',
          category: '捏脸',
          name: `捏脸-${timestamp()}`,
          source: 'face',
          jobId: randomId(),
        })
        if (seq !== faceGenSeq) return
        if (!result?.imageUrl) throw new Error('接口没有返回图片地址')

        state.face.imageUrl = result.imageUrl
        persistSoon()
        renderFaceResult()
        // 生成记录面板若开着，让下一次打开能看到这张
        historyPanel.invalidate()
        dom.faceGenStatus.textContent = '定妆照已生成'
      } catch (error) {
        dom.faceGenStatus.textContent = error.message || '生成失败，请稍后重试'
        showToast(error.message || '生成失败，请稍后重试', true)
      } finally {
        if (seq === faceGenSeq) {
          faceGenBusy = false
          dom.faceGenerate.disabled = !state.face.prompt
          dom.faceGenerate.textContent = '生成定妆照'
          dom.faceDesignRun.disabled = serverConfig !== null && !faceTextModelAvailable()
        }
      }
    }

    /** 复制一段文本；navigator.clipboard 不可用时用临时 textarea 兜底，段落也能复制 */
    async function copyFaceText(text, successMessage) {
      if (!text) {
        showToast('这里还没有内容可复制')
        return
      }
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        const helper = document.createElement('textarea')
        helper.value = text
        helper.setAttribute('readonly', '')
        helper.style.position = 'fixed'
        helper.style.opacity = '0'
        document.body.appendChild(helper)
        helper.select()
        document.execCommand('copy')
        helper.remove()
      }
      showToast(successMessage)
    }

    /* ===== 断线恢复：刷新页面后接回仍在后台生成的图片 =====
       提交前先生成 jobId 存到本地；页面若被刷新，重新载入时凭 jobId
       轮询服务端任务状态，拿到结果后照常渲染。
       任务同样按账号隔离：换了账号不能去接上一个人的进度。 */
    function rememberPendingJob(jobId) {
      if (!currentUserId) return
      try {
        localStorage.setItem(
          pendingJobKey(),
          JSON.stringify({ jobId, userId: currentUserId, startedAt: Date.now() }),
        )
      } catch {}
    }

    function readPendingJob() {
      if (!currentUserId) return null
      try {
        const raw = localStorage.getItem(pendingJobKey())
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.jobId !== 'string') return null
        // 双保险：值里的归属与当前账号不一致就不认
        if (parsed.userId && parsed.userId !== currentUserId) return null
        return parsed
      } catch {
        return null
      }
    }

    function clearPendingJob() {
      if (!currentUserId) return
      try {
        localStorage.removeItem(pendingJobKey())
      } catch {}
    }

    /**
     * 旧版 pendingJob 也不分账号。为了不在换账号时接到别人的任务，
     * 这里同样只认「服务端确认归属」的：任务查询接口对非本人返回 404。
     */
    async function adoptLegacyPendingJobIfOwned() {
      if (!currentUserId || localStorage.getItem(pendingJobKey())) return
      try {
        const raw = localStorage.getItem(LEGACY_PENDING_JOB_KEY)
        if (!raw) return
        const saved = JSON.parse(raw)
        if (!saved || typeof saved.jobId !== 'string') return
        const startedAt = Number(saved.startedAt) || 0
        if (!startedAt || Date.now() - startedAt > 10 * 60 * 1000) return

        await fetchGenerationJob(saved.jobId) // 不是本人的任务会抛 404
        localStorage.setItem(
          pendingJobKey(),
          JSON.stringify({ jobId: saved.jobId, userId: currentUserId, startedAt }),
        )
        localStorage.removeItem(LEGACY_PENDING_JOB_KEY)
      } catch {
        // 不属于当前账号或任务已过期：旧键留着不动
      }
    }

    /** 判断本地是否还有未完成的生成任务，有就恢复进度并开始轮询 */
    function resumePendingJobIfAny() {
      const pending = readPendingJob()
      if (!pending) return
      if (Date.now() - (pending.startedAt || 0) > 10 * 60 * 1000) {
        clearPendingJob()
        return
      }

      // 回到自由创作页签，并把进度条设在「进行中」的样子
      if (state.activeTab !== 'free') {
        state.activeTab = 'free'
        renderTabs()
        renderActivePanel()
      }
      state.freeBusy = true
      dom.freePrompt.disabled = true
      dom.freeSubmit.disabled = true
      dom.freeSubmit.textContent = '正在生成…'
      dom.freeStatus.textContent = '检测到未完成的生成任务，正在接回…'
      freeProgressValue = Math.max(12, freeProgressValue)
      freeStartedAt = pending.startedAt || Date.now()
      dom.freeProgress.classList.add('visible')
      dom.freeProgressLabel.textContent = '后台仍在生成'
      setFreeProgress(Math.max(freeProgressValue, 20))
      startFreeProgress()

      pollPendingJob(pending.jobId, 0)
    }

    async function pollPendingJob(jobId, attempt) {
      window.clearTimeout(resumeTimer)
      try {
        const response = await fetch(`/api/images/jobs/${encodeURIComponent(jobId)}`, {
          credentials: 'include',
        })
        const data = await response.json().catch(() => ({}))

        if (response.status === 404) {
          // 任务过期或服务重启：清掉标记，避免一直转圈
          clearPendingJob()
          finishResume()
          dom.freeStatus.textContent = '上次的生成任务已失效（可能服务重启过），请重新生成'
          return
        }
        if (!response.ok) throw new Error(data.error || '查询生成状态失败')

        if (data.status === 'running') {
          dom.freeStatus.textContent = '后台仍在生成，完成后会自动显示'
          // 进度条随已用时长缓慢推进，最多 94%
          const elapsedSec = Math.max(0, (data.elapsedMs || 0) / 1000)
          const guess = Math.min(94, 20 + elapsedSec * 1.2)
          if (guess > freeProgressValue) setFreeProgress(guess)
          resumeTimer = window.setTimeout(() => pollPendingJob(jobId, attempt + 1), 1800)
          return
        }

        if (data.status === 'done' && data.result) {
          clearPendingJob()
          stopFreeProgress()
          dom.freeProgressLabel.textContent = '图像已生成'
          setFreeProgress(100)
          state.freeImageUrl = data.result.imageUrl
          state.freeImageExtension = getImageExtension(data.result.imageUrl)
          persistSoon()
          dom.freeImage.src = `${data.result.imageUrl}?t=${Date.now()}`
          dom.freePreview.classList.add('has-image')
          dom.freeDownload.disabled = false
          dom.freeMaximize.disabled = false
          dom.freeStatus.textContent = `已接回刷新前的生成结果 · ${data.result.width} × ${data.result.height}`
          finishResume()
          showToast('刷新前的生成已完成，结果已恢复')
          return
        }

        // 失败
        clearPendingJob()
        stopFreeProgress()
        dom.freeProgressLabel.textContent = '生成中断'
        dom.freeStatus.textContent = data.error?.message || '生成失败，请重新尝试'
        finishResume()
      } catch (error) {
        if (attempt < 20) {
          resumeTimer = window.setTimeout(() => pollPendingJob(jobId, attempt + 1), 2500)
          return
        }
        clearPendingJob()
        finishResume()
        dom.freeStatus.textContent = '无法查询生成状态，请重新生成'
      }
    }

    function finishResume() {
      window.clearTimeout(resumeTimer)
      state.freeBusy = false
      dom.freePrompt.disabled = false
      dom.freeSubmit.disabled = false
      dom.freeSubmit.textContent = '生成图像'
    }

    /* ===== 自由创作的参考图：可多张，粘贴 / 拖入追加，不占按钮位 ===== */

    const FREE_REF_LIMIT = 6
    /** 依次倾斜，避免排开时角度一样显得死板 */
    const FREE_REF_TILTS = ['-7deg', '4deg', '-3deg', '6deg', '-4deg', '3deg']

    function freeReferenceUrl(ref) {
      if (!ref || !ref.path) return ''
      return ref.url || referenceUrl(ref.path)
    }

    /** 渲染参考图条：每张一个可点、可删、可抬起的卡片 */
    function renderFreeReferences() {
      const stack = dom.freeRefStack
      if (!stack) return
      const refs = state.freeReferences
      const hasRef = refs.length > 0

      if (dom.freeForm) dom.freeForm.classList.toggle('has-ref', hasRef)
      stack.hidden = !hasRef
      if (dom.freeRefBusy) dom.freeRefBusy.hidden = !state.freeRefUploading

      // 有参考图时优化会先调一次视觉模型看图，按钮提示要提前说明，免得以为卡住
      if (dom.freePromptOptimize) {
        const optimizeLabel = hasRef ? 'AI 优化（会先分析参考图）' : 'AI 优化提示词'
        dom.freePromptOptimize.title = optimizeLabel
        dom.freePromptOptimize.setAttribute('aria-label', optimizeLabel)
      }

      stack.innerHTML = refs
        .map((ref, index) => {
          const tilt = FREE_REF_TILTS[index % FREE_REF_TILTS.length]
          const url = freeReferenceUrl(ref)
          const label = escapeAttr(ref.name || `参考图 ${index + 1}`)
          return `<div class="free-ref" style="--tilt:${tilt}" data-ref-index="${index}">
            <div class="free-ref-corner" aria-hidden="true"></div>
            <div class="free-ref-frame"><img src="${escapeAttr(url)}" alt="${label}" loading="lazy"></div>
            <button class="free-ref-delete" type="button" data-ref-delete="${index}" aria-label="删除参考图 ${index + 1}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>`
        })
        .join('')

      // 生成中不能让删图把状态改乱
      const busy = state.freeBusy || state.processing || state.freeRefUploading
      stack.querySelectorAll('.free-ref-delete').forEach(button => {
        button.disabled = busy
      })
    }

    /** 校验 → 交给 runFreeReferenceUpload；在途的那一次记在 freeRefUploadTask 上 */
    async function attachFreeReference(file) {
      if (!file) return
      if (state.freeBusy) {
        showToast('正在生成中，稍后再加参考图', true)
        return
      }
      if (state.freeReferences.length >= FREE_REF_LIMIT) {
        showToast(`参考图最多 ${FREE_REF_LIMIT} 张`, true)
        return
      }
      if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
        showToast('参考图仅支持 PNG / JPEG / WebP', true)
        return
      }
      if (file.size > 8 * 1024 * 1024) {
        showToast('单张参考图不能超过 8 MB', true)
        return
      }
      if (state.freeRefUploading) return

      freeRefUploadFailed = ''
      const task = runFreeReferenceUpload(file)
      freeRefUploadTask = task
      try {
        await task
      } finally {
        if (freeRefUploadTask === task) freeRefUploadTask = null
      }
    }

    /** 真正的上传流程：失败时记下原因，优化据此拒绝发起 */
    async function runFreeReferenceUpload(file) {
      state.freeRefUploading = true
      renderFreeReferences()
      try {
        const dataUrl = await readFileAsDataUrl(file)
        const result = await uploadReferenceImage({ name: '自由创作', dataUrl })
        if (!result?.path) throw new Error('上传接口没有返回图片路径')
        state.freeReferences.push({
          path: result.path,
          url: result.url || '',
          name: file.name || `参考图 ${state.freeReferences.length + 1}`,
        })
        persistSoon()
        showToast(`参考图已添加（${state.freeReferences.length} 张）`)
        return true
      } catch (error) {
        freeRefUploadFailed = error.message || '参考图上传失败'
        showToast(freeRefUploadFailed, true)
        return false
      } finally {
        state.freeRefUploading = false
        renderFreeReferences()
      }
    }

    function removeFreeReference(index) {
      if (state.freeBusy) return
      if (!Number.isInteger(index) || !state.freeReferences[index]) return
      // 用户已经改了参考图集合，上一次上传失败不再挡后续优化
      freeRefUploadFailed = ''
      state.freeReferences.splice(index, 1)
      persistSoon()
      renderFreeReferences()
      showToast('参考图已移除')
    }

    /** 粘贴 / 拖入里挑第一张图片 */
    function imageFileFromEvent(event) {
      const items = event.clipboardData?.items || event.dataTransfer?.items
      if (items && items.length) {
        for (const item of items) {
          if (item.kind === 'file' && /^image\//i.test(item.type || '')) {
            const file = item.getAsFile ? item.getAsFile() : null
            if (file) return file
          }
        }
      }
      const files = event.clipboardData?.files || event.dataTransfer?.files
      if (files && files.length) {
        for (const file of files) {
          if (/^image\//i.test(file.type || '')) return file
        }
      }
      return null
    }

    /**
     * 悬停抬起：每张图有一根「竖直柱」热区，从抬起后的顶端一直到文本框边线往里 8px。
     * 柱子把图片与文本框之间的空隙也包进来，鼠标停在那块空隙里图片不会缩回去。
     *
     * 归属按「看得见的范围」判定，而不是「布局盒中心谁近」：抬起的那张放大 1.3 后很宽，
     * 它右上角的删除按钮已经越过与右邻居的中间线，按中心选就会把归属让给邻居，
     * 表现为鼠标一凑近按钮，当前这张缩回、旁边那张放大，来回抖。所以：
     * 已抬起的那张优先（迟滞），并且它的右边界要额外盖住删除按钮；
     * 删除按钮的浮现也改由几何判定，不再依赖会跟着抬起跑掉的 CSS :hover。
     */
    function wireFreeRefHover(shell) {
      const RAISE_Y = 84 // 与 free.css 里 .free-ref.is-raised 的 translateY 一致
      const RAISE_S = 1.3 // 与 free.css 里的 scale 一致
      const TILT_SKEW = 6 // 倾斜 ±7deg 时卡片角点横向外扩的上限
      const EDGE_GRACE = 8 // 判定边缘的宽容，避免刚好擦边就抖
      const BUTTON_REACH = 20 // 抬起后删除按钮伸出卡片右侧的距离（含倾斜带来的偏移）
      const CORNER_SIZE = 54 // 右上角删除热区（按抬起后的目标位置算，不跟动画中间态）
      const HIDE_DELAY = 160 // 删除按钮收回的延迟，划过时不会闪一下

      let deleteTimer = 0

      function clearDeleteTimer() {
        if (!deleteTimer) return
        clearTimeout(deleteTimer)
        deleteTimer = 0
      }

      function resetCards(cards) {
        clearDeleteTimer()
        for (const card of cards) {
          if (card.classList.contains('is-raised')) card.classList.remove('is-raised')
          if (card.classList.contains('is-delete-open')) card.classList.remove('is-delete-open')
        }
      }

      /** 卡片几何：布局盒换算成视口坐标，再附上倾斜与缩放后的可见范围 */
      function measure(stack) {
        const stackRect = stack.getBoundingClientRect()
        const stackTop = stack.offsetTop // 相对文本框顶边，CSS 里是负的
        return [...stack.querySelectorAll('.free-ref')].map(card => {
          const width = card.offsetWidth
          const height = card.offsetHeight
          const left = stackRect.left + card.offsetLeft
          const centerX = left + width / 2
          const centerY = stackTop + card.offsetTop + height / 2
          const spare = (width * RAISE_S - width) / 2
          const wide = spare + TILT_SKEW + EDGE_GRACE
          // 抬起后的样子：顶边、右边界，以及长在右上角的删除热区
          const raisedTop = centerY - RAISE_Y - (height * RAISE_S) / 2
          const raisedRight = centerX + (width * RAISE_S) / 2
          return {
            card,
            centerX,
            raised: card.classList.contains('is-raised'),
            wideLeft: left - wide,
            wideRight: left + width + wide,
            // 已经抬起的那张只留倾斜余量，别把右邻居的一大截也扣在自己名下
            stickyLeft: left - spare - TILT_SKEW,
            stickyRight: left + width + spare + TILT_SKEW,
            cornerLeft: raisedRight + BUTTON_REACH - CORNER_SIZE,
            cornerRight: raisedRight + BUTTON_REACH,
            cornerTop: raisedTop - BUTTON_REACH,
            cornerBottom: raisedTop - BUTTON_REACH + CORNER_SIZE
          }
        })
      }

      /** 抬起后卡片右上角那一块：删除按钮就长在这里 */
      function inCorner(item, x, y) {
        return (
          x >= item.cornerLeft - EDGE_GRACE &&
          x <= item.cornerRight + EDGE_GRACE &&
          y >= item.cornerTop - EDGE_GRACE &&
          y <= item.cornerBottom + EDGE_GRACE
        )
      }

      shell.addEventListener('mousemove', event => {
        const stack = shell.querySelector('.free-ref-stack')
        if (!stack || stack.hidden) return
        const cards = [...stack.querySelectorAll('.free-ref')]
        if (!cards.length) return

        const shellRect = shell.getBoundingClientRect()
        const items = measure(stack)
        const x = event.clientX
        const y = event.clientY - shellRect.top
        const bandTop = Math.min(...items.map(item => item.cornerTop)) - EDGE_GRACE

        if (y < bandTop || y > EDGE_GRACE) {
          resetCards(cards)
          return
        }

        // 归属分四步，前几步都是迟滞，鼠标往按钮上走时不会被右邻居抢走：
        //   1. 鼠标比所有卡片底座都高（图片与抬起位置之间那段空隙）→ 继续用已抬起的那张；
        //   2. 还在已抬起那张的可见范围里 → 继续用它；
        //   3. 停在它抬起后的右上角删除按钮那片 → 继续用它；
        //   4. 以上都不成立才按「谁近」换人。
        let picked = null
        if (y < stack.offsetTop) {
          const raised = items.find(
            item => item.raised && x >= item.wideLeft && x <= item.cornerRight + EDGE_GRACE
          )
          picked = raised?.card || null
        }
        if (!picked) {
          const sticky = items.find(item => item.raised && x >= item.stickyLeft && x <= item.stickyRight)
          const cornerHold = sticky ? null : items.find(item => item.raised && inCorner(item, x, y))
          picked = (sticky || cornerHold)?.card || null
        }
        if (!picked) {
          let best = Infinity
          for (const item of items) {
            if (x < item.wideLeft || x > item.wideRight) continue
            const distance = Math.abs(item.centerX - x)
            if (distance < best) {
              best = distance
              picked = item.card
            }
          }
        }

        for (const item of items) {
          const shouldRaise = item.card === picked
          if (item.card.classList.contains('is-raised') !== shouldRaise) {
            item.card.classList.toggle('is-raised', shouldRaise)
          }
        }

        // 鼠标进了抬起后那张卡的右上角方块才浮现删除按钮
        const focused = picked ? items.find(item => item.card === picked) : null
        if (focused && inCorner(focused, x, y)) {
          clearDeleteTimer()
          for (const item of items) {
            if (item.card !== picked && item.card.classList.contains('is-delete-open')) {
              item.card.classList.remove('is-delete-open')
            }
          }
          if (!picked.classList.contains('is-delete-open')) picked.classList.add('is-delete-open')
          return
        }

        // 除此之外：其他卡片的按钮立刻收回，当前这张稍等一下再收，避免边角擦过就消失
        const open = items.filter(item => item.card.classList.contains('is-delete-open'))
        const keep = picked ? open.find(item => item.card === picked) : null
        for (const item of open) {
          if (!keep || item.card !== keep.card) item.card.classList.remove('is-delete-open')
        }
        if (!keep) {
          clearDeleteTimer()
        } else if (!deleteTimer) {
          deleteTimer = setTimeout(() => {
            deleteTimer = 0
            keep.card.classList.remove('is-delete-open')
          }, HIDE_DELAY)
        }
      })

      shell.addEventListener('mouseleave', () => {
        resetCards([...shell.querySelectorAll('.free-ref')])
      })
    }

    async function generateFreeImage(event) {
      event.preventDefault()
      const references = state.freeReferences
      const typed = dom.freePrompt.value.trim()
      // 只给参考图也能生成：补一句默认描述（服务端仍然要求非空提示词）
      const prompt = typed || (references.length ? '以参考图为基础生成画面，保持参考图的主体与构图' : '')
      if (!prompt) {
        dom.freePrompt.focus()
        dom.freeStatus.textContent = '请先写下画面描述，或粘贴一张参考图'
        return
      }
      if (state.processing) {
        showToast('批量任务运行中，完成后再进行自由创作', true)
        return
      }
      if (state.freeBusy) return

      state.freeBusy = true
      dom.freePrompt.disabled = true
      dom.freeSubmit.disabled = true
      dom.freeSubmit.textContent = '正在生成…'
      dom.freeStatus.textContent = 'Magpie 正在绘制'
      renderFreeReferences()
      startFreeProgress()

      const jobId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now())
      rememberPendingJob(jobId)

      try {
        const result = await generateImage({
          prompt,
          ratio: dom.freeRatio.value,
          category: '自由创作',
          name: `自由创作-${timestamp()}`,
          source: 'free',
          jobId,
          referencePaths: references.length ? references.map(ref => ref.path) : undefined,
        })
        if (!result?.imageUrl) throw new Error('接口没有返回图片地址')
        clearPendingJob()

        stopFreeProgress()
        dom.freeProgressLabel.textContent = '图像已生成'
        setFreeProgress(100)
        await sleep(320)
        state.freeImageUrl = result.imageUrl
        state.freeImageExtension = getImageExtension(result.imageUrl)
        persistSoon()
        dom.freeImage.src = `${result.imageUrl}?t=${Date.now()}`
        dom.freePreview.classList.add('has-image')
        dom.freeDownload.disabled = false
        dom.freeMaximize.disabled = false
        dom.freeStatus.textContent = `生成完成 · ${result.width} × ${result.height}`
        // 自由创作的图同样进服务端记录，面板下次打开要重新拉
        historyPanel.invalidate()
      } catch (error) {
        clearPendingJob()
        stopFreeProgress()
        dom.freeProgressLabel.textContent = '生成中断'
        dom.freeStatus.textContent = error.message || '生成失败，请稍后重试'
      } finally {
        state.freeBusy = false
        dom.freePrompt.disabled = false
        dom.freeSubmit.disabled = false
        dom.freeSubmit.textContent = '生成图像'
        renderFreeReferences()
      }
    }

    function renderFreeResult() {
      // 提示词草稿回填（刷新后不丢失）
      if (dom.freePrompt && dom.freePrompt.value !== state.freePrompt) {
        dom.freePrompt.value = state.freePrompt
        dom.freeCount.textContent = String(state.freePrompt.length)
      }
      if (state.freeImageUrl) {
        dom.freeImage.src = state.freeImageUrl
        dom.freePreview.classList.add('has-image')
        dom.freeDownload.disabled = false
        dom.freeMaximize.disabled = false
      }
      renderFreeReferences()
    }

    function startFreeProgress() {
      stopFreeProgress()
      freeProgressValue = 3
      freeStartedAt = Date.now()
      setFreeProgress(freeProgressValue)
      dom.freeProgress.classList.add('visible')
      dom.freeProgressLabel.textContent = '正在理解画面'
      const stages = [
        [0, '正在理解画面'],
        [18, '正在搭建构图'],
        [42, '正在细化光影'],
        [68, '正在完成渲染'],
        [88, '正在接收图像'],
      ]
      freeElapsedTimer = window.setInterval(() => {
        const seconds = Math.floor((Date.now() - freeStartedAt) / 1000)
        dom.freeElapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
      }, 1000)
      freeProgressTimer = window.setInterval(() => {
        freeProgressValue += Math.max(0.25, (94 - freeProgressValue) * 0.035)
        freeProgressValue = Math.min(94, freeProgressValue)
        setFreeProgress(freeProgressValue)
        for (const [threshold, label] of stages) {
          if (freeProgressValue >= threshold) dom.freeProgressLabel.textContent = label
        }
      }, 650)
    }

    function stopFreeProgress() {
      window.clearInterval(freeProgressTimer)
      window.clearInterval(freeElapsedTimer)
    }

    function setFreeProgress(value) {
      dom.freeProgressBar.style.width = `${Math.round(value)}%`
    }

    /* ===== 启动 ===== */

    const historyPanel = setupHistoryPanel()
    const avatarMenu = setupAvatarMenu({
      shouldIgnoreOutsideClick: event => event.target.closest?.('#history-panel'),
    })

    document.querySelector('#logout-button')?.addEventListener('click', async () => {
      await logout().catch(() => {})
      // 退出只清掉这个账号「未完成的生图任务」；工作区快照按账号各自保留
      try {
        if (currentUserId) localStorage.removeItem(pendingJobKey())
      } catch {}
      window.location.replace('/login.html')
    })

    /* ===== 修改显示名（登录用户名不变） ===== */
    const renameModal = document.querySelector('#rename-modal')
    const renameInput = document.querySelector('#rename-input')
    const renameMsg = document.querySelector('#rename-msg')
    const renameSave = document.querySelector('#rename-save')

    document.querySelector('#rename-button')?.addEventListener('click', event => {
      event.stopPropagation()
      avatarMenu.close()
      openRenameDialog()
    })

    renameInput?.addEventListener('input', () => {
      renameInput.classList.remove('invalid')
      renameInput.removeAttribute('aria-invalid')
      renameMsg.textContent = ''
    })

    document.querySelector('#rename-cancel')?.addEventListener('click', closeRenameDialog)
    document.querySelector('#rename-close')?.addEventListener('click', closeRenameDialog)
    renameModal?.addEventListener('click', event => {
      if (event.target === renameModal) closeRenameDialog()
    })

    document.querySelector('#rename-form')?.addEventListener('submit', async event => {
      event.preventDefault()
      const next = renameInput.value.trim()
      const current = (document.querySelector('#header-user')?.textContent || '').trim()

      if (!next) {
        renameMsg.textContent = '名称不能为空'
        renameInput.classList.add('invalid')
        renameInput.setAttribute('aria-invalid', 'true')
        renameInput.focus()
        return
      }
      if (next === current) {
        closeRenameDialog()
        return
      }

      renameSave.disabled = true
      renameSave.textContent = '保存中…'
      try {
        const result = await updateMyProfile({ displayName: next })
        if (result?.user) applyUserChrome(result.user)
        closeRenameDialog()
        showToast('名称已更新')
      } catch (error) {
        // 重名等错误由服务端给出具体文案
        renameMsg.textContent = error.message || '修改失败，请重试'
        renameInput.classList.add('invalid')
        renameInput.setAttribute('aria-invalid', 'true')
        renameInput.focus()
      } finally {
        renameSave.disabled = false
        renameSave.textContent = '保存'
      }
    })

    function wireEvents() {
      document.addEventListener('click', handleClick)
      document.addEventListener('change', handleChange)
      document.addEventListener('input', handleInput)

      // 页签组：方向键 / Home / End 切换，和鼠标点击走同一个 switchTab；
      // 点击仍由上面的 data-tab 分发处理，这里只管键盘，避免重复 switchTab
      setupTablist(document.querySelector('.tabs'), {
        onChange: switchTab,
        initialId: state.activeTab,
        hash: false,
        click: false,
      })

      dom.headerImport.addEventListener('click', openFilePicker)
      dom.headerProjects?.addEventListener('click', openProjectsDrawer)
      dom.projectsClose?.addEventListener('click', closeProjectsDrawer)
      dom.projectsBackdrop?.addEventListener('click', closeProjectsDrawer)
      dom.projectsNew?.addEventListener('click', handleNewProject)
      dom.projectsImport?.addEventListener('click', () => {
        closeProjectsDrawer()
        openFilePicker()
      })
      dom.projectsList?.addEventListener('click', handleProjectListClick)
      dom.dropzone.addEventListener('click', openFilePicker)
      dom.dropzone.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openFilePicker()
        }
      })

      dom.fileInput.addEventListener('change', async event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) await importFile(file)
      })

      for (const eventName of ['dragenter', 'dragover']) {
        dom.dropzone.addEventListener(eventName, event => {
          event.preventDefault()
          dom.dropzone.classList.add('dragging')
        })
      }

      for (const eventName of ['dragleave', 'drop']) {
        dom.dropzone.addEventListener(eventName, event => {
          event.preventDefault()
          dom.dropzone.classList.remove('dragging')
        })
      }

      dom.dropzone.addEventListener('drop', async event => {
        const file = event.dataTransfer?.files?.[0]
        if (file) await importFile(file)
      })

      dom.stopQueue.addEventListener('click', stopQueue)
      dom.modalClose.addEventListener('click', closeAssetModal)
      dom.modal.addEventListener('click', event => {
        if (event.target === dom.modal) closeAssetModal()
      })
      dom.lightboxClose.addEventListener('click', closeLightbox)
      dom.lightbox.addEventListener('click', event => {
        if (event.target === dom.lightbox) closeLightbox()
      })

      dom.modalPrompt.addEventListener('input', () => {
        const asset = findAsset(state.modalId)
        if (!asset) return
        asset.prompt = dom.modalPrompt.value
        dom.modalPromptCount.textContent = String(asset.prompt.length)
        persistSoon()
      })

      dom.modalResetPrompt.addEventListener('click', () => {
        const asset = findAsset(state.modalId)
        if (!asset) return
        asset.prompt = buildPrompt(asset)
        dom.modalPrompt.value = asset.prompt
        dom.modalPromptCount.textContent = String(asset.prompt.length)
        persistSoon()
        showToast('已恢复根据字段自动生成的提示词')
      })

      dom.modalGenerate.addEventListener('click', () => {
        const asset = findAsset(state.modalId)
        if (!asset) return
        startBatch([asset.id], `生成 ${asset.name}`)
      })

      // 改写提示词：入口在资产弹窗与自由创作两处，弹窗本身共用
      if (dom.modalRevisePrompt) {
        dom.modalRevisePrompt.addEventListener('click', openReviseForAsset)
      }
      if (dom.reviseRun) dom.reviseRun.addEventListener('click', runRevise)
      if (dom.reviseApply) dom.reviseApply.addEventListener('click', applyRevise)
      if (dom.reviseClose) dom.reviseClose.addEventListener('click', closeReviseDialog)
      if (dom.reviseUseRefs) dom.reviseUseRefs.addEventListener('change', renderReviseThumbs)
      if (dom.reviseUseResult) dom.reviseUseResult.addEventListener('change', renderReviseThumbs)
      if (dom.reviseResult) {
        dom.reviseResult.addEventListener('input', () => {
          dom.reviseResultCount.textContent = String(dom.reviseResult.value.length)
        })
      }
      if (dom.reviseInstruction) {
        // Ctrl / Cmd + Enter 直接开始改写
        dom.reviseInstruction.addEventListener('keydown', event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault()
            void runRevise()
          }
        })
      }
      if (dom.reviseModal) {
        // 点卡片外的遮罩关闭，和资产弹窗 / 灯箱保持一致
        dom.reviseModal.addEventListener('click', event => {
          if (event.target === dom.reviseModal) closeReviseDialog()
        })
      }

      dom.modalResultThumb.addEventListener('click', () => {
        const asset = findAsset(state.modalId)
        const url = asset ? primaryImageOf(asset) : ''
        if (url) openLightbox(url, `${asset.name} 主要图片`)
      })

      dom.freeForm.addEventListener('submit', generateFreeImage)

      // 捏脸页：表单提交生成方案，结果区负责复制、下载与看大图
      dom.faceForm.addEventListener('submit', runFaceDesign)
      dom.faceForm.addEventListener('input', persistFaceForm)
      dom.faceForm.addEventListener('change', persistFaceForm)
      dom.faceGenerate.addEventListener('click', generateFaceImage)
      dom.faceCopyAll.addEventListener('click', () => {
        void copyFaceText(state.face.prompt, '提示词已复制到剪贴板')
      })
      dom.faceDownload.addEventListener('click', () => {
        if (!state.face.imageUrl) return
        downloadImage(
          state.face.imageUrl,
          `画境-捏脸-${timestamp()}.${getImageExtension(state.face.imageUrl)}`,
        )
      })
      dom.faceOpen.addEventListener('click', () => {
        if (state.face.imageUrl) openLightbox(state.face.imageUrl, '捏脸定妆照')
      })
      dom.faceOutput.addEventListener('click', event => {
        const button = event.target.closest('[data-face-copy]')
        if (!button) return
        const target = document.getElementById(button.dataset.faceCopy)
        if (!target) return
        const value = 'value' in target ? target.value : target.textContent || ''
        void copyFaceText(value, '已复制')
      })
      dom.freePrompt.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          dom.freeForm.requestSubmit()
        }
      })
      dom.freeDownload.addEventListener('click', () => {
        if (!state.freeImageUrl) return
        downloadImage(state.freeImageUrl, `画境-自由创作-${timestamp()}.${state.freeImageExtension}`)
      })
      dom.freeMaximize.addEventListener('click', () => {
        if (state.freeImageUrl) openLightbox(state.freeImageUrl, '自由创作生成图')
      })

      // 提示词悬浮工具：复制 + AI 优化 + 最大化编辑器（与单张工作台同款）
      dom.freePromptCopy.addEventListener('click', async () => {
        const value = dom.freePrompt.value
        if (!value) {
          showToast('提示词还是空的')
          return
        }
        try {
          await navigator.clipboard.writeText(value)
        } catch {
          dom.freePrompt.focus()
          dom.freePrompt.select()
          document.execCommand('copy')
          dom.freePrompt.setSelectionRange(dom.freePrompt.value.length, dom.freePrompt.value.length)
        }
        showToast('提示词已复制到剪贴板')
      })

      dom.freePromptMaximize.addEventListener('click', () => openFreePromptEditor())
      dom.freePromptOptimize.addEventListener('click', optimizeFreePrompt)
      if (dom.freePromptRevise) dom.freePromptRevise.addEventListener('click', openReviseForFree)

      /* ===== 自由创作参考图：粘贴 / 拖入追加（可多张），点图看大图，右上角删除 ===== */
      const freeShell = dom.freePromptShell
      if (freeShell) {
        const hasFiles = event =>
          Boolean(event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files'))

        dom.freePrompt.addEventListener('paste', event => {
          const file = imageFileFromEvent(event)
          if (!file) return
          // 图片不往文本框里粘，直接当参考图
          event.preventDefault()
          void attachFreeReference(file)
        })

        freeShell.addEventListener('dragover', event => {
          if (!hasFiles(event)) return
          event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
          freeShell.classList.add('is-dragover')
        })

        freeShell.addEventListener('dragleave', event => {
          if (!freeShell.contains(event.relatedTarget)) freeShell.classList.remove('is-dragover')
        })

        freeShell.addEventListener('drop', event => {
          if (!hasFiles(event)) return
          // 不拦的话浏览器会直接把文件当页面打开
          event.preventDefault()
          freeShell.classList.remove('is-dragover')
          const file = imageFileFromEvent(event)
          if (file) void attachFreeReference(file)
          else showToast('参考图仅支持 PNG / JPEG / WebP', true)
        })

        // 卡片是动态渲染的，统一用委托：右上角删除 / 点图看大图
        dom.freeRefStack.addEventListener('click', event => {
          const remove = event.target.closest('[data-ref-delete]')
          if (remove) {
            event.stopPropagation()
            removeFreeReference(Number(remove.dataset.refDelete))
            return
          }
          const card = event.target.closest('.free-ref')
          if (!card) return
          const index = Number(card.dataset.refIndex)
          const ref = state.freeReferences[index]
          const url = freeReferenceUrl(ref)
          if (url) openLightbox(url, ref?.name || '参考图', card)
        })

        wireFreeRefHover(freeShell)

        dom.freeRefFile.addEventListener('change', () => {
          const file = dom.freeRefFile.files && dom.freeRefFile.files[0]
          if (file) void attachFreeReference(file)
        })
      }

      /* 悬浮工具只在输入框右上角热区出现：热区 = 右侧 150px、顶部 56px */
      const promptShell = dom.freePrompt.closest('.prompt-shell')
      if (promptShell) {
        const HOT_W = 150
        const HOT_H = 56
        promptShell.addEventListener('mousemove', event => {
          const rect = promptShell.getBoundingClientRect()
          const nearRight = event.clientX >= rect.right - HOT_W
          const nearTop = event.clientY <= rect.top + HOT_H
          promptShell.classList.toggle('tools-near', nearRight && nearTop)
        })
        promptShell.addEventListener('mouseleave', () => {
          promptShell.classList.remove('tools-near')
        })
      }
    }

    /* 委托点击的 data-* 分发表：自上而下取第一个命中的选择器并交给对应
       handler，行为与原先的 if 链等价；整行打开详情放在最后兜底。 */
    const CLICK_DISPATCH = [
      ['[data-tab]', target => switchTab(target.dataset.tab)],
      ['[data-history-action]', handleHistoryActionClick],
      ['[data-ref-action]', handleRefActionClick],
      ['[data-group-toggle]', handleGroupToggleClick],
      ['[data-row-action]', handleRowActionClick],
      ['[data-action]', handleActionClick],
      ['[data-style-action]', handleStyleClick],
      ['[data-asset-row]', handleAssetRowClick],
    ]

    function handleClick(event) {
      for (const [selector, handler] of CLICK_DISPATCH) {
        const target = event.target.closest(selector)
        if (!target) continue
        handler(target, event)
        return
      }
    }

    function handleHistoryActionClick(target) {
      const asset = findAsset(state.modalId)
      if (!asset) return
      const url = target.dataset.url || ''
      if (target.dataset.historyAction === 'primary' && url) {
        asset.primaryUrl = url
        persistSoon()
        renderAssetModalState()
        renderTable(asset.type)
        showToast('已设为主要图片')
      } else if (target.dataset.historyAction === 'preview' && url) {
        openLightbox(url, `${asset.name} 历史生成图`)
      }
    }

    function handleRefActionClick(target) {
      const action = target.dataset.refAction
      if (action === 'preview') {
        openLightbox(target.dataset.refUrl || '', target.dataset.refLabel || '面部参考图')
      } else if (action === 'upload') {
        startReferenceUpload(target.dataset.refCharacter || '')
      } else if (action === 'clear') {
        clearReference(target.dataset.refCharacter || '')
      }
    }

    function handleGroupToggleClick(target) {
      toggleGroup(target.dataset.groupToggle || '', target.dataset.groupType || 'role')
    }

    function handleRowActionClick(target) {
      const asset = findAsset(target.dataset.id)
      if (!asset) return

      switch (target.dataset.rowAction) {
        case 'open':
          openAssetModal(asset.id)
          break
        case 'generate':
          startBatch([asset.id], `生成 ${asset.name}`)
          break
        case 'preview': {
          const url = primaryImageOf(asset)
          if (url) openLightbox(url, `${asset.name} 主要图片`)
          break
        }
        case 'download': {
          const url = primaryImageOf(asset)
          if (url) downloadImage(url, assetFilename(asset))
          break
        }
      }
    }

    function handleActionClick(target) {
      if (target.dataset.action === 'reset-asset-prompt') {
        const asset = findAsset(target.dataset.id)
        if (asset) {
          asset.prompt = buildPrompt(asset)
          persistSoon()
          openAssetModal(asset.id)
          showToast('已恢复自动提示词')
        }
        return
      }

      const type = currentAssetType()
      switch (target.dataset.action) {
        case 'select-page':
          selectVisible(type)
          break
        case 'select-type':
          selectType(type)
          break
        case 'clear-selection':
          selectedIdsOf(type).forEach(id => state.selected.delete(id))
          renderTable(type)
          refreshSelectionLabels()
          break
        case 'apply-params':
          applyBulkParams(type)
          break
        case 'generate-selected':
          startBatch(selectedIdsOf(type), '批量生成所选资产')
          break
        case 'generate-type':
          generateWholeType(type)
          break
        case 'download-selected':
          downloadSelectedAssets(type)
          break
        case 'previous-page':
          state.page[type] = Math.max(1, state.page[type] - 1)
          renderTable(type)
          persistSoon()
          break
        case 'next-page':
          state.page[type] += 1
          renderTable(type)
          persistSoon()
          break
      }
    }

    /* 整行点击打开资产详情；行内的输入控件、按钮与链接保持自己的行为 */
    function handleAssetRowClick(target, event) {
      if (event.target.closest('input, select, button, a, label')) return
      openAssetModal(target.dataset.assetRow)
    }

    function handleChange(event) {
      // 角色面部参考图：文件选好后走上传流程
      if (event.target === dom.refFile) {
        handleReferenceFile(event.target.files?.[0])
        return
      }

      // 风格库导入：选好 JSON 后解析合并
      if (event.target === dom.styleImport) {
        handleStyleImportFile(event.target.files?.[0])
        return
      }

      // 并行生成数：记住选择，三个资产页共用同一个值
      const concurrency = event.target.closest('[data-concurrency]')
      if (concurrency) {
        const limit = imageConcurrencyLimit()
        const picked = Math.max(1, Math.floor(Number(concurrency.value) || 1))
        const value = limit && limit > 0 ? Math.min(limit, picked) : picked
        state.concurrency = value
        state.concurrencyCustom = true
        // 三个资产页共用同一个值，但各页任务数不同，按各自选项上限截断
        document.querySelectorAll('[data-concurrency]').forEach(select => {
          const options = select.options.length
          select.value = String(options ? Math.min(value, options) : value)
        })
        persistSoon()
        return
      }

      // 自由创作画面比例：记住选择，刷新后保持
      if (event.target === dom.freeRatio) {
        state.freeRatio = dom.freeRatio.value
        persistSoon()
        return
      }

      // 工具栏批量比例/风格：记住选择，刷新后保持
      const bulkRatio = event.target.closest('[id^="bulk-ratio-"]')
      if (bulkRatio) {
        const type = bulkRatio.id.replace('bulk-ratio-', '')
        state.bulkParams[type] = { ...state.bulkParams[type], ratio: bulkRatio.value }
        refreshBulkSummary(type)
        persistSoon()
        return
      }

      const bulkStyle = event.target.closest('[id^="bulk-style-"]')
      if (bulkStyle) {
        const type = bulkStyle.id.replace('bulk-style-', '')
        state.bulkParams[type] = { ...state.bulkParams[type], styleId: bulkStyle.value }
        refreshBulkSummary(type)
        persistSoon()
        return
      }

      const rowRatio = event.target.closest('[data-row-ratio]')
      if (rowRatio) {
        const asset = findAsset(rowRatio.dataset.rowRatio)
        if (asset) {
          asset.ratio = rowRatio.value
          persistSoon()
        }
        return
      }

      const rowStyle = event.target.closest('[data-row-style]')
      if (rowStyle) {
        const asset = findAsset(rowStyle.dataset.rowStyle)
        if (asset) {
          asset.styleId = resolveAssetStyleId(asset, rowStyle.value)
          persistSoon()
          renderTable(asset.type)
        }
        return
      }

      const groupCheck = event.target.closest('[data-select-group]')
      if (groupCheck) {
        const type = groupCheck.dataset.selectGroupType || 'role'
        const group = buildAssetGroups(type).find(item => item.key === groupCheck.dataset.selectGroup)
        if (group) {
          group.assets.forEach(asset => {
            if (groupCheck.checked) state.selected.add(asset.id)
            else state.selected.delete(asset.id)
          })
          renderTable(type)
          refreshSelectionLabels()
        }
        return
      }

      const checkbox = event.target.closest('[data-select-id]')
      if (checkbox) {
        const id = checkbox.dataset.selectId
        if (checkbox.checked) state.selected.add(id)
        else state.selected.delete(id)
        const row = checkbox.closest('tr')
        row?.classList.toggle('selected-row', checkbox.checked)
        // 分组子行的勾选要连带刷新父行的整组勾选框
        const asset = findAsset(id)
        if (asset && row?.classList.contains('asset-child-row')) renderTable(asset.type)
        refreshSelectionLabels()
        return
      }

      if (event.target === dom.modalRatio) {
        const asset = findAsset(state.modalId)
        if (asset) {
          asset.ratio = dom.modalRatio.value
          persistSoon()
          refreshCurrentTable()
        }
        return
      }

      if (event.target === dom.modalStyle) {
        const asset = findAsset(state.modalId)
        if (asset) {
          asset.styleId = resolveAssetStyleId(asset, dom.modalStyle.value)
          persistSoon()
          refreshCurrentTable()
          renderAssetModalState()
        }
        return
      }

      const styleField = event.target.closest('[data-style-field]')
      if (styleField) {
        state.styleDirty = true
        updateStyleFormState()
      }
    }

    function handleInput(event) {
      const search = event.target.closest('[data-search]')
      if (search) {
        const type = search.dataset.search
        state.search[type] = search.value
        state.page[type] = 1
        renderTable(type)
        return
      }

      if (event.target === dom.freePrompt) {
        state.freePrompt = dom.freePrompt.value
        dom.freeCount.textContent = String(state.freePrompt.length)
        persistSoon()
      }
    }

    async function boot() {
      let user
      try {
        user = await requireLogin()
      } catch {
        // guard 已把 401/403 跳转到登录页；其余错误要说出来，别把空页面当正常
        showToast('无法确认登录状态，请刷新页面重试', true)
        return
      }

      // /api/auth/me 返回的是 { userId, username, displayName, role }，
      // 登录接口返回的才是 { id, ... }，两处都兼容一下
      currentUserId = user.id || user.userId || ''
      if (!currentUserId) {
        showToast('登录状态异常，请刷新页面重试', true)
        return
      }
      applyUserChrome(user)

      await adoptLegacySnapshotIfOwned()
      await adoptLegacyPendingJobIfOwned()
      restoreState()
      // 捏脸表单先按快照回填；服务端配置到达后再决定按钮是否可用
      hydrateFaceForm()
      // 比例下拉先按本地选择渲染；服务端配置到达后再刷一次
      renderRatioSelects()
      renderAll()
      // 刷新前若有正在生成的图片，自动接回进度与结果（只接本账号自己的）
      resumePendingJobIfAny()

      // 先加载项目，再决定风格库用项目的还是全局模板的
      loadProjects().then(() => loadSharedStyles())

      // 后端配置决定可选画面比例与并行上限，拉取失败时不静默掩盖
      fetchServerConfig()
        .then(config => {
          serverConfig = config
          const concurrency = config?.imageConcurrency
          if (Number.isInteger(concurrency) && concurrency >= 0) rememberImageConcurrency(concurrency)
          renderActivePanel()
          renderRatioSelects()
          // 没配文本模型时不亮出按钮，省得点了才发现用不了
          const textModel = config?.promptOptimize?.textModel
          if (textModel) {
            dom.freePromptOptimize.hidden = false
            if (dom.freePromptRevise) dom.freePromptRevise.hidden = false
            if (dom.modalRevisePrompt) dom.modalRevisePrompt.hidden = false
            if (dom.faceDesignRun) dom.faceDesignRun.disabled = false
          } else if (dom.faceStatus) {
            dom.faceStatus.textContent = '管理员还没配置提示词模型，捏脸暂时不可用'
            if (dom.faceDesignRun) dom.faceDesignRun.disabled = true
          }
        })
        .catch(() => {
          // 本会话读到过就沿用并说明；一次都没读到，开批时会被拦下并给重试
          if (sessionImageConcurrency !== null) {
            showToast('没读到服务端配置，并行上限沿用本会话上次读取的值')
          }
        })
    }

    /** 头像与菜单里的账号标识（名字取自 /api/auth/me 的实时结果） */
    function applyUserChrome(user) {
      const label = document.querySelector('#header-user')
      if (label) label.textContent = user.displayName || user.username

      const letter = document.querySelector('#avatar-letter')
      if (letter) {
        const source = user.displayName || user.username || '境'
        letter.textContent = Array.from(source)[0] || '境'
      }
    }

    /* 启动顺序很重要：必须**先确认当前是谁**，再读本地快照并渲染。
       以前是同步 restoreState() + renderAll()，而身份是异步拿的，
       结果换账号后上一账号的草稿/图片会先画到页面上且之后不再覆盖。 */
    wireEvents()
    boot()

    /* ===== 反馈 ===== */

    /* 版本号由 vite.config.ts 从 web/package.json 注入，与安装包版本同源 */
    const FEEDBACK_APP_VERSION = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__
    /* 服务端按 page 字段归类「哪个页面提的」，用文件名而不是完整 URL（带端口/域名没意义） */
    const FEEDBACK_PAGE = 'batch.html'
    const FEEDBACK_MINE_LIMIT = 20
    const FEEDBACK_CATEGORY_LABEL = { bug: '缺陷', suggestion: '建议', other: '其他' }
    const FEEDBACK_CATEGORIES = Object.keys(FEEDBACK_CATEGORY_LABEL)
    const FEEDBACK_CONTENT_MIN = 5
    /* 草稿与「没送达服务端」的记录都按账号存在本机，换账号自然隔离 */
    const FEEDBACK_DRAFT_KEY = userId => `moying.feedback.draft.v1.${userId}`
    const FEEDBACK_FAILED_KEY = userId => `moying.feedback.failed.v1.${userId}`
    /* 失败记录最多留 5 条，多的从最旧的开始丢 */
    const FEEDBACK_FAILED_MAX = 5

    const feedbackModal = document.querySelector('#feedback-modal')
    const feedbackForm = document.querySelector('#feedback-form')
    const feedbackCategories = document.querySelector('#feedback-categories')
    const feedbackContent = document.querySelector('#feedback-content')
    const feedbackCount = document.querySelector('#feedback-count')
    const feedbackMsg = document.querySelector('#feedback-msg')
    const feedbackStatus = document.querySelector('#feedback-status')
    const feedbackSubmit = document.querySelector('#feedback-submit')
    const feedbackList = document.querySelector('#feedback-list')
    const feedbackHistoryStatus = document.querySelector('#feedback-history-status')
    const feedbackHistoryPanel = document.querySelector('#feedback-history-panel')
    const feedbackHistoryToggle = document.querySelector('#feedback-history-toggle')
    const feedbackHistoryRefresh = document.querySelector('#feedback-history-refresh')

    let feedbackOverlayHandle = null
    let feedbackCategory = 'bug'
    let feedbackSubmitting = false
    /* 服务端返回的本人反馈，最新在前 */
    let feedbackRecords = []
    /* 没送达服务端的失败记录，存在本机，可以重试 */
    let feedbackFailed = []
    /* 展开了详情的记录 id，重新渲染后仍保持展开 */
    let feedbackExpanded = new Set()
    /* 列表请求序号：只认最后一次的结果，慢响应不覆盖新数据 */
    let feedbackLoadSeq = 0
    let feedbackDraftTimer = null

    /* ---------- 本机草稿与失败记录 ---------- */

    function readFeedbackStorage(key) {
      if (!key) return null
      try {
        const raw = localStorage.getItem(key)
        if (!raw) return null
        return JSON.parse(raw)
      } catch {
        // 隐私模式或被写坏的内容一律当作没有草稿
        return null
      }
    }

    function writeFeedbackStorage(key, value) {
      if (!key) return false
      try {
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, JSON.stringify(value))
        return true
      } catch {
        return false
      }
    }

    function feedbackDraftKey() {
      return currentUserId ? FEEDBACK_DRAFT_KEY(currentUserId) : ''
    }

    /** 保存草稿：内容 + 类型，按账号隔离；只有提交成功才会清除 */
    function saveFeedbackDraft() {
      if (!currentUserId) return
      const content = feedbackContent?.value ?? ''
      if (!content.trim()) {
        writeFeedbackStorage(feedbackDraftKey(), null)
        return
      }
      writeFeedbackStorage(feedbackDraftKey(), {
        content,
        category: feedbackCategory,
        updatedAt: new Date().toISOString(),
      })
    }

    function scheduleFeedbackDraftSave() {
      if (feedbackDraftTimer) clearTimeout(feedbackDraftTimer)
      feedbackDraftTimer = setTimeout(() => {
        feedbackDraftTimer = null
        saveFeedbackDraft()
      }, 300)
    }

    function clearFeedbackDraft() {
      if (feedbackDraftTimer) {
        clearTimeout(feedbackDraftTimer)
        feedbackDraftTimer = null
      }
      if (!currentUserId) return
      writeFeedbackStorage(feedbackDraftKey(), null)
    }

    /** 打开弹窗时恢复本账号上次没提交完的草稿 */
    function restoreFeedbackDraft() {
      if (!currentUserId) return
      const draft = readFeedbackStorage(feedbackDraftKey())
      if (!draft || typeof draft.content !== 'string' || !draft.content) return
      feedbackContent.value = draft.content
      if (FEEDBACK_CATEGORIES.includes(draft.category)) feedbackCategory = draft.category
    }

    function loadFeedbackFailed() {
      if (!currentUserId) {
        feedbackFailed = []
        return
      }
      const list = readFeedbackStorage(FEEDBACK_FAILED_KEY(currentUserId))
      feedbackFailed = Array.isArray(list)
        ? list.filter(item => item && typeof item.content === 'string' && item.content)
        : []
    }

    function persistFeedbackFailed() {
      if (!currentUserId) return
      writeFeedbackStorage(FEEDBACK_FAILED_KEY(currentUserId), feedbackFailed)
    }

    /** 记一条「没送达服务端」的反馈：草稿留着，记录也能重试 */
    function rememberFailedFeedback(entry) {
      const same = feedbackFailed.find(item => item.content === entry.content)
      if (same) {
        same.reason = entry.reason
        same.category = entry.category
        same.createdAt = entry.createdAt
      } else {
        feedbackFailed.unshift(entry)
      }
      feedbackFailed = feedbackFailed.slice(0, FEEDBACK_FAILED_MAX)
      persistFeedbackFailed()
    }

    function removeFailedFeedback(content) {
      const next = feedbackFailed.filter(item => item.content !== content)
      if (next.length === feedbackFailed.length) return
      feedbackFailed = next
      persistFeedbackFailed()
    }

    /** 折叠时优先用 hidden="until-found"：内容仍能被页内查找命中，老浏览器回落到普通 hidden */
    const supportsHiddenUntilFound = 'onbeforematch' in (document.body || document.documentElement)

    function setFeedbackPanelHidden(element, hidden) {
      if (!element) return
      if (!hidden) {
        element.removeAttribute('hidden')
        return
      }
      element.setAttribute('hidden', supportsHiddenUntilFound ? 'until-found' : '')
    }

    /** 同步弹窗视图：提交态、字数与三档控件的选中态 */
    function renderFeedbackModal() {
      if (!feedbackModal) return
      feedbackSubmit.disabled = feedbackSubmitting
      feedbackSubmit.textContent = feedbackSubmitting ? '提交中…' : '提交反馈'
      feedbackForm?.setAttribute('aria-busy', String(feedbackSubmitting))
      feedbackCount.textContent = String(feedbackContent.value.length)
      /* aria-checked 表达选中，靠 roving tabindex 让 Tab 只停在当前档 */
      feedbackCategories.querySelectorAll('[data-feedback-category]').forEach(button => {
        const active = button.dataset.feedbackCategory === feedbackCategory
        button.classList.toggle('active', active)
        button.setAttribute('aria-checked', String(active))
        button.tabIndex = active ? 0 : -1
      })
    }

    function setFeedbackError(text) {
      feedbackMsg.textContent = text
      if (text) feedbackStatus.textContent = ''
    }

    function setFeedbackStatus(text) {
      feedbackStatus.textContent = text
      if (text) feedbackMsg.textContent = ''
    }

    function setFeedbackHistoryStatus(text) {
      feedbackHistoryStatus.textContent = text
    }

    /** 展开/收起历史记录区；展开状态用 aria-expanded 表达 */
    function setFeedbackHistoryOpen(open) {
      if (!feedbackHistoryPanel || !feedbackHistoryToggle) return
      setFeedbackPanelHidden(feedbackHistoryPanel, !open)
      feedbackHistoryToggle.setAttribute('aria-expanded', String(open))
      feedbackHistoryToggle.textContent = open ? '收起记录' : '展开记录'
    }

    /* 页内查找命中折叠内容时，浏览器会先移除 hidden="until-found"，
       这里同步展开按钮的 aria-expanded，别让状态对不上 */
    feedbackHistoryPanel?.addEventListener('beforematch', () => {
      feedbackHistoryToggle?.setAttribute('aria-expanded', 'true')
      if (feedbackHistoryToggle) feedbackHistoryToggle.textContent = '收起记录'
    })

    function openFeedbackModal() {
      if (!feedbackModal) return
      feedbackMsg.textContent = ''
      feedbackStatus.textContent = ''
      feedbackContent.classList.remove('invalid')
      feedbackContent.removeAttribute('aria-invalid')
      /* 先清空再恢复：上一个账号留下的文字不能串到当前账号 */
      feedbackContent.value = ''
      feedbackCategory = 'bug'
      loadFeedbackFailed()
      restoreFeedbackDraft()
      feedbackExpanded = new Set()
      renderFeedbackModal()
      renderFeedbackList()
      feedbackModal.classList.add('visible')
      if (!feedbackOverlayHandle) {
        feedbackOverlayHandle = activateOverlay(feedbackModal, {
          onRequestClose: closeFeedbackModal,
          initialFocus: feedbackContent,
        })
      }
      // 重开时 overlay 不会重新定焦点（handle 复用），这里补上
      feedbackContent.focus()
      // 打开即加载本人最近记录
      loadMyFeedback()
    }

    function closeFeedbackModal() {
      // 关闭前先落盘草稿，刷新或换页后还能接着写
      saveFeedbackDraft()
      feedbackOverlayHandle?.release()
      feedbackOverlayHandle = null
      feedbackModal?.classList.remove('visible')
    }

    /** 把失败原因翻译成人能看懂的一句话，顺带说明草稿还在 */
    function describeFeedbackError(error) {
      if (error?.status === 429 || error?.code === 'RATE_LIMITED') {
        return '提交太频繁，请稍后再试（草稿已保留）'
      }
      if (error instanceof ApiRequestError) {
        return `${error.message || '提交失败'}（草稿已保留）`
      }
      return '网络连接失败，请检查网络后重试（草稿已保留）'
    }

    async function submitFeedbackFromForm(event) {
      event.preventDefault()
      if (!feedbackContent || feedbackSubmitting) return

      // 先用 trim 后的长度判断，避免「只打了几个空格」通过校验
      const content = feedbackContent.value.trim()
      if (content.length < FEEDBACK_CONTENT_MIN) {
        setFeedbackError(`请至少写 ${FEEDBACK_CONTENT_MIN} 个字，方便我们判断问题`)
        feedbackContent.classList.add('invalid')
        feedbackContent.setAttribute('aria-invalid', 'true')
        feedbackContent.focus()
        return
      }

      setFeedbackError('')
      setFeedbackStatus('')
      feedbackContent.classList.remove('invalid')
      feedbackContent.removeAttribute('aria-invalid')
      feedbackSubmitting = true
      renderFeedbackModal()
      try {
        await submitFeedback({
          category: feedbackCategory,
          content,
          page: FEEDBACK_PAGE,
          appVersion: FEEDBACK_APP_VERSION,
        })
        // 只有真正送达服务端才清草稿
        clearFeedbackDraft()
        feedbackContent.value = ''
        removeFailedFeedback(content)
        setFeedbackStatus('已提交，感谢你的反馈，可以接着写下一条。')
        showToast('反馈已提交，感谢你的建议')
        // 提交完把焦点还给输入框，接着写下一条
        feedbackContent.focus()
      } catch (error) {
        const reason = describeFeedbackError(error)
        // 失败也要留底：草稿照旧，列表里多一条可重试的记录
        rememberFailedFeedback({
          id: randomId(),
          category: feedbackCategory,
          content,
          createdAt: new Date().toISOString(),
          reason,
        })
        saveFeedbackDraft()
        setFeedbackError(reason)
      } finally {
        feedbackSubmitting = false
        renderFeedbackModal()
      }
      renderFeedbackList()
      await loadMyFeedback()
    }

    /** 重试一条没送达服务端的反馈 */
    async function retryFailedFeedback(item) {
      if (feedbackSubmitting) return
      feedbackSubmitting = true
      renderFeedbackModal()
      renderFeedbackList()
      try {
        await submitFeedback({
          category: item.category,
          content: item.content,
          page: FEEDBACK_PAGE,
          appVersion: FEEDBACK_APP_VERSION,
        })
        removeFailedFeedback(item.content)
        // 草稿内容与这条一致时一并清掉，否则用户改写过的内容要留下
        if (feedbackContent.value.trim() === item.content.trim()) {
          feedbackContent.value = ''
          clearFeedbackDraft()
        }
        setFeedbackStatus('重试成功，这条反馈已经送达。')
        showToast('反馈已提交，感谢你的建议')
      } catch (error) {
        const reason = describeFeedbackError(error)
        rememberFailedFeedback({
          id: item.key,
          category: item.category,
          content: item.content,
          createdAt: item.createdAt,
          reason,
        })
        setFeedbackError(reason)
      } finally {
        feedbackSubmitting = false
        renderFeedbackModal()
        renderFeedbackList()
      }
      await loadMyFeedback()
    }

    /** 打开弹窗即加载本人最近 20 条记录 */
    async function loadMyFeedback() {
      const seq = ++feedbackLoadSeq
      if (feedbackHistoryRefresh) feedbackHistoryRefresh.disabled = true
      setFeedbackHistoryStatus('正在加载最近反馈…')
      try {
        const result = await fetchMyFeedback(FEEDBACK_MINE_LIMIT)
        // 慢响应不覆盖后发起的请求
        if (seq !== feedbackLoadSeq) return
        const items = Array.isArray(result?.feedback) ? result.feedback : []
        feedbackRecords = items.map(normalizeFeedbackRecord)
        setFeedbackHistoryStatus(`已加载 ${feedbackRecords.length} 条记录`)
      } catch {
        if (seq !== feedbackLoadSeq) return
        // 拉取失败不清空已有记录，保留上次的内容让用户还能看
        setFeedbackHistoryStatus('加载失败，点「刷新」重试')
      }
      if (feedbackHistoryRefresh) feedbackHistoryRefresh.disabled = false
      renderFeedbackList()
    }

    /** 服务端返回的字段可能缺省（旧数据没有回复），统一成一份安全的结构 */
    function normalizeFeedbackRecord(item) {
      const record = item && typeof item === 'object' ? item : {}
      const reply = typeof record.reply === 'string'
        ? record.reply
        : (typeof record.adminReply === 'string' ? record.adminReply : '')
      return {
        key: String(record.id || ''),
        category: FEEDBACK_CATEGORIES.includes(record.category) ? record.category : 'other',
        content: typeof record.content === 'string' ? record.content : '',
        page: typeof record.page === 'string' ? record.page : '',
        appVersion: typeof record.appVersion === 'string' ? record.appVersion : '',
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
        status: record.status === 'resolved' ? 'resolved' : 'new',
        reply,
        repliedAt: typeof record.repliedAt === 'string' ? record.repliedAt : '',
        repliedBy: typeof record.repliedBy === 'string' ? record.repliedBy : '',
        failed: false,
        reason: '',
      }
    }

    function normalizeFailedRecord(item) {
      const record = item && typeof item === 'object' ? item : {}
      return {
        key: `failed-${record.id || record.createdAt || ''}`,
        category: FEEDBACK_CATEGORIES.includes(record.category) ? record.category : 'other',
        content: typeof record.content === 'string' ? record.content : '',
        page: FEEDBACK_PAGE,
        appVersion: FEEDBACK_APP_VERSION,
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
        status: 'new',
        reply: '',
        repliedAt: '',
        repliedBy: '',
        failed: true,
        reason: typeof record.reason === 'string' ? record.reason : '',
      }
    }

    function renderFeedbackList() {
      if (!feedbackList) return
      // 失败记录排在最前面：那是用户还没拿到结果的条目
      const items = [...feedbackFailed.map(normalizeFailedRecord), ...feedbackRecords]
      feedbackList.textContent = ''
      if (!items.length) {
        const empty = document.createElement('li')
        empty.className = 'feedback-empty'
        empty.textContent = '还没有反馈记录'
        feedbackList.append(empty)
        return
      }
      items.forEach((item, index) => {
        feedbackList.append(buildFeedbackItem(item, index))
      })
    }

    /** 一条记录：摘要常显，正文与管理员回复展开后可见 */
    function buildFeedbackItem(item, index) {
      const li = document.createElement('li')
      li.className = 'feedback-item'

      const top = document.createElement('div')
      top.className = 'feedback-item-top'
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = FEEDBACK_CATEGORY_LABEL[item.category] || FEEDBACK_CATEGORY_LABEL.other
      const pill = document.createElement('span')
      pill.className = `status-pill ${item.failed ? 'error' : item.status === 'resolved' ? 'done' : 'queued'}`
      pill.textContent = item.failed ? '提交失败' : item.status === 'resolved' ? '已处理' : '未处理'
      const time = document.createElement('span')
      time.className = 'feedback-item-meta'
      time.textContent = formatDateTime(item.createdAt)
      top.append(badge, pill, time)

      const summary = document.createElement('p')
      summary.className = 'feedback-item-text'
      summary.textContent = shorten(item.content, 60)

      const facts = document.createElement('p')
      facts.className = 'feedback-item-meta'
      facts.textContent = [
        item.appVersion ? `版本 ${item.appVersion}` : '',
        item.page ? `页面 ${item.page}` : '',
      ].filter(Boolean).join(' · ')

      const detailId = `feedback-detail-${index}`
      /* 外层只负责承载 hidden="until-found"：样式都放在内层，
         免得 display 之类直接盖在隐藏元素上让页内查找失效 */
      const detail = document.createElement('div')
      detail.className = 'feedback-item-detail'
      detail.id = detailId
      const detailInner = document.createElement('div')
      detailInner.className = 'feedback-item-detail-inner'

      const full = document.createElement('p')
      full.className = 'feedback-item-full'
      full.textContent = item.content
      detailInner.append(full)

      if (item.failed) {
        const reason = document.createElement('p')
        reason.className = 'feedback-item-reason'
        reason.textContent = item.reason ? `未送达：${item.reason}` : '未送达服务器'
        detailInner.append(reason)
      }

      if (item.reply) {
        const reply = document.createElement('div')
        reply.className = 'feedback-item-reply'
        const replyTitle = document.createElement('p')
        replyTitle.className = 'feedback-item-reply-title'
        replyTitle.textContent = '管理员回复'
        const replyText = document.createElement('p')
        replyText.className = 'feedback-item-reply-text'
        replyText.textContent = item.reply
        reply.append(replyTitle, replyText)
        const replyMeta = document.createElement('p')
        replyMeta.className = 'feedback-item-meta'
        replyMeta.textContent = [
          item.repliedAt ? `回复于 ${formatDateTime(item.repliedAt)}` : '',
          item.repliedBy ? `处理人 ${item.repliedBy}` : '',
        ].filter(Boolean).join(' · ')
        if (replyMeta.textContent) reply.append(replyMeta)
        detailInner.append(reply)
      }
      detail.append(detailInner)

      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'button ghost feedback-item-toggle'
      toggle.setAttribute('aria-controls', detailId)
      const expanded = feedbackExpanded.has(item.key)
      toggle.setAttribute('aria-expanded', String(expanded))
      toggle.textContent = expanded ? '收起详情' : '查看详情'
      setFeedbackPanelHidden(detail, !expanded)
      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') === 'true'
        toggle.setAttribute('aria-expanded', String(!open))
        toggle.textContent = open ? '查看详情' : '收起详情'
        setFeedbackPanelHidden(detail, open)
        if (open) feedbackExpanded.delete(item.key)
        else feedbackExpanded.add(item.key)
      })
      /* 页内查找命中时浏览器会展开这块内容，按钮状态跟着改 */
      detail.addEventListener('beforematch', () => {
        toggle.setAttribute('aria-expanded', 'true')
        toggle.textContent = '收起详情'
        feedbackExpanded.add(item.key)
      })

      li.append(top, summary, facts, toggle, detail)

      if (item.failed) {
        const actions = document.createElement('div')
        actions.className = 'feedback-item-actions'
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.className = 'button ghost feedback-item-retry'
        retry.textContent = '重试提交'
        retry.disabled = feedbackSubmitting
        retry.addEventListener('click', () => retryFailedFeedback(item))
        actions.append(retry)
        li.append(actions)
      }

      return li
    }

    document.querySelector('#feedback-button')?.addEventListener('click', event => {
      event.stopPropagation()
      avatarMenu.close()
      openFeedbackModal()
    })

    document.querySelector('#feedback-close')?.addEventListener('click', closeFeedbackModal)
    document.querySelector('#feedback-cancel')?.addEventListener('click', closeFeedbackModal)
    feedbackModal?.addEventListener('click', event => {
      if (event.target === feedbackModal) closeFeedbackModal()
    })

    document.querySelector('#feedback-form')?.addEventListener('submit', submitFeedbackFromForm)

    document.querySelector('#feedback-history-refresh')?.addEventListener('click', () => {
      loadMyFeedback()
    })

    feedbackHistoryToggle?.addEventListener('click', () => {
      const open = feedbackHistoryToggle.getAttribute('aria-expanded') === 'true'
      setFeedbackHistoryOpen(!open)
    })

    feedbackContent?.addEventListener('input', () => {
      feedbackCount.textContent = String(feedbackContent.value.length)
      if (feedbackMsg.textContent) {
        feedbackMsg.textContent = ''
        feedbackContent.classList.remove('invalid')
        feedbackContent.removeAttribute('aria-invalid')
      }
      scheduleFeedbackDraftSave()
    })

    feedbackCategories?.addEventListener('click', event => {
      const option = event.target.closest('[data-feedback-category]')
      const next = option?.dataset.feedbackCategory
      if (!FEEDBACK_CATEGORIES.includes(next)) return
      feedbackCategory = next
      renderFeedbackModal()
      scheduleFeedbackDraftSave()
    })

    /* radiogroup 的方向键：选中项跟着焦点走，和 aria-activedescendant 无关 */
    feedbackCategories?.addEventListener('keydown', event => {
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
      if (!step) return
      event.preventDefault()
      const index = FEEDBACK_CATEGORIES.indexOf(feedbackCategory)
      feedbackCategory = FEEDBACK_CATEGORIES[(index + step + FEEDBACK_CATEGORIES.length) % FEEDBACK_CATEGORIES.length]
      renderFeedbackModal()
      scheduleFeedbackDraftSave()
      feedbackCategories.querySelector(`[data-feedback-category="${feedbackCategory}"]`)?.focus()
    })

    /* 刷新或关页面前把草稿落盘，避免最后一次输入来不及存 */
    window.addEventListener('pagehide', () => {
      saveFeedbackDraft()
    })

    /* ===== 关于与更新 ===== */

    /* 版本号与反馈同源：vite.config.ts 从 web/package.json 注入 */
    const ABOUT_VERSION_LABEL = `v${FEEDBACK_APP_VERSION}`
    /* 首屏还在抢请求，晚 6 秒再问更新；同一标签页 2 小时内不重复问，
       否则反复开页面会把更新接口打成热点 */
    const ABOUT_AUTO_CHECK_DELAY = 6000
    const ABOUT_CHECK_INTERVAL = 2 * 60 * 60 * 1000
    const ABOUT_LAST_CHECK_KEY = 'huajing.update.lastCheckAt'

    const aboutModal = document.querySelector('#about-modal')
    const aboutClose = document.querySelector('#about-close')
    const aboutCurrent = document.querySelector('#about-current')
    const aboutStatus = document.querySelector('#about-status')
    const aboutNotesWrap = document.querySelector('#about-notes-wrap')
    const aboutNotesTitle = document.querySelector('#about-notes-title')
    const aboutNotes = document.querySelector('#about-notes')
    const aboutMsg = document.querySelector('#about-msg')
    const aboutDownload = document.querySelector('#about-download')
    const aboutRecheck = document.querySelector('#about-recheck')
    const aboutMenuLabel = document.querySelector('#about-menu-label')
    const aboutMenuVersion = document.querySelector('#about-menu-version')
    const avatarButton = document.querySelector('#user-avatar')

    let aboutOverlayHandle = null
    let aboutChecking = false

    if (aboutMenuVersion) aboutMenuVersion.textContent = ABOUT_VERSION_LABEL
    if (aboutCurrent) aboutCurrent.textContent = ABOUT_VERSION_LABEL

    function markUpdateChecked() {
      try {
        sessionStorage.setItem(ABOUT_LAST_CHECK_KEY, String(Date.now()))
      } catch {
        // 隐私模式禁用 sessionStorage，没记住就当没有节流
      }
    }

    /** 只在成功检查后记时间：失败往往是临时的，不该把它锁两小时 */
    function shouldAutoCheck() {
      try {
        const last = Number(sessionStorage.getItem(ABOUT_LAST_CHECK_KEY) || 0)
        return !last || Date.now() - last > ABOUT_CHECK_INTERVAL
      } catch {
        return true
      }
    }

    /** 把一次检查结果铺到弹窗与头像上：成功、无更新、有更新、失败四种落点 */
    function applyUpdateStatus(info) {
      if (!info) return
      const latest = info.latestVersion ? `v${info.latestVersion}` : ''
      const hasUpdate = Boolean(info.hasUpdate && info.latestVersion)

      if (aboutStatus) {
        if (info.error) aboutStatus.textContent = '检查失败'
        else if (info.disabled) aboutStatus.textContent = '当前版本未开启更新检查'
        else if (hasUpdate) aboutStatus.textContent = `有新版本 ${latest}`
        else aboutStatus.textContent = '已是最新版本'
      }

      if (aboutMsg) aboutMsg.textContent = info.error || ''

      // 只要拿到了最新版本信息就展示它的更新日志，不只限于「有新版本」
      if (aboutNotesWrap && aboutNotes) {
        aboutNotesWrap.hidden = !latest
        if (aboutNotesTitle) {
          aboutNotesTitle.textContent = latest ? `最新版本 ${latest} 的更新内容` : '更新内容'
        }
        // 纯文本写入：releaseNotes 来自外部源，不能当 HTML 解析
        aboutNotes.textContent = String(info.releaseNotes || '').trim() || '这个版本没有提供更新说明'
      }

      if (aboutDownload) {
        const url = hasUpdate ? info.downloadUrl || info.pageUrl : ''
        aboutDownload.hidden = !url
        aboutDownload.href = url || '#'
        aboutDownload.textContent = info.downloadUrl ? '下载安装包' : '前往发布页'
      }

      avatarButton?.classList.toggle('has-update-dot', hasUpdate)
      if (aboutMenuLabel) {
        aboutMenuLabel.textContent = hasUpdate ? `有新版本 ${latest}` : '关于画境'
      }
    }

    async function checkUpdate(force = false) {
      if (aboutChecking) return
      aboutChecking = true
      if (aboutRecheck) aboutRecheck.disabled = true
      if (aboutStatus) aboutStatus.textContent = '正在检查更新…'
      if (aboutMsg) aboutMsg.textContent = ''
      try {
        const info = await getUpdateStatus(force)
        markUpdateChecked()
        applyUpdateStatus(info)
      } catch (error) {
        if (aboutStatus) aboutStatus.textContent = '检查失败'
        // 网络层抛的是 TypeError，直接显示 message 会是英文
        if (aboutMsg) {
          aboutMsg.textContent = error instanceof ApiRequestError
            ? error.message
            : '无法连接更新服务，请检查网络后重试'
        }
      } finally {
        aboutChecking = false
        if (aboutRecheck) aboutRecheck.disabled = false
      }
    }

    function silentUpdateCheck() {
      if (!shouldAutoCheck()) return
      getUpdateStatus(false)
        .then(info => {
          markUpdateChecked()
          applyUpdateStatus(info)
        })
        .catch(() => {})
    }

    function openAboutModal() {
      if (!aboutModal) return
      aboutModal.classList.add('visible')
      // 关闭时已经释放句柄，这里每次打开都重新登记：焦点才会重新落到关闭按钮上
      if (!aboutOverlayHandle) {
        aboutOverlayHandle = activateOverlay(aboutModal, {
          onRequestClose: closeAboutModal,
          // 「重新检查」在检查期间会被 disable，不能当初始焦点
          initialFocus: aboutClose,
        })
      }
      checkUpdate(false)
    }

    function closeAboutModal() {
      aboutOverlayHandle?.release()
      aboutOverlayHandle = null
      aboutModal?.classList.remove('visible')
    }

    document.querySelector('#about-button')?.addEventListener('click', event => {
      event.stopPropagation()
      avatarMenu.close()
      openAboutModal()
    })

    document.querySelector('#about-close')?.addEventListener('click', closeAboutModal)
    aboutModal?.addEventListener('click', event => {
      if (event.target === aboutModal) closeAboutModal()
    })
    aboutRecheck?.addEventListener('click', () => checkUpdate(true))

    setTimeout(silentUpdateCheck, ABOUT_AUTO_CHECK_DELAY)
