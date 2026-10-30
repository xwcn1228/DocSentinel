import { DocumentBlock, ReviewIssue, ReviewResult, Reviewer } from '../../shared/reviewWorkflow'

// Keep both input and required per-paragraph JSON output within modest budgets.
// 标题对齐：遇到标题块且当前片段已积累足够内容时优先在标题前切断，B 结构路
// 因此尽量拿到完整小节的上下文；小节不足 SECTION_MIN_CHARS 时并入后续内容，
// 避免大量微小章节把片段数（= 模型调用次数）炸开。硬上限（字数/块数）不因
// 标题放宽；单块超长仍独立成片段，块本身永不切开。
const SECTION_MIN_CHARS = 1200
export function partitionBlocks(blocks: DocumentBlock[], maxChars = 3600, maxBlocks = 8): DocumentBlock[][] {
  const chunks: DocumentBlock[][] = []
  let current: DocumentBlock[] = [], chars = 0
  const closeCurrent = () => { chunks.push(current); current = []; chars = 0 }
  for (const block of blocks) {
    const hardLimit = current.length >= maxBlocks || chars + block.text.length > maxChars
    const sectionBreak = !!block.heading && current.length > 0 && chars >= SECTION_MIN_CHARS
    if (current.length && (hardLimit || sectionBreak)) closeCurrent()
    current.push(block); chars += block.text.length
  }
  if (current.length) chunks.push(current)
  return chunks
}

export function issuesForChunk(issues: ReviewIssue[], reviewer: Reviewer, chunk: DocumentBlock[]): ReviewIssue[] {
  const ids = new Set(chunk.map(b => b.id))
  return issues.filter(issue => issue.reviewer === reviewer && ids.has(issue.evidence[0]?.blockId))
}

// Prefix new model IDs with the first evidence block; preserve IDs seen in prior rounds.
export function stabilizeIssueIds(raw: any, prior: ReviewIssue[]): any {
  if (!prior.length && Array.isArray(raw?.resolutions) && raw.resolutions.length) {
    raw.resolutions = []
    if (typeof raw.summary === 'string') raw.summary += '（本片段没有上一轮问题；已忽略模型返回的无关复核项。）'
  }
  if (!Array.isArray(raw?.issues)) return raw
  for (const resolution of raw.resolutions || []) {
    const old = prior.find(p => p.id === resolution?.issueId || p.id.endsWith(`::${resolution?.issueId}`))
    if (old) resolution.issueId = old.id
  }
  for (const issue of raw.issues) {
    if (typeof issue?.id !== 'string') continue
    const old = prior.find(p => p.id === issue.id || p.id.endsWith(`::${issue.id}`))
    if (old) issue.id = old.id
    else if (!/^b\d{6}::/.test(issue.id) && typeof issue.evidence?.[0]?.blockId === 'string') issue.id = `${issue.evidence[0].blockId}::${issue.id}`
  }
  return raw
}

const round = (score: number) => Math.round(score * 100) / 100
export function mergeChunkReviews(reviewer: Reviewer, results: ReviewResult[], chunks: DocumentBlock[][]): ReviewResult {
  if (results.length === 1) return results[0]
  const weights = chunks.map(chunk => Math.max(1, chunk.reduce((n, b) => n + b.text.length, 0)))
  const weighted = (values: number[]) => round(values.reduce((n, value, i) => n + value * weights[i], 0) / weights.reduce((a, b) => a + b, 0))
  const merged: ReviewResult = {
    reviewer, status: 'valid', paragraphResults: results.flatMap(r => r.paragraphResults),
    evidence: results.flatMap(r => r.evidence), issues: results.flatMap(r => r.issues),
    resolutions: results.flatMap(r => r.resolutions),
    summary: results.map((r, i) => `片段 ${i + 1}/${results.length}：${r.summary}`).join('\n')
  }
  if (new Set(merged.issues.map(i => i.id)).size !== merged.issues.length) throw new Error('跨片段问题 ID 重复，不能合并审查结果')
  merged.scoreType = 'agent-heuristic'
  merged.qualitativeAssessment = results.map((r, i) => `片段 ${i + 1}：${r.qualitativeAssessment}`).join('\n')
  merged.overallRiskScore = weighted(results.map(r => r.overallRiskScore!))
  return merged
}
