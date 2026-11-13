/**
 * 服务端入口：只负责启动应用，具体装配在 app/main.ts。
 * 启动失败时打印原因并以非零码退出，交给进程管理器或桌面端外壳处理。
 */
import { startServer } from './app/main.js'

startServer().catch(error => {
  console.error('服务启动失败', error)
  process.exit(1)
})
