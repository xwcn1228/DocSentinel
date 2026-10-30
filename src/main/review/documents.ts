import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DocumentBlock, RevisionPlan } from '../../shared/reviewWorkflow'
import { applyExactInlineEdits } from '../wordProcess'
const { loadDocx } = require('docx-edit')
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom')

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
interface Entry { node: any; parent: any; block: DocumentBlock }
interface BlockMap { sha256: string; blocks: { id: string; text: string }[] }

function collect(tree: any, doc: any): Entry[] {
  const entries: Entry[] = []
  let inReferences = false
  const visit = (node: any, parent: any, part: string, ancestors: string[]) => {
    if (node.type === 'paragraph' && node.props.text?.trim()) {
      const text: string = node.props.text
      const raw: string = doc.getNodeById(node.id).source.toString()
      if (part === 'body' && /^(参考文献|References|Bibliography)\s*$/i.test(text.trim())) inReferences = true
      const special = /<(?:w:(?:fldChar|instrText|fldSimple|footnoteReference|endnoteReference|drawing|pict|bookmarkStart|bookmarkEnd|commentRangeStart|commentRangeEnd|commentReference|ins|del|sectPr|numPr)|m:)/.test(raw)
      const heading = /heading|title|标题|目录/i.test(String(node.props.style?.styleId || '')) || /<w:outlineLvl\b/.test(raw)
      const plain = node.children.every((r: any) => r.type === 'run' && r.children.every((t: any) => t.type === 'text'))
      const editable = part === 'body' && plain && !special && !heading && !inReferences && !ancestors.includes('sdt')
      entries.push({ node, parent, block: { id: '', text, editable, movable: editable && parent?.type === 'body', heading,
        ...(!editable ? { protection: '包含格式/域/引用/公式/标题等保护内容，保留原样并供审查' } : {}) } })
    }
    for (const child of node.children || []) visit(child, node, part === '' ? child.type : part, [...ancestors, node.type])
  }
  visit(tree, null, '', [])
  return entries
}

export async function initializeDocument(source: string, directory: string): Promise<{ originalPath: string; originalSha256: string }> {
  if (path.extname(source).toLowerCase() !== '.docx') throw new Error('请选择 DOCX 文档')
  const bytes = await fs.readFile(source)
  await fs.mkdir(directory, { recursive: true })
  const originalPath = path.join(directory, 'original.docx')
  await fs.writeFile(originalPath, bytes, { flag: 'wx' })
  const doc = await loadDocx(bytes)
  const entries = collect(doc.toComponentTree(), doc)
  if (!entries.length) throw new Error('文档没有可读取的文本块')
  const map: BlockMap = { sha256: sha256(bytes), blocks: entries.map((e, i) => ({ id: `b${String(i + 1).padStart(6, '0')}`, text: e.block.text })) }
  await fs.writeFile(`${originalPath}.blocks.json`, JSON.stringify(map, null, 2), { flag: 'wx' })
  return { originalPath, originalSha256: map.sha256 }
}

async function loadMapped(filePath: string) {
  const bytes = await fs.readFile(filePath)
  const map: BlockMap = JSON.parse(await fs.readFile(`${filePath}.blocks.json`, 'utf8'))
  if (sha256(bytes) !== map.sha256) throw new Error('文档已被外部修改，块 ID 映射失效')
  const doc = await loadDocx(bytes)
  const tree = doc.toComponentTree()
  const entries = collect(tree, doc)
  if (entries.length !== map.blocks.length || entries.some((e, i) => e.block.text !== map.blocks[i].text)) throw new Error('DOCX 内容与保存的块 ID 映射不一致')
  entries.forEach((e, i) => { e.block.id = map.blocks[i].id })
  return { doc, tree, entries }
}

export async function readReviewBlocks(filePath: string): Promise<DocumentBlock[]> {
  return (await loadMapped(filePath)).entries.map(e => e.block)
}

