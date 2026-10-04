import {
  db,
  createId,
  exportSnapshot,
  type IncenseSnapshot
} from '@/utils/db'
import { FORMULA_STATES, SCENT_TYPES, USAGE_SCENES, type Formula } from '@/types/formula'
import { MATERIAL_GRADES, PROCESS_METHODS, type Material } from '@/types/material'
import { PROPORTION_ROLES, type Proportion } from '@/types/proportion'
import { FORMING_METHODS, type Batch, type BatchSnapshotItem } from '@/types/batch'
import { CELLAR_STATES, CELLAR_CONTAINERS, type Cellar } from '@/types/cellar'
import type { Tasting } from '@/types/tasting'
import {
  LEGACY_ID_PREFIX,
  TABLE_LABELS,
  type FieldDiff,
  type IdBackfill,
  type ReconcileConflict,
  type ReconcilePlan,
  type ReconcileCounts,
  type ReconcileTableKey
} from '@/types/reconcile'

const TABLE_KEYS: ReconcileTableKey[] = [
  'formulas',
  'materials',
  'proportions',
  'batches',
  'cellars',
  'tastings'
]

/** 参与对账比对（决定是否冲突）的字段；updatedAt 单列处理，快照字段刻意排除 */
const FIELD_LABELS: Record<string, string> = {
  name: '名称',
  scentType: '香型',
  usage: '用途',
  state: '状态',
  createdAt: '创方日期',
  totalRatio: '配比合计',
  origin: '产地',
  grade: '等级',
  processMethod: '炮制方式',
  aromaNote: '香气特征',
  formulaId: '所属香方',
  materialId: '引用香料',
  ratio: '占比%',
  role: '君臣佐使',
  note: '备注',
  seq: '编排顺序',
  mixedAt: '和香日期',
  formingMethod: '成型方式',
  quantity: '数量',
  operator: '制香人',
  startDate: '入窖日期',
  endDate: '出窖日期',
  temperatureC: '温度℃',
  humidityPct: '湿度%',
  container: '容器',
  batchId: '归属批次',
  tastedAt: '品鉴日期',
  aroma: '香韵',
  lastingMin: '留香分钟',
  smokeScore: '烟气评分',
  comment: '评语'
}

const EMPTY_COUNTS = (): ReconcileCounts => ({
  formulas: 0,
  materials: 0,
  proportions: 0,
  batches: 0,
  cellars: 0,
  tastings: 0
})

const EMPTY_ID_LISTS = (): Record<ReconcileTableKey, string[]> => ({
  formulas: [],
  materials: [],
  proportions: [],
  batches: [],
  cellars: [],
  tastings: []
})

/** 对账规范化阶段的错误（消息即待处理清单的原因） */
export class ReconcileValidationError extends Error {
  errors: string[]
  constructor(errors: string[]) {
    super(errors[0] ?? '备份内容校验未通过')
    this.name = 'ReconcileValidationError'
    this.errors = errors
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function enumValue<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  errors: string[],
  context: string,
  fallback: T
): T {
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    errors.push(`${context} 取值非法：${String(raw)}（允许：${allowed.join('/')}）`)
    return fallback
  }
  return raw as T
}

/** 确定性短哈希，用于老备份缺编号时按业务键派生稳定业务编号 */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** 生成带业务键的确定性编号：重复导入同一份旧备份不会重复建档 */
function legacyId(table: ReconcileTableKey, businessKey: string): string {
  return `${LEGACY_ID_PREFIX[table]}_${stableHash(businessKey)}`
}

/* ------------------------------------------------------------------ */
/* 规范化：旧备份缺编号先补齐，枚举 / 引用非法整批判错                    */
/* ------------------------------------------------------------------ */

function normalizeFormula(raw: unknown, index: number, errors: string[]): Formula {
  const ctx = `formulas[${index}]`
  const name = asString(isRecord(raw) ? raw.name : '').trim()
  if (name.length === 0) errors.push(`${ctx} 缺少 name`)
  return {
    id: asString(isRecord(raw) ? raw.id : ''),
    name,
    scentType: enumValue(isRecord(raw) ? raw.scentType : undefined, SCENT_TYPES, errors, `${ctx} scentType`, '线香'),
    usage: enumValue(isRecord(raw) ? raw.usage : undefined, USAGE_SCENES, errors, `${ctx} usage`, '静室'),
    createdAt: asString(isRecord(raw) ? raw.createdAt : '', '1970-01-01'),
    totalRatio: asNumber(isRecord(raw) ? raw.totalRatio : 0),
    state: enumValue(isRecord(raw) ? raw.state : undefined, FORMULA_STATES, errors, `${ctx} state`, '草稿'),
    updatedAt: asNumber(isRecord(raw) ? raw.updatedAt : 0)
  }
}

