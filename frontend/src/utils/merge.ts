import { db, createId, createBizNo } from '@/utils/db'
import type { Table } from 'dexie'
import type { Formula } from '@/types/formula'
import type { Material } from '@/types/material'
import type { Proportion } from '@/types/proportion'
import type { Batch, BatchSnapshotItem } from '@/types/batch'
import type { Cellar } from '@/types/cellar'
import type { Tasting } from '@/types/tasting'
import type {
  MergeEntityKind,
  MergeImportCounts,
  MergeImportRecord,
  MergePendingItem,
  MergePendingReason,
  MergeResult
} from '@/types/merge'

/** 归一化后的子记录：附带推导出来的父级稳定业务编号（不持久化） */
type NormalizedProportion = Proportion & { _formulaBizNo: string; _materialBizNo: string }
type NormalizedBatch = Batch & { _formulaBizNo: string }
type NormalizedCellar = Cellar & { _batchBizNo: string }
type NormalizedTasting = Tasting & { _batchBizNo: string }

interface NormalizedSnapshot {
  formulas: Formula[]
  materials: Material[]
  proportions: NormalizedProportion[]
  batches: NormalizedBatch[]
  cellars: NormalizedCellar[]
  tastings: NormalizedTasting[]
}

const IMPORT_HISTORY_KEY = 'gbincense:merge-imports'
const MAX_IMPORT_HISTORY = 20

const KIND_LABEL: Record<MergeEntityKind, string> = {
  formula: '香方',
  material: '香料',
  proportion: '配比',
  batch: '批次',
  cellar: '窖藏',
  tasting: '品香'
}

const KIND_BIZ_PREFIX: Record<MergeEntityKind, string> = {
  formula: 'F',
  material: 'M',
  proportion: 'P',
  batch: 'B',
  cellar: 'C',
  tasting: 'T'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function sameText(a: unknown, b: unknown): boolean {
  return asString(a) === asString(b)
}

function sameNumber(a: unknown, b: unknown): boolean {
  return asNumber(a) === asNumber(b)
}

/** 批次快照的可比键：按 香料名 + 占比 + 角色 序列化，忽略香料本地 id 差异 */
function snapshotKey(snapshot: BatchSnapshotItem[]): string {
  return (Array.isArray(snapshot) ? snapshot : [])
    .map((item) => `${asString(item.materialName)}|${asNumber(item.ratio)}|${asString(item.role)}`)
    .sort()
    .join(';;')
}

/** 归一化单条记录：补齐 bizNo，返回新对象与错误信息 */
function normalizeRecord<T extends { bizNo?: string }>(
  raw: unknown,
  kind: MergeEntityKind,
  index: number,
  errors: string[]
): T | null {
  if (!isRecord(raw)) {
    errors.push(`${KIND_LABEL[kind]}[${index}] 不是合法对象`)
    return null
  }
  const record = { ...raw } as T
  if (typeof record.bizNo !== 'string' || record.bizNo.length === 0) {
    record.bizNo = createBizNo(KIND_BIZ_PREFIX[kind])
  }
  return record
}

/**
 * 归一化全量快照：为缺编号的旧备份补齐 bizNo，
 * 并由父记录的 id 推导出子记录的父级 bizNo（仅合并过程使用，不落库）。
 */
function normalizeSnapshot(input: unknown): { snapshot: NormalizedSnapshot | null; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(input)) {
    return { snapshot: null, errors: ['文件内容不是合法的 JSON 对象'] }
  }
  if (input.app !== 'gbincense') {
    errors.push('app 字段应为 gbincense，文件来源不明')
  }
  const keys = ['formulas', 'materials', 'proportions', 'batches', 'cellars', 'tastings'] as const
  keys.forEach((key) => {
    if (!Array.isArray(input[key])) errors.push(`${key} 字段缺失或不是数组`)
  })
  if (errors.length > 0) return { snapshot: null, errors }

  const formulas: Formula[] = []
  const materials: Material[] = []
  const proportions: NormalizedProportion[] = []
  const batches: NormalizedBatch[] = []
  const cellars: NormalizedCellar[] = []
  const tastings: NormalizedTasting[] = []

  const formulaIdToBiz = new Map<string, string>()
  const materialIdToBiz = new Map<string, string>()
  const batchIdToBiz = new Map<string, string>()

  ;(input.formulas as unknown[]).forEach((raw, index) => {
    const record = normalizeRecord<Formula>(raw, 'formula', index, errors)
    if (record) {
      formulas.push(record)
      formulaIdToBiz.set(record.id, record.bizNo)
    }
  })
  ;(input.materials as unknown[]).forEach((raw, index) => {
    const record = normalizeRecord<Material>(raw, 'material', index, errors)
    if (record) {
      materials.push(record)
      materialIdToBiz.set(record.id, record.bizNo)
    }
  })
  ;(input.batches as unknown[]).forEach((raw, index) => {
    const record = normalizeRecord<Batch>(raw, 'batch', index, errors)
    if (record) {
      const formulaId = asString(record.formulaId)
      const _formulaBizNo = formulaIdToBiz.get(formulaId) ?? ''
      batches.push({ ...record, _formulaBizNo })
      batchIdToBiz.set(record.id, record.bizNo)
    }
  })
  ;(input.proportions as unknown[]).forEach((raw, index) => {
    const record = normalizeRecord<Proportion>(raw, 'proportion', index, errors)
    if (record) {
      const formulaId = asString(record.formulaId)
      const materialId = asString(record.materialId)
      const _formulaBizNo = formulaIdToBiz.get(formulaId) ?? ''
      const _materialBizNo = materialIdToBiz.get(materialId) ?? ''
      proportions.push({ ...record, _formulaBizNo, _materialBizNo })
    }
  })
  ;(input.cellars as unknown[]).forEach((raw, index) => {
    const record = normalizeRecord<Cellar>(raw, 'cellar', index, errors)
    if (record) {
      const batchId = asString(record.batchId)
      const _batchBizNo = batchIdToBiz.get(batchId) ?? ''
      cellars.push({ ...record, _batchBizNo })
    }
  })
  ;(input.tastings as unknown[]).forEach((raw, index) => {
    const record = normalizeRecord<Tasting>(raw, 'tasting', index, errors)
    if (record) {
      const batchId = asString(record.batchId)
      const _batchBizNo = batchIdToBiz.get(batchId) ?? ''
      tastings.push({ ...record, _batchBizNo })
    }
  })

  return {
    snapshot: { formulas, materials, proportions, batches, cellars, tastings },
    errors
  }
}