export async function saveCandidate(inputPath: string, directory: string, round: number, stage: 'structure' | 'content', plan: RevisionPlan): Promise<string> {
  const { doc, tree, entries } = await loadMapped(inputPath)
  const byId = new Map(entries.map(e => [e.block.id, e]))
  const grouped = new Map<string, typeof plan.edits>()
  for (const edit of plan.edits) {
    if (!byId.get(edit.blockId)?.block.editable) throw new Error(`不可编辑的块 ${edit.blockId}`)
    grouped.set(edit.blockId, [...(grouped.get(edit.blockId) || []), edit])
  }
  for (const [id, edits] of grouped) applyExactInlineEdits(byId.get(id)!.node, edits)
  // Keep immutable workflow IDs separately: docx-edit's runtime VNode IDs change on reload.
  const nodeIds = new Map(entries.map(e => [e.node.id, e.block.id]))
  const ordered: { id: string; text: string }[] = []
  const visit = (node: any) => {
    const id = nodeIds.get(node.id)
    if (id) {
      const entry = byId.get(id)!
      let text = entry.block.text
      for (const edit of [...(grouped.get(id) || [])].sort((a,b) => entry.block.text.indexOf(b.original) - entry.block.text.indexOf(a.original))) {
        const pos = entry.block.text.indexOf(edit.original)
        text = text.slice(0, pos) + edit.replacement + text.slice(pos + edit.original.length)
      }
      if (!text.trim()) throw new Error('不允许清空段落')
      ordered.push({ id, text })
    }
    for (const child of node.children || []) visit(child)
  }
  visit(tree)
  if (stage === 'content' && plan.moves?.length) throw new Error('内容阶段不允许移动段落')
  const bodyTree = tree.children?.find((child: any) => child.type === 'body')
  const directParagraphs: any[] = bodyTree?.children?.filter((child: any) => child.type === 'paragraph') || []
  const paragraphById = new Map(entries.filter(e => e.block.movable).map(e => [e.block.id, e.node]))
  for (const move of plan.moves || []) {
    const from = paragraphById.get(move.blockId), to = paragraphById.get(move.beforeBlockId)
    if (!from || !to || from === to || !directParagraphs.includes(from) || !directParagraphs.includes(to)) throw new Error('段落移动目标无效或受保护')
    const fromIndex = ordered.findIndex(b => b.id === move.blockId), toIndex = ordered.findIndex(b => b.id === move.beforeBlockId)
    if (fromIndex < 0 || toIndex < 0) throw new Error('段落 ID 映射失效')
    const [item] = ordered.splice(fromIndex, 1)
    ordered.splice(ordered.findIndex(b => b.id === move.beforeBlockId), 0, item)
  }
  const output = path.join(directory, `round-${round}-${stage}.docx`)
  await fs.access(output).then(() => { throw new Error('候选版本已存在，禁止覆盖') }, (e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e })
  const temp = `${output}.partial`
  if (plan.edits.length) {
    doc.patch(tree)
    await doc.saveAs(temp)
  }
  else await fs.copyFile(inputPath, temp)
  // docx-edit serializes all parts on save. Carry only its changed body XML
  // into the original ZIP, preserving every unrelated part byte for byte.
  const serialized = await loadDocx(temp)
  const original = await loadDocx(inputPath)
  const originalBody = original.zip.file('word/document.xml')
  let bodyBytes: Buffer = await serialized.zip.file('word/document.xml').async('nodebuffer')
  if (plan.moves?.length) {
    const xml = new DOMParser().parseFromString(bodyBytes.toString('utf8'), 'application/xml')
    const body = xml.getElementsByTagName('w:body')[0]
    const xmlParagraphs = Array.from(body?.childNodes || []).filter((n: any) => n.nodeType === 1 && n.nodeName === 'w:p') as any[]
    if (xmlParagraphs.length !== directParagraphs.length) throw new Error('正文段落数量与 DOCX 映射不一致')
    const xmlById = new Map([...paragraphById].map(([id, node]) => [id, xmlParagraphs[directParagraphs.indexOf(node)]]))
    for (const move of plan.moves) body.insertBefore(xmlById.get(move.blockId), xmlById.get(move.beforeBlockId))
    bodyBytes = Buffer.from(new XMLSerializer().serializeToString(xml), 'utf8')
  }
  const originalBodyBytes = await originalBody.async('nodebuffer')
  original.zip.file('word/document.xml', bodyBytes)
  await fs.writeFile(temp, await original.zip.generateAsync({ type: 'nodebuffer' }))
  original.zip.file('word/document.xml', originalBodyBytes)
  const check = await loadDocx(temp)
  const actual = collect(check.toComponentTree(), check)
  if (actual.length !== ordered.length || actual.some((e, i) => e.block.text !== ordered[i].text)) throw new Error('候选回读校验失败，未提交版本')
  const originalEntries = collect(original.toComponentTree(), original)
  const idsBefore = entries.map(e => e.block.id)
  const stripText = (xml: string) => xml.replace(/(<w:t\b[^>]*>)[\s\S]*?(<\/w:t>)/g, '$1$2')
  for (let i = 0; i < actual.length; i++) {
    const beforeEntry = originalEntries[idsBefore.indexOf(ordered[i].id)]
    const beforeXml = original.getNodeById(beforeEntry.node.id).source.toString()
    const afterXml = check.getNodeById(actual[i].node.id).source.toString()
    if (stripText(beforeXml) !== stripText(afterXml)) throw new Error(`候选改变了段落格式或非文本内容 ${ordered[i].id}`)
  }
  // Apart from the body part, every ZIP payload must remain byte-identical.
  const keys = Object.keys(original.zip.files).filter(k => !original.zip.files[k].dir)
  const afterKeys = Object.keys(check.zip.files).filter(k => !check.zip.files[k].dir)
  if (JSON.stringify([...keys].sort()) !== JSON.stringify([...afterKeys].sort())) throw new Error('候选改变了 DOCX 部件集合')
  for (const key of keys.filter(k => k !== 'word/document.xml')) {
    const before = await original.zip.file(key).async('nodebuffer'), after = await check.zip.file(key).async('nodebuffer')
    if (!before.equals(after)) throw new Error(`候选改变了受保护部件 ${key}`)
  }
  const bytes = await fs.readFile(temp)
  await fs.writeFile(`${output}.blocks.json`, JSON.stringify({ sha256: sha256(bytes), blocks: ordered }, null, 2), { flag: 'wx' })
  await fs.rename(temp, output)
  return output
}