function normalizeMaterial(raw: unknown, index: number, errors: string[]): Material {
  const ctx = `materials[${index}]`
  const name = asString(isRecord(raw) ? raw.name : '').trim()
  if (name.length === 0) errors.push(`${ctx} 缺少 name`)
  return {
    id: asString(isRecord(raw) ? raw.id : ''),
    name,
    origin: asString(isRecord(raw) ? raw.origin : '', '未记录'),
    grade: enumValue(isRecord(raw) ? raw.grade : undefined, MATERIAL_GRADES, errors, `${ctx} grade`, '二级'),
    processMethod: enumValue(
      isRecord(raw) ? raw.processMethod : undefined,
      PROCESS_METHODS,
      errors,
      `${ctx} processMethod`,
      '生用'
    ),
    aromaNote: asString(isRecord(raw) ? raw.aromaNote : ''),
    createdAt: asString(isRecord(raw) ? raw.createdAt : '', '1970-01-01'),
    updatedAt: asNumber(isRecord(raw) ? raw.updatedAt : 0)
  }
}

function normalizeProportion(raw: unknown, index: number, errors: string[]): Proportion {
  const ctx = `proportions[${index}]`
  const formulaId = asString(isRecord(raw) ? raw.formulaId : '')
  if (formulaId.length === 0) errors.push(`${ctx} 缺少 formulaId，无法归属香方`)
  const materialId = asString(isRecord(raw) ? raw.materialId : '')
  if (materialId.length === 0) errors.push(`${ctx} 缺少 materialId`)
  const ratio = asNumber(isRecord(raw) ? raw.ratio : 0)
  if (ratio < 0 || ratio > 100) errors.push(`${ctx} ratio 应在 0 ~ 100 之间`)
  return {
    id: asString(isRecord(raw) ? raw.id : ''),
    formulaId,
    materialId,
    ratio,
    role: enumValue(isRecord(raw) ? raw.role : undefined, PROPORTION_ROLES, errors, `${ctx} role`, '君'),
    note: asString(isRecord(raw) ? raw.note : ''),
    seq: asNumber(isRecord(raw) ? raw.seq : index + 1),
    updatedAt: asNumber(isRecord(raw) ? raw.updatedAt : 0)
  }
}

function normalizeSnapshotItems(raw: unknown): BatchSnapshotItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isRecord)
    .map((item) => ({
      materialId: asString(item.materialId),
      materialName: asString(item.materialName, '未知香料'),
      ratio: asNumber(item.ratio, 0),
      role: asString(item.role, '君')
    }))
}

function normalizeBatch(raw: unknown, index: number, errors: string[]): Batch {
  const ctx = `batches[${index}]`
  const formulaId = asString(isRecord(raw) ? raw.formulaId : '')
  if (formulaId.length === 0) errors.push(`${ctx} 缺少 formulaId，无法归属香方`)
  return {
    id: asString(isRecord(raw) ? raw.id : ''),
    formulaId,
    mixedAt: asString(isRecord(raw) ? raw.mixedAt : '', '1970-01-01'),
    formingMethod: enumValue(
      isRecord(raw) ? raw.formingMethod : undefined,
      FORMING_METHODS,
      errors,
      `${ctx} formingMethod`,
      '挤条'
    ),
    quantity: asNumber(isRecord(raw) ? raw.quantity : 0),
    operator: asString(isRecord(raw) ? raw.operator : ''),
    snapshot: normalizeSnapshotItems(isRecord(raw) ? raw.snapshot : undefined),
    snapshotAt: asNumber(isRecord(raw) ? raw.snapshotAt : 0),
    updatedAt: asNumber(isRecord(raw) ? raw.updatedAt : 0)
  }
}

