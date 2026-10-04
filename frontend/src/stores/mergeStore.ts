import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  adoptPending,
  attributeOrphan,
  discardPending,
  listImports,
  mergeSnapshotFile
} from '@/utils/merge'
import type { MergeImportRecord, MergePendingItem, MergeResult } from '@/types/merge'

/**
 * 对账 store：维护待处理项（冲突两版 / 孤儿挂起）与导入历史，
 * 封装对账合并、选版、丢弃与归属批次动作，供对账中心与各页导入入口消费。
 */
export const useMergeStore = defineStore('merge', () => {
  const pendingTable = useIdbTable<MergePendingItem>(
    (database) => database.mergePending,
    { sortByUpdatedAt: false }
  )

  const imports = ref<MergeImportRecord[]>(listImports())
  const lastResult = ref<MergeResult | null>(null)
  const merging = ref(false)
  const error = ref<string | null>(null)

  /** 全部待处理项，按创建时间倒序 */
  const pendingItems = computed<MergePendingItem[]>(() =>
    [...pendingTable.rows.value].sort((a, b) => b.createdAt - a.createdAt)
  )

  /** 仅待处理（pending）项 */
  const activePending = computed<MergePendingItem[]>(() =>
    pendingItems.value.filter((item) => item.status === 'pending')
  )

  /** 冲突待选定项 */
  const conflictItems = computed<MergePendingItem[]>(() =>
    activePending.value.filter((item) => item.reason === 'conflict')
  )

  /** 孤儿待归属项 */
  const orphanItems = computed<MergePendingItem[]>(() =>
    activePending.value.filter((item) => item.reason === 'orphan')
  )

  const pendingCount = computed(() => activePending.value.length)
  const hasPending = computed(() => pendingCount.value > 0)

  function refreshImports(): void {
    imports.value = listImports()
  }

  /** 对账合并一个快照文件，返回合并结果；失败时整批回滚并留下失败清单 */
  async function mergeFile(input: unknown, fileName: string): Promise<MergeResult> {
    merging.value = true
    error.value = null
    try {
      const result = await mergeSnapshotFile(input, fileName)
      lastResult.value = result
      refreshImports()
      return result
    } catch (err) {
      error.value = err instanceof Error ? err.message : '对账合并失败'
      refreshImports()
      throw err
    } finally {
      merging.value = false
    }
  }

  /** 采用导入版（本地版另存待处理，可切回） */
  async function adopt(itemId: string): Promise<void> {
    await adoptPending(itemId)
    await pendingTable.refresh()
  }

  /** 丢弃导入版（保留本地主表） */
  async function discard(itemId: string): Promise<void> {
    await discardPending(itemId)
    await pendingTable.refresh()
  }

  /** 把孤儿窖藏/品香归属到指定批次，或孤儿配比归属到指定香方 */
  async function attribute(itemId: string, targetParentId: string): Promise<void> {
    await attributeOrphan(itemId, targetParentId)
    await pendingTable.refresh()
  }

  return {
    imports,
    lastResult,
    merging,
    error,
    pendingItems,
    activePending,
    conflictItems,
    orphanItems,
    pendingCount,
    hasPending,
    refreshImports,
    mergeFile,
    adopt,
    discard,
    attribute
  }
})
