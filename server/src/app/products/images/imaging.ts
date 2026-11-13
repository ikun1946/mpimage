export interface ImageType {
  extension: string
  mimeType: string
}

export function detectImageType(buffer: Buffer): ImageType {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: 'png', mimeType: 'image/png' }
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', mimeType: 'image/jpeg' }
  }

  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { extension: 'webp', mimeType: 'image/webp' }
  }

  throw new Error('Magpie 返回了不支持的图片格式')
}

/**
 * 直接从文件头读取图片像素尺寸，不解码整张图。
 * 用于如实回报交付图片的真实尺寸，而不是声明值。
 */
export function readImageSize(buffer: Buffer): { width: number; height: number } | undefined {
  // PNG: 8 字节签名 + IHDR
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }

  // JPEG: 遍历段标记，SOF0..SOF15 携带尺寸
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = buffer[offset + 1]
      if (marker === undefined) break
      // 填充字节
      if (marker === 0xff) {
        offset++
        continue
      }
      // 无长度字段的标记
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      offset += 2 + length
    }
  }

  // WEBP: RIFF 容器内的 VP8 / VP8L / VP8X
  if (
    buffer.length >= 30 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const format = buffer.toString('ascii', 12, 16)
    if (format === 'VP8 ') {
      return {
        width: (buffer.readUInt16LE(26) ?? 0) & 0x3fff,
        height: (buffer.readUInt16LE(28) ?? 0) & 0x3fff,
      }
    }
    if (format === 'VP8L') {
      const bits = buffer.readUInt32LE(21)
      return {
        width: ((bits ?? 0) & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      }
    }
    if (format === 'VP8X') {
      const width = 1 + ((buffer[24] ?? 0) | ((buffer[25] ?? 0) << 8) | ((buffer[26] ?? 0) << 16))
      const height = 1 + ((buffer[27] ?? 0) | ((buffer[28] ?? 0) << 8) | ((buffer[29] ?? 0) << 16))
      return { width, height }
    }
  }

  return undefined
}
