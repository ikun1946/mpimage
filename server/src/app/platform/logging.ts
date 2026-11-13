import { createWriteStream } from 'node:fs'
import { join } from 'node:path'

export interface LogSink {
  /** 交给 Fastify logger 的写入口：同时写控制台与当天日志文件 */
  stream: { write(line: string): void }
  /** 关闭底层文件流，保证进程退出前最后几行落盘 */
  close(): Promise<void>
}

/**
 * 日志按天写入 logs/YYYY-MM-DD.log，同时输出到控制台。
 * 流对象本身不变，跨天时在内部换文件，Fastify 抓的是同一个引用。
 */
export function createLogSink(logsDirectory: string): LogSink {
  const today = () => new Date().toISOString().slice(0, 10)

  let filePath = join(logsDirectory, `${today()}.log`)
  let fileStream = createWriteStream(filePath, { flags: 'a' })
  let closed = false

  const stream = {
    write(line: string) {
      process.stdout.write(line)
      if (closed) return
      // 跨天时切到新文件
      const nextPath = join(logsDirectory, `${today()}.log`)
      if (nextPath !== filePath) {
        filePath = nextPath
        fileStream.end()
        fileStream = createWriteStream(nextPath, { flags: 'a' })
      }
      fileStream.write(line)
    },
  }

  return {
    stream,
    close() {
      return new Promise<void>(resolveClose => {
        if (closed) {
          resolveClose()
          return
        }
        closed = true
        try {
          fileStream.end(resolveClose)
        } catch {
          resolveClose()
        }
      })
    },
  }
}
