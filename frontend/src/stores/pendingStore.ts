import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { LS_KEYS } from '@/utils/db'
import type { Cellar } from '@/types/cellar'
import type { Tasting } from '@/types/tasting'
import type { IdBackfill, ReconcileTableKey } from '@/types/reconcile'

/** 待处理事项类型：归属不到批次 / 导入整批回滚 / 旧备份补编号留痕 */
export type PendingKind = 'orphan' | 'import-failure' | 'id-backfill'

export interface PendingItem {
  /** 待处理清单内的稳定编号 */
  key: string
  kind: PendingKind
  /** 涉及的业务表（导入失败时可为 null） */
  table: ReconcileTableKey | null
  /** 可辨认的标题 */
  label: string
  /** 原因 / 错误明细 */
  reason: string
  /** 来源文件名或说明 */
  source: string
  createdAt: number
  /** orphan 专属：挂起的原始窖藏 / 品香记录，归属批次时写回 */
  record?: Cellar | Tasting
  /** orphan 专属：目标批次表，归属时据此落库 */
  orphanTable?: 'cellars' | 'tastings'
  /** 已手工忽略（保留在清单中但不再提醒） */
  ignored: boolean
}

function loadItems(): PendingItem[] {
  try {
    const raw = localStorage.getItem(LS_KEYS.pendingItems)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is PendingItem =>
        typeof item === 'object' && item !== null && typeof item.key === 'string' && typeof item.kind === 'string'
    )
  } catch {
    return []
  }
}

let seq = 0
function pendingKey(prefix: string): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq}`
}

/**
 * 待处理清单 store：跨会话持久化在 localStorage。
 * 导入整批回滚、孤儿窖藏 / 品香、旧备份补编号都在此留痕，供对账中心处理。
 */
export const usePendingStore = defineStore('pending', () => {
  const items = ref<PendingItem[]>(loadItems())

  watch(
    items,
    (value) => {
      localStorage.setItem(LS_KEYS.pendingItems, JSON.stringify(value))
    },
    { deep: true }
  )

  const activeItems = computed(() => items.value.filter((item) => !item.ignored))
  const orphanItems = computed(() => activeItems.value.filter((item) => item.kind === 'orphan'))
  const failureItems = computed(() => activeItems.value.filter((item) => item.kind === 'import-failure'))
  const backfillItems = computed(() => activeItems.value.filter((item) => item.kind === 'id-backfill'))
  /** 顶导航徽标数：孤儿与失败需要处理；补编号留痕不计入 */
  const attentionCount = computed(() => orphanItems.value.length + failureItems.value.length)

  function add(item: Omit<PendingItem, 'key' | 'createdAt' | 'ignored'>): PendingItem {
    const full: PendingItem = {
      key: pendingKey(item.kind),
      createdAt: Date.now(),
      ignored: false,
      ...item
    }
    items.value = [full, ...items.value]
    return full
  }

  /** 整批回滚后登记失败原因清单 */
  function addImportFailure(source: string, reasons: string[]): void {
    reasons.forEach((reason) => {
      add({ kind: 'import-failure', table: null, label: '备份导入失败（已整批回滚）', reason, source })
    })
  }

  /** 旧备份补齐编号留痕（仅提示，不阻塞） */
  function addBackfills(source: string, backfills: IdBackfill[]): void {
    backfills.forEach((backfill) => {
      add({
        kind: 'id-backfill',
        table: backfill.table,
        label: `${backfill.label} 已补齐稳定业务编号`,
        reason: `旧备份缺编号，已按业务键补齐为 ${backfill.id}，补齐后再参与对账`,
        source
      })
    })
  }

  function ignore(key: string): void {
    const item = items.value.find((entry) => entry.key === key)
    if (item) item.ignored = true
  }

  function remove(key: string): void {
    items.value = items.value.filter((item) => item.key !== key)
  }

  function clearResolved(): void {
    items.value = items.value.filter((item) => item.kind !== 'id-backfill' && !item.ignored)
  }

  return {
    items,
    activeItems,
    orphanItems,
    failureItems,
    backfillItems,
    attentionCount,
    add,
    addImportFailure,
    addBackfills,
    ignore,
    remove,
    clearResolved
  }
})
