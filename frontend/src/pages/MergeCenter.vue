<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Check, Warning } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useMergeStore } from '@/stores/mergeStore'
import { useFormulaStore } from '@/stores/formulaStore'
import { useMaterialStore } from '@/stores/materialStore'
import { useProportionStore } from '@/stores/proportionStore'
import { useCellarStore } from '@/stores/cellarStore'
import type { MergePendingItem } from '@/types/merge'

const mergeStore = useMergeStore()
const formulaStore = useFormulaStore()
const materialStore = useMaterialStore()
const proportionStore = useProportionStore()
const cellarStore = useCellarStore()

/** 孤儿项选中的归属目标父记录 id，按待处理项 id 分别存放 */
const targetParent = reactive<Record<string, string>>({})

onMounted(() => {
  mergeStore.refreshImports()
})

const conflictItems = computed(() => mergeStore.conflictItems)
const orphanItems = computed(() => mergeStore.orphanItems)
const imports = computed(() => mergeStore.imports)

/** 按 bizNo 在本地主表中查找同编号记录，用于两版对照 */
function localVersionOf(item: MergePendingItem): Record<string, unknown> | null {
  let list: Array<{ bizNo?: string }> = []
  if (item.kind === 'formula') list = formulaStore.formulas
  else if (item.kind === 'material') list = materialStore.materials
  else if (item.kind === 'proportion') list = proportionStore.proportions
  else if (item.kind === 'batch') list = formulaStore.batches
  else if (item.kind === 'cellar') list = cellarStore.cellars
  else if (item.kind === 'tasting') list = formulaStore.tastings
  const found = list.find((record) => record.bizNo === item.bizNo)
  return found ? (found as Record<string, unknown>) : null
}

function versionText(version: Record<string, unknown> | null): string {
  if (!version) return '（本地无此编号记录）'
  const { id, ...rest } = version
  return JSON.stringify(rest, null, 2)
}

/** 孤儿项缺失的父级类型文案 */
function missingParentLabel(item: MergePendingItem): string {
  if (item.kind === 'cellar' || item.kind === 'tasting') return '选择归属批次'
  if (item.kind === 'batch') return '选择归属香方'
  if (item.kind === 'proportion') return '选择归属香方'
  return '选择归属'
}

/** 孤儿项可归属的父级选项 */
function parentOptions(item: MergePendingItem): Array<{ label: string; value: string }> {
  if (item.kind === 'cellar' || item.kind === 'tasting') {
    return formulaStore.batches.map((batch) => ({
      label: `${formulaStore.formulaName(batch.formulaId)} · ${batch.mixedAt} · ${batch.formingMethod}`,
      value: batch.id
    }))
  }
  return formulaStore.formulas.map((formula) => ({ label: formula.name, value: formula.id }))
}

async function adopt(item: MergePendingItem): Promise<void> {
  try {
    await mergeStore.adopt(item.id)
    ElMessage.success(`已采用导入版「${item.label}」，本地版已另存可切回`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '采用失败')
  }
}

async function discard(item: MergePendingItem): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `丢弃「${item.label}」的导入版？本地主表保留不变。`,
    '丢弃导入版',
    { type: 'warning', confirmButtonText: '丢弃', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await mergeStore.discard(item.id)
  ElMessage.success('已丢弃导入版，本地版保留')
}

async function attribute(item: MergePendingItem): Promise<void> {
  const targetId = targetParent[item.id]
  if (!targetId) {
    ElMessage.warning(`请先${missingParentLabel(item)}`)
    return
  }
  try {
    await mergeStore.attribute(item.id, targetId)
    ElMessage.success(`已归属「${item.label}」`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '归属失败')
  }
}

function formatTime(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('zh-CN')
}
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>对账中心</h2>
        <p>
          按稳定业务编号对账 · 待处理 {{ mergeStore.pendingCount }} 项（冲突 {{ conflictItems.length }} · 孤儿
          {{ orphanItems.length }}）
        </p>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="待处理" :value="mergeStore.pendingCount" suffix="项" icon="Files" tone="warning" />
      <StatBadge label="冲突待选定" :value="conflictItems.length" suffix="项" icon="WarningFilled" tone="danger" />
      <StatBadge label="孤儿待归属" :value="orphanItems.length" suffix="项" icon="Box" tone="info" />
      <StatBadge label="导入历史" :value="imports.length" suffix="批" icon="DataLine" tone="default" />
    </div>

    <div v-if="mergeStore.pendingCount === 0" class="section-card">
      <EmptyPanel
        title="暂无待处理对账项"
        description="导入全量 JSON 后，同编号冲突与归属不到批次的窖藏/品香会集中显示在这里，由你选定版本或归属批次。"
        action-text="去导入 JSON"
        :show-seed="false"
        @action="$router.push('/tastings')"
      />
    </div>

    <div v-else>
      <!-- 同编号冲突：保留两版由制香师选定 -->
      <div v-if="conflictItems.length > 0" class="section-card">
        <div class="section-card__head">
          <h3>同编号冲突（保留两版，由制香师选定）</h3>
          <span class="muted">选定导入版后本地版会另存为待处理项，可随时切回</span>
        </div>
        <div v-for="item in conflictItems" :key="item.id" class="merge-card">
          <div class="merge-card__head">
            <el-tag type="danger" effect="plain" round>冲突</el-tag>
            <span class="merge-card__label">{{ item.label }}</span>
          </div>
          <div class="merge-card__versions">
            <div class="version">
              <div class="version__title">本地版</div>
              <pre class="version__pre">{{ versionText(localVersionOf(item)) }}</pre>
            </div>
            <div class="version">
              <div class="version__title">导入版</div>
              <pre class="version__pre">{{ versionText(item.data) }}</pre>
            </div>
          </div>
          <div class="merge-card__actions">
            <el-button type="primary" :icon="Check" @click="adopt(item)">采用导入版</el-button>
            <el-button :icon="Warning" @click="discard(item)">保留本地（丢弃导入版）</el-button>
          </div>
        </div>
      </div>

      <!-- 孤儿待归属：窖藏/品香归属批次前不进香方均分与提醒 -->
      <div v-if="orphanItems.length > 0" class="section-card">
        <div class="section-card__head">
          <h3>待归属（归属批次前不进香方均分与提醒）</h3>
          <span class="muted">补齐父级后归属，归属后才参与台账均分与窖藏提醒</span>
        </div>
        <div v-for="item in orphanItems" :key="item.id" class="merge-card">
          <div class="merge-card__head">
            <el-tag type="info" effect="plain" round>孤儿</el-tag>
            <span class="merge-card__label">{{ item.label }}</span>
            <span class="muted">· 缺失：{{ item.missingRef || '未知父级' }}</span>
          </div>
          <div class="merge-card__actions">
            <el-select
              v-model="targetParent[item.id]"
              :placeholder="missingParentLabel(item)"
              filterable
              style="width: 320px"
            >
              <el-option v-for="option in parentOptions(item)" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
            <el-button type="primary" @click="attribute(item)">归属</el-button>
            <el-button @click="discard(item)">丢弃</el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 导入历史：失败也留下待处理清单 -->
    <div class="section-card">
      <div class="section-card__head">
        <h3>导入历史</h3>
        <span class="muted">失败批次已整批回滚，可在此查看原因后重新导入</span>
      </div>
      <el-table :data="imports" size="small" stripe>
        <el-table-column label="文件名" prop="fileName" min-width="200" show-overflow-tooltip />
        <el-table-column label="导入时间" width="180">
          <template #default="{ row }">
            <span class="mono">{{ formatTime(row.importedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结果" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'success' ? 'success' : 'danger'" effect="plain" round>
              {{ row.status === 'success' ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="建档/冲突/孤儿/跳过" width="200">
          <template #default="{ row }">
            <span class="monuted">
              {{ row.counts.inserted }} / {{ row.counts.conflicts }} / {{ row.counts.orphans }} /
              {{ row.counts.skipped }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="失败原因" min-width="200">
          <template #default="{ row }">
            <span v-if="row.error" class="ratio-error">{{ row.error }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.merge-card {
  padding: 14px;
  margin-bottom: 12px;
  background: #fbf9f5;
  border: 1px solid var(--line);
  border-radius: 10px;
}

.merge-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.merge-card__label {
  font-weight: 600;
}

.merge-card__versions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}

.version__title {
  font-size: 12px;
  color: #8c8479;
  margin-bottom: 4px;
}

.version__pre {
  margin: 0;
  padding: 10px;
  background: #ffffff;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 260px;
  overflow: auto;
}

.merge-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mono {
  font-variant-numeric: tabular-nums;
}

.monuted {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

.ratio-error {
  color: #c0392b;
  font-size: 12px;
}

.muted {
  color: #8c8479;
  font-size: 12px;
}
</style>
