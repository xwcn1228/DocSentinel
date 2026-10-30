<template>
  <section class="review-result">
    <h3>{{ title }} <el-tag :type="result.status === 'failed' ? 'danger' : 'info'">{{ result.status === 'failed' ? '失败' : '结果有效' }}</el-tag></h3>
    <el-alert v-if="result.error" :title="result.error" type="error" :closable="false" />
    <p v-if="result.overallRiskScore !== undefined"><strong>{{ result.overallRiskScore }} / 100</strong><br>Agent 启发式风险评分（非真实 AI 概率，越高风险越高）</p>
    <p v-if="result.confidence !== undefined">主观判断信心：{{ result.confidence }}（非概率校准）</p>
    <p>{{ result.qualitativeAssessment }}</p><p>{{ result.summary }}</p>
    <article v-for="issue in result.issues" :key="issue.id" class="issue">
      <strong>{{ issue.severity }} · {{ issue.id }}</strong><p>{{ issue.reason }}</p><p>建议：{{ issue.suggestion }}；信心：{{ issue.confidence }}</p>
      <blockquote v-for="(e, i) in issue.evidence" :key="i">{{ e.blockId }}：{{ e.quote }}</blockquote>
    </article>
    <details v-if="result.paragraphResults.length"><summary>逐段判断与证据（{{ result.paragraphResults.length }} 段）</summary>
      <article v-for="p in result.paragraphResults" :key="p.blockId" class="issue"><strong>{{ p.blockId }} · {{ p.riskScore }}</strong><p>{{ p.reason }}；信心：{{ p.confidence }}</p><blockquote v-for="(e, i) in p.evidence" :key="i">{{ e.blockId }}：{{ e.quote }}</blockquote></article>
    </details>
    <details v-if="result.resolutions.length"><summary>上一轮问题复核</summary><p v-for="r in result.resolutions" :key="r.issueId">{{ r.issueId }} · {{ r.resolved ? '已解决' : '未解决' }}：{{ r.reason }}</p></details>
  </section>
</template>
<script setup lang="ts">
import type { ReviewResult } from '../../shared/reviewWorkflow'
defineProps<{ title: string; result: ReviewResult }>()
</script>
<style scoped>
.review-result { padding: 16px; border: 1px solid var(--el-border-color); border-radius: 10px; min-width: 0; }
h3 { margin-top: 0; } p, blockquote { white-space: pre-wrap; overflow-wrap: anywhere; }
blockquote { margin: 8px 0; padding: 6px 12px; border-left: 3px solid var(--el-color-primary); background: var(--el-fill-color-light); }
.issue { border-top: 1px solid var(--el-border-color-lighter); padding-top: 12px; margin-top: 12px; }
summary { cursor: pointer; margin-top: 16px; }
</style>
