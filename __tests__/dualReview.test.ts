import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_REVIEW_CONFIG, DocumentBlock, Reviewer, WorkflowRun, REVIEW_MODEL_NOTICE } from '../src/shared/reviewWorkflow'
import { decide, validateConfig, validateEvidence, validateReview } from '../src/main/review/validation'
import { evaluateOne, executeWorkflow, ReviewDependencies } from '../src/main/review/engine'
import { reportMarkdown } from '../src/main/review/storage'
import { codexReviewSchema } from '../src/main/review/localCodex'
import { modelRoleForStage, resolveReviewModels } from '../src/main/review/modelRouting'

// Every model result in this file is simulated and never stored as a live detection.
const blocks: DocumentBlock[] = [{ id: 'b000001', text: '本文讨论研究方法。', editable: true, movable: true }]
const evidence = [{ blockId: blocks[0].id, quote: blocks[0].text }]
function response(reviewer: Reviewer, input: any, score: number) {
  const prior = input.previousIssues || []
  const high = score > 80
  const issues = high ? [prior[0] ? { ...prior[0], evidence } : { id: `${reviewer}-issue`, severity: 'major', reason: '模拟：段落表达重复且空泛', suggestion: '明确论据与衔接', confidence: 0.8, evidence }] : []
  return { summary: '模拟风险审查', qualitativeAssessment: high ? '模拟高风险' : '模拟低风险', issues,
    resolutions: prior.map((p: any) => ({ issueId: p.id, resolved: !high, reason: '模拟复核', evidence })),
    paragraphResults: input.blocks.map((b: DocumentBlock) => ({ blockId: b.id, riskScore: score, reason: '模拟逐段理由', confidence: 0.8, evidence: score >= 30 ? [{ blockId: b.id, quote: b.text }] : [] })) }
}
function run(config = DEFAULT_REVIEW_CONFIG): WorkflowRun {
  return { id: 'mock-only', status: 'running', dataOrigin: 'mock', sourcePath: 'mock-source.docx', originalPath: 'mock-original.docx',
    originalSha256: 'mock', currentPath: 'mock-original.docx', directory: 'mock-only', config, model: 'mock', modelNotice: REVIEW_MODEL_NOTICE,
    startedAt: '2026-10-30T00:00:00Z', phase: '', rounds: [], pendingRevisions: [], unresolvedIssues: [], errors: [] }
}
function deps(scores: (stage: Reviewer, call: number) => number, abort?: AbortController): ReviewDependencies & { calls: string[] } {
  const counts: Record<Reviewer, number> = { structure: 0, content: 0 }
  const calls: string[] = []
  return { calls, call: vi.fn(async (stage, _system, text) => {
    calls.push(stage)
    if (stage.startsWith('revise')) return JSON.stringify({ summary: '模拟无安全修改', edits: [], moves: [] })
    const reviewer = stage as Reviewer
    return JSON.stringify(response(reviewer, JSON.parse(text), scores(reviewer, counts[reviewer]++)))
  }), read: vi.fn(async () => structuredClone(blocks)),
  revise: vi.fn(async (_source, round, stage) => { if (abort) abort.abort(); return `mock-round-${round}-${stage}.docx` }),
  persist: vi.fn(async () => {}), notify: vi.fn() }
}


