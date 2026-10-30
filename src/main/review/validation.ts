import { codexModelId, DEFAULT_REVIEW_CONFIG, DocumentBlock, Evidence, ModelRole, ReviewBundle, ReviewConfig, ReviewDecision, ReviewIssue, Reviewer, ReviewModelChoice, ReviewResult, RevisionPlan } from '../../shared/reviewWorkflow'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`结果校验失败：${message}`)
}
const string = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
function array(value: unknown): any[] { assert(Array.isArray(value), '应为数组'); return value }
function number(value: unknown, max = 100): number {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max, `分值必须为 0–${max} 的数值`)
  return value
}
export function parseObject(text: string): any {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const result = JSON.parse(clean)
  assert(result && typeof result === 'object' && !Array.isArray(result), '必须是 JSON 对象')
  return result
}

export function validateConfig(value: ReviewConfig): ReviewConfig {
  assert(value && Number.isInteger(value.maxRounds) && value.maxRounds >= 1 && value.maxRounds <= 10, '循环轮数须为 1–10')
  number(value.maxRiskB)
  number(value.maxRiskC)
  assert(string(value.discipline) && value.discipline.length <= 200, '缺少学科或学科名称过长')
  const codexProxy = value.codexProxy ?? DEFAULT_REVIEW_CONFIG.codexProxy
  assert(typeof codexProxy.enabled === 'boolean' && Number.isInteger(codexProxy.port) && codexProxy.port >= 1 && codexProxy.port <= 65535, 'Codex 代理端口须为 1–65535')
  const models = {} as Record<ModelRole, ReviewModelChoice>
  for (const role of ['structure', 'content', 'reviseStructure', 'reviseContent'] as const) {
    const legacy = (value.models as typeof value.models & { reviser?: ReviewModelChoice })?.reviser
    const choice = value.models?.[role] || (role.startsWith('revise') ? legacy : undefined) || { kind: 'selected-api' }
    assert(choice && ['selected-api', 'saved-api', 'local-codex'].includes(choice.kind), `${role} 模型来源无效`)
    if (choice.kind === 'saved-api') {
      assert(Number.isSafeInteger(choice.apiSettingId) && choice.apiSettingId > 0, `${role} 已保存模型 ID 无效`)
      models[role] = { kind: 'saved-api', apiSettingId: choice.apiSettingId }
    } else if (choice.kind === 'local-codex') {
      assert(choice.executable === undefined || (string(choice.executable) && choice.executable.length <= 500), `${role} Codex 路径无效`)
      assert(choice.model === undefined || (string(choice.model) && choice.model.length <= 100), `${role} Codex 模型名无效`)
      const model = codexModelId(choice.model)
      models[role] = { kind: 'local-codex', ...(choice.executable ? { executable: choice.executable.trim() } : {}), ...(model ? { model } : {}) }
    } else models[role] = { kind: 'selected-api' }
  }
  return { maxRounds: value.maxRounds, maxRiskB: value.maxRiskB, maxRiskC: value.maxRiskC, discipline: value.discipline, codexProxy: { ...codexProxy }, models }
}

// —— 证据引文分级匹配 ——
// 模型引用原文时常出现无恶意的偏差：多余/缺失空白、全角半角混用（NFKC 归一
// 可消除）、弯引号与直引号、零宽字符。先用原文精确匹配；未命中再做归一化
// 匹配（NFKC + 去零宽 + 去全部空白），并要求归一化后引文长度 ≥6，避免短片段
// 跨词误配。归一化后仍匹配不上才判定为编造证据——防幻觉的底线不变。
const ZERO_WIDTH_RE = /[​-‍﻿]/g
const DOUBLE_QUOTE_FOLD_RE = /[“”„«»]/g
const SINGLE_QUOTE_FOLD_RE = /[‘’‹›]/g
function normalizeForEvidence(text: string): string {
  return text.normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(/\s+/g, '')
    .replace(DOUBLE_QUOTE_FOLD_RE, '"')
    .replace(SINGLE_QUOTE_FOLD_RE, "'")
}
export function evidenceMatches(blockText: string, quote: string): boolean {
  if (blockText.includes(quote)) return true
  const normalizedQuote = normalizeForEvidence(quote)
  if (normalizedQuote.length < 6) return false
  return normalizeForEvidence(blockText).includes(normalizedQuote)
}