/** 本地三张主表的 id ↔ bizNo 对照，供子记录按自然键比对 */
interface LocalMaps {
  formulaIdToBiz: Map<string, string>
  materialIdToBiz: Map<string, string>
  batchIdToBiz: Map<string, string>
}

async function buildLocalMaps(): Promise<LocalMaps> {
  const [formulas, materials, batches] = await Promise.all([
    db.formulas.toArray(),
    db.materials.toArray(),
    db.batches.toArray()
  ])
  const formulaIdToBiz = new Map<string, string>()
  const materialIdToBiz = new Map<string, string>()
  const batchIdToBiz = new Map<string, string>()
  formulas.forEach((item) => formulaIdToBiz.set(item.id, item.bizNo))
  materials.forEach((item) => materialIdToBiz.set(item.id, item.bizNo))
  batches.forEach((item) => batchIdToBiz.set(item.id, item.bizNo))
  return { formulaIdToBiz, materialIdToBiz, batchIdToBiz }
}

function isSameFormula(a: Formula, b: Formula): boolean {
  return (
    sameText(a.name, b.name) &&
    sameText(a.scentType, b.scentType) &&
    sameText(a.usage, b.usage) &&
    sameText(a.createdAt, b.createdAt) &&
    sameNumber(a.totalRatio, b.totalRatio) &&
    sameText(a.state, b.state)
  )
}

function isSameMaterial(a: Material, b: Material): boolean {
  return (
    sameText(a.name, b.name) &&
    sameText(a.origin, b.origin) &&
    sameText(a.grade, b.grade) &&
    sameText(a.processMethod, b.processMethod) &&
    sameText(a.aromaNote, b.aromaNote) &&
    sameText(a.createdAt, b.createdAt)
  )
}

function isSameProportion(a: NormalizedProportion, b: Proportion, maps: LocalMaps): boolean {
  const bFormulaBiz = maps.formulaIdToBiz.get(b.formulaId) ?? ''
  const bMaterialBiz = maps.materialIdToBiz.get(b.materialId) ?? ''
  return (
    a._formulaBizNo === bFormulaBiz &&
    a._materialBizNo === bMaterialBiz &&
    sameNumber(a.ratio, b.ratio) &&
    sameText(a.role, b.role) &&
    sameText(a.note, b.note) &&
    sameNumber(a.seq, b.seq)
  )
}