describe('证据引文分级匹配（空白/全半角/引号容差，编造仍拦截）', () => {
  const rich: DocumentBlock[] = [{ id: 'b000010', text: '实验表明，模型在“高负载”下的吞吐量提升了 30%。', editable: true, movable: true }]
  it('引文与原文完全一致时通过（精确匹配）', () => {
    expect(validateEvidence([{ blockId: 'b000010', quote: '模型在“高负载”下的吞吐量' }], rich)).toHaveLength(1)
  })
  it('引文多余空格、全角数字百分号、直引号替代弯引号时通过（归一化匹配）', () => {
    expect(validateEvidence([{ blockId: 'b000010', quote: '模型在"高负载"下的吞吐量提升了３０％' }], rich)).toHaveLength(1)
    expect(validateEvidence([{ blockId: 'b000010', quote: '吞吐量 提升了 30' }], rich)).toHaveLength(1)
  })
  it('归一化后仍对不上的编造引文继续拦截', () => {
    expect(() => validateEvidence([{ blockId: 'b000010', quote: '本实验证明该方法完全无效' }], rich)).toThrow('不匹配原文')
  })
  it('过短的模糊片段不参与归一化匹配（防跨词误配）', () => {
    expect(() => validateEvidence([{ blockId: 'b000010', quote: '实验表明' }], rich, false)).not.toThrow()
    expect(() => validateEvidence([{ blockId: 'b000010', quote: '不存在 的 短语' }], rich, false)).toThrow('不匹配原文')
  })
})

