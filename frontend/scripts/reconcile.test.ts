import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, rmSync } from 'node:fs'
import { strict as assert } from 'node:assert'

/**
 * 内存级对账引擎测试：
 * 用 esbuild 把 @/utils/db（依赖浏览器 IndexedDB）替换为内存假 db，
 * 只验证纯业务规则：单边建档 / 冲突两版 / 快照固化 / 孤儿挂起 / 旧档补号 / 整批回滚。
 */
const tables = ['formulas', 'materials', 'proportions', 'batches', 'cellars', 'tastings'] as const
type TName = (typeof tables)[number]
const stores = new Map<TName, Map<string, any>>()
tables.forEach((name) => stores.set(name, new Map()))

function makeDb() {
  const t: Record<string, any> = {}
  tables.forEach((name) => {
    const map = stores.get(name)!
    t[name] = {
      async bulkPut(rows: any[]) { rows.forEach((r) => map.set(r.id, r)) },
      async get(id: string) { return map.get(id) },
      async toArray() { return [...map.values()] },
      async put(r: any) { map.set(r.id, r) }
    }
  })
  return {
    ...t,
    transaction: async (_m: string, _x: unknown[], fn: () => Promise<void>) => fn()
  }
}

const mockDbSource = `
export const DB_VERSION = 2
export function createId(p: string) { return p + '_' + Math.random().toString(36).slice(2, 8) }
export const db = globalThis.__fakeDb
export async function exportSnapshot() {
  const keys = ['formulas','materials','proportions','batches','cellars','tastings']
  const out = { app: 'gbincense', dbVersion: 2, exportedAt: new Date().toISOString() }
  for (const k of keys) out[k] = await db[k].toArray()
  return out
}
`

