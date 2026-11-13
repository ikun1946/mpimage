import type { FastifyInstance } from 'fastify'
import { ApiError } from '../app/platform/errors.js'
import { requireAuth } from './auth.js'
import type { Project, ProjectStore } from '../app/products/projects/project-store.js'

interface CreateBody {
  name?: unknown
  fileName?: unknown
}

interface UpdateBody {
  name?: unknown
  assets?: unknown
  styles?: unknown
  defaultStyle?: unknown
  bulkParams?: unknown
}

export function registerProjectRoutes(app: FastifyInstance, deps: { projects: ProjectStore }): void {
  // 全部接口按登录账号隔离：只能看到/操作自己的项目
  app.get('/api/projects', async request => {
    const auth = requireAuth(request)
    const { projects, activeProjectId } = await deps.projects.listForOwner(auth.userId)
    return { projects, activeProjectId }
  })

  app.get('/api/projects/:id', async request => {
    const auth = requireAuth(request)
    const project = await ownProject(deps.projects, auth.userId, request)
    return { project }
  })

  app.post('/api/projects', async request => {
    const auth = requireAuth(request)
    const body = (request.body ?? {}) as CreateBody
    const project = await deps.projects.create({
      name: typeof body.name === 'string' ? body.name : undefined,
      fileName: typeof body.fileName === 'string' ? body.fileName : undefined,
      ownerId: auth.userId,
    })
    return { project }
  })

  app.patch('/api/projects/:id', async request => {
    const auth = requireAuth(request)
    await ownProject(deps.projects, auth.userId, request)
    const body = (request.body ?? {}) as UpdateBody

    const patch: Record<string, unknown> = {}
    if (typeof body.name === 'string') patch.name = body.name
    if (body.assets !== undefined) patch.assets = body.assets
    if (body.styles !== undefined) patch.styles = body.styles
    if (body.defaultStyle !== undefined) patch.defaultStyle = body.defaultStyle
    if (body.bulkParams !== undefined) patch.bulkParams = body.bulkParams

    const project = await deps.projects.save(projectId(request), patch)
    if (!project) throw new ApiError('PROJECT_NOT_FOUND', '项目不存在', 404)
    return { project }
  })

  app.delete('/api/projects/:id', async request => {
    const auth = requireAuth(request)
    await ownProject(deps.projects, auth.userId, request)
    const removed = await deps.projects.remove(projectId(request))
    if (!removed) throw new ApiError('PROJECT_NOT_FOUND', '项目不存在', 404)
    return { ok: true }
  })

  app.post('/api/projects/:id/activate', async request => {
    const auth = requireAuth(request)
    await ownProject(deps.projects, auth.userId, request)
    const project = await deps.projects.setActive(projectId(request))
    if (!project) throw new ApiError('PROJECT_NOT_FOUND', '项目不存在', 404)
    return { project }
  })
}

function projectId(request: { params?: unknown }): string {
  return (request.params as { id?: string })?.id ?? ''
}

/** 取指定项目并确认归属当前账号，否则一律按「不存在」处理，避免泄露他人项目。 */
async function ownProject(
  projects: ProjectStore,
  ownerId: string,
  request: { params?: unknown },
): Promise<Project> {
  const project = await projects.find(projectId(request))
  if (!project || (project.ownerId || '') !== ownerId) {
    throw new ApiError('PROJECT_NOT_FOUND', '项目不存在', 404)
  }
  return project
}
