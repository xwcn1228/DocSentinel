import fs from 'node:fs/promises'
import path from 'node:path'
import { WorkflowRun } from '../../shared/reviewWorkflow'

export function reportMarkdown(run: WorkflowRun): string {
  const lines = ['# B/C 双路循环审查报告', '', `状态：${run.status}；${run.phase}`, `数据来源：${run.dataOrigin === 'mock' ? '模拟结果，仅用于测试' : '实际模型调用'}`, '', run.modelNotice,
    '', 'B/C 分数为 Agent 启发式文本风格风险分，越高风险越高，非真实 AI 生成概率。',
    `模型：${run.model}；学科：${run.config.discipline}；B 结构阈值 ${run.config.maxRiskB}；C 内容阈值 ${run.config.maxRiskC}；最多修改 ${run.config.maxRounds} 轮。`,
    ...(run.modelLabels ? [`B 模型：${run.modelLabels.structure}；C 模型：${run.modelLabels.content}；结构修改：${run.modelLabels.reviseStructure || '未记录'}；内容修改：${run.modelLabels.reviseContent || '未记录'}。`] : []),
    `原文 SHA256：${run.originalSha256}`, `当前候选：${path.basename(run.currentPath)}`,
    `Token 用量：${(() => { const u = run.tokenUsage || {}; const labels: Record<string, string> = { structure: 'B', content: 'C', reviseStructure: '结构修改', reviseContent: '内容修改' }; const parts = Object.entries(labels).filter(([s]) => (u[s] || 0) > 0).map(([s, l]) => `${l} ${u[s]}`); const total = Object.values(u).reduce((a, b) => a + (b || 0), 0); return parts.length ? `${parts.join(' · ')}｜合计 ${total}` : '未统计（本地 Codex CLI 不计入）' })()}`,
    '', '| 轮次 | B 结构风险分 | C 内容风险分 | 通过 |', '|---|---|---|---|']
  for (const round of run.rounds) {
    const r = round.reviews
    const score = (review?: typeof r.structure) => !review ? '无结果' : review.status === 'failed' ? '失败' : `${review.overallRiskScore}/100`
    lines.push(`| ${round.index} | ${score(r.structure)} | ${score(r.content)} | ${round.decision.passed} |`)
  }
  for (const round of run.rounds) {
    lines.push('', `## 第 ${round.index} 轮`, round.decision.risk?.summary || '', ...round.decision.reasons.map(r => `- ${r}`))
    for (const review of [round.reviews.structure, round.reviews.content]) {
      lines.push('', `### ${review.reviewer}`, `风险分：${review.overallRiskScore ?? '失败'}/100（非真实概率）`, review.summary, review.qualitativeAssessment || '', review.error || '')
      for (const p of review.paragraphResults) lines.push(`- ${p.blockId}：${p.riskScore}；信心 ${p.confidence}；${p.reason}`, ...p.evidence.map(e => `  - 「${e.quote}」`))
      for (const issue of review.issues) lines.push(`- [${issue.severity}] ${issue.id}：${issue.reason}；建议：${issue.suggestion}；信心 ${issue.confidence}`, ...issue.evidence.map(e => `  - ${e.blockId}：「${e.quote}」`))
      for (const r of review.resolutions) lines.push(`- 上轮问题 ${r.issueId}：${r.resolved ? '已解决' : '未解决'}；${r.reason}`, ...r.evidence.map(e => `  - ${e.blockId}：「${e.quote}」`))
    }
  }
  for (const revision of [...run.rounds.flatMap(r => r.revisions), ...run.pendingRevisions]) {
    lines.push('', `## ${revision.stage === 'structure' ? '结构' : '内容'}修改：${path.basename(revision.afterPath)}`, revision.summary)
    for (const edit of revision.edits) lines.push(`- ${edit.blockId}：${edit.reason}`, `  - 修改前：${edit.original}`, `  - 修改后：${edit.replacement}`)
    for (const move of revision.moves || []) lines.push(`- 移动 ${move.blockId} 至 ${move.beforeBlockId} 之前：${move.reason}`)
  }
  lines.push('', '## 未解决问题', ...run.unresolvedIssues.map(i => `- [${i.severity}] ${i.reviewer}/${i.id}：${i.reason}`), '', '## 执行错误', ...run.errors.map(e => `- ${e}`))
  return lines.join('\n')
}

// Windows 下杀毒软件/索引服务可能短暂占用刚写入的文件，导致 rename 报
// EPERM/EBUSY。短暂重试以避免持久化被偶发外部扫描打断。
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let i = 0; ; i++) {
    try { return await fs.rename(from, to) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && i < attempts - 1) {
        await new Promise(resolve => setTimeout(resolve, 20 * (i + 1)))
        continue
      }
      throw error
    }
  }
}

export async function persistRun(run: WorkflowRun): Promise<void> {
  const file = path.join(run.directory, 'run.json')
  await fs.writeFile(`${file}.tmp`, JSON.stringify(run, null, 2), 'utf8')
  await renameWithRetry(`${file}.tmp`, file)
  await fs.writeFile(path.join(run.directory, 'report.md'), reportMarkdown(run), 'utf8')
}

export async function loadRun(root: string, id: string): Promise<WorkflowRun> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('任务 ID 无效')
  const directory = path.join(root, id)
  const run: WorkflowRun = JSON.parse(await fs.readFile(path.join(directory, 'run.json'), 'utf8'))
  if (run.id !== id || path.resolve(run.directory) !== path.resolve(directory)) throw new Error('记录路径无效')
  return run
}

export async function exportBundle(run: WorkflowRun): Promise<Buffer> {
  const JSZip = require('jszip')
  const zip = new JSZip()
  zip.file('report.md', reportMarkdown(run))
  zip.file('versions.json', JSON.stringify(run, null, 2))
  const paths = new Set([run.originalPath, run.currentPath, ...run.rounds.map(r => r.candidatePath), ...run.rounds.flatMap(r => r.revisions.map(v => v.afterPath)), ...run.pendingRevisions.map(v => v.afterPath)])
  for (const file of paths) {
    if (path.dirname(path.resolve(file)) !== path.resolve(run.directory)) throw new Error('版本路径不在任务目录内')
    zip.file(`versions/${path.basename(file)}`, await fs.readFile(file))
    zip.file(`versions/${path.basename(file)}.blocks.json`, await fs.readFile(`${file}.blocks.json`))
  }
  zip.file('current-candidate.docx', await fs.readFile(run.currentPath))
  return zip.generateAsync({ type: 'nodebuffer' })
}
