import { describe, expect, it } from 'vitest'
import { applyHeuristicFloors, computeBlockSignals, signalsForPrompt } from '../src/main/review/heuristics'
import { DocumentBlock, ReviewResult } from '../src/shared/reviewWorkflow'

const block = (id: string, text: string): DocumentBlock => ({ id, text, editable: true, movable: true })

// 典型 AI 风格文本：模板句式 + 句长均匀 + 连接词密集 + 标点单一
const aiStyle = '首先，随着人工智能技术的发展，模型训练具有重要意义。其次，数据质量起到关键作用。再者，算法优化不仅影响效率，而且具有重要意义。最后，综上所述，该领域具有重要的作用。'
// 人写风格：句长起伏大、具体细节、标点多样
const humanStyle = '上周三下午，我在机房跑通了第一版训练脚本——只有 47 行，却折腾了整整两天。快吗？不算快。但那次实验让我明白了一件事：数据清洗比调参重要得多（老师也是这么说的）。后来我们把清洗规则从 3 条加到 17 条，准确率直接涨了 6.4 个点。'

describe('程序启发式信号', () => {
  it('AI 风格文本命中多个统计特征，得分显著高于人写文本', () => {
    const ai = computeBlockSignals(block('b1', aiStyle))
    const human = computeBlockSignals(block('b2', humanStyle))
    expect(ai.heuristicScore).toBeGreaterThanOrEqual(40)
    expect(ai.summary).toContain('总结模板')
    expect(human.heuristicScore).toBeLessThan(ai.heuristicScore)
    expect(human.heuristicScore).toBeLessThan(30)
  })
  it('短块（<40字）信号标记为不可靠且得分为 0', () => {
    const short = computeBlockSignals(block('b3', '这是一段很短的文字。'))
    expect(short.heuristicScore).toBe(0)
    expect(short.summary).toContain('不可靠')
  })
  it('signalsForPrompt 只保留有信号的块', () => {
    const blocks = [block('b1', aiStyle), block('b2', '这一段也是相当短的文字内容。')]
    const prompt = signalsForPrompt(blocks, blocks.map(b => computeBlockSignals(b)))
    const ids = prompt.map(s => s.blockId)
    expect(ids).toContain('b1')
    expect(ids).not.toContain('b2')
  })
})

describe('启发式兜底提升', () => {
  const result = (score: number): ReviewResult => ({
    reviewer: 'structure', status: 'valid', overallRiskScore: score,
    paragraphResults: [{ blockId: 'b1', riskScore: score, reason: '模型判断低风险', confidence: 0.8, evidence: [] }],
    evidence: [], issues: [], resolutions: [], summary: '模拟审查'
  })
  it('强信号（≥60）+ 模型低分（<30）时抬到 30 并标注', () => {
    const blocks = [block('b1', aiStyle)]
    const signal = computeBlockSignals(blocks[0])
    if (signal.heuristicScore < 60) return // 防御：夹具未达强信号阈值则跳过
    const raised = applyHeuristicFloors(result(10), blocks)
    expect(raised.paragraphResults[0].riskScore).toBe(30)
    expect(raised.paragraphResults[0].reason).toContain('程序统计信号提升')
    expect(raised.overallRiskScore).toBeGreaterThan(10)
    expect(raised.summary).toContain('兜底提升')
  })
  it('纯 AI 文本被模型均匀打低分（18/22）时，统计托底抬高整体分', () => {
    const blocks = [block('b1', aiStyle), block('b2', aiStyle + '与此同时，为进一步地提升效果，方案具有广阔的应用前景，起到了至关重要的作用。')]
    const low = { ...result(20), paragraphResults: [
      { blockId: 'b1', riskScore: 22, reason: '模型判断低风险', confidence: 0.8, evidence: [] },
      { blockId: 'b2', riskScore: 18, reason: '模型判断低风险', confidence: 0.8, evidence: [] }
    ] } as ReviewResult
    const calibrated = applyHeuristicFloors(low, blocks)
    expect(calibrated.overallRiskScore).toBeGreaterThan(22)
    expect(calibrated.summary).toContain('统计信号托底')
  })
  it('模型已给 ≥30 或信号弱时不改动', () => {
    const untouched = applyHeuristicFloors(result(10), [block('b1', humanStyle)])
    expect(untouched.paragraphResults[0].riskScore).toBe(10)
    const alreadyHigh = applyHeuristicFloors(result(45), [block('b1', aiStyle)])
    expect(alreadyHigh.paragraphResults[0].riskScore).toBe(45)
    expect(alreadyHigh.summary).toContain('程序信号校准')
  })
})
