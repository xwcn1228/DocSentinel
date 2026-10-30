import { describe, expect, it } from 'vitest'
import { applyExactInlineEdits } from '../src/main/wordProcess'

function paragraph(parts: { text: string; style?: Record<string, string | boolean> }[]) {
  return {
    type: 'paragraph', props: { text: parts.map(p => p.text).join('') },
    children: parts.map(p => ({
      type: 'run', props: { style: p.style || {} },
      children: [{ type: 'text', props: { text: p.text } }]
    }))
  }
}
const texts = (p: ReturnType<typeof paragraph>) => p.children.map(r => r.children.map(t => t.props.text).join(''))

describe('跨 Word 文本片段精确修改', () => {
  it('允许同格式文字被 Word 拆分到多个 run', () => {
    const p = paragraph([{ text: '研究结' }, { text: '果需要' }, { text: '具体说明。' }])
    applyExactInlineEdits(p, [{ original: '研究结果需要具体说明', replacement: '研究结果应当具体说明' }])
    expect(texts(p).join('')).toBe('研究结果应当具体说明。')
    expect(p.children).toHaveLength(3)
  })

  it('跨片段的多处改写保留中间未修改的粗体和下标', () => {
    const p = paragraph([
      { text: '我们研究' }, { text: 'CO', style: { bold: true } },
      { text: '2', style: { vertAlign: 'subscript' } }, { text: '并进行分析。' }
    ])
    const styles = p.children.map(r => ({ ...r.props.style }))
    applyExactInlineEdits(p, [{ original: '我们研究CO2并进行分析', replacement: '本研究考察CO2并分析其来源' }])
    expect(texts(p)).toEqual(['本研究考察', 'CO', '2', '并分析其来源。'])
    expect(p.children.map(r => r.props.style)).toEqual(styles)
  })

  it('插入文字在匹配结尾继承前一片段格式，在匹配开头继承后一片段格式', () => {
    const p = paragraph([{ text: '重点', style: { bold: true } }, { text: '说明' }])
    applyExactInlineEdits(p, [
      { original: '说明', replacement: '补充说明' },
      { original: '重点', replacement: '重点内容' }
    ])
    expect(texts(p)).toEqual(['重点内容', '补充说明'])
  })

  it('删除跨片段内容时保留空节点和范围外文字', () => {
    const p = paragraph([{ text: '甲多余' }, { text: '的', style: { bold: true } }, { text: '内容乙' }])
    applyExactInlineEdits(p, [{ original: '多余的内容', replacement: '' }])
    expect(texts(p)).toEqual(['甲', '', '乙'])
    expect(p.children[1].props.style).toEqual({ bold: true })
  })

  it('多条修改都使用原始坐标，不重复修改新写入的文字', () => {
    const p = paragraph([{ text: '提出' }, { text: '建议，' }, { text: '应当' }, { text: '验证。' }])
    applyExactInlineEdits(p, [
      { original: '应当验证', replacement: '需要认真验证' },
      { original: '提出建议', replacement: '提出了具体建议' }
    ])
    expect(texts(p).join('')).toBe('提出了具体建议，需要认真验证。')
  })

  it('不拆开非 BMP 字符（生僻字或 emoji）的代理对', () => {
    const p = paragraph([{ text: '甲😀', style: { bold: true } }, { text: '乙' }])
    applyExactInlineEdits(p, [{ original: '甲😀乙', replacement: '甲😁乙' }])
    expect(texts(p)).toEqual(['甲😁', '乙'])
    expect(texts(p).every(t => t.isWellFormed())).toBe(true)
  })

  it('重复匹配和重叠修改仍然拒绝，失败时不改动任何节点', () => {
    const p = paragraph([{ text: '相同相同' }, { text: '内容' }])
    const before = structuredClone(p)
    expect(() => applyExactInlineEdits(p, [
      { original: '内容', replacement: '文字' }, { original: '相同', replacement: '不同' }
    ])).toThrow('不唯一')
    expect(p).toEqual(before)
    expect(() => applyExactInlineEdits(p, [
      { original: '相同相同', replacement: '不同' }, { original: '相同内容', replacement: '文字' }
    ])).toThrow('重叠')
    expect(p).toEqual(before)
  })
})
