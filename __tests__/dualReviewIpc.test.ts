import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import JSZip from 'jszip'
import { DEFAULT_REVIEW_CONFIG } from '../src/shared/reviewWorkflow'

// Isolated IPC integration: all model responses are simulated, while DOCX import and persistence are real.
const mock = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: any[]) => any>(), calls: [] as string[], highFirst: false, bCalls: 0 }))
vi.mock('electron', () => ({ app: { getPath: () => mock.root }, ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => mock.handlers.set(name, fn) }, dialog: { showSaveDialog: async () => ({ canceled: true }) } }))
vi.mock('../src/main/database', () => ({ DB: { getAPISettingById: async (): Promise<null> => null } }))
vi.mock('../src/main/ipc/apiState', () => ({ api_info: { apiKey: 'mock-secret', modelName: 'mock-api', apiURL: 'http://mock.invalid/v1', provider: 'openai-compatible', parallel: 4 } }))
import { registerReviewWorkflowHandlers } from '../src/main/ipc/reviewWorkflowHandlers'

describe('B/C IPC 自动循环（模拟模型，真实 DOCX）', () => {
  let source: string
  const sender = Object.assign(new EventEmitter(), { id: 91, isDestroyed: () => false, send: vi.fn() })
  const invoke = (name: string, ...args: any[]) => mock.handlers.get(name)!({ sender }, ...args)
  beforeAll(async () => {
    const root = path.resolve(__dirname, 'tmp'); await fs.mkdir(root, { recursive: true })
    mock.root = await fs.mkdtemp(path.join(root, 'bc-ipc-'))
    source = path.join(mock.root, 'source.docx')
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>这是一段模拟测试原文。</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')
    await fs.writeFile(source, await zip.generateAsync({ type: 'nodebuffer' }))
    registerReviewWorkflowHandlers({ dataOrigin: 'mock', callModel: async (_provider, system, text) => {
      const data = JSON.parse(text)
      if (system.includes('结构修改 Agent')) { mock.calls.push('reviseStructure'); return { result: JSON.stringify({ summary: '模拟结构阶段', edits: [], moves: [] }), total_tokens: 0 } }
      if (system.includes('内容修改 Agent')) { mock.calls.push('reviseContent'); return { result: JSON.stringify({ summary: '模拟内容阶段', edits: [], moves: [] }), total_tokens: 0 } }
      const stage = system.includes('B 结构风险评估 Agent') ? 'structure' : 'content'
      mock.calls.push(stage)
      const score = stage === 'structure' && mock.highFirst && mock.bCalls++ === 0 ? 90 : 20
      const evidence = [{ blockId: data.blocks[0].id, quote: data.blocks[0].text }]
      const previous = data.previousIssues || []
      const issues = score > 80 ? [previous[0] ? { ...previous[0], evidence } : { id: 'structure-issue', severity: 'major', reason: '模拟结构重复', suggestion: '调整衔接', confidence: 0.8, evidence }] : []
      return { result: JSON.stringify({ summary: '模拟审查', qualitativeAssessment: '模拟结论', issues,
        resolutions: previous.map((p: any) => ({ issueId: p.id, resolved: score <= 80, reason: '模拟复核', evidence })),
        paragraphResults: data.blocks.map((b: any) => ({ blockId: b.id, riskScore: score, reason: '模拟逐段判断', confidence: 0.8, evidence: score >= 30 ? [{ blockId: b.id, quote: b.text }] : [] })) }), total_tokens: 0 }
    } })
  })
  afterAll(async () => { if (path.resolve(mock.root).startsWith(path.resolve(__dirname, 'tmp') + path.sep)) await fs.rm(mock.root, { recursive: true, force: true }) })
  it('两路低于阈值时初审即结束，不产生候选修改', async () => {
    mock.calls = []; mock.highFirst = false; mock.bCalls = 0
    const { id } = await invoke('dual-review-start', { filePath: source, config: DEFAULT_REVIEW_CONFIG })
    await vi.waitFor(async () => expect((await invoke('dual-review-get', id)).status).toBe('passed'))
    const record = await invoke('dual-review-get', id)
    expect(record.phase).toContain('AI率低，无需修改')
    expect(record.rounds).toHaveLength(1)
    expect(record.currentPath).toBe(record.originalPath)
    expect(mock.calls.sort()).toEqual(['content', 'structure'])
    expect(JSON.stringify(record)).not.toContain('mock-secret')
  })
  it('B 超阈值时自动改结构、跳过内容修改并复审到终态', async () => {
    mock.calls = []; mock.highFirst = true; mock.bCalls = 0
    const { id } = await vi.waitFor(() => invoke('dual-review-start', { filePath: source, config: DEFAULT_REVIEW_CONFIG }))
    await vi.waitFor(async () => expect((await invoke('dual-review-get', id)).status).toBe('passed'))
    const record = await invoke('dual-review-get', id)
    expect(record.rounds).toHaveLength(2)
    expect(mock.calls.filter(s => s.startsWith('revise'))).toEqual(['reviseStructure'])
    expect(record.currentPath).not.toBe(record.originalPath)
    expect((await fs.stat(record.currentPath)).size).toBeGreaterThan(0)
  })
})