const entry = `
import {
  normalizeSnapshot, buildReconcilePlan, commitReconcilePlan, attachOrphanRecord, ReconcileValidationError
} from '${process.cwd()}/src/utils/reconcile.ts'
import assert from 'node:assert'

const tables = ['formulas','materials','proportions','batches','cellars','tastings']
const get = (k, id) => globalThis.__stores.get(k).get(id)
const size = (k) => globalThis.__stores.get(k).size

function formula(id, over = {}) {
  return { id, name: '香方' + id, scentType: '线香', usage: '静室', createdAt: '2024-01-01', totalRatio: 100, state: '在用', updatedAt: 1, ...over }
}

async function main() {
  // 本地：香方 F1（旧名）、批次 B1 已固化快照、香方 F-LOCAL
  globalThis.__stores.get('formulas').set('F1', formula('F1', { name: '本地安神香', updatedAt: 100 }))
  globalThis.__stores.get('formulas').set('F-LOCAL', formula('F-LOCAL'))
  globalThis.__stores.get('batches').set('B1', {
    id: 'B1', formulaId: 'F1', mixedAt: '2024-04-01', formingMethod: '挤条', quantity: 320,
    operator: '林砚舟', snapshot: [{ materialId: 'M1', materialName: '沉香', ratio: 45, role: '君' }],
    snapshotAt: 111, updatedAt: 100
  })

  const backup = {
    app: 'gbincense', dbVersion: 2, exportedAt: '2024-05-01T00:00:00Z',
    formulas: [
      formula('F1', { name: '作坊改名安神香', updatedAt: 200 }),
      formula('F2') // 单边新增
    ],
    materials: [],
    proportions: [],
    batches: [
      // 同编号冲突：operator/quantity 不同；快照内容也不同，但快照不应成为冲突点、也不能改本地
      { id: 'B1', formulaId: 'F1', mixedAt: '2024-04-01', formingMethod: '压模', quantity: 500,
        operator: '作坊学徒', snapshot: [{ materialId: 'M9', materialName: '不该出现', ratio: 9, role: '使' }],
        snapshotAt: 222, updatedAt: 200 }
    ],
    cellars: [
      { id: 'C-ORPHAN', batchId: 'B-GHOST', startDate: '2024-04-05', endDate: '2024-10-05',
        temperatureC: 22, humidityPct: 60, container: '陶罐', state: '窖藏中', updatedAt: 200 }
    ],
    tastings: [
      { id: 'T1', batchId: 'B1', tastedAt: '2024-07-01', aroma: '清甜', lastingMin: 60, smokeScore: 9, comment: '', updatedAt: 200 }
    ]
  }

  const { snapshot, backfills } = normalizeSnapshot(backup)
  assert.equal(backfills.length, 0, '编号齐全时不应补号')
  const plan = await buildReconcilePlan(snapshot, [], '作坊备份.json')

  // 规则 1：单边出现直接建档
  assert.deepEqual(plan.inserts.formulas, ['F2'])
  assert.deepEqual(plan.inserts.tastings, ['T1'])
  // 规则 2：同编号两边不同 → 冲突两版
  const fConflict = plan.conflicts.find((c) => c.id === 'F1')
  assert.ok(fConflict, 'F1 应产生冲突')
  assert.equal(fConflict!.choice, null)
  const bConflict = plan.conflicts.find((c) => c.id === 'B1')
  assert.ok(bConflict, 'B1 应产生冲突')
  const formDiff = bConflict!.diffs.find((d) => d.field === 'formingMethod')
  assert.ok(formDiff)
  assert.ok(!bConflict!.diffs.some((d) => d.field.startsWith('snapshot')), '快照字段不参与冲突')
  // 规则 3：孤儿窖藏（批次在两边都不存在）
  assert.equal(plan.orphanRecords.length, 1)
  assert.equal(plan.orphanRecords[0].table, 'cellars')

  // 规则 4：未选定冲突 → 整批回滚
  await assert.rejects(() => commitReconcilePlan(plan), (e: any) => e instanceof ReconcileValidationError)
  assert.equal(size('formulas'), 2, '回滚后本地香方仍为 2 条')
  assert.equal(get('formulas', 'F1').name, '本地安神香', '回滚后本地香方名不变')

  // 制香师选定：F1 用备份版；B1 也选备份版（但快照必须保留本地）
  fConflict!.choice = 'incoming'
  bConflict!.choice = 'incoming'
  await commitReconcilePlan(plan)

  assert.equal(size('formulas'), 3, '合并后香方 3 条（F1/F-LOCAL/F2）')
  assert.equal(get('formulas', 'F1').name, '作坊改名安神香', 'F1 采用备份版字段')
  const b1 = get('batches', 'B1')
  assert.equal(b1.formingMethod, '压模', 'B1 业务字段采用备份版')
  assert.equal(b1.quantity, 500)
  // 规则 5：固化快照不能跟着改
  assert.equal(b1.snapshot[0].materialId, 'M1', '快照必须保留本地固化版')
  assert.equal(b1.snapshotAt, 111, 'snapshotAt 必须保留本地固化版')
  // 规则 6：孤儿未入库；T1 已入库
  assert.equal(size('cellars'), 0, '孤儿窖藏归属前不入库')
  assert.ok(get('tastings', 'T1'))

  // 规则 7：孤儿归属到批次后并入
  await attachOrphanRecord('cellars', plan.orphanRecords[0].record, 'B1')
  const attached = get('cellars', 'C-ORPHAN')
  assert.ok(attached)
  assert.equal(attached.batchId, 'B1', '归属后 batchId 指向真实批次')

  // 规则 8：旧备份缺编号 → 先补齐再对账（确定性编号、重复导入不重建）
  const legacy = {
    app: 'gbincense', dbVersion: 1, exportedAt: '2023-01-01',
    formulas: [formula('', { id: '', name: '老香方', updatedAt: 1 })],
    materials: [], proportions: [], batches: [], cellars: [], tastings: []
  }
  const n1 = normalizeSnapshot(legacy)
  const n2 = normalizeSnapshot(legacy)
  assert.equal(n1.backfills.length, 1)
  assert.equal(n1.snapshot.formulas[0].id, n2.snapshot.formulas[0].id, '补号应确定性一致')
  assert.ok(n1.snapshot.formulas[0].id.startsWith('legacy_formula_'))

  // 规则 9：非法枚举 / 引用缺失 → 规范化抛错（调用方整批回滚 + 待处理）
  assert.throws(
    () => normalizeSnapshot({ ...backup, formulas: [formula('F9', { scentType: '非法' as any })] }),
    (e: any) => e instanceof ReconcileValidationError && e.errors.length > 0
  )
  assert.throws(
    () => normalizeSnapshot({ app: 'gbincense', formulas: [], materials: [],
      proportions: [{ id: 'P1', formulaId: 'NOPE', materialId: 'M1', ratio: 50, role: '君', note: '', seq: 1, updatedAt: 1 }],
      batches: [], cellars: [], tastings: [] }),
    (e: any) => /香方/.test(e.errors.join())
  )

  console.log('全部对账引擎断言通过 ✅')
}
main().catch((e) => { console.error(e); process.exit(1) })
`

const outfile = '/tmp/gbincense-reconcile-test.mjs'
writeFileSync('/tmp/__mock_db.ts', mockDbSource)
;(async () => {
await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
  alias: { '@/utils/db': '/tmp/__mock_db.ts' }
})

;(globalThis as any).__stores = stores
;(globalThis as any).__fakeDb = makeDb()
await import(pathToFileURL(outfile).href)
rmSync(outfile, { force: true })
rmSync('/tmp/__mock_db.ts', { force: true })
})()