export function validateEvidence(value: unknown, blocks: DocumentBlock[], required = true, context = '证据'): Evidence[] {
  const evidence = array(value).map(e => {
    assert(e && string(e.blockId) && string(e.quote), `${context}缺少块 ID 或引文`)
    assert(blocks.some(b => b.id === e.blockId && evidenceMatches(b.text, e.quote)), `${context}不匹配原文 ${e.blockId}`)
    return { blockId: e.blockId, quote: e.quote }
  })
  assert(!required || evidence.length > 0, `${context}缺少可核实原文证据`)
  return evidence
}

export function validateReview(reviewer: Reviewer, raw: any, blocks: DocumentBlock[], previous: ReviewIssue[] = []): ReviewResult {
  assert(raw && string(raw.summary), '缺少 summary')
  const ids = new Set<string>()
  const issues: ReviewIssue[] = array(raw.issues).map(i => {
    assert(i && string(i.id) && !ids.has(i.id), '问题 ID 缺失或重复'); ids.add(i.id)
    assert(['minor', 'major', 'critical'].includes(i.severity), '问题严重性无效')
    assert(string(i.reason) && string(i.suggestion), '问题缺少理由或建议')
    return { id: i.id, reviewer, severity: i.severity, reason: i.reason, suggestion: i.suggestion, confidence: number(i.confidence, 1), evidence: validateEvidence(i.evidence, blocks, true, `问题 ${i.id} 的证据`) }
  })
  const prior = previous.filter(i => i.reviewer === reviewer)
  const seen = new Set<string>()
  const resolutions = array(raw.resolutions).map(r => {
    assert(r && prior.some(i => i.id === r.issueId) && !seen.has(r.issueId), '复核 ID 未知或重复'); seen.add(r.issueId)
    assert(typeof r.resolved === 'boolean' && string(r.reason), '复核状态/理由无效')
    assert(r.resolved ? !ids.has(r.issueId) : ids.has(r.issueId), '复核状态与问题列表矛盾')
    return { issueId: r.issueId, resolved: r.resolved, reason: r.reason, evidence: validateEvidence(r.evidence, blocks, true, `复核 ${r.issueId} 的证据`) }
  })
  assert(prior.every(i => seen.has(i.id)), '上一轮问题未经逐项复核')
  const result: ReviewResult = { reviewer, status: 'valid', paragraphResults: [], evidence: issues.flatMap(i => i.evidence), issues, resolutions, summary: raw.summary }
  assert(string(raw.qualitativeAssessment), '缺少定性评估')
  result.qualitativeAssessment = raw.qualitativeAssessment
  const paragraphIds = new Set<string>()
  result.paragraphResults = array(raw.paragraphResults).map(p => {
    assert(p && blocks.some(b => b.id === p.blockId) && !paragraphIds.has(p.blockId), '段落 ID 无效或重复'); paragraphIds.add(p.blockId)
    const score = number(p.riskScore)
    assert(string(p.reason), '段落缺少判断理由')
    const evidence = validateEvidence(p.evidence, blocks, score >= 30, `段落 ${p.blockId} 的证据`)
    assert(score < 30 || evidence.some(e => e.blockId === p.blockId), '风险段落缺少本段证据')
    return { blockId: p.blockId, riskScore: score, reason: p.reason, confidence: number(p.confidence, 1), evidence }
  })
  assert(blocks.every(b => paragraphIds.has(b.id)), '段落评估未覆盖全文')
  result.scoreType = 'agent-heuristic'
  const totalChars = blocks.reduce((sum, b) => sum + Math.max(1, b.text.length), 0)
  result.overallRiskScore = Math.round(result.paragraphResults.reduce((sum, p) => sum + p.riskScore * Math.max(1, blocks.find(b => b.id === p.blockId)!.text.length), 0) / totalChars * 100) / 100
  result.evidence = [...result.evidence, ...result.paragraphResults.flatMap(p => p.evidence)]
  return result
}

export function decide(reviews: ReviewBundle, config: ReviewConfig): ReviewDecision {
  const valid = reviews.structure.status === 'valid' && reviews.content.status === 'valid'
  const priorityBlockIds = valid ? [...new Set(reviews.structure.issues.flatMap(i => i.evidence.map(e => e.blockId)).filter(id => reviews.content.issues.some(i => i.evidence.some(e => e.blockId === id))))] : []
  const reasons: string[] = []
  for (const r of [reviews.structure, reviews.content]) {
    if (r.status !== 'valid') reasons.push(`${r.reviewer} 调用或校验失败：${r.error}`)
  }
  if (reviews.structure.status === 'valid' && reviews.structure.overallRiskScore! > config.maxRiskB) reasons.push(`B 结构风险分超过阈值 ${config.maxRiskB}`)
  if (reviews.content.status === 'valid' && reviews.content.overallRiskScore! > config.maxRiskC) reasons.push(`C 内容风险分超过阈值 ${config.maxRiskC}`)
  return { passed: reasons.length === 0, reasons, risk: {
    priorityBlockIds,
    evidence: valid ? [...reviews.structure.evidence, ...reviews.content.evidence] : [],
    summary: !valid ? 'B/C 审查结果无效，不得通过。' : reasons.length ? `B 结构风险 ${reviews.structure.overallRiskScore}，C 内容风险 ${reviews.content.overallRiskScore}；按超阈值项修改。` : 'AI 风格风险低，无需修改。'
  } }
}

