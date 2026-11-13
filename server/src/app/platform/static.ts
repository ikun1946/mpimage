import { access } from 'node:fs/promises'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

/**
 * 前端构建产物的静态托管。
 * 单张工作台已合并进批量页，不再有 index.html，入口检查改为 batch.html；
 * 找不到产物时只记一条警告，API 仍然可以单独使用。
 */
export async function registerStaticRoutes(
  app: FastifyInstance,
  webDirectory: string,
): Promise<void> {
  let registered = false

  try {
    await access(join(webDirectory, 'batch.html'))
    await app.register(fastifyStatic, {
      root: webDirectory,
      prefix: '/',
      decorateReply: false,
      index: ['index.html'],
    })
    registered = true

    // 老地址一律跳批量页
    app.get('/batch', async (_request, reply) => reply.redirect('/batch.html'))
    app.get('/studio', async (_request, reply) => reply.redirect('/batch.html'))
    app.get('/index.html', async (_request, reply) => reply.redirect('/batch.html'))
    app.get('/login', async (_request, reply) => reply.redirect('/login.html'))
    app.get('/admin', async (_request, reply) => reply.redirect('/admin.html'))
  } catch (error) {
    app.log.warn(
      `未找到前端构建产物 ${webDirectory}，仅提供 API：${(error as Error).message}`,
    )
  }

  if (!registered) {
    app.get('/', async (_request, reply) => {
      reply.header('Content-Type', 'text/html; charset=utf-8')
      return reply.send('<h1>画境后端</h1><p>前端请访问 Vite 开发服务，或先执行 npm run build。</p>')
    })
    return
  }

  // 根路径即批量工作台（唯一客户端）
  app.get('/', async (_request, reply) => reply.redirect('/batch.html'))
}