function normalizeCellar(raw: unknown, index: number, errors: string[]): Cellar {
  const ctx = `cellars[${index}]`
  const batchId = asString(isRecord(raw) ? raw.batchId : '')
  if (batchId.length === 0) errors.push(`${ctx} 缺少 batchId，无法归属批次`)
  return {
    id: asString(isRecord(raw) ? raw.id : ''),
    batchId,
    startDate: asString(isRecord(raw) ? raw.startDate : '', '1970-01-01'),
    endDate: asString(isRecord(raw) ? raw.endDate : '', '1970-01-01'),
    temperatureC: asNumber(isRecord(raw) ? raw.temperatureC : 22),
    humidityPct: asNumber(isRecord(raw) ? raw.humidityPct : 60),
    container: enumValue(
      isRecord(raw) ? raw.container : undefined,
      CELLAR_CONTAINERS,
      errors,
      `${ctx} container`,
      '陶罐'
    ),
    state: enumValue(isRecord(raw) ? raw.state : undefined, CELLAR_STATES, errors, `${ctx} state`, '窖藏中'),
    updatedAt: asNumber(isRecord(raw) ? raw.updatedAt : 0)
  }
}

function normalizeTasting(raw: unknown, index: number, errors: string[]): Tasting {
  const ctx = `tastings[${index}]`
  const batchId = asString(isRecord(raw) ? raw.batchId : '')
  if (batchId.length === 0) errors.push(`${ctx} 缺少 batchId，无法归属批次`)
  const smokeScore = asNumber(isRecord(raw) ? raw.smokeScore : 0)
  if (smokeScore < 1 || smokeScore > 10) errors.push(`${ctx} smokeScore 应在 1 ~ 10 之间`)
  return {
    id: asString(isRecord(raw) ? raw.id : ''),
    batchId,
    tastedAt: asString(isRecord(raw) ? raw.tastedAt : '', '1970-01-01'),
    aroma: asString(isRecord(raw) ? raw.aroma : ''),
    lastingMin: asNumber(isRecord(raw) ? raw.lastingMin : 0),
    smokeScore,
    comment: asString(isRecord(raw) ? raw.comment : ''),
    updatedAt: asNumber(isRecord(raw) ? raw.updatedAt : 0)
  }
}

/** 各表规范化结果（id 先留空，下一步统一补编号） */
type NormalizedRows = {
  formulas: Formula[]
  materials: Material[]
  proportions: Proportion[]
  batches: Batch[]
  cellars: Cellar[]
  tastings: Tasting[]
}

/**
 * 把任意备份 JSON 规范化为可对账的快照。
 * 旧备份缺编号时按业务键确定性补齐，补齐留痕通过 backfills 返回。
 * 校验失败抛 ReconcileValidationError（调用方整批回滚并记待处理清单）。
 */
export function normalizeSnapshot(input: unknown): { snapshot: IncenseSnapshot; backfills: IdBackfill[] } {
  const errors: string[] = []
  if (!isRecord(input)) {
    throw new ReconcileValidationError(['文件内容不是合法的 JSON 对象'])
  }
  if (input.app !== undefined && input.app !== 'gbincense') {
    errors.push('app 字段应为 gbincense，文件来源不明')
  }
  TABLE_KEYS.forEach((key) => {
    if (!Array.isArray(input[key])) errors.push(`${key} 字段缺失或不是数组`)
  })
  if (errors.length > 0) throw new ReconcileValidationError(errors)

  const rows: NormalizedRows = {
    formulas: (input.formulas as unknown[]).map((raw, i) => normalizeFormula(raw, i, errors)),
    materials: (input.materials as unknown[]).map((raw, i) => normalizeMaterial(raw, i, errors)),
    proportions: (input.proportions as unknown[]).map((raw, i) => normalizeProportion(raw, i, errors)),
    batches: (input.batches as unknown[]).map((raw, i) => normalizeBatch(raw, i, errors)),
    cellars: (input.cellars as unknown[]).map((raw, i) => normalizeCellar(raw, i, errors)),
    tastings: (input.tastings as unknown[]).map((raw, i) => normalizeTasting(raw, i, errors))
  }
  if (errors.length > 0) throw new ReconcileValidationError(errors)

  const backfills: IdBackfill[] = []
  const seen = new Map<ReconcileTableKey, Set<string>>()
  TABLE_KEYS.forEach((key) => seen.set(key, new Set<string>()))

  // 先补父表，再补子表，保证子表业务键里可以带上补齐后的父编号
  rows.formulas.forEach((row) => assignId('formulas', row, `name=${row.name}|created=${row.createdAt}`, backfills, seen.get('formulas')!))
  rows.materials.forEach((row) =>
    assignId('materials', row, `name=${row.name}|origin=${row.origin}|grade=${row.grade}`, backfills, seen.get('materials')!)
  )
  rows.proportions.forEach((row, i) =>
    assignId('proportions', row, `formula=${row.formulaId}|material=${row.materialId}|${i}`, backfills, seen.get('proportions')!)
  )
  rows.batches.forEach((row, i) =>
    assignId('batches', row, `formula=${row.formulaId}|mixed=${row.mixedAt}|op=${row.operator}|${i}`, backfills, seen.get('batches')!)
  )
  rows.cellars.forEach((row, i) =>
    assignId('cellars', row, `batch=${row.batchId}|start=${row.startDate}|${i}`, backfills, seen.get('cellars')!)
  )
  rows.tastings.forEach((row, i) =>
    assignId('tastings', row, `batch=${row.batchId}|tasted=${row.tastedAt}|${i}`, backfills, seen.get('tastings')!)
  )

  // 引用完整性：配比 / 批次必须能对应到香方（香方缺失无法在台账成档）
  const formulaIds = new Set(rows.formulas.map((row) => row.id))
  rows.proportions.forEach((row, i) => {
    if (!formulaIds.has(row.formulaId)) {
      errors.push(`proportions[${i}] 引用的香方 ${row.formulaId} 在备份与本地香方中均不存在`)
    }
  })
  rows.batches.forEach((row, i) => {
    if (!formulaIds.has(row.formulaId)) {
      errors.push(`batches[${i}] 引用的香方 ${row.formulaId} 在备份与本地香方中均不存在`)
    }
  })
  if (errors.length > 0) throw new ReconcileValidationError(errors)

  return {
    snapshot: {
      app: 'gbincense',
      dbVersion: asNumber(input.dbVersion, 0),
      exportedAt: asString(input.exportedAt, new Date().toISOString()),
      ...rows
    },
    backfills
  }
}

