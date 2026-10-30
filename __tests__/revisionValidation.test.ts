import { describe, expect, it } from 'vitest'
import { validateRevision } from '../src/main/review/validation'
import { DocumentBlock, ReviewBundle } from '../src/shared/reviewWorkflow'

// 最小可用审查结果：一条 structure 问题，证据落在 b1
const bundle = (): ReviewBundle => {
  const mk = (reviewer: 'structure' | 'content') => ({
    reviewer, status: 'valid' as const, overallRiskScore: 50, paragraphResults: [],
    evidence: [], resolutions: [], summary: '模拟',
    issues: [
      { id: 'b000001::issue_1', reviewer, severity: 'major' as const, reason: '模拟结构问题', suggestion: '调整', confidence: 0.8, evidence: [{ blockId: 'b000001', quote: '本文研究' }] },
      { id: 'b000002::issue_1', reviewer, severity: 'major' as const, reason: '模拟结构问题', suggestion: '调整', confidence: 0.8, evidence: [{ blockId: 'b000002', quote: '数据表明' }] }
    ]
  })
  return { structure: mk('structure'), content: mk('content') }
}
const blocks = (): DocumentBlock[] => [
  { id: 'b000001', text: '本文研究测试方法。样本有20份，相关指标见[1]。', editable: true, movable: true },
  { id: 'b000002', text: '2024年的数据表明，系统吞吐提升了1,024次每秒，详见https://example.com/a。', editable: true, movable: true }
]

describe('修改计划：数字/引用保护与软丢弃', () => {
  it('改变数字的修改被丢弃（不抛错），其余合法修改保留', () => {
    const plan = validateRevision({
      summary: '模拟修改',
      edits: [
        { blockId: 'b000001', original: '本文研究', replacement: '本文探讨', reason: '表达优化', issueIds: ['b000001::issue_1'] },
        { blockId: 'b000001', original: '样本有20份', replacement: '样本有30份', reason: '试图改数字', issueIds: ['b000001::issue_1'] }
      ],
      moves: []
    }, blocks(), bundle(), 'structure')
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0].replacement).toBe('本文探讨')
    expect(plan.summary).toContain('已丢弃 1 条')
  })
  it('语序调整导致数字先后互换不误伤（多重集合比较）', () => {
    const plan = validateRevision({
      summary: '模拟修改',
      edits: [{ blockId: 'b000002', original: '2024年的数据表明，系统吞吐提升了1,024次每秒', replacement: '系统吞吐在2024年提升了1,024次每秒', reason: '语序调整', issueIds: ['b000002::issue_1'] }],
      moves: []
    }, blocks(), bundle(), 'structure')
    expect(plan.edits).toHaveLength(1)
  })
  it('全角百分号与千分位写法差异不误伤，数值实质变化仍丢弃', () => {
    const ok = validateRevision({
      summary: '模拟',
      edits: [{ blockId: 'b000002', original: '提升了1,024次每秒', replacement: '提升了1024次/每秒', reason: '格式', issueIds: ['b000002::issue_1'] }],
      moves: []
    }, blocks(), bundle(), 'structure')
    expect(ok.edits).toHaveLength(1)
    const bad = validateRevision({
      summary: '模拟',
      edits: [{ blockId: 'b000002', original: '提升了1,024次每秒', replacement: '提升了2,048次每秒', reason: '试图翻倍', issueIds: ['b000002::issue_1'] }],
      moves: []
    }, blocks(), bundle(), 'structure')
    expect(bad.edits).toHaveLength(0)
    expect(bad.summary).toContain('已丢弃 1 条')
  })
})
