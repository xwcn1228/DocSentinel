import { contextBridge, ipcRenderer } from 'electron'
import { apiSettings } from './database'
import { StartReviewRequest, WorkflowRun } from '../shared/reviewWorkflow'

console.log('this message from the preload')

const WINDOW_MAXIMIZE_CHANNEL = 'window:maximizeChanged'

// contextBridge.exposeInMainWorld 是一个安全机制，它允许你在预加载脚本中定义一些函数或对象，并将它们注入到网页的全局 window 对象中。
// 第一个参数 electronAPI 表示将要挂载到window上的属性名称
// 第二个参数，是一个对象，包含了想要暴露给前端的函数或者值
contextBridge.exposeInMainWorld('electronAPI', {
  startDualReview: (request: StartReviewRequest) => ipcRenderer.invoke('dual-review-start', request),
  getLocalCodexInfo: () => ipcRenderer.invoke('dual-review-codex-info'),
  stopDualReview: (id: string) => ipcRenderer.invoke('dual-review-stop', id),
  getDualReview: (id: string) => ipcRenderer.invoke('dual-review-get', id),
  listDualReviews: () => ipcRenderer.invoke('dual-review-list'),
  exportDualReview: (id: string, kind: 'docx' | 'report' | 'bundle') => ipcRenderer.invoke('dual-review-export', id, kind),
  onDualReviewUpdate: (callback: (run: WorkflowRun) => void) => {
    const listener = (_event: unknown, run: WorkflowRun) => callback(run)
    ipcRenderer.on('dual-review-update', listener)
    return () => ipcRenderer.removeListener('dual-review-update', listener)
  },
  selectDocxFile: () => ipcRenderer.invoke('select-docx-file'),
  APISettings: (url: string, key: string, modelName: string, provider?: string) =>
    ipcRenderer.invoke('set-api', url, key, modelName, provider),
  updateAPISetting: (id: number, url: string, key: string, modelName: string, provider?: string) =>
    ipcRenderer.invoke('update-api', id, url, key, modelName, provider),
  getALLAPISettings: () => ipcRenderer.invoke('get-all-api-settings', {}),
  deleteOneAPI: (id: number) => ipcRenderer.invoke('delete-one-api-setting', id),
  testAPI: (url: string, key: string, modelName: string) => ipcRenderer.invoke('test-api', url, key, modelName),
  testAPIWithProvider: (provider: string, url: string, key: string, modelName: string) =>
    ipcRenderer.invoke('test-api-with-provider', provider, url, key, modelName),
  selectAPISetting: (
    url: string,
    key: string,
    modelName: string,
    parallel?: number,
    TimeLimit?: number | null,
    provider?: string,
    requestTimeoutSec?: number | null,
    thinkingMode?: string
  ) =>
    ipcRenderer.invoke(
      'selectAPISetting',
      url,
      key,
      modelName,
      parallel,
      TimeLimit,
      provider,
      requestTimeoutSec,
      thinkingMode || 'default'
    ),
  getAPISettings: () => ipcRenderer.invoke('get-api-settings', {}),

  // 代理设置相关API
  setProxySettings: (enabled: boolean, port: number) => ipcRenderer.invoke('setProxySettings', enabled, port),
  getProxySettings: () => ipcRenderer.invoke('getProxySettings'),
  // 窗口控制：自定义标题栏按钮（top-toolbar 右上角）
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onWindowMaximizeChange: (callback: (isMaximized: boolean) => void) => {
    const listener = (_event: any, isMaximized: boolean) => {
      callback(isMaximized)
    }
    ipcRenderer.on(WINDOW_MAXIMIZE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(WINDOW_MAXIMIZE_CHANNEL, listener)
    }
  }
})
