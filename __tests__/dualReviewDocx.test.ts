import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { initializeDocument, readReviewBlocks, saveCandidate, sha256 } from '../src/main/review/documents'
import { exportBundle, persistRun, loadRun } from '../src/main/review/storage'
import { DEFAULT_REVIEW_CONFIG, REVIEW_MODEL_NOTICE, WorkflowRun } from '../src/shared/reviewWorkflow'
import { randomUUID } from 'node:crypto'
const { loadDocx } = require('docx-edit')

const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
export async function makeReviewFixture(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="h1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>')
  zip.file('word/header1.xml', `<w:hdr xmlns:w="${NS}"><w:p><w:r><w:t>固定页眉</w:t></w:r></w:p></w:hdr>`)
  zip.file('word/styles.xml', `<w:styles xmlns:w="${NS}"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`)
  zip.file('word/media/image1.png', Buffer.from([137, 80, 78, 71, 1, 2, 3]))
  zip.file('word/footnotes.xml', `<w:footnotes xmlns:w="${NS}"><w:footnote w:id="1"><w:p><w:r><w:t>原始脚注</w:t></w:r></w:p></w:footnote></w:footnotes>`)
  const p = (t: string) => `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr><w:t>${t}</w:t></w:r></w:p>`
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${NS}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>
${p('重复内容保持原样。')}${p('重复内容保持原样。')}${p('研究结果需要具体说明。')}
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>粗体</w:t></w:r><w:r><w:t>正常文字</w:t></w:r></w:p>
<w:p><w:r><w:t>公式如下</w:t></w:r><m:oMath><m:r><m:t>x=1</m:t></m:r></m:oMath></w:p>
<w:p><w:r><w:t>带脚注</w:t><w:footnoteReference w:id="1"/></w:r></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText> TOC </w:instrText><w:fldChar w:fldCharType="end"/></w:r></w:p>
<w:tbl><w:tr><w:tc>${p('表格原文')}</w:tc></w:tr></w:tbl>
${p('表格后的段落。')}
<w:p><w:r><w:t>拆分</w:t></w:r><w:r><w:t>片段</w:t></w:r><w:r><w:t>正常文字。</w:t></w:r></w:p>
<w:p><w:r><w:t>研究CO</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>2</w:t></w:r><w:r><w:t>并进行分析。</w:t></w:r></w:p>
${p('参考文献')}${p('[1] Smith (2024). Original source.')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:left="1440"/></w:sectPr>
</w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('DOCX 实际读写、格式及原文版本保护（合成文件，不调用模型）', () => {
  let directory: string, source: string, initial: Awaited<ReturnType<typeof initializeDocument>>, originalBytes: Buffer, candidate: string
  beforeAll(async () => {
    const root = path.resolve(__dirname, 'tmp'); await fs.mkdir(root, { recursive: true })
    directory = await fs.mkdtemp(path.join(root, 'dual-review-'))
    source = path.join(directory, 'source.docx'); originalBytes = await makeReviewFixture(); await fs.writeFile(source, originalBytes)
    initial = await initializeDocument(source, path.join(directory, 'run'))
  })
  afterAll(async () => {
    const expected = path.resolve(__dirname, 'tmp') + path.sep
    if (directory && path.resolve(directory).startsWith(expected)) await fs.rm(directory, { recursive: true, force: true })
  })
  it('原文按字节复制，块 ID 唯一并可重复读取', async () => {
    expect((await fs.readFile(initial.originalPath)).equals(originalBytes)).toBe(true)
    expect(initial.originalSha256).toBe(sha256(originalBytes))
    const first = await readReviewBlocks(initial.originalPath), second = await readReviewBlocks(initial.originalPath)
    expect(first).toEqual(second); expect(new Set(first.map(b => b.id)).size).toBe(first.length)
    expect(first.some(b => b.text.includes('表格原文'))).toBe(true)
    expect(first.filter(b => /公式如下|带脚注|固定页眉|Smith/.test(b.text)).every(b => !b.editable)).toBe(true)
  })
  it('用块 ID 修改第二个重复段落，保留原文、格式和全部非正文部件', async () => {
    const blocks = await readReviewBlocks(initial.originalPath), target = blocks[1]
    candidate = await saveCandidate(initial.originalPath, path.dirname(initial.originalPath), 1, 'content', {
      edits: [{ blockId: target.id, original: '重复内容', replacement: '修改后的内容', reason: '合成测试', issueIds: ['mock-detector'] }], moves: [], summary: '模拟修改，实际 DOCX 写入'
    })
    const after = await readReviewBlocks(candidate)
    expect(after[0].text).toBe(blocks[0].text); expect(after[1].text).toBe('修改后的内容保持原样。')
    expect(after.map(b => b.id)).toEqual(blocks.map(b => b.id))
    expect((await fs.readFile(source)).equals(originalBytes)).toBe(true); expect((await fs.readFile(initial.originalPath)).equals(originalBytes)).toBe(true)
    const beforeZip = await JSZip.loadAsync(originalBytes), afterZip = await JSZip.loadAsync(await fs.readFile(candidate))
    for (const [name, file] of Object.entries(beforeZip.files)) {
      if (name === 'word/document.xml' || file.dir) continue
      expect(await afterZip.file(name)!.async('nodebuffer'), name).toEqual(await file.async('nodebuffer'))
    }
    const xml = await afterZip.file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:b/>'); expect(xml).toContain('w:eastAsia="宋体"'); expect(xml).toContain('<m:t>x=1</m:t>'); expect(xml).toContain('w:pgSz')
  })
  it('候选版本可继续精确编辑', async () => {
    const blocks = await readReviewBlocks(candidate)
    const modified = await saveCandidate(candidate, path.dirname(candidate), 2, 'content', { edits: [{ blockId: blocks[2].id, original: '需要', replacement: '应当', reason: '合成修改', issueIds: ['mock'] }], moves: [], summary: '模拟' })
    const after = await readReviewBlocks(modified)
    expect(after.find(b => b.id === blocks[2].id)!.text).toBe('研究结果应当具体说明。')
  })
  it('结构阶段移动段落后块 ID 随段落保留，原文和非正文部件不变', async () => {
    const before = await readReviewBlocks(initial.originalPath)
    const moved = await saveCandidate(initial.originalPath, path.dirname(initial.originalPath), 1, 'structure', {
      edits: [], moves: [{ blockId: before[2].id, beforeBlockId: before[0].id, reason: '模拟结构调整', issueIds: ['mock-structure'] }], summary: '模拟结构调整'
    })
    const after = await readReviewBlocks(moved)
    expect(after.slice(0, 3).map(b => b.id)).toEqual([before[2].id, before[0].id, before[1].id])
    expect(after[0].text).toBe(before[2].text)
    expect((await fs.readFile(initial.originalPath)).equals(originalBytes)).toBe(true)
    const beforeZip = await JSZip.loadAsync(originalBytes), afterZip = await JSZip.loadAsync(await fs.readFile(moved))
    for (const [name, file] of Object.entries(beforeZip.files)) if (name !== 'word/document.xml' && !file.dir) expect(await afterZip.file(name)!.async('nodebuffer')).toEqual(await file.async('nodebuffer'))
  })
  it('跨混合格式改写保留未修改文字的粗体及原有 run', async () => {
    const blocks = await readReviewBlocks(initial.originalPath)
    const mixed = blocks.find(b => b.text === '粗体正常文字')!
    const output = await saveCandidate(initial.originalPath, path.dirname(initial.originalPath), 4, 'content', {
      edits: [{ blockId: mixed.id, original: mixed.text, replacement: '粗体常规文字', reason: '合成测试', issueIds: ['mock'] }], moves: [], summary: '模拟'
    })
    const doc = await loadDocx(output)
    const para = doc.getBody().getParagraphs().find((p: any) => p.getText() === '粗体常规文字')
    expect(para.getRuns().map((r: any) => r.getText())).toEqual(['粗体', '常规文字'])
    expect(para.getRuns()[0].getStyle().bold).toBe(true)
    expect((await readReviewBlocks(output)).find(b => b.id === mixed.id)?.text).toBe('粗体常规文字')
  })
  it('跨片段缩短内容后允许空文本节点，继续保存下一轮版本', async () => {
    const blocks = await readReviewBlocks(initial.originalPath)
    const mixed = blocks.find(b => b.text === '粗体正常文字')!
    const output = await saveCandidate(initial.originalPath, path.dirname(initial.originalPath), 5, 'content', {
      edits: [{ blockId: mixed.id, original: mixed.text, replacement: '修改', reason: '合成测试', issueIds: ['mock'] }], moves: [], summary: '模拟'
    })
    const doc = await loadDocx(output)
    const para = doc.getBody().getParagraphs().find((p: any) => p.getText() === '修改')
    expect(para.getRuns().map((r: any) => r.getText())).toEqual(['修改', ''])
    expect(para.getRuns()[0].getStyle().bold).toBe(true)
    const next = await saveCandidate(output, path.dirname(output), 6, 'content', {
      edits: [{ blockId: mixed.id, original: '修改', replacement: '修改后文字', reason: '合成测试', issueIds: ['mock'] }], moves: [], summary: '模拟'
    })
    expect((await readReviewBlocks(next)).find(b => b.id === mixed.id)?.text).toBe('修改后文字')
  })
  it('同格式多片段替换支持新增首尾空格且保留其余部件', async () => {
    const blocks = await readReviewBlocks(initial.originalPath)
    const split = blocks.find(b => b.text === '拆分片段正常文字。')!
    const output = await saveCandidate(initial.originalPath, path.dirname(initial.originalPath), 7, 'content', {
      edits: [{ blockId: split.id, original: '拆分片段', replacement: ' 拆分 片段 ', reason: '合成测试', issueIds: ['mock'] }], moves: [], summary: '模拟'
    })
    expect((await readReviewBlocks(output)).find(b => b.id === split.id)?.text).toBe(' 拆分 片段 正常文字。')
    const before = await JSZip.loadAsync(originalBytes), after = await JSZip.loadAsync(await fs.readFile(output))
    for (const [name, file] of Object.entries(before.files)) if (name !== 'word/document.xml' && !file.dir) expect(await after.file(name)!.async('nodebuffer')).toEqual(await file.async('nodebuffer'))
  })
  it('跨下标修改时下标文字仍在原 run 中', async () => {
    const blocks = await readReviewBlocks(initial.originalPath)
    const subscript = blocks.find(b => b.text === '研究CO2并进行分析。')!
    const output = await saveCandidate(initial.originalPath, path.dirname(initial.originalPath), 8, 'content', {
      edits: [{ blockId: subscript.id, original: subscript.text, replacement: '考察CO2并分析其来源。', reason: '合成测试', issueIds: ['mock'] }], moves: [], summary: '模拟'
    })
    const doc = await loadDocx(output)
    const para = doc.getBody().getParagraphs().find((p: any) => p.getText() === '考察CO2并分析其来源。')
    expect(para.getRuns().map((r: any) => r.getText())).toEqual(['考察CO', '2', '并分析其来源。'])
    expect(para.getRuns()[1].getStyle().vertAlign).toBe('subscript')
  })
  it('仍禁止修改公式段落', async () => {
    const formula = (await readReviewBlocks(initial.originalPath)).find(b => b.text.includes('公式如下'))!
    await expect(saveCandidate(initial.originalPath, path.dirname(initial.originalPath), 9, 'content', {
      edits: [{ blockId: formula.id, original: '公式如下', replacement: '修改', reason: '合成测试', issueIds: ['mock'] }], moves: [], summary: '模拟'
    })).rejects.toThrow('不可编辑')
  })
  it('拒绝覆盖原版本，外部篡改触发校验失败', async () => {
    await expect(saveCandidate(initial.originalPath, path.dirname(initial.originalPath), 1, 'content', { edits: [], moves: [], summary: '模拟' })).rejects.toThrow('禁止覆盖')
    const external = path.join(directory, 'external.docx')
    await fs.copyFile(initial.originalPath, external); await fs.copyFile(`${initial.originalPath}.blocks.json`, `${external}.blocks.json`)
    await fs.appendFile(external, 'tampered')
    await expect(readReviewBlocks(external)).rejects.toThrow('外部修改')
  })
  it('版本包包括当前 DOCX、原文、块映射和明确标记的模拟报告', async () => {
    const record: WorkflowRun = { id: randomUUID(), status: 'not-passed', sourcePath: source, ...initial, currentPath: candidate, directory: path.dirname(candidate), config: DEFAULT_REVIEW_CONFIG,
      model: 'mock-model', dataOrigin: 'mock', modelNotice: REVIEW_MODEL_NOTICE, startedAt: new Date().toISOString(), phase: '模拟测试记录', rounds: [], pendingRevisions: [], unresolvedIssues: [], errors: [] }
    await persistRun(record)
    const zip = await JSZip.loadAsync(await exportBundle(record))
    expect(zip.file('versions/original.docx')).toBeTruthy(); expect(zip.file('versions/original.docx.blocks.json')).toBeTruthy()
    expect(await zip.file('current-candidate.docx')!.async('nodebuffer')).toEqual(await fs.readFile(candidate))
    expect(await zip.file('report.md')!.async('string')).toContain('模拟结果，仅用于测试')
    expect(JSON.parse(await zip.file('versions.json')!.async('string')).dataOrigin).toBe('mock')
    await expect(loadRun(directory, '../escape')).rejects.toThrow('ID 无效')
  })
})
