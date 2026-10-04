<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  CircleCheck,
  RefreshLeft,
  Upload
} from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { usePendingStore } from '@/stores/pendingStore'
import { db } from '@/utils/db'
import { readFileText } from '@/utils/export'
import {
  attachOrphanRecord,
  buildReconcilePlan,
  commitReconcilePlan,
  normalizeSnapshot,
  planSummary,
  ReconcileValidationError
} from '@/utils/reconcile'
import {
  TABLE_LABELS,
  type ReconcileConflict,
  type ReconcilePlan,
  type ReconcileTableKey
} from '@/types/reconcile'
import type { Cellar } from '@/types/cellar'
import type { Tasting } from '@/types/tasting'

const pendingStore = usePendingStore()

const importText = ref('')
const importFileName = ref('')
const planning = ref(false)
const committing = ref(false)
const plan = ref<ReconcilePlan | null>(null)
const commitResult = ref<string>('')

const summary = computed(() => (plan.value ? planSummary(plan.value) : null))

const insertGroups = computed<Array<{ table: ReconcileTableKey; ids: string[] }>>(() => {
  if (!plan.value) return []
  return (Object.keys(TABLE_LABELS) as ReconcileTableKey[])
    .map((table) => ({ table, ids: plan.value!.inserts[table] }))
    .filter((group) => group.ids.length > 0)
})

const conflictsByTable = computed<Record<ReconcileTableKey, ReconcileConflict[]>>(() => {
  const grouped = {
    formulas: [],
    materials: [],
    proportions: [],
    batches: [],
    cellars: [],
    tastings: []
  } as Record<ReconcileTableKey, ReconcileConflict[]>
  plan.value?.conflicts.forEach((conflict) => grouped[conflict.table].push(conflict))
  return grouped
})

const unresolvedCount = computed(
  () => plan.value?.conflicts.filter((conflict) => conflict.choice === null).length ?? 0
)

/** 批次选项（孤儿归属用）：直接读库，保证归属时批次已建档 */
const batchOptions = ref<Array<{ value: string; label: string }>>([])

async function refreshBatchOptions(): Promise<void> {
  const [batches, formulas] = await Promise.all([db.batches.toArray(), db.formulas.toArray()])
  const formulaNames = new Map(formulas.map((formula) => [formula.id, formula.name]))
  batchOptions.value = batches.map((batch) => ({
    value: batch.id,
    label: `${formulaNames.get(batch.formulaId) ?? '香方已删除'} · ${batch.mixedAt} · ${batch.formingMethod}`
  }))
}
void refreshBatchOptions()

async function handleFile(file: File): Promise<void> {
  importFileName.value = file.name
  importText.value = await readFileText(file)
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files && input.files[0]
  if (file) void handleFile(file)
}

function resetPlan(): void {
  plan.value = null
  commitResult.value = ''
  importText.value = ''
  importFileName.value = ''
}

/** 选文件 / 粘贴后先生成对账预案（不落库） */
async function preview(): Promise<void> {
  if (importText.value.trim().length === 0) {
    ElMessage.warning('请先选择合作作坊备份文件，或粘贴快照 JSON 内容')
    return
  }
  planning.value = true
  try {
    let parsed: unknown
    try {
      parsed = JSON.parse(importText.value)
    } catch {
      ElMessage.error('JSON 解析失败：文件内容不是合法 JSON')
      return
    }
    const normalized = normalizeSnapshot(parsed)
    plan.value = await buildReconcilePlan(normalized.snapshot, normalized.backfills, importFileName.value || '合作作坊备份')
    pendingStore.addBackfills(plan.value.source, plan.value.backfills)
    commitResult.value = ''
    const s = planSummary(plan.value)
    ElMessage.success(
      `对账预案已生成：直接建档 ${s.inserts} 条、待选定冲突 ${s.conflicts} 条、待归属 ${s.orphans} 条、一致 ${s.unchanged} 条`
    )
  } catch (err) {
    plan.value = null
    if (err instanceof ReconcileValidationError) {
      pendingStore.addImportFailure(importFileName.value || '合作作坊备份', err.errors)
      ElMessage.error(`对账校验未通过，已整批回滚并生成 ${err.errors.length} 条待处理清单`)
    } else {
      pendingStore.addImportFailure(importFileName.value || '合作作坊备份', [
        err instanceof Error ? err.message : '对账过程中发生未知错误'
      ])
      ElMessage.error('对账失败，已整批回滚')
    }
  } finally {
    planning.value = false
  }
}

