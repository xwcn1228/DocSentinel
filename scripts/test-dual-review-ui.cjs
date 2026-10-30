// Isolated browser UI smoke test. All API results are explicitly MOCK data.
// Requires Playwright (local installation or NODE_PATH), npm run build first.
const { chromium } = require('playwright')
const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')

async function main() {
  const root = path.resolve(__dirname, '../out/renderer')
  const output = path.resolve(__dirname, '../docs/dual-review-validation')
  const server = http.createServer(async (req, res) => {
    try {
      const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'))
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return }
      const extension = path.extname(file)
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' })[extension] || 'application/octet-stream')
      res.end(await fs.readFile(file))
    } catch { res.writeHead(404).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      const ev = [{ blockId: 'b000001', quote: '首先，研究具有重要意义。' }]
      const issue = { id: 'structure-1', reviewer: 'structure', severity: 'major', reason: '模拟结果：论证缺少具体衔接。', suggestion: '按现有论据补充衔接。', confidence: 0.8, evidence: ev }
      const base = { status: 'valid', evidence: ev, summary: '模拟评估，仅用于页面测试', issues: [], resolutions: [], paragraphResults: [] }
      const detector = (reviewer, score) => ({ ...base, reviewer, scoreType: 'agent-heuristic', overallRiskScore: score, riskLevel: score > 60 ? 'high' : 'low', qualitativeAssessment: '模拟定性判断', confidence: 0.8,
        paragraphResults: [{ blockId: 'b000001', riskScore: score, riskLevel: score > 60 ? 'high' : 'low', confidence: 0.8, evidence: ev, reason: '模拟段落分析' }] })
      let state = { id: '00000000-0000-0000-0000-000000000001', status: 'not-passed', dataOrigin: 'mock', sourcePath: 'mock-source.docx', originalPath: 'mock-original.docx', originalSha256: 'MOCK-HASH', currentPath: 'mock-candidate.docx', directory: 'mock-only',
        config: { maxRounds: 3, maxRiskB: 80, maxRiskC: 80, discipline: '通用（学科未指定）' }, model: 'MOCK-MODEL', startedAt: '2026-10-29T00:00:00Z', phase: '模拟审查完成', modelNotice: '模拟结果', errors: [], unresolvedIssues: [issue], pendingRevisions: [], rounds: [{ index: 0, candidatePath: 'mock-candidate.docx', blocks: [{ id: 'b000001', text: ev[0].quote, editable: true, movable: true }],
          reviews: { structure: { ...detector('structure', 90), issues: [issue] }, content: detector('content', 20) },
          decision: { passed: false, reasons: ['模拟：B 结构超阈值'], risk: { riskLevel: 'high', priorityBlockIds: [], evidence: ev, summary: 'B 结构超阈值。' } }, unresolvedIssues: [issue], revisions: [{ stage: 'structure', beforePath: 'mock-original.docx', afterPath: 'mock-candidate.docx', summary: '模拟修改意见', moves: [], edits: [{ blockId: 'b000001', original: '首先', replacement: '在这一范围内', reason: '模拟改善衔接', issueIds: ['structure-1'] }] }] }] }
      let callback = () => {}
      window.__mockExports = []
      window.__proxyCalls = []
      const api = {
        listDualReviews: async () => [state], getDualReview: async () => structuredClone(state),
        onDualReviewUpdate: cb => { callback = cb; return () => {} }, selectDocxFile: async () => 'mock-selected.docx',
        startDualReview: async request => { window.__lastReviewRequest = structuredClone(request); state = { ...state, status: 'running', phase: '模拟运行中' }; return { id: state.id } },
        stopDualReview: async () => { state = { ...state, status: 'stopped', phase: '用户停止模拟任务' }; callback(structuredClone(state)); return true },
        exportDualReview: async (_id, kind) => { window.__mockExports.push(kind); return `mock-export.${kind}` },
        setProxySettings: async (enabled, port) => { window.__proxyCalls.push({ enabled, port }); return { success: true } },
        getPromptSettings: async () => ({}), getALLAPISettings: async () => [{ id: 11, apiURL: 'mock', apiKey: 'MOCK-KEY', modelName: 'MOCK-A', provider: 'glm' }], getAPISettings: async () => [], getLocalCodexInfo: async () => ({ available: true, executable: 'C:\\mock\\codex.exe' }), getCurrentBackgroundInstruction: async () => '',
        onProofreadProgress: () => () => {}, onProofreadStream: () => () => {}, onWindowMaximizeChanged: () => () => {}
      }
      window.electronAPI = new Proxy(api, { get: (target, key) => key in target ? target[key] : () => Promise.resolve(null) })
      localStorage.setItem('lastDualReviewId', state.id)
    })
    await page.goto(`http://127.0.0.1:${server.address().port}/#/dual-review`)
    await page.getByText('B · 结构风险评估', { exact: false }).waitFor()
    assert.equal(await page.locator('.model-grid .el-select').count(), 4)
    assert.equal(await page.getByRole('button', { name: '从原文重新运行', exact: true }).count(), 1)
    for (const text of ['B · 结构风险评估', 'C · 内容风险评估', '每轮评分对比', '模拟结果，仅用于测试', '每轮修改意见与文本差异']) {
      assert(await page.getByText(text, { exact: false }).count() > 0, text)
    }
    await fs.mkdir(output, { recursive: true })
    await page.screenshot({ path: path.join(output, 'ui-mock-results.png'), fullPage: true, animations: 'disabled' })
    const notices = await page.locator('.el-alert, .el-tag').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, color: getComputedStyle(node).color, opacity: getComputedStyle(node).opacity, visibility: getComputedStyle(node).visibility })))
    await fs.writeFile(path.join(output, 'ui-notices.json'), JSON.stringify(notices, null, 2))
    await page.locator('.dual-review').evaluate(node => { node.scrollTop = 1100 })
    await page.screenshot({ path: path.join(output, 'ui-mock-details.png'), fullPage: true, animations: 'disabled' })
    await page.locator('.dual-review').evaluate(node => { node.scrollTop = 0 })
    await page.locator('.model-grid .el-select').nth(0).click()
    await page.locator('.el-select-dropdown:visible').getByText('本地 Codex CLI', { exact: true }).click()
    await page.getByPlaceholder('CLI 模型 ID，如 gpt-6.1-sol；留空使用默认').fill('GPT-6.1 Sol')
    for (const index of [2, 3]) {
      const selector = page.locator('.model-grid .el-select').nth(index)
      await selector.scrollIntoViewIfNeeded()
      await selector.click()
      const listId = await selector.locator('input').first().getAttribute('aria-controls')
      await page.locator(`#${listId} .el-select-dropdown__item`).last().evaluate(node => node.click())
    }
    await page.getByRole('button', { name: '选择 DOCX', exact: true }).click()
    await page.getByRole('button', { name: '开始循环审查', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__lastReviewRequest.config.models.structure.kind), 'local-codex')
    assert.equal(await page.evaluate(() => window.__lastReviewRequest.config.models.structure.model), 'gpt-6.1-sol')
    assert.equal(await page.evaluate(() => window.__lastReviewRequest.config.models.reviseStructure.kind), 'local-codex')
    assert.equal(await page.evaluate(() => window.__lastReviewRequest.config.models.reviseContent.kind), 'local-codex')
    assert.equal(await page.evaluate(() => window.__lastReviewRequest.config.maxRiskB), 80)
    assert.equal(await page.evaluate(() => window.__lastReviewRequest.config.maxRiskC), 80)
    assert.deepEqual(await page.evaluate(() => window.__lastReviewRequest.config.codexProxy), { enabled: true, port: 7890 })
    const stop = page.getByRole('button', { name: '停止任务', exact: true })
    await stop.waitFor(); await stop.click()
    await page.getByText('用户停止模拟任务', { exact: false }).waitFor()
    for (const name of ['导出当前候选 DOCX', '导出审查报告', '导出版本记录 ZIP']) await page.getByRole('button', { name, exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.__mockExports), ['docx', 'report', 'bundle'])
    await page.goto(`http://127.0.0.1:${server.address().port}/#/api`)
    const proxySection = page.locator('.setting-section').filter({ hasText: '代理设置' }).first()
    await proxySection.locator('.el-switch').click()
    const proxyInput = proxySection.locator('.el-input-number input')
    await proxyInput.fill('7891'); await proxyInput.press('Enter')
    await page.waitForFunction(() => window.__proxyCalls.some(call => call.enabled && call.port === 7891))
    assert.deepEqual(errors, [], 'browser page errors')
    await page.goto(`http://127.0.0.1:${server.address().port}/#/dual-review`)
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.screenshot({ path: path.join(output, 'ui-mock-narrow.png'), fullPage: true })
    await fs.writeFile(path.join(output, 'ui-smoke.json'), JSON.stringify({ passed: true, dataOrigin: 'mock', checks: ['B/C two review panels', 'four model selectors', 'Codex review and revision choices submitted', 'B/C thresholds submitted', 'Codex proxy 7890 submitted', 'proxy settings port update', 'round comparison', 'diff', 'start', 'stop', 'three exports', 'no page errors', 'narrow viewport'], errors }, null, 2))
    process.stdout.write('UI smoke passed (isolated MOCK bridge, no real model requests or exports).\n')
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