function isSameBatch(a: NormalizedBatch, b: Batch, maps: LocalMaps): boolean {
  const bFormulaBiz = maps.formulaIdToBiz.get(b.formulaId) ?? ''
  return (
    a._formulaBizNo === bFormulaBiz &&
    sameText(a.mixedAt, b.mixedAt) &&
    sameText(a.formingMethod, b.formingMethod) &&
    sameNumber(a.quantity, b.quantity) &&
    sameText(a.operator, b.operator) &&
    snapshotKey(a.snapshot) === snapshotKey(b.snapshot)
  )
}

function isSameCellar(a: NormalizedCellar, b: Cellar, maps: LocalMaps): boolean {
  const bBatchBiz = maps.batchIdToBiz.get(b.batchId) ?? ''
  return (
    a._batchBizNo === bBatchBiz &&
    sameText(a.startDate, b.startDate) &&
    sameText(a.endDate, b.endDate) &&
    sameNumber(a.temperatureC, b.temperatureC) &&
    sameNumber(a.humidityPct, b.humidityPct) &&
    sameText(a.container, b.container) &&
    sameText(a.state, b.state)
  )
}

function isSameTasting(a: NormalizedTasting, b: Tasting, maps: LocalMaps): boolean {
  const bBatchBiz = maps.batchIdToBiz.get(b.batchId) ?? ''
  return (
    a._batchBizNo === bBatchBiz &&
    sameText(a.tastedAt, b.tastedAt) &&
    sameText(a.aroma, b.aroma) &&
    sameNumber(a.lastingMin, b.lastingMin) &&
    sameNumber(a.smokeScore, b.smokeScore) &&
    sameText(a.comment, b.comment)
  )
}

/** 生成待处理项的辨识文案 */
function labelOf(kind: MergeEntityKind, record: Record<string, unknown>): string {
  const bizNo = asString(record.bizNo)
  switch (kind) {
    case 'formula':
      return `香方「${asString(record.name)}」（${bizNo}）`
    case 'material':
      return `香料「${asString(record.name)}」（${bizNo}）`
    case 'proportion':
      return `配比 ${bizNo}（${asNumber(record.ratio)}%）`
    case 'batch':
      return `批次 ${bizNo}（${asString(record.mixedAt)} · ${asString(record.formingMethod)}）`
    case 'cellar':
      return `窖藏 ${bizNo}（${asString(record.startDate)} 入窖）`
    case 'tasting':
      return `品香 ${bizNo}（${asString(record.tastedAt)} · ${asNumber(record.smokeScore)} 分）`
  }
}

/** 剔除仅用于合并过程的父级 bizNo 临时字段，返回与入参同类型的持久化对象 */
function stripTransient<T extends object>(record: T): T {
  const out = { ...(record as Record<string, unknown>) }
  delete out._formulaBizNo
  delete out._materialBizNo
  delete out._batchBizNo
  return out as T
}