async function commit(): Promise<void> {
  if (!plan.value) return
  if (unresolvedCount.value > 0) {
    ElMessage.warning(`还有 ${unresolvedCount.value} 条冲突未由制香师选定，不能提交`)
    return
  }
  const confirmed = await ElMessageBox.confirm(
    `将在单个事务中合并备份：任一步失败都会整批回滚，本地档案维持对账前状态。确认提交？`,
    '提交对账合并',
    { type: 'warning', confirmButtonText: '确认合并', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return

  committing.value = true
  try {
    // 孤儿先登记到待处理清单：归属批次前不入库，不影响均分与提醒
    const orphans = plan.value.orphanRecords
    const counts = await commitReconcilePlan(plan.value)
    orphans.forEach((orphan) => {
      pendingStore.add({
        kind: 'orphan',
        table: orphan.table,
        label: orphan.label,
        reason: `${TABLE_LABELS[orphan.table]}找不到归属批次，已挂起；选定批次后即并入并参与均分/提醒`,
        source: plan.value!.source,
        record: orphan.record,
        orphanTable: orphan.table
      })
    })
    commitResult.value =
      `合并完成：香方 ${counts.formulas} / 香料 ${counts.materials} / 配比 ${counts.proportions} / ` +
      `批次 ${counts.batches} / 窖藏 ${counts.cellars} / 品香 ${counts.tastings}（合并后库内总条数）`
    ElMessage.success('对账合并已提交')
    await refreshBatchOptions()
  } catch (err) {
    const reasons = err instanceof ReconcileValidationError ? err.errors : [err instanceof Error ? err.message : '提交失败']
    pendingStore.addImportFailure(plan.value.source, reasons)
    ElMessage.error('提交失败，整批已回滚，详见待处理清单')
  } finally {
    committing.value = false
  }
}

/* ---------------- 待处理清单操作 ---------------- */

const attachingKey = ref<string | null>(null)

async function attachPending(key: string, batchId: string): Promise<void> {
  const item = pendingStore.items.find((entry) => entry.key === key)
  if (!item || !item.record || !item.orphanTable) return
  attachingKey.value = key
  try {
    await attachOrphanRecord(item.orphanTable, item.record as Cellar | Tasting, batchId)
    pendingStore.remove(key)
    await refreshBatchOptions()
    ElMessage.success('已归属到批次并并入档案，香方均分与出窖提醒已同步')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '归属失败')
  } finally {
    attachingKey.value = null
  }
}

async function dismiss(key: string): Promise<void> {
  const confirmed = await ElMessageBox.confirm('从待处理清单移除该条？原始备份不会被改动。', '移除确认', {
    type: 'warning',
    confirmButtonText: '移除',
    cancelButtonText: '取消'
  }).catch(() => false)
  if (!confirmed) return
  pendingStore.remove(key)
}

const TABLE_ORDER: ReconcileTableKey[] = ['formulas', 'materials', 'proportions', 'batches', 'cellars', 'tastings']
const conflictGroups = computed(() =>
  TABLE_ORDER.map((table) => ({ table, rows: conflictsByTable.value[table] })).filter((group) => group.rows.length > 0)
)
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>备份对账合并</h2>
        <p>按稳定业务编号对账：单边记录直接建档，同编号两边不同则两版保留由制香师选定，批次固化配比快照不会被改动。</p>
      </div>
      <div class="page-title__actions">
        <el-button :icon="RefreshLeft" @click="resetPlan">清空重做</el-button>
        <el-button type="primary" :icon="Upload" :loading="planning" @click="preview">生成对账预案</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="待处理事项" :value="pendingStore.attentionCount" suffix="项" icon="Warning" tone="danger" />
      <StatBadge label="待归属窖藏/品香" :value="pendingStore.orphanItems.length" suffix="条" icon="Clock" tone="warning" />
      <StatBadge label="导入失败" :value="pendingStore.failureItems.length" suffix="批" icon="WarningFilled" tone="danger" />
      <StatBadge label="本次直接建档" :value="summary?.inserts ?? 0" suffix="条" icon="DocumentAdd" tone="success" />
      <StatBadge label="本次冲突" :value="summary?.conflicts ?? 0" suffix="条" icon="Select" tone="primary" />
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>1. 选择合作作坊离线备份</h3>
        <span class="muted">旧备份缺编号会先按业务键补齐再对账；校验不通过整批回滚</span>
      </div>
      <el-form label-width="96px">
        <el-form-item label="备份文件">
          <input class="import-file" type="file" accept="application/json,.json" @change="onFileChange" />
          <span v-if="importFileName" class="muted">{{ importFileName }}</span>
        </el-form-item>
        <el-form-item label="JSON 内容">
          <el-input v-model="importText" type="textarea" :rows="6" placeholder="可粘贴全量快照 JSON；点击「生成对账预案」后仅做对账预览，不写库" />
        </el-form-item>
      </el-form>
    </div>

    <template v-if="plan">
      <el-alert
        v-if="summary && summary.backfills > 0"
        class="reconcile-alert"
        type="info"
        show-icon
        :closable="false"
        :title="`旧备份中有 ${summary.backfills} 条记录缺少稳定业务编号，已先补齐再对账（见下方待处理清单）`"
      />

      <div class="section-card">
        <div class="section-card__head">
          <h3>2. 单边记录：直接建档（{{ summary?.inserts ?? 0 }} 条）</h3>
          <span class="muted">仅在备份出现、本地没有的编号直接新建，不动本地任何记录</span>
        </div>
        <div v-if="insertGroups.length === 0" class="muted">没有单边新增记录。</div>
        <div v-else class="insert-grid">
          <div v-for="group in insertGroups" :key="group.table" class="insert-group">
            <div class="insert-group__title">{{ TABLE_LABELS[group.table] }} · {{ group.ids.length }}</div>
            <ul class="mono-list">
              <li v-for="id in group.ids.slice(0, 8)" :key="id">{{ id }}</li>
              <li v-if="group.ids.length > 8" class="muted">…… 另 {{ group.ids.length - 8 }} 条</li>
            </ul>
          </div>
        </div>
      </div>

      <div class="section-card">
        <div class="section-card__head">
          <h3>3. 同编号两边不同：两版保留，由制香师选定（{{ plan.conflicts.length }} 条）</h3>
          <span class="muted">
            <el-tag type="danger" size="small" effect="plain">未选定 {{ unresolvedCount }} 条</el-tag>
            批次冲突时配比快照恒取本地固化版，不随选择改动
          </span>
        </div>
        <div v-if="conflictGroups.length === 0" class="muted">没有同编号内容不同的记录。</div>
        <div v-else class="conflict-list">
          <div v-for="group in conflictGroups" :key="group.table" class="conflict-group">
            <h4 class="conflict-group__title">{{ TABLE_LABELS[group.table] }}（{{ group.rows.length }}）</h4>
            <el-table :data="group.rows" size="small" row-key="id" border>
              <el-table-column label="记录 / 字段" min-width="220">
                <template #default="{ row }: { row: ReconcileConflict }">
                  <div class="cell-main">{{ row.label }}</div>
                  <div class="cell-sub mono">{{ row.id }}</div>
                  <el-tag v-if="row.frozenSnapshot" type="warning" size="small" effect="plain">配比快照已固化，保留本地</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="本地版（制香工作室）" min-width="150">
                <template #default="{ row }: { row: ReconcileConflict }">
                  <div v-for="diff in row.diffs" :key="diff.field" class="diff-line">
                    <span class="diff-label">{{ diff.label }}</span>
                    <span class="diff-local">{{ diff.local }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="备份版（合作作坊）" min-width="150">
                <template #default="{ row }: { row: ReconcileConflict }">
                  <div v-for="diff in row.diffs" :key="diff.field" class="diff-line">
                    <span class="diff-label">{{ diff.label }}</span>
                    <span class="diff-incoming">{{ diff.incoming }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="选定" width="200">
                <template #default="{ row }: { row: ReconcileConflict }">
                  <el-radio-group v-model="row.choice" size="small">
                    <el-radio-button value="local">留本地</el-radio-button>
                    <el-radio-button value="incoming">用备份</el-radio-button>
                  </el-radio-group>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>
      </div>

      <div class="section-card">
        <div class="section-card__head">
          <h3>4. 归属不到批次的窖藏 / 品香（{{ plan.orphanRecords.length }} 条）</h3>
          <span class="muted">提交后挂起到待处理清单，选定归属批次前不入库、不计均分与提醒</span>
        </div>
        <div v-if="plan.orphanRecords.length === 0" class="muted">窖藏与品香都能归属到批次。</div>
        <el-table v-else :data="plan.orphanRecords" size="small" row-key="record.id" border>
          <el-table-column label="类型" width="110">
            <template #default="{ row }: { row: { table: 'cellars' | 'tastings' } }">{{ TABLE_LABELS[row.table] }}</template>
          </el-table-column>
          <el-table-column prop="label" label="记录" min-width="260" />
          <el-table-column prop="source" label="备份来源" min-width="160" />
        </el-table>
      </div>

      <div class="commit-bar">
        <el-button
          type="primary"
          size="large"
          :icon="CircleCheck"
          :loading="committing"
          :disabled="unresolvedCount > 0"
          @click="commit"
        >
          {{ unresolvedCount > 0 ? `还有 ${unresolvedCount} 条冲突待选定` : '确认无误，提交对账合并' }}
        </el-button>
        <span v-if="commitResult" class="commit-result">{{ commitResult }}</span>
      </div>
    </template>

    <div class="section-card pending-card">
      <div class="section-card__head">
        <h3>待处理清单（{{ pendingStore.activeItems.length }}）</h3>
        <span class="muted">跨会话保留；导入失败整批回滚、孤儿归属、旧档补编号都在此留痕</span>
      </div>

      <div v-if="pendingStore.activeItems.length === 0">
        <EmptyPanel title="暂无待处理事项" description="备份校验通过且所有窖藏、品香都已归属批次时，这里为空。" />
      </div>

      <el-table v-else :data="pendingStore.activeItems" size="small" row-key="key" border>
        <el-table-column label="类型" width="130">
          <template #default="{ row }: { row: { kind: string; table: ReconcileTableKey | null } }">
            <el-tag v-if="row.kind === 'orphan'" type="warning" size="small" effect="plain">待归属</el-tag>
            <el-tag v-else-if="row.kind === 'import-failure'" type="danger" size="small" effect="plain">导入失败</el-tag>
            <el-tag v-else type="info" size="small" effect="plain">已补编号</el-tag>
            <div v-if="row.table" class="cell-sub muted">{{ TABLE_LABELS[row.table] }}</div>
          </template>
        </el-table-column>
        <el-table-column label="事项" min-width="220">
          <template #default="{ row }">
            <div class="cell-main">{{ row.label }}</div>
            <div class="cell-sub muted">{{ row.reason }}</div>
          </template>
        </el-table-column>
        <el-table-column label="来源" min-width="150">
          <template #default="{ row }"><span class="cell-sub">{{ row.source }}</span></template>
        </el-table-column>
        <el-table-column label="归属到批次 / 处理" width="300">
          <template #default="{ row }">
            <template v-if="row.kind === 'orphan'">
              <el-select
                class="attach-select"
                size="small"
                filterable
                placeholder="选择归属批次"
                :disabled="attachingKey === row.key"
                @change="(batchId: string) => attachPending(row.key, batchId)"
              >
                <el-option v-for="option in batchOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
            </template>
            <el-button v-else-if="row.kind === 'import-failure'" size="small" text @click="pendingStore.ignore(row.key)">忽略</el-button>
            <span v-else class="muted cell-sub">无需处理，仅留痕</span>
          </template>
        </el-table-column>
        <el-table-column label="" width="80">
          <template #default="{ row }">
            <el-button size="small" text type="danger" @click="dismiss(row.key)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.reconcile-alert {
  margin-bottom: 12px;
}

.import-file {
  font-size: 13px;
}

.insert-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.insert-group {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
}

.insert-group__title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.mono-list {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  color: #6b5a45;
  word-break: break-all;
}

.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.conflict-group__title {
  margin: 0 0 8px;
  font-size: 14px;
}

.cell-main {
  font-weight: 600;
}

.cell-sub {
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
}

.diff-line {
  display: flex;
  gap: 6px;
  font-size: 12px;
  line-height: 1.7;
}

.diff-label {
  color: #8c8479;
  flex: 0 0 64px;
}

.diff-local {
  color: #6b4a2c;
}

.diff-incoming {
  color: #1e5a8a;
}

.commit-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 18px 0;
}

.commit-result {
  font-size: 13px;
  color: #1e8449;
}

.pending-card {
  margin-top: 20px;
}

.attach-select {
  width: 100%;
}
</style>