function assignId<T extends { id: string }>(
  table: ReconcileTableKey,
  row: T,
  businessKey: string,
  backfills: IdBackfill[],
  seen: Set<string>
): void {
  if (row.id && row.id.length > 0) {
    if (seen.has(row.id)) {
      throw new ReconcileValidationError([`${TABLE_LABELS[table]}存在重复业务编号 ${row.id}，请先在源头整理后再对账`])
    }
    seen.add(row.id)
    return
  }
  row.id = legacyId(table, businessKey)
  if (seen.has(row.id)) {
    // 业务键哈希碰撞时追加随机编号，避免同一批老记录挤成一条
    row.id = `${row.id}_${createId('x').slice(-4)}`
  }
  seen.add(row.id)
  backfills.push({ table, id: row.id, label: describeRow(table, row) })
}

/* ------------------------------------------------------------------ */
/* 建对账预案                                                           */
/* ------------------------------------------------------------------ */

function describeRow(table: ReconcileTableKey, row: unknown): string {
  if (!isRecord(row)) return TABLE_LABELS[table]
  const name = asString(row.name)
  if (name) return `${TABLE_LABELS[table]}「${name}」`
  const date = asString(row.mixedAt) || asString(row.tastedAt) || asString(row.startDate)
  if (date) return `${TABLE_LABELS[table]}（${date} · 编号 ${asString(row.id).slice(0, 12)}）`
  return `${TABLE_LABELS[table]}（编号 ${asString(row.id).slice(0, 12)}）`
}

function fieldNames(table: ReconcileTableKey): string[] {
  const perTable: Record<ReconcileTableKey, string[]> = {
    formulas: ['name', 'scentType', 'usage', 'createdAt', 'totalRatio', 'state'],
    materials: ['name', 'origin', 'grade', 'processMethod', 'aromaNote', 'createdAt'],
    proportions: ['formulaId', 'materialId', 'ratio', 'role', 'note', 'seq'],
    batches: ['formulaId', 'mixedAt', 'formingMethod', 'quantity', 'operator'],
    cellars: ['batchId', 'startDate', 'endDate', 'temperatureC', 'humidityPct', 'container', 'state'],
    tastings: ['batchId', 'tastedAt', 'aroma', 'lastingMin', 'smokeScore', 'comment']
  }
  return perTable[table]
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return `[${value.length} 项]`
  return String(value)
}

function buildConflict(
  table: ReconcileTableKey,
  id: string,
  localRow: Record<string, unknown>,
  incomingRow: Record<string, unknown>
): ReconcileConflict | null {
  const diffs: FieldDiff[] = []
  fieldNames(table).forEach((field) => {
    const localValue = localRow[field]
    const incomingValue = incomingRow[field]
    if (formatValue(localValue) !== formatValue(incomingValue)) {
      diffs.push({
        field,
        label: FIELD_LABELS[field] ?? field,
        local: formatValue(localValue),
        incoming: formatValue(incomingValue)
      })
    }
  })
  // 仅更新时间不同：自动取较新，不构成需要制香师裁决的冲突
  if (diffs.length === 0) return null
  const localSnapshot = table === 'batches' && isRecord(localRow) && Array.isArray(localRow.snapshot)
    ? (localRow.snapshot as unknown[])
    : []
  return {
    table,
    id,
    label: describeRow(table, incomingRow),
    diffs,
    // 本地已固化非空快照即受保护：无论选哪版，提交时都保留本地 snapshot / snapshotAt
    frozenSnapshot: localSnapshot.length > 0,
    choice: null
  }
}

/** 窖藏 / 品香能否在「本地 ∪ 备份」批次里找到归属；找不到即孤儿 */
function buildOrphans(plan: Pick<ReconcilePlan, 'incoming' | 'orphanRecords'>, batchIds: Set<string>): void {
  plan.incoming.cellars.forEach((record) => {
    if (!batchIds.has(record.batchId)) {
      plan.orphanRecords.push({
        table: 'cellars',
        record,
        label: `${describeRow('cellars', record)}（批次 ${record.batchId.slice(0, 12)} 缺失）`,
        source: plan.incoming.exportedAt
      })
    }
  })
  plan.incoming.tastings.forEach((record) => {
    if (!batchIds.has(record.batchId)) {
      plan.orphanRecords.push({
        table: 'tastings',
        record,
        label: `${describeRow('tastings', record)}（批次 ${record.batchId.slice(0, 12)} 缺失）`,
        source: plan.incoming.exportedAt
      })
    }
  })
}

/**
 * 按稳定业务编号生成对账预案。
 * 单边出现 → inserts（直接建档）；两边一致 → same；同编号不同 → 冲突待选定。
 */
export async function buildReconcilePlan(
  incoming: IncenseSnapshot,
  backfills: IdBackfill[],
  source = '合作作坊备份'
): Promise<ReconcilePlan> {
  const local = await exportSnapshot()
  const plan: ReconcilePlan = {
    source,
    generatedAt: Date.now(),
    incoming,
    local,
    backfills,
    conflicts: [],
    orphanRecords: [],
    inserts: EMPTY_ID_LISTS(),
    sameIds: EMPTY_ID_LISTS()
  }

  TABLE_KEYS.forEach((table) => {
    const localMap = new Map(local[table].map((row) => [row.id, row]))
    incoming[table].forEach((incomingRow) => {
      const localRow = localMap.get(incomingRow.id)
      if (!localRow) {
        plan.inserts[table].push(incomingRow.id)
        return
      }
      const conflict = buildConflict(
        table,
        incomingRow.id,
        localRow as unknown as Record<string, unknown>,
        incomingRow as unknown as Record<string, unknown>
      )
      if (conflict) plan.conflicts.push(conflict)
      else plan.sameIds[table].push(incomingRow.id)
    })
  })

  // 窖藏 / 品香归属闸口：批次必须在本地或备份中存在
  const batchIds = new Set<string>([
    ...local.batches.map((batch) => batch.id),
    ...incoming.batches.map((batch) => batch.id)
  ])
  buildOrphans(plan, batchIds)

  return plan
}

export function planSummary(plan: ReconcilePlan): {
  inserts: number
  conflicts: number
  orphans: number
  backfills: number
  unchanged: number
} {
  return {
    inserts: TABLE_KEYS.reduce((sum, key) => sum + plan.inserts[key].length, 0),
    conflicts: plan.conflicts.length,
    orphans: plan.orphanRecords.length,
    backfills: plan.backfills.length,
    unchanged: TABLE_KEYS.reduce((sum, key) => sum + plan.sameIds[key].length, 0)
  }
}

/* ------------------------------------------------------------------ */
/* 提交：单事务整批落库，任何异常整体回滚                                */
/* ------------------------------------------------------------------ */

