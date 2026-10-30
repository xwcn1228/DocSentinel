import { app, dialog, ipcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ModelRole, StartReviewRequest, WorkflowRun, REVIEW_MODEL_NOTICE } from '../../shared/reviewWorkflow'
import { api_info } from './apiState'
import { getModelResponse, setRequestTimeoutMs, setThinkingMode } from '../chat'
import { ModelProvider } from '../../shared/modelProviders'
import { DB } from '../database'
import { initializeDocument, readReviewBlocks, saveCandidate } from '../review/documents'
import { executeWorkflow } from '../review/engine'
import { callLocalCodex, codexExecutable, findLocalCodexExecutable } from '../review/localCodex'
import { modelRoleForStage, resolveReviewModels } from '../review/modelRouting'
import { exportBundle, loadRun, persistRun, reportMarkdown } from '../review/storage'
import { validateConfig } from '../review/validation'

// Test adapter is not exposed through IPC; production registration has no adapter.
export function registerReviewWorkflowHandlers(testAdapter?: { callModel: typeof getModelResponse; callCodex?: typeof callLocalCodex; dataOrigin: 'mock' }) {
  const active = new Map<string, { controller: AbortController; run: WorkflowRun; owner: number }>()
  const root = () => path.join(app.getPath('userData'), 'dual-review-runs')
  const getRun = async (id: string) => active.get(id)?.run || loadRun(root(), id)
  ipcMain.handle('dual-review-codex-info', async () => {
    const executable = await findLocalCodexExecutable()
    return { available: !!executable, executable }
  })
  ipcMain.handle('dual-review-start', async (event, request: StartReviewRequest) => {
    if ([...active.values()].some(v => v.owner === event.sender.id)) throw new Error('当前已有循环审查任务')
    const config = validateConfig(request.config)
    const api = { ...api_info }
    const models = await resolveReviewModels(config, api, id => DB.getAPISettingById(id))
    for (const choice of Object.values(models)) {
      if (choice.kind !== 'local-codex') continue
      choice.executable = choice.executable ? codexExecutable(choice.executable) : await findLocalCodexExecutable() || undefined
      if (!choice.executable && !testAdapter) throw new Error('未找到本地 Codex CLI；请在界面填写 codex.exe 的完整路径')
      if (choice.executable && path.isAbsolute(choice.executable)) await fs.access(choice.executable).catch(() => { throw new Error(`Codex 可执行文件不存在：${choice.executable}`) })
    }
    const modelLabels = Object.fromEntries(Object.entries(models).map(([role, choice]) => [role, choice.label])) as Record<ModelRole, string>
    const id = randomUUID(), directory = path.join(root(), id)
    const controller = new AbortController()
    const run: WorkflowRun = { id, status: 'running', sourcePath: request.filePath, originalPath: '', originalSha256: '', currentPath: '', directory,
      config, model: `${modelLabels.structure} / ${modelLabels.content}`, modelLabels, dataOrigin: testAdapter?.dataOrigin || 'live', modelNotice: REVIEW_MODEL_NOTICE, startedAt: new Date().toISOString(), phase: '正在读取 DOCX 并保存原文', rounds: [], pendingRevisions: [], unresolvedIssues: [], errors: [], tokenUsage: {} }
    active.set(id, { controller, run, owner: event.sender.id })
    const send = (state: WorkflowRun) => { if (!event.sender.isDestroyed()) event.sender.send('dual-review-update', state) }
    const destroyed = () => controller.abort()
    event.sender.once('destroyed', destroyed)
    // Start returns immediately, so the Stop button works during document import too.
    void (async () => {
      try {
        Object.assign(run, await initializeDocument(request.filePath, directory))
        run.currentPath = run.originalPath
        setRequestTimeoutMs(api.requestTimeoutSec ? api.requestTimeoutSec * 1000 : null)
        setThinkingMode(api.thinkingMode || 'default')
        let nextCall = 0, inFlight = 0
        const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
          if (signal.aborted) { reject(new Error('任务已停止')); return }
          const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new Error('任务已停止')) }
          const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
          signal.addEventListener('abort', stop, { once: true })
        })
        await executeWorkflow(run, {
          read: readReviewBlocks,
          revise: (input, round, stage, plan) => saveCandidate(input, directory, round, stage, plan),
          persist: persistRun, notify: send,
          call: async (stage, system, input, signal) => {
            const choice = models[modelRoleForStage(stage)]
            if (choice.kind === 'local-codex') {
              const invokeCodex = testAdapter ? testAdapter.callCodex : callLocalCodex
              if (!invokeCodex) throw new Error('模拟 Codex 调用器未配置')
              return invokeCodex(stage, system, input, signal, { executable: choice.executable, model: choice.model, directory, proxy: config.codexProxy })
            }
            while (inFlight >= Math.max(1, Math.min(6, api.parallel || 6))) await wait(50, signal)
            inFlight++
            try {
              const at = Math.max(Date.now(), nextCall)
              nextCall = at + (api.requestsPerMinute && api.requestsPerMinute > 0 ? 60000 / api.requestsPerMinute : 0)
              await wait(Math.max(0, at - Date.now()), signal)
              const response = await (testAdapter?.callModel || getModelResponse)(choice.api.provider || ModelProvider.OPENAI_COMPATIBLE, system, input, choice.api.apiKey, choice.api.modelName, choice.api.apiURL, undefined, signal)
              // 按阶段累计 token 用量（Codex 路径不经此处，不统计）
              run.tokenUsage[stage] = (run.tokenUsage[stage] || 0) + (response.total_tokens || 0)
              return response.result
            } finally { inFlight-- }
          }
        }, controller.signal)
      } catch (error) {
        run.status = controller.signal.aborted ? 'stopped' : 'failed'
        run.phase = '任务停止或执行失败'
        run.errors.push(error instanceof Error ? error.message : String(error))
        run.finishedAt = new Date().toISOString()
        await fs.mkdir(directory, { recursive: true })
        await persistRun(run).catch(() => {})
        send(run)
      } finally {
        active.delete(id)
        if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', destroyed)
      }
    })()
    return { id }
  })
  ipcMain.handle('dual-review-stop', (event, id: string) => {
    const task = active.get(id)
    if (task && task.owner === event.sender.id) { task.controller.abort(); return true }
    return false
  })
  ipcMain.handle('dual-review-get', async (_event, id: string) => {
    const run = await getRun(id)
    if (run.status === 'running' && !active.has(id)) {
      run.status = 'stopped'; run.phase = '应用中断，保留最后已保存版本'; run.finishedAt = new Date().toISOString()
      await persistRun(run)
    }
    return run
  })
  ipcMain.handle('dual-review-list', async () => {
    await fs.mkdir(root(), { recursive: true })
    const entries = await fs.readdir(root(), { withFileTypes: true })
    const results = await Promise.all(entries.filter(e => e.isDirectory()).map(async e => {
      try { const r = await getRun(e.name); return { id: r.id, status: r.status, startedAt: r.startedAt, sourcePath: r.sourcePath } } catch { return null }
    }))
    return results.filter(Boolean).sort((a,b) => b!.startedAt.localeCompare(a!.startedAt))
  })
  ipcMain.handle('dual-review-export', async (_event, id: string, kind: 'docx' | 'report' | 'bundle') => {
    const run = await getRun(id)
    if (run.status === 'running') throw new Error('请等待任务结束或停止后再导出')
    if (!['docx', 'report', 'bundle'].includes(kind)) throw new Error('导出类型无效')
    if (!run.currentPath && kind !== 'report') throw new Error('没有可导出的候选文件')
    const extension = kind === 'docx' ? 'docx' : kind === 'report' ? 'md' : 'zip'
    const result = await dialog.showSaveDialog({ defaultPath: `review-${id}.${extension}`, filters: [{ name: '审查结果', extensions: [extension] }] })
    if (result.canceled || !result.filePath) return null
    const destination = path.resolve(result.filePath).toLowerCase()
    if (destination === path.resolve(run.sourcePath).toLowerCase() || destination.startsWith(path.resolve(run.directory).toLowerCase() + path.sep)) throw new Error('禁止覆盖原文或任务版本，请选择其他导出路径')
    const bytes = kind === 'docx' ? await fs.readFile(run.currentPath) : kind === 'report' ? reportMarkdown(run) : await exportBundle(run)
    await fs.writeFile(result.filePath, bytes)
    return result.filePath
  })
}