/** 从 localStorage 读取导入历史（失败也保留，作为待处理清单） */
export function listImports(): MergeImportRecord[] {
  try {
    const raw = localStorage.getItem(IMPORT_HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as MergeImportRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function recordImport(rec: MergeImportRecord): void {
  const list = listImports()
  list.unshift(rec)
  try {
    localStorage.setItem(IMPORT_HISTORY_KEY, JSON.stringify(list.slice(0, MAX_IMPORT_HISTORY)))
  } catch {
    // localStorage 写满或不可用时静默失败，不影响对账主流程
  }
}

/** 读取全部待处理项（含已处理），供对账中心展示 */
export async function listPending(): Promise<MergePendingItem[]> {
  return db.mergePending.orderBy('createdAt').reverse().toArray()
}

/**
 * 对账合并：在一个事务内按 香方/香料 → 配比/批次 → 窖藏/品香 的顺序处理。
 * 仅单边出现直接建档；同编号两边不同保留导入版为待处理；归属不到批次的窖藏/品香挂起。
 * 任何一步抛错则整批回滚，不写主表。
 */
async function mergeNormalized(
  snapshot: NormalizedSnapshot,
  fileName: string
): Promise<MergeResult> {
  const importBatchId = createId('import')
  const counts: MergeImportCounts = { inserted: 0, conflicts: 0, orphans: 0, skipped: 0 }
  const pending: MergePendingItem[] = []
  const now = Date.now()

  const makePending = (
    kind: MergeEntityKind,
    record: object,
    reason: MergePendingReason,
    missingRef?: string
  ): void => {
    const rec = record as Record<string, unknown>
    pending.push({
      id: createId('pending'),
      importBatchId,
      kind,
      bizNo: asString(rec.bizNo),
      // 孤儿保留父级 bizNo 临时字段，归属时用于解析父记录；冲突版已解析为本地 id，剔除临时字段
      data: reason === 'orphan' ? { ...rec } : stripTransient(rec),
      reason,
      missingRef,
      label: labelOf(kind, rec),
      status: 'pending',
      createdAt: now
    })
    if (reason === 'conflict') counts.conflicts += 1
    else counts.orphans += 1
  }

  await db.transaction(
    'rw',
    [db.formulas, db.materials, db.proportions, db.batches, db.cellars, db.tastings, db.mergePending],
    async () => {
      // 1. 香料（顶层，配比依赖它）
      for (const raw of snapshot.materials) {
        const existing = await db.materials.where('bizNo').equals(raw.bizNo).first()
        if (!existing) {
          await db.materials.put({ ...raw, id: createId('material'), updatedAt: now })
          counts.inserted += 1
        } else if (!isSameMaterial(raw, existing)) {
          makePending('material', raw, 'conflict')
        } else {
          counts.skipped += 1
        }
      }

      // 2. 香方（顶层，配比与批次依赖它）
      for (const raw of snapshot.formulas) {
        const existing = await db.formulas.where('bizNo').equals(raw.bizNo).first()
        if (!existing) {
          await db.formulas.put({ ...raw, id: createId('formula'), updatedAt: now })
          counts.inserted += 1
        } else if (!isSameFormula(raw, existing)) {
          makePending('formula', raw, 'conflict')
        } else {
          counts.skipped += 1
        }
      }

      // 构建本地 id ↔ bizNo 对照，供子记录按自然键解析父级
      const maps = await buildLocalMaps()

      // 3. 配比（依赖香方与香料）
      for (const raw of snapshot.proportions) {
        const formulaId = [...maps.formulaIdToBiz.entries()].find(([, biz]) => biz === raw._formulaBizNo)?.[0]
        const materialId = [...maps.materialIdToBiz.entries()].find(
          ([, biz]) => biz === raw._materialBizNo
        )?.[0]
        const missing: string[] = []
        if (!formulaId) missing.push(`香方 ${raw._formulaBizNo || '未知'}`)
        if (!materialId) missing.push(`香料 ${raw._materialBizNo || '未知'}`)
        if (missing.length > 0 || !formulaId || !materialId) {
          makePending('proportion', raw, 'orphan', missing.join('，'))
          continue
        }
        const existing = await db.proportions.where('bizNo').equals(raw.bizNo).first()
        if (!existing) {
          await db.proportions.put({
            ...stripTransient(raw),
            id: createId('prop'),
            formulaId,
            materialId,
            updatedAt: now
          })
          counts.inserted += 1
        } else if (!isSameProportion(raw, existing, maps)) {
          // 冲突版保留解析后的本地父引用，便于制香师选定时直接落库
          makePending(
            'proportion',
            { ...raw, formulaId, materialId },
            'conflict'
          )
        } else {
          counts.skipped += 1
        }
      }

      // 4. 批次（依赖香方；快照固化后不随配比改动）
      for (const raw of snapshot.batches) {
        const formulaId = [...maps.formulaIdToBiz.entries()].find(
          ([, biz]) => biz === raw._formulaBizNo
        )?.[0]
        if (!formulaId) {
          makePending('batch', raw, 'orphan', `香方 ${raw._formulaBizNo || '未知'}`)
          continue
        }
        const existing = await db.batches.where('bizNo').equals(raw.bizNo).first()
        if (!existing) {
          // 新批次直接使用导入版快照，不重新计算
          await db.batches.put({
            ...stripTransient(raw),
            id: createId('batch'),
            formulaId,
            updatedAt: now
          })
          counts.inserted += 1
        } else if (!isSameBatch(raw, existing, maps)) {
          makePending('batch', { ...raw, formulaId }, 'conflict')
        } else {
          counts.skipped += 1
        }
      }

      // 重建批次对照（批次可能刚插入）
      const batchMaps = await buildLocalMaps()

      // 5. 窖藏（依赖批次；归属批次前不进台账提醒）
      for (const raw of snapshot.cellars) {
        const batchId = [...batchMaps.batchIdToBiz.entries()].find(
          ([, biz]) => biz === raw._batchBizNo
        )?.[0]
        if (!batchId) {
          makePending('cellar', raw, 'orphan', `批次 ${raw._batchBizNo || '未知'}`)
          continue
        }
        const existing = await db.cellars.where('bizNo').equals(raw.bizNo).first()
        if (!existing) {
          await db.cellars.put({
            ...stripTransient(raw),
            id: createId('cellar'),
            batchId,
            updatedAt: now
          })
          counts.inserted += 1
        } else if (!isSameCellar(raw, existing, batchMaps)) {
          makePending('cellar', { ...raw, batchId }, 'conflict')
        } else {
          counts.skipped += 1
        }
      }

      // 6. 品香（依赖批次；归属批次前不进香方均分）
      for (const raw of snapshot.tastings) {
        const batchId = [...batchMaps.batchIdToBiz.entries()].find(
          ([, biz]) => biz === raw._batchBizNo
        )?.[0]
        if (!batchId) {
          makePending('tasting', raw, 'orphan', `批次 ${raw._batchBizNo || '未知'}`)
          continue
        }
        const existing = await db.tastings.where('bizNo').equals(raw.bizNo).first()
        if (!existing) {
          await db.tastings.put({
            ...stripTransient(raw),
            id: createId('tasting'),
            batchId,
            updatedAt: now
          })
          counts.inserted += 1
        } else if (!isSameTasting(raw, existing, batchMaps)) {
          makePending('tasting', { ...raw, batchId }, 'conflict')
        } else {
          counts.skipped += 1
        }
      }

      // 配比合并后回写香方合计，避免台账显示过期均分
      const allProportions = await db.proportions.toArray()
      const ratioByFormula = new Map<string, number>()
      allProportions.forEach((item) => {
        ratioByFormula.set(item.formulaId, (ratioByFormula.get(item.formulaId) ?? 0) + item.ratio)
      })
      for (const [formulaId, total] of ratioByFormula) {
        await db.formulas.update(formulaId, { totalRatio: Math.round(total * 100) / 100 })
      }

      // 待处理项随主表同一事务写入，失败一起回滚
      if (pending.length > 0) await db.mergePending.bulkPut(pending)
    }
  )

  const result: MergeResult = { importBatchId, fileName, counts, pending }
  recordImport({
    id: importBatchId,
    fileName,
    importedAt: new Date().toISOString(),
    status: 'success',
    counts
  })
  return result
}

/** 归一化 + 对账合并；失败时整批回滚并留下失败清单 */
export async function mergeSnapshotFile(input: unknown, fileName: string): Promise<MergeResult> {
  const { snapshot, errors } = normalizeSnapshot(input)
  if (!snapshot) {
    const message = errors.join('；') || '快照解析失败'
    recordImport({
      id: createId('import'),
      fileName,
      importedAt: new Date().toISOString(),
      status: 'failed',
      counts: { inserted: 0, conflicts: 0, orphans: 0, skipped: 0 },
      error: message
    })
    throw new Error(message)
  }
  try {
    return await mergeNormalized(snapshot, fileName)
  } catch (err) {
    const message = err instanceof Error ? err.message : '对账合并失败'
    recordImport({
      id: createId('import'),
      fileName,
      importedAt: new Date().toISOString(),
      status: 'failed',
      counts: { inserted: 0, conflicts: 0, orphans: 0, skipped: 0 },
      error: message
    })
    throw err
  }
}

/** 取某类实体的本地主表（以宽松类型返回，便于写入导入版数据） */
function tableOf(kind: MergeEntityKind): Table<Record<string, unknown>, string> {
  switch (kind) {
    case 'formula':
      return db.formulas as unknown as Table<Record<string, unknown>, string>
    case 'material':
      return db.materials as unknown as Table<Record<string, unknown>, string>
    case 'proportion':
      return db.proportions as unknown as Table<Record<string, unknown>, string>
    case 'batch':
      return db.batches as unknown as Table<Record<string, unknown>, string>
    case 'cellar':
      return db.cellars as unknown as Table<Record<string, unknown>, string>
    case 'tasting':
      return db.tastings as unknown as Table<Record<string, unknown>, string>
  }
}

/**
 * 采用导入版：同编号下用导入数据覆盖本地主表，
 * 本地版另存为待处理项以便随时切回（保留两版）。
 */
export async function adoptPending(itemId: string): Promise<void> {
  const item = await db.mergePending.get(itemId)
  if (!item || item.status !== 'pending') return
  const table = tableOf(item.kind)
  const now = Date.now()
  const data = item.data

  await db.transaction('rw', [table, db.mergePending], async () => {
    const local = await table.where('bizNo').equals(item.bizNo).first()
    if (!local) {
      await table.put({ ...data, id: createId(item.kind), bizNo: item.bizNo, updatedAt: now })
    } else {
      // 本地版另存为待处理项，保留两版
      const alternate: MergePendingItem = {
        id: createId('pending'),
        importBatchId: item.importBatchId,
        kind: item.kind,
        bizNo: item.bizNo,
        data: local as unknown as Record<string, unknown>,
        reason: 'conflict',
        label: `${KIND_LABEL[item.kind]} ${item.bizNo}（本地版）`,
        status: 'pending',
        createdAt: now
      }
      await db.mergePending.put(alternate)
      await table.put({ ...data, id: local.id, bizNo: item.bizNo, updatedAt: now })
    }
    await db.mergePending.update(itemId, { status: 'adopted', resolvedAt: now })
  })

  // 配比选版后回写香方合计
  if (item.kind === 'proportion') {
    const formulaId = asString(data.formulaId)
    if (formulaId) await recomputeFormulaTotalRatio(formulaId)
  }
}

/** 丢弃导入版：保留本地主表不变 */
export async function discardPending(itemId: string): Promise<void> {
  const item = await db.mergePending.get(itemId)
  if (!item || item.status !== 'pending') return
  await db.mergePending.update(itemId, { status: 'discarded', resolvedAt: Date.now() })
}

/** 配比变动后回写香方合计，避免台账显示过期均分 */
async function recomputeFormulaTotalRatio(formulaId: string): Promise<void> {
  const proportions = await db.proportions.where('formulaId').equals(formulaId).toArray()
  const total = proportions.reduce((sum, item) => sum + item.ratio, 0)
  await db.formulas.update(formulaId, { totalRatio: Math.round(total * 100) / 100 })
}

/**
 * 归属孤儿：把暂无法归属批次的窖藏/品香挂到指定批次，
 * 或把孤儿配比挂到指定香方（香料仍缺失则保持挂起）。
 */
export async function attributeOrphan(itemId: string, targetParentId: string): Promise<void> {
  const item = await db.mergePending.get(itemId)
  if (!item || item.status !== 'pending' || item.reason !== 'orphan') return
  const now = Date.now()
  const data = { ...item.data }

  if (item.kind === 'cellar' || item.kind === 'tasting') {
    const batch = await db.batches.get(targetParentId)
    if (!batch) throw new Error('所选批次不存在')
    data.batchId = batch.id
    data.bizNo = item.bizNo
    await tableOf(item.kind).put({ ...data, id: createId(item.kind), updatedAt: now })
    await db.mergePending.update(itemId, { status: 'adopted', resolvedAt: now })
    return
  }

  if (item.kind === 'batch') {
    const formula = await db.formulas.get(targetParentId)
    if (!formula) throw new Error('所选香方不存在')
    data.formulaId = formula.id
    data.bizNo = item.bizNo
    await db.batches.put({ ...data, id: createId('batch'), updatedAt: now } as unknown as Batch)
    await db.mergePending.update(itemId, { status: 'adopted', resolvedAt: now })
    return
  }

  if (item.kind === 'proportion') {
    const formula = await db.formulas.get(targetParentId)
    if (!formula) throw new Error('所选香方不存在')
    data.formulaId = formula.id
    // 香料仍需存在，否则保持挂起
    const materialBiz = asString(data._materialBizNo ?? data.materialBizNo)
    const material = materialBiz
      ? await db.materials.where('bizNo').equals(materialBiz).first()
      : undefined
    if (!material) {
      await db.mergePending.update(itemId, { missingRef: `香料 ${materialBiz || '未知'}` })
      throw new Error('香料仍缺失，请先在香料库补齐后再归属')
    }
    data.materialId = material.id
    data.bizNo = item.bizNo
    await db.proportions.put({ ...data, id: createId('prop'), updatedAt: now } as unknown as Proportion)
    await db.mergePending.update(itemId, { status: 'adopted', resolvedAt: now })
    await recomputeFormulaTotalRatio(formula.id)
  }
}
