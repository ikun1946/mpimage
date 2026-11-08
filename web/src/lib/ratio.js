import { escapeAttr, escapeHtml } from './dom.js'

/**
 * 画面比例的唯一来源。
 * 服务端 /api/config 会返回 ratios（id / label / shortLabel），客户端只做兜底：
 * HTML 静态选项、批量工具栏、行内下拉、资产详情、自由创作都从这里取。
 */
export const FALLBACK_RATIOS = [
  { id: '1:1', label: '1 : 1', shortLabel: '1 : 1' },
  { id: '4:3', label: '4 : 3', shortLabel: '4 : 3' },
  { id: '3:4', label: '3 : 4', shortLabel: '3 : 4' },
  { id: '16:9', label: '16 : 9', shortLabel: '16 : 9' },
  { id: '9:16', label: '9 : 16', shortLabel: '9 : 16' },
  { id: '3:2', label: '3 : 2', shortLabel: '3 : 2' },
  { id: '2:3', label: '2 : 3', shortLabel: '2 : 3' },
  { id: '5:4', label: '5 : 4', shortLabel: '5 : 4' },
  { id: '4:5', label: '4 : 5', shortLabel: '4 : 5' },
  { id: '21:9', label: '21 : 9', shortLabel: '21 : 9' },
  { id: '2:1', label: '2 : 1', shortLabel: '2 : 1' },
  { id: '1:2', label: '1 : 2', shortLabel: '1 : 2' },
  { id: '3:1', label: '3 : 1', shortLabel: '3 : 1' },
  { id: '1:3', label: '1 : 3', shortLabel: '1 : 3' },
]

/** 服务端给了配置就用配置，否则回落到内置列表 */
export function ratioList(ratios) {
  return Array.isArray(ratios) && ratios.length ? ratios : FALLBACK_RATIOS
}

export function ratioExists(id, ratios) {
  return ratioList(ratios).some(ratio => ratio.id === id)
}

/** 下拉用：短标签，选中项由调用方传入 */
export function ratioOptions(selected, ratios) {
  return ratioList(ratios)
    .map(ratio => {
      const label = ratio.shortLabel || ratio.label || ratio.id
      return `<option value="${escapeAttr(ratio.id)}" ${ratio.id === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`
    })
    .join('')
}

/** 纯文本标签：卡片、详情、汇总里显示用 */
export function ratioLabel(id, ratios, { short = false } = {}) {
  const ratio = ratioList(ratios).find(item => item.id === id)
  if (!ratio) return id || ''
  return (short ? ratio.shortLabel : ratio.label) || ratio.label || ratio.id
}