<template>
  <div class="dual-review">
    <header><div><h1>B/C 双路循环审查</h1><p>B 结构风险评估 + C 内容风险评估；长文分段处理 → 超阈值时先改结构再改内容 → 自动复审</p></div><el-button @click="$router.push('/api')">API 设置</el-button></header>
    <el-alert :title="REVIEW_MODEL_NOTICE" type="info" show-icon :closable="false" />
    <section class="controls">
      <div class="file-row"><el-button :disabled="busy" @click="chooseFile">选择 DOCX</el-button><span>{{ filePath || '尚未选择文档' }}</span></div>
      <el-form inline label-position="top">
        <el-form-item label="学科"><el-select v-model="config.discipline" :disabled="busy" style="width: 210px"><el-option v-for="d in disciplines" :key="d" :label="d" :value="d" /></el-select></el-form-item>
        <el-form-item label="最多修改轮数（初始审查另计）"><el-input-number v-model="config.maxRounds" :min="1" :max="10" :disabled="busy" /></el-form-item>
        <el-form-item label="B 结构风险分阈值"><el-input-number v-model="config.maxRiskB" :min="0" :max="100" :disabled="busy" /></el-form-item>
        <el-form-item label="C 内容风险分阈值"><el-input-number v-model="config.maxRiskC" :min="0" :max="100" :disabled="busy" /></el-form-item>
      </el-form>
      <div class="model-grid">
        <el-form-item v-for="role in modelRoles" :key="role.id" :label="`${role.label} 使用模型`">
          <el-select v-model="modelSelection[role.id]" :disabled="busy" style="width: 280px">
            <el-option :label="`当前 API：${apiStore.selectedApi.name || '未选择'}`" value="selected" />
            <el-option v-for="saved in availableModels" :key="saved.id" :label="`${saved.modelName} · ${saved.provider} (#${saved.id})`" :value="`saved:${saved.id}`" />
            <el-option label="本地 Codex CLI" value="codex" />
          </el-select>
          <el-input v-if="modelSelection[role.id] === 'codex'" v-model="codexModels[role.id]" :disabled="busy" placeholder="CLI 模型 ID，如 gpt-6.1-sol；留空使用默认" style="width: 280px; margin-top: 6px" />
        </el-form-item>
      </div>
      <div v-if="codexSelected" class="codex-path"><el-input v-model="codexPath" :disabled="busy" placeholder="codex.exe 完整路径（留空自动查找）" style="max-width: 700px"><template #prepend>Codex 可执行文件</template></el-input><span class="hint">{{ codexDetected ? `已检测到：${detectedCodexPath}` : '未自动检测到；可手动填写 codex.exe 路径' }}。CLI 通常仍需登录并联网。</span></div>
      <div v-if="codexSelected" class="codex-path"><el-switch v-model="config.codexProxy.enabled" :disabled="busy" active-text="Codex CLI 使用本地 HTTP 代理" inactive-text="Codex CLI 不另设代理" /><el-input-number v-if="config.codexProxy.enabled" v-model="config.codexProxy.port" :min="1" :max="65535" :disabled="busy" /><span class="hint">应用于本地 Codex 审查及修改进程；默认 127.0.0.1:7890。</span></div>
      <p class="hint">B/C 风险分越高，观察到的相关文本风格风险越多；这是启发式风险评分（非真实 AI 概率）。只有风险分严格超过对应阈值才修改；两路都未超阈值时直接结束。</p>
      <div class="actions"><el-button type="primary" :disabled="!filePath || busy" @click="start">开始循环审查</el-button><el-button type="danger" :disabled="!busy || !runId" @click="stop">停止任务</el-button></div>
    </section>
    <section class="history"><el-select v-model="historyId" placeholder="恢复历史审查记录" style="width: min(600px, 80%)" :disabled="busy" @change="restore"><el-option v-for="item in history" :key="item.id" :value="item.id" :label="`${item.startedAt.slice(0, 16)} · ${item.sourcePath} · ${statusName(item.status)}`" /></el-select><el-button :disabled="busy" @click="refreshHistory">刷新</el-button></section>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template v-if="run">
      <section class="run-status"><h2>{{ statusName(run.status) }} · {{ run.phase }}</h2><el-tag :type="run.dataOrigin === 'mock' ? 'warning' : 'info'">{{ run.dataOrigin === 'mock' ? '模拟结果，仅用于测试' : '实际模型调用' }}</el-tag><p>本次模型：{{ run.model }} · 学科：{{ run.config.discipline }} · B 阈值 {{ run.config.maxRiskB }}；C 阈值 {{ run.config.maxRiskC }}</p><p v-if="run.modelLabels">B：{{ run.modelLabels.structure }} · C：{{ run.modelLabels.content }} · 结构修改：{{ run.modelLabels.reviseStructure || legacyReviser(run) }} · 内容修改：{{ run.modelLabels.reviseContent || legacyReviser(run) }}</p><p v-if="tokenSummary">Token 用量：{{ tokenSummary }}<span v-if="hasCodexRole" class="hint">（本地 Codex CLI 不计入）</span></p><p>当前候选：{{ run.currentPath || '读取中' }}</p><p class="hint">原文 SHA-256：{{ run.originalSha256 }}</p>
        <div class="actions"><el-button v-if="run.status === 'failed' || run.status === 'not-passed'" type="primary" :disabled="busy" @click="retryFromSource">从原文重新运行</el-button><el-button :disabled="busy || !run.currentPath" @click="exportResult('docx')">导出{{ run.status === 'passed' ? '最终' : '当前候选' }} DOCX</el-button><el-button :disabled="busy" @click="exportResult('report')">导出审查报告</el-button><el-button :disabled="busy || !run.currentPath" @click="exportResult('bundle')">导出版本记录 ZIP</el-button></div>
        <el-alert v-for="(message, i) in run.errors" :key="i" :title="message" type="error" :closable="false" />
      </section>
      <h2>每轮评分对比</h2>
      <el-table :data="run.rounds" @row-click="selectRound">
        <el-table-column label="轮次" width="85"><template #default="{ row }">{{ row.index === 0 ? '初始' : `第 ${row.index} 轮` }}</template></el-table-column>
        <el-table-column label="B 结构风险分"><template #default="{ row }">{{ riskStatus(row.reviews.structure) }}</template></el-table-column>
        <el-table-column label="C 内容风险分"><template #default="{ row }">{{ riskStatus(row.reviews.content) }}</template></el-table-column>
        <el-table-column label="程序判定"><template #default="{ row }">{{ row.decision.passed ? '通过' : '未通过' }}</template></el-table-column>
      </el-table>
      <template v-if="selected">
        <h2>第 {{ selected.index }} 轮详情 <el-select v-model="selectedIndex" style="width: 140px"><el-option v-for="r in run.rounds" :key="r.index" :value="r.index" :label="`第 ${r.index} 轮`" /></el-select></h2>
        <el-alert type="info" :title="selected.decision.risk?.summary || '暂无风险汇总'" :closable="false" />
        <p>共同标记段落：{{ selected.decision.risk?.priorityBlockIds.join('、') || '无' }}</p>
        <ul><li v-for="reason in selected.decision.reasons" :key="reason">{{ reason }}</li></ul>
        <div class="results"><WorkflowReviewResult v-if="selected.reviews.structure" title="B · 结构风险评估" :result="selected.reviews.structure" /><WorkflowReviewResult v-if="selected.reviews.content" title="C · 内容风险评估" :result="selected.reviews.content" /></div>
        <details><summary>当前轮全文及块 ID（{{ selected.blocks.length }} 块）</summary><article v-for="block in selected.blocks" :key="block.id"><strong>{{ block.id }} {{ block.editable ? '' : '· 受保护' }}</strong><p class="text">{{ block.text }}</p></article></details>
      </template>
      <h2>每轮修改意见与文本差异</h2>
      <p v-if="!revisions.length">尚无候选修改。</p>
      <article v-for="revision in revisions" :key="revision.afterPath" class="revision"><h3>{{ revision.afterPath.split(/[\\/]/).pop() }} · {{ revision.stage === 'structure' ? '结构' : '内容' }}修改</h3><p>{{ revision.summary }}</p><div v-for="(edit, i) in revision.edits" :key="i"><p>{{ edit.blockId }}：{{ edit.reason }}（{{ edit.issueIds.join('、') }}）</p><div class="diff"><del>{{ edit.original }}</del><ins>{{ edit.replacement }}</ins></div></div><p v-for="(move, i) in revision.moves || []" :key="`move-${i}`">段落 {{ move.blockId }} → {{ move.beforeBlockId }} 之前：{{ move.reason }}</p></article>
      <h2>尚未解决的问题（{{ run.unresolvedIssues.length }}）</h2><p v-for="issue in run.unresolvedIssues" :key="`${issue.reviewer}-${issue.id}`">[{{ issue.severity }}] {{ issue.reviewer }} / {{ issue.id }}：{{ issue.reason }}</p>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import { useApiStore } from '../stores/apiStore'
import WorkflowReviewResult from '../components/WorkflowReviewResult.vue'
import { codexModelId, DEFAULT_REVIEW_CONFIG, ModelRole, ReviewConfig, ReviewModelChoice, REVIEW_MODEL_NOTICE, WorkflowRun, ReviewRound } from '../../shared/reviewWorkflow'
const apiStore = useApiStore()
const api = window.electronAPI
const filePath = ref(''), error = ref(''), runId = ref(''), historyId = ref('')
// WorkflowRun 体积大（全部轮次/块/评审/证据），整棵深代理是卡顿来源；
// 更新都是整体替换，shallowRef 避免递归 proxy，替换 .value 时照常触发更新
const run = shallowRef<WorkflowRun | null>(null), starting = ref(false), selectedIndex = ref(0)
const history = ref<{ id: string; status: string; startedAt: string; sourcePath: string }[]>([])
const config = ref({ ...DEFAULT_REVIEW_CONFIG, codexProxy: { ...DEFAULT_REVIEW_CONFIG.codexProxy } })
const modelRoles: { id: ModelRole; label: string }[] = [{ id: 'structure', label: 'B 结构检测' }, { id: 'content', label: 'C 内容检测' }, { id: 'reviseStructure', label: '结构修改 Agent' }, { id: 'reviseContent', label: '内容修改 Agent' }]
const modelSelection = ref<Record<ModelRole, string>>({ structure: 'selected', content: 'selected', reviseStructure: 'selected', reviseContent: 'selected' })
const codexModels = ref<Record<ModelRole, string>>({ structure: '', content: '', reviseStructure: '', reviseContent: '' })
const codexPath = ref(''), codexDetected = ref(false), detectedCodexPath = ref('')
const availableModels = ref<{ id: number; modelName: string; provider: string }[]>([])
const codexSelected = computed(() => modelRoles.some(role => modelSelection.value[role.id] === 'codex'))
const disciplines = ['通用（学科未指定）', '文科', '理工科', '医学', '经管']
const busy = computed(() => starting.value || run.value?.status === 'running')
const selected = computed(() => run.value?.rounds.find(r => r.index === selectedIndex.value))
const revisions = computed(() => [...(run.value?.rounds.flatMap(r => r.revisions) || []), ...(run.value?.pendingRevisions || [])])
const statusName = (value: string) => ({ running: '进行中', passed: '全部通过', 'not-passed': '未通过', failed: '执行失败', stopped: '已停止' }[value] || value)
const riskStatus = (value?: { status: string; overallRiskScore?: number }) => !value ? '旧记录未执行' : value.status === 'failed' ? '失败' : `${value.overallRiskScore ?? '旧版无分'} / 100`
const legacyReviser = (value: WorkflowRun) => (value.modelLabels as typeof value.modelLabels & { reviser?: string })?.reviser || '未记录'
// token 用量展示：B / C / 结构修改 / 内容修改 分项 + 合计（千位简写）
const STAGE_TOKEN_LABELS: Record<string, string> = { structure: 'B', content: 'C', reviseStructure: '结构修改', reviseContent: '内容修改' }
const fmtTokens = (n: number) => n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
const tokenSummary = computed(() => {
  const usage = run.value?.tokenUsage
  if (!usage || !Object.values(usage).some(v => v > 0)) return ''
  const parts = Object.entries(STAGE_TOKEN_LABELS)
    .filter(([stage]) => (usage[stage] || 0) > 0)
    .map(([stage, label]) => `${label} ${fmtTokens(usage[stage])}`)
  const total = Object.values(usage).reduce((a, b) => a + (b || 0), 0)
  return parts.length ? `${parts.join(' · ')}｜合计 ${fmtTokens(total)}` : ''
})
const hasCodexRole = computed(() => Object.values(run.value?.config.models || {}).some(m => m.kind === 'local-codex'))
const selectRound = (row: ReviewRound) => { selectedIndex.value = row.index }
const showError = (e: unknown) => { error.value = e instanceof Error ? e.message : String(e) }
async function chooseFile() { try { const result = await api.selectDocxFile(); if (result) filePath.value = result } catch (e) { showError(e) } }
async function refreshHistory() { try { history.value = await api.listDualReviews() } catch (e) { showError(e) } }
async function refreshModels() {
  try { availableModels.value = (await api.getALLAPISettings()).filter(item => typeof item.id === 'number').map(item => ({ id: item.id, modelName: item.modelName, provider: item.provider || 'openai_compatible' })) }
  catch (e) { showError(e) }
}
function choiceFor(role: ModelRole): ReviewModelChoice {
  const selected = modelSelection.value[role]
  if (selected === 'codex') {
    const model = codexModelId(codexModels.value[role])
    codexModels.value[role] = model || ''
    return { kind: 'local-codex', ...(codexPath.value.trim() ? { executable: codexPath.value.trim() } : {}), ...(model ? { model } : {}) }
  }
  if (selected.startsWith('saved:')) return { kind: 'saved-api', apiSettingId: Number(selected.slice(6)) }
  return { kind: 'selected-api' }
}
function applyChoices(state: WorkflowRun) {
  codexPath.value = ''
  for (const role of modelRoles.map(r => r.id)) {
    const choice = state.config.models?.[role] || (state.config.models as typeof state.config.models & { reviser?: ReviewModelChoice })?.reviser
    modelSelection.value[role] = choice?.kind === 'saved-api' ? `saved:${choice.apiSettingId}` : choice?.kind === 'local-codex' ? 'codex' : 'selected'
    if (choice?.kind === 'local-codex') { codexModels.value[role] = choice.model || ''; if (choice.executable) codexPath.value = choice.executable }
  }
}
function receive(state: WorkflowRun) {
  if (runId.value && state.id !== runId.value) return
  const finishedNow = run.value?.id === state.id && run.value.status === 'running' && state.status !== 'running'
  runId.value = state.id; run.value = state; selectedIndex.value = state.rounds.at(-1)?.index || 0
  localStorage.setItem('lastDualReviewId', state.id)
  if (finishedNow) ElMessage({ message: `循环审查已结束：${statusName(state.status)}。可查看最终判定并导出结果。`, type: state.status === 'passed' ? 'success' : 'warning', duration: 6000 })
}
async function start() {
  error.value = ''; starting.value = true
  try {
    const a = apiStore.selectedApi
    await api.selectAPISetting(a.URL, a.key, a.name, a.parallel, a.TimeLimit, a.provider, a.requestTimeoutSec, a.thinkingMode)
    runId.value = ''; run.value = null
    const models = Object.fromEntries(modelRoles.map(role => [role.id, choiceFor(role.id)])) as Record<ModelRole, ReviewModelChoice>
    // Electron IPC uses structured clone; Vue's nested reactive proxy cannot cross it.
    const requestConfig: ReviewConfig = {
      maxRounds: config.value.maxRounds,
      maxRiskB: config.value.maxRiskB,
      maxRiskC: config.value.maxRiskC,
      discipline: config.value.discipline,
      codexProxy: { enabled: config.value.codexProxy.enabled, port: config.value.codexProxy.port },
      models
    }
    const result = await api.startDualReview({ filePath: filePath.value, config: requestConfig })
    localStorage.setItem('reviewModelChoices', JSON.stringify({ modelSelection: modelSelection.value, codexModels: codexModels.value, codexPath: codexPath.value, codexProxy: config.value.codexProxy }))
    runId.value = result.id; localStorage.setItem('lastDualReviewId', result.id)
    receive(await api.getDualReview(result.id))
  } catch (e) { showError(e) } finally { starting.value = false }
}
async function stop() { try { await api.stopDualReview(runId.value) } catch (e) { showError(e) } }
async function retryFromSource() { if (!run.value) return; filePath.value = run.value.sourcePath; config.value = { ...DEFAULT_REVIEW_CONFIG, maxRounds: run.value.config.maxRounds, maxRiskB: run.value.config.maxRiskB ?? DEFAULT_REVIEW_CONFIG.maxRiskB, maxRiskC: run.value.config.maxRiskC ?? DEFAULT_REVIEW_CONFIG.maxRiskC, discipline: run.value.config.discipline, codexProxy: { ...(run.value.config.codexProxy || DEFAULT_REVIEW_CONFIG.codexProxy) } }; applyChoices(run.value); await start() }
async function restore(id: string) { try { runId.value = id; receive(await api.getDualReview(id)) } catch (e) { showError(e) } }
async function exportResult(kind: 'docx' | 'report' | 'bundle') { try { const file = await api.exportDualReview(runId.value, kind); if (file) ElMessage.success(`已导出：${file}`) } catch (e) { showError(e) } }
let unsubscribe: (() => void) | undefined
onMounted(async () => {
  unsubscribe = api.onDualReviewUpdate(receive)
  await Promise.all([refreshHistory(), refreshModels()])
  try {
    const saved = JSON.parse(localStorage.getItem('reviewModelChoices') || '{}')
    for (const role of modelRoles.map(r => r.id)) if (typeof saved.modelSelection?.[role] === 'string') modelSelection.value[role] = saved.modelSelection[role]
    for (const role of modelRoles.map(r => r.id)) if (typeof saved.codexModels?.[role] === 'string') codexModels.value[role] = saved.codexModels[role]
    if (typeof saved.codexPath === 'string') codexPath.value = saved.codexPath
    if (saved.codexProxy && typeof saved.codexProxy.enabled === 'boolean' && Number.isInteger(saved.codexProxy.port)) config.value.codexProxy = saved.codexProxy
  } catch { /* Ignore malformed local UI preferences. */ }
  try { const info = await api.getLocalCodexInfo(); codexDetected.value = !!info?.available; detectedCodexPath.value = info?.executable || '' } catch { /* Manual path remains available. */ }
  const last = localStorage.getItem('lastDualReviewId')
  if (last && history.value.some(h => h.id === last)) { historyId.value = last; await restore(last) }
})
onUnmounted(() => unsubscribe?.())
</script>
<style scoped>
.dual-review { padding: 24px; height: 100%; overflow-y: auto; box-sizing: border-box; }
header, .file-row, .actions, .history { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
header { justify-content: space-between; } h1 { margin: 0; font-size: 24px; } h2 { font-size: 19px; margin-top: 28px; }
.controls, .run-status, .revision { margin: 20px 0; padding: 18px; border: 1px solid var(--el-border-color); border-radius: 12px; }
.file-row { margin-bottom: 16px; overflow-wrap: anywhere; }.hint { color: var(--el-text-color-secondary); font-size: 13px; overflow-wrap: anywhere; }
.model-grid { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0; }.codex-path { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.results { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }.diff { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
del, ins { display: block; padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; text-decoration: none; }
del { background: var(--el-color-danger-light-9); border-left: 3px solid var(--el-color-danger); }ins { background: var(--el-color-success-light-9); border-left: 3px solid var(--el-color-success); }
.text { white-space: pre-wrap; }summary { cursor: pointer; margin: 20px 0; }.el-alert { margin: 12px 0; }
@media (max-width: 1100px) { .results, .diff { grid-template-columns: 1fr; } }
</style>
