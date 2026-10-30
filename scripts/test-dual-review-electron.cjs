// Smoke-test the actual Electron preload/IPC/renderer in an isolated profile.
// No model configuration, credentials, or live model calls are used.
const { app, BrowserWindow } = require('electron')
const output = require('node:path').resolve(__dirname, '../docs/dual-review-validation')
require('node:fs').mkdirSync(output, { recursive: true })
const mark = message => require('node:fs').appendFileSync(require('node:path').resolve(__dirname, '../docs/dual-review-validation/electron-steps.log'), `${new Date().toISOString()} ${message}\n`)
mark('entry')
process.on('uncaughtException', error => { mark(error.stack); process.stderr.write(error.stack + '\n'); app.exit(1) })
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const profile = path.join(output, 'electron-smoke-profile')
require('node:fs').mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
process.env.TS_NODE_TRANSPILE_ONLY = 'true'
require('ts-node/register/transpile-only')
mark('ts-node loaded')
require('../src/main/ipcHandlers').registerIpcHandlers()
mark('handlers registered')
const deadline = setTimeout(() => { process.stderr.write('Electron smoke timeout\n'); app.exit(1) }, 30000)
app.whenReady().then(async () => {
  mark('ready')
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { preload: path.resolve(__dirname, '../out/preload/preload.js'), contextIsolation: true, nodeIntegration: false } })
  try {
    await win.loadFile(path.resolve(__dirname, '../out/renderer/index.html'), { hash: '/dual-review' })
    mark('renderer loaded')
    const result = await win.webContents.executeJavaScript(`(async () => {
      const start = Date.now();
      while (!document.querySelector('.dual-review h1') && Date.now() - start < 10000) await new Promise(resolve => setTimeout(resolve, 50));
      return { title: document.querySelector('.dual-review h1')?.textContent, history: await window.electronAPI.listDualReviews(), bridge: typeof window.electronAPI.startDualReview, stop: typeof window.electronAPI.stopDualReview, codexInfo: await window.electronAPI.getLocalCodexInfo(), proxy: await window.electronAPI.getProxySettings(), text: document.querySelector('.dual-review')?.innerText };
    })()`)
    assert.equal(result.title, 'B/C 双路循环审查')
    assert.equal(result.bridge, 'function'); assert.equal(result.stop, 'function'); assert.deepEqual(result.history, [])
    assert.equal(typeof result.codexInfo.available, 'boolean')
    assert.equal(result.proxy.port, 7890)
    assert(result.text.includes('风险评分（非真实概率）'))
    await fs.mkdir(output, { recursive: true })
    await fs.writeFile(path.join(output, 'electron-smoke.json'), JSON.stringify({ passed: true, modelCalls: 0, isolatedProfile: true, ...result }, null, 2))
    await fs.writeFile(path.join(output, 'electron-empty-page.png'), (await win.webContents.capturePage()).toPNG())
    process.stdout.write('Real Electron preload / IPC / renderer smoke passed; no model calls.\n')
    mark('passed'); clearTimeout(deadline); win.destroy(); app.exit(0)
  } catch (error) { mark(error.stack); process.stderr.write(error.stack + '\n'); clearTimeout(deadline); win.destroy(); app.exit(1) }
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1) })
