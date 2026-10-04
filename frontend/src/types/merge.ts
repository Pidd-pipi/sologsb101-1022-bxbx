/** 对账合并相关的类型定义：待处理项、导入批次记录与合并结果 */

/** 参与对账的实体种类 */
export type MergeEntityKind = 'formula' | 'material' | 'proportion' | 'batch' | 'cellar' | 'tasting'

/** 待处理项成因：两边同编号内容冲突 / 子记录暂无父批次可归属 */
export type MergePendingReason = 'conflict' | 'orphan'

/** 待处理项状态：待选定 / 已采用导入版 / 已丢弃导入版 */
export type MergePendingStatus = 'pending' | 'adopted' | 'discarded'

/**
 * 对账待处理项：同编号两边内容不一致时保留的导入版，
 * 或暂时归属不到批次的窖藏 / 品香记录。
 */
export interface MergePendingItem {
  id: string
  /** 同一次导入的批次号，便于按导入批次回查 */
  importBatchId: string
  kind: MergeEntityKind
  /** 稳定业务编号 */
  bizNo: string
  /** 导入版记录数据（已规范化，父引用尽量解析为本地 id） */
  data: Record<string, unknown>
  reason: MergePendingReason
  /** orphan 时缺失的父级业务编号，如「批次 B-xxx」 */
  missingRef?: string
  /** 供制香师辨识的文案 */
  label: string
  status: MergePendingStatus
  createdAt: number
  resolvedAt?: number
}

/** 单次导入的四类计数 */
export interface MergeImportCounts {
  /** 仅单边出现、直接建档的条数 */
  inserted: number
  /** 同编号两边冲突、保留两版待选定的条数 */
  conflicts: number
  /** 归属不到批次、暂挂待处理的条数 */
  orphans: number
  /** 两边一致、无需写入的条数 */
  skipped: number
}

/** 导入批次历史记录（localStorage 持久化，失败也留下待处理清单） */
export interface MergeImportRecord {
  id: string
  fileName: string
  importedAt: string
  status: 'success' | 'failed'
  counts: MergeImportCounts
  /** 失败原因，status=failed 时存在 */
  error?: string
}

/** 一次对账合并的结果 */
export interface MergeResult {
  importBatchId: string
  fileName: string
  counts: MergeImportCounts
  /** 本次产生的待处理项 */
  pending: MergePendingItem[]
}