/** 选出冲突记录的最终版本；批次冲突时固化快照恒取本地 */
function resolveConflict<T extends { id: string; updatedAt: number }>(
  plan: ReconcilePlan,
  table: ReconcileTableKey,
  incomingRow: T
): T {
  const conflict = plan.conflicts.find((item) => item.table === table && item.id === incomingRow.id)
  const localRow = plan.local[table].find((row) => row.id === incomingRow.id) as T | undefined
  if (!conflict || !localRow) {
    // 两边一致：仅更新时间取较新，业务字段相同
    return incomingRow.updatedAt >= (localRow?.updatedAt ?? 0) ? incomingRow : (localRow ?? incomingRow)
  }
  const chosen = conflict.choice === 'incoming' ? incomingRow : localRow
  const newerUpdatedAt = Math.max(localRow.updatedAt ?? 0, incomingRow.updatedAt ?? 0)
  const resolved = { ...chosen, updatedAt: newerUpdatedAt || Date.now() } as T
  if (table === 'batches') {
    // 固化过的批次配比快照不能跟着改：恒保留本地已固化快照
    const localBatch = localRow as unknown as Batch
    const resolvedBatch = resolved as unknown as Batch
    const localSnapshot = Array.isArray(localBatch.snapshot) ? localBatch.snapshot : []
    if (localSnapshot.length > 0) {
      resolvedBatch.snapshot = localSnapshot
      resolvedBatch.snapshotAt = localBatch.snapshotAt
    }
  }
  return resolved
}

/**
 * 提交对账预案。未决冲突、孤儿记录或任一步骤异常都会导致整批回滚。
 * 孤儿记录不参与写入（已由调用方挂起到待处理清单）。
 */
export async function commitReconcilePlan(plan: ReconcilePlan): Promise<ReconcileCounts> {
  const unresolved = plan.conflicts.filter((conflict) => conflict.choice === null)
  if (unresolved.length > 0) {
    throw new ReconcileValidationError([`还有 ${unresolved.length} 条同编号冲突未由制香师选定，已整批回滚`])
  }
  const orphanSet = new Set(plan.orphanRecords.map((orphan) => orphan.record.id))

  // 合并后的最终数据集：以本地为基底，按预案覆盖 / 追加
  const finalRows: NormalizedRows = {
    formulas: [...plan.local.formulas],
    materials: [...plan.local.materials],
    proportions: [...plan.local.proportions],
    batches: [...plan.local.batches],
    cellars: plan.local.cellars.filter((row) => !orphanSet.has(row.id)),
    tastings: plan.local.tastings.filter((row) => !orphanSet.has(row.id))
  }

  const upsert = <T extends { id: string }>(list: T[], row: T): void => {
    const index = list.findIndex((item) => item.id === row.id)
    if (index >= 0) list[index] = row
    else list.push(row)
  }

  TABLE_KEYS.forEach((table) => {
    plan.incoming[table].forEach((incomingRow) => {
      // 孤儿窖藏 / 品香：归属批次前不入库
      if (orphanSet.has(incomingRow.id)) return
      const resolved = resolveConflict(plan, table, incomingRow) as never
      upsert(finalRows[table] as unknown as { id: string }[], resolved as unknown as { id: string })
    })
  })

  await db.transaction(
    'rw',
    [db.formulas, db.materials, db.proportions, db.batches, db.cellars, db.tastings],
    async () => {
      await db.formulas.bulkPut(finalRows.formulas)
      await db.materials.bulkPut(finalRows.materials)
      await db.proportions.bulkPut(finalRows.proportions)
      await db.batches.bulkPut(finalRows.batches)
      await db.cellars.bulkPut(finalRows.cellars)
      await db.tastings.bulkPut(finalRows.tastings)
    }
  )

  return {
    formulas: finalRows.formulas.length,
    materials: finalRows.materials.length,
    proportions: finalRows.proportions.length,
    batches: finalRows.batches.length,
    cellars: finalRows.cellars.length,
    tastings: finalRows.tastings.length
  }
}

/* ------------------------------------------------------------------ */
/* 待处理清单：孤儿归属并入                                             */
/* ------------------------------------------------------------------ */

/**
 * 把挂起的窖藏 / 品香归属到某个已建档批次后并入库。
 * 仅这一条记录单独事务落库，成功后调用方从待处理清单移除。
 */
export async function attachOrphanRecord(
  table: 'cellars' | 'tastings',
  record: Cellar | Tasting,
  batchId: string
): Promise<void> {
  const target = db[table]
  const batch = await db.batches.get(batchId)
  if (!batch) throw new ReconcileValidationError(['所选批次不存在，无法完成归属'])
  await db.transaction('rw', target, async () => {
    await target.put({ ...record, batchId, updatedAt: Date.now() } as never)
  })
}

/** 待处理清单计数（供页面徽标与测试复用） */
export function emptyCounts(): ReconcileCounts {
  return EMPTY_COUNTS()
}
