import type { Cellar } from './cellar'
import type { Tasting } from './tasting'
import type { IncenseSnapshot } from '@/utils/db'

/** 参与对账的六张业务表 */
export type ReconcileTableKey =
  | 'formulas'
  | 'materials'
  | 'proportions'
  | 'batches'
  | 'cellars'
  | 'tastings'

/** 业务表中文名，冲突卡片与待处理清单复用 */
export const TABLE_LABELS: Record<ReconcileTableKey, string> = {
  formulas: '香方',
  materials: '香料',
  proportions: '配比',
  batches: '和香批次',
  cellars: '窖藏',
  tastings: '品香评鉴'
}

/** 老备份缺编号时的确定性补号前缀 */
export const LEGACY_ID_PREFIX: Record<ReconcileTableKey, string> = {
  formulas: 'legacy_formula',
  materials: 'legacy_material',
  proportions: 'legacy_prop',
  batches: 'legacy_batch',
  cellars: 'legacy_cellar',
  tastings: 'legacy_tasting'
}

/** 一条补编号留痕 */
export interface IdBackfill {
  table: ReconcileTableKey
  /** 补齐后使用的稳定业务编号 */
  id: string
  /** 可辨认的业务描述 */
  label: string
}

/** 冲突字段级差异（快照字段不参与） */
export interface FieldDiff {
  field: string
  label: string
  local: string
  incoming: string
}

export type ConflictChoice = 'local' | 'incoming'

/** 同编号两边不同：保留两版，由制香师选定 */
export interface ReconcileConflict {
  table: ReconcileTableKey
  id: string
  /** 冲突记录的业务标题，如「香方「静室安神线香」」 */
  label: string
  /** 字段级差异，供两版并排展示 */
  diffs: FieldDiff[]
  /**
   * 批次冲突时为 true：本地已固化配比快照，
   * 无论最终选哪版，snapshot / snapshotAt 都保留本地版本。
   */
  frozenSnapshot: boolean
  /** 制香师的选择，未选择前为 null（提交时仍为 null 则整批回滚） */
  choice: ConflictChoice | null
}

/** 找不到归属批次的窖藏 / 品香：先挂起，归属后才并入 */
export interface OrphanRecord {
  table: 'cellars' | 'tastings'
  record: Cellar | Tasting
  label: string
  source: string
}

/** 对账预案：规范化完成后、提交前的完整中间态 */
export interface ReconcilePlan {
  /** 来源文件名或说明 */
  source: string
  generatedAt: number
  /** 规范化后的备份数据 */
  incoming: IncenseSnapshot
  /** 建预案时的本地快照（提交时据此取“本地版”） */
  local: IncenseSnapshot
  /** 老备份补齐的编号留痕 */
  backfills: IdBackfill[]
  /** 同编号两边不同的冲突清单 */
  conflicts: ReconcileConflict[]
  /** 归属不到批次的窖藏 / 品香 */
  orphanRecords: OrphanRecord[]
  /** 各表仅在备份出现、将直接建档的 id */
  inserts: Record<ReconcileTableKey, string[]>
  /** 各表两边一致、无需改动的 id */
  sameIds: Record<ReconcileTableKey, string[]>
}

/** 提交对账后的落库计数 */
export type ReconcileCounts = Record<ReconcileTableKey, number>
