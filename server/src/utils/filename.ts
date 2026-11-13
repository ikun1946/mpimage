/** 是否可以作为单段文件名/目录名使用（不含路径分隔符与保留字符）。 */
export function isValidFilename(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 80 &&
    !/[<>:"/\\|?*\u0000-\u001f]/.test(value) &&
    value !== '.' &&
    value !== '..'
  )
}
