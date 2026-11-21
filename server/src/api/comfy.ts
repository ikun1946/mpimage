import type { FastifyInstance } from 'fastify'
import { ApiError } from '../app/platform/errors.js'
import { parseComfyConfig, parseApiWorkflow } from '../app/control/comfy-config.js'
import type { SettingsStore } from '../app/control/settings-store.js'
import { convertWorkflow } from '../app/products/images/comfy-convert.js'
import {
  fetchComfySavedWorkflow,
  getComfyObjectInfo,
  listComfySavedWorkflows,
  testComfyConnection,
} from '../app/products/images/comfyui.js'
import { comfyLifecycle } from '../app/products/images/comfy-lifecycle.js'
import { requireAdmin } from './auth.js'

const IMPORT_BODY_LIMIT = 2 * 1024 * 1024

/**
 * ComfyUI 工作流管理接口。
 * 工作流配置独立于 Magpie/自定义供应商保存，避免上游页面的未保存编辑覆盖工作流。
 */
export function registerComfyRoutes(
  app: FastifyInstance,
  deps: { settings: SettingsStore },
): void {
  app.get('/api/admin/comfy', async request => {
    requireAdmin(request)
    return deps.settings.getComfyConfig()
  })

  app.post('/api/admin/comfy', { bodyLimit: IMPORT_BODY_LIMIT }, async (request, reply) => {
    requireAdmin(request)
    const config = parseComfyConfig(request.body)
    await deps.settings.setComfyConfig(config)
    comfyLifecycle.onConfigChanged()
    request.log.info({ count: config.workflows.length }, 'ComfyUI 工作流已更新')
    return reply.send({ ok: true, ...deps.settings.getComfyConfig() })
  })

  /** 服务状态：是否运行、是否由本服务启动、队列与空闲倒计时 */
  app.get('/api/admin/comfy/status', async request => {
    requireAdmin(request)
    return comfyLifecycle.status()
  })

  app.post('/api/admin/comfy/start', async request => {
    requireAdmin(request)
    return comfyLifecycle.start()
  })

  app.post('/api/admin/comfy/stop', async request => {
    requireAdmin(request)
    return comfyLifecycle.stop()
  })

  app.post('/api/admin/comfy/reconnect', async request => {
    requireAdmin(request)
    return comfyLifecycle.reconnect()
  })

  /** 只测 ComfyUI 本身，不触发生成 */
  app.post('/api/admin/comfy/test', async request => {
    requireAdmin(request)
    const body = (request.body ?? {}) as { baseUrl?: unknown }
    const baseUrl = resolveBaseUrl(body.baseUrl, deps.settings)
    const result = await testComfyConnection(baseUrl, 20_000)
    return result
  })

  /** 列出 ComfyUI 用户目录中的 UI 工作流 */
  app.post('/api/admin/comfy/discover', async request => {
    requireAdmin(request)
    const body = (request.body ?? {}) as { baseUrl?: unknown }
    const baseUrl = resolveBaseUrl(body.baseUrl, deps.settings)
    const workflows = await listComfySavedWorkflows(baseUrl, 20_000)
    return { baseUrl, workflows }
  })

  /**
   * 导入并转换成 API 格式。输入二选一：
   * - name: ComfyUI 用户目录里的已保存工作流名称；
   * - workflow: 前端读取的 JSON（UI 画布或 API 格式均可）。
   */
  app.post(
    '/api/admin/comfy/import',
    { bodyLimit: IMPORT_BODY_LIMIT },
    async request => {
      requireAdmin(request)
      try {
      const body = (request.body ?? {}) as {
        baseUrl?: unknown
        name?: unknown
        workflow?: unknown
        label?: unknown
      }
      const baseUrl = resolveBaseUrl(body.baseUrl, deps.settings)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      let raw = body.workflow
      if (name) {
        raw = await fetchComfySavedWorkflow(baseUrl, name, 30_000)
      } else if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw) as unknown
        } catch {
          throw new ApiError('UPSTREAM_INVALID', '工作流 JSON 解析失败', 400)
        }
      }
      if (raw === undefined || raw === null) {
        throw new ApiError('UPSTREAM_INVALID', '请提供工作流文件或 ComfyUI 工作流名称', 400)
      }

      const sourceName = name || (typeof body.label === 'string' ? body.label.trim() : '')
      const fallbackLabel = sourceName
        ? sourceName.replace(/\.json$/i, '').slice(0, 80)
        : 'ComfyUI 工作流'
      const objectInfo = await getComfyObjectInfo(baseUrl, 30_000)
      const converted = convertWorkflow(raw, objectInfo, {
        label: fallbackLabel,
        sourceName: sourceName || undefined,
      })

      // 转换结果仍走一遍保存时的严格校验，避免把坏数据带进管理台
      const validated = parseComfyConfig({
        baseUrl,
        workflows: [
          {
            id: 'imported-workflow',
            label: fallbackLabel,
            enabled: true,
            sourceName: sourceName || undefined,
            workflow: converted.workflow,
            mapping: converted.mapping,
          },
        ],
      }).workflows[0]

      if (!validated) throw new ApiError('UPSTREAM_INVALID', '工作流没有可保存的节点', 400)
      return {
        ok: true,
        baseUrl,
        label: fallbackLabel,
        sourceName: sourceName || '',
        workflow: parseApiWorkflow(validated.workflow, fallbackLabel),
        mapping: validated.mapping,
        nodes: converted.nodes,
        outputNodes: converted.outputNodes,
        warnings: converted.warnings,
        nodeCount: Object.keys(validated.workflow).length,
      }
      } catch (error) {
        request.log.error(
          {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : '',
          },
          'ComfyUI 工作流导入失败',
        )
        throw error
      }
    },
  )
}

function resolveBaseUrl(raw: unknown, settings: SettingsStore): string {
  if (typeof raw === 'string' && raw.trim()) {
    // 保存时空工作流是允许的，借它统一做 URL 校验
    return parseComfyConfig({ baseUrl: raw, workflows: [] }).baseUrl
  }
  return settings.getComfyConfig().baseUrl
}