export function qualityTasks(reviews: ReviewBundle): ReviewIssue[] {
  return [...reviews.structure.issues, ...reviews.content.issues]
}
export function validateRevision(raw: any, blocks: DocumentBlock[], reviews: ReviewBundle, stage: 'structure' | 'content'): RevisionPlan {
  assert(raw && string(raw.summary), '修改计划缺少说明')
  const tasks = stage === 'structure' ? reviews.structure.issues : reviews.content.issues
  const check = (operation: any) => {
    const block = blocks.find(b => b.id === operation?.blockId)
    assert(block && block.editable, `块不存在或受保护 ${operation?.blockId}`)
    assert(string(operation.reason), '修改缺少理由')
    const ids = array(operation.issueIds)
    assert(ids.length > 0 && ids.every(id => tasks.some(t => t.id === id && t.evidence.some(e => e.blockId === block.id))), '修改必须关联本阶段质量问题且有本段证据')
    return block
  }
  const ranges = new Map<string, [number, number][]>()
  // 数字/引用/占位符/URL 的保护比对：多重集合（排序后）比较 + 归一化
  // （NFKC 全半角、千分位逗号），语序调整不误伤；仍会拦截增删或改写数值。
  const protectedTokens = (s: string) =>
    (s.match(/\[\[[\s\S]*?\]\]|\[[^\]]*\]|https?:\/\/\S+|\d+(?:[.,]\d+)*(?:%|％)?/g) || [])
      .map(t => t.normalize('NFKC').replace(/(\d),(?=\d{3}\b)/g, '$1'))
      .sort()
  let droppedTokenEdits = 0
  const edits = array(raw.edits).map(e => {
    const block = check(e)
    assert(string(e.original) && typeof e.replacement === 'string' && !/[\r\n\u0000]/.test(e.replacement), '修改文本无效或跨段')
    const start = block.text.indexOf(e.original)
    assert(start >= 0 && block.text.indexOf(e.original, start + 1) < 0, '原文不匹配或不唯一')
    const end = start + e.original.length
    const used = ranges.get(block.id) || []
    assert(!used.some(([a,b]) => start < b && end > a), '段内修改重叠'); used.push([start,end]); ranges.set(block.id, used)
    // 改动数字/引用的提议不落盘（保持原文不动），也不因单条违规否决整份计划——
    // 重试+对半拆分仍失败会让整个任务停摆；丢弃并在 summary 说明更稳健。
    if (JSON.stringify(protectedTokens(e.original)) !== JSON.stringify(protectedTokens(e.replacement))) {
      droppedTokenEdits++
      return null
    }
    return { blockId: block.id, original: e.original, replacement: e.replacement, reason: e.reason, issueIds: e.issueIds }
  }).filter((e): e is { blockId: string; original: string; replacement: string; reason: string; issueIds: string[] } => e !== null)
  const moves = array(raw.moves).map(m => {
    assert(stage === 'structure', '内容阶段不允许移动段落')
    const source = blocks.find(b => b.id === m?.blockId), target = blocks.find(b => b.id === m?.beforeBlockId)
    assert(source?.movable && target?.movable && source.id !== target.id, '移动目标不存在或受保护')
    assert(string(m.reason), '移动缺少理由')
    const issueIds = array(m.issueIds)
    assert(issueIds.length > 0 && issueIds.every(id => tasks.some(t => t.id === id && t.evidence.some(e => e.blockId === source.id))), '移动必须关联本段结构问题')
    return { blockId: source.id, beforeBlockId: target.id, reason: m.reason, issueIds }
  })
  assert(new Set(moves.map(m => m.blockId)).size === moves.length, '段落不能重复移动')
  const summary = droppedTokenEdits > 0
    ? `${raw.summary}（已丢弃 ${droppedTokenEdits} 条改变数字/引用/受保护标记的修改提议，对应文字保持原文。）`
    : raw.summary
  return { edits, moves, summary }
}