describe('B/C 双路风险工作流（模拟模型）', () => {
  it.each(['structure', 'content'] as Reviewer[])('%s 单独评估并按段落分计算整体风险', async reviewer => {
    const result = await evaluateOne(reviewer, blocks, DEFAULT_REVIEW_CONFIG, [], { call: async (_stage, _prompt, input) => JSON.stringify(response(reviewer, JSON.parse(input), 25)) }, new AbortController().signal)
    expect(result.status).toBe('valid')
    expect(result.overallRiskScore).toBe(25)
    expect(result.scoreType).toBe('agent-heuristic')
    expect(result.paragraphResults).toHaveLength(1)
  })
  it('阈值等于风险分时通过；两路未超阈值直接结束且不修改', async () => {
    const state = run({ ...DEFAULT_REVIEW_CONFIG, maxRiskB: 80, maxRiskC: 80 })
    const d = deps(() => 80)
    const result = await executeWorkflow(state, d, new AbortController().signal)
    expect(result.status).toBe('passed')
    expect(result.phase).toContain('AI率低，无需修改')
    expect(result.rounds).toHaveLength(1)
    expect(d.revise).not.toHaveBeenCalled()
    expect(d.calls.sort()).toEqual(['content', 'structure'])
    expect(reportMarkdown(result)).toContain('模拟结果，仅用于测试')
  })
  it('B 超阈值、C 未超阈值时只运行结构修改，复审后通过', async () => {
    const d = deps((stage, call) => stage === 'structure' && call === 0 ? 90 : 20)
    const result = await executeWorkflow(run(), d, new AbortController().signal)
    expect(result.status).toBe('passed')
    expect(result.rounds).toHaveLength(2)
    expect(d.calls.filter(s => s.startsWith('revise'))).toEqual(['reviseStructure'])
    expect(result.rounds[1].revisions.map(r => r.stage)).toEqual(['structure'])
  })
  it('C 超阈值、B 未超阈值时只运行内容修改', async () => {
    const d = deps((stage, call) => stage === 'content' && call === 0 ? 90 : 20)
    expect((await executeWorkflow(run(), d, new AbortController().signal)).status).toBe('passed')
    expect(d.calls.filter(s => s.startsWith('revise'))).toEqual(['reviseContent'])
  })
  it('双路都超阈值时先改结构后改内容，并自动复审', async () => {
    const d = deps((_stage, call) => call === 0 ? 90 : 20)
    const result = await executeWorkflow(run(), d, new AbortController().signal)
    expect(result.status).toBe('passed')
    expect(d.calls.filter(s => s.startsWith('revise'))).toEqual(['reviseStructure', 'reviseContent'])
    expect(result.rounds[1].revisions.map(r => r.stage)).toEqual(['structure', 'content'])
  })
  it('达到最大轮数时保留最新候选及未解决问题', async () => {
    const d = deps(() => 90)
    const result = await executeWorkflow(run({ ...DEFAULT_REVIEW_CONFIG, maxRounds: 1 }), d, new AbortController().signal)
    expect(result.status).toBe('not-passed')
    expect(result.currentPath).toBe('mock-round-1-content.docx')
    expect(result.unresolvedIssues.length).toBeGreaterThan(0)
  })
  it('检测失败不得默认通过，且不执行修改', async () => {
    const d = deps(() => 20)
    d.call = vi.fn(async stage => { if (stage === 'structure') throw new Error('模拟调用失败'); return JSON.stringify(response('content', { blocks }, 20)) })
    const result = await executeWorkflow(run(), d, new AbortController().signal)
    expect(result.status).toBe('failed')
    expect(d.revise).not.toHaveBeenCalled()
  })
  it('用户停止后保留已安全保存的候选', async () => {
    const controller = new AbortController(), d = deps(() => 90, controller)
    const result = await executeWorkflow(run(), d, controller.signal)
    expect(result.status).toBe('stopped')
    expect(result.currentPath).toBe('mock-round-1-structure.docx')
  })
  it('低分可有问题记录，但不会仅凭问题进入修改；无效证据拒绝', () => {
    const low = validateReview('structure', response('structure', { blocks }, 20), blocks)
    const content = validateReview('content', response('content', { blocks }, 20), blocks)
    expect(decide({ structure: low, content }, DEFAULT_REVIEW_CONFIG).passed).toBe(true)
    const bad = response('structure', { blocks }, 90)
    bad.issues[0].evidence = [{ blockId: blocks[0].id, quote: '不存在' }]
    expect(() => validateReview('structure', bad, blocks)).toThrow('证据')
  })
  it('阈值和独立模型路由有效，Codex 结构化 schema 覆盖两路和修改阶段', async () => {
    expect(() => validateConfig({ ...DEFAULT_REVIEW_CONFIG, maxRiskB: 101 })).toThrow()
    const config = validateConfig({ ...DEFAULT_REVIEW_CONFIG, models: { ...DEFAULT_REVIEW_CONFIG.models,
      structure: { kind: 'local-codex', model: 'GPT-6.1 Sol' }, content: { kind: 'saved-api', apiSettingId: 2 },
      reviseStructure: { kind: 'local-codex' }, reviseContent: { kind: 'selected-api' } } })
    const current = { apiKey: 'mock', apiURL: 'http://mock.invalid', modelName: 'current' }
    const models = await resolveReviewModels(config, current, async id => id === 2 ? { ...current, modelName: 'saved' } : null)
    expect(models.structure).toMatchObject({ kind: 'local-codex', model: 'gpt-6.1-sol' })
    expect(models.content).toMatchObject({ kind: 'api', api: { modelName: 'saved' } })
    expect(models.reviseStructure.kind).toBe('local-codex')
    expect(modelRoleForStage('reviseContent')).toBe('reviseContent')
    expect((codexReviewSchema('structure') as any).required).toContain('paragraphResults')
    expect((codexReviewSchema('content') as any).required).toContain('paragraphResults')
    expect((codexReviewSchema('reviseStructure') as any).required).toContain('moves')
  })
  it('长文按片审查，B/C 均覆盖全部块', async () => {
    const many = Array.from({ length: 25 }, (_, i): DocumentBlock => ({ id: `b${String(i + 1).padStart(6, '0')}`, text: `模拟段落 ${i + 1}。`, editable: true, movable: true }))
    const sizes: number[] = []
    for (const reviewer of ['structure', 'content'] as Reviewer[]) {
      const result = await evaluateOne(reviewer, many, DEFAULT_REVIEW_CONFIG, [], { call: async (_stage, _prompt, input) => {
        const data = JSON.parse(input); sizes.push(data.blocks.length)
        return JSON.stringify(response(reviewer, data, 20))
      } }, new AbortController().signal)
      expect(result.status).toBe('valid')
      expect(result.paragraphResults).toHaveLength(25)
    }
    expect(sizes.length).toBe(8)
    expect(sizes.every(size => size <= 8)).toBe(true)
  })
})
