import { beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { partitionBlocks } from '../src/main/review/chunking'
import { computeBlockSignals, loadExternalPhrases } from '../src/main/review/heuristics'
import { DocumentBlock } from '../src/shared/reviewWorkflow'

const para = (id: string, text: string, heading = false): DocumentBlock => ({ id, text, editable: !heading, movable: !heading, heading })
const long = (prefix: string) => `${prefix}这是一段用于测试的正文内容，包含足够多的文字以撑起片段体积。` + '数据表明该方案在多个场景下的表现稳定可靠，能够支撑后续分析。'.repeat(3)

describe('标题对齐切块', () => {
  it('当前片段积累足够内容时，在标题前切断（片段不跨章节）', () => {
    const blocks = [
      para('b1', '第一章 概述'.padEnd(1300, '概述正文'), true),
      para('b2', long('第二章内容前导'), true),
      para('b3', '正文'.padEnd(1300, '第二章节的正文内容继续填充以满足阈值')),
      para('b4', '第三章 标题'.padEnd(1300, '第三章内容'), true)
    ]
    const chunks = partitionBlocks(blocks, 3600, 8)
    // b4 是标题且此前累计 >= SECTION_MIN_CHARS → b4 必须开新片段
    const flat = chunks.map(c => c.map(b => b.id))
    expect(flat.some(c => c[0] === 'b4')).toBe(true)
    for (const c of flat) {
      // 除首个片段外，标题只允许出现在片段开头
      for (let i = 1; i < c.length; i++) {
        const block = blocks.find(b => b.id === c[i])!
        if (block.heading) throw new Error(`标题 ${c[i]} 出现在片段中间: ${flat.map(x => x.join(',')).join(' | ')}`)
      }
    }
  })
  it('小节不足阈值时并入后续内容（避免微小章节炸片段数）', () => {
    const blocks = [
      para('b1', '一、短标题一', true),
      para('b2', '只有一句话的小节。'),
      para('b3', '二、短标题二', true),
      para('b4', '同样很短的内容。'),
      para('b5', '三、短标题三', true)
    ]
    const chunks = partitionBlocks(blocks, 3600, 8)
    expect(chunks.length).toBe(1)
    expect(chunks[0].map(b => b.id)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5'])
  })
  it('无标题标记时退化为原字数/块数装箱', () => {
    const blocks = Array.from({ length: 20 }, (_, i) => para(`b${i + 1}`, `普通段落 ${i + 1}，内容。`))
    const chunks = partitionBlocks(blocks, 100, 3)
    expect(chunks.every(c => c.length <= 3)).toBe(true)
    expect(chunks.flat().length).toBe(20)
  })
})

describe('外部启发式短语表', () => {
  let tableFile: string
  beforeAll(() => {
    tableFile = path.join(os.tmpdir(), `heuristic-test-${Date.now()}.json`)
    fs.writeFileSync(tableFile, JSON.stringify({ phrases: ['赋能抓手闭环'], patterns: ['量子[计算+]+'] }), 'utf8')
    loadExternalPhrases(tableFile)
  })
  it('外部短语命中计入信号并出现在 findings 中', () => {
    const text = '本方案通过平台赋能抓手闭环，实现了业务流程的全面贯通，相关指标均有明显改善，整体运行态势保持稳定。'
    const s = computeBlockSignals(para('b1', text))
    expect(s.summary).toContain('自定义短语"赋能抓手闭环"×1')
    expect(s.heuristicScore).toBeGreaterThan(0)
  })
  it('外部正则模式同样命中', () => {
    const text = '系统引入量子计算模块之后，处理能力得到增强，整体效率进一步提升，满足了业务发展的需要。'
    const s = computeBlockSignals(para('b1', text))
    expect(s.summary).toContain('自定义模式×1')
  })
  it('内置表不受外部表影响（常规模板句式仍命中）', () => {
    const text = '首先，随着技术的发展，本系统具有重要意义。其次，方案起到了关键作用。综上所述，整体价值显著。'
    const s = computeBlockSignals(para('b1', text))
    expect(s.summary).toContain('总结模板')
  })
})
