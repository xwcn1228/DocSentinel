/**
 * Electron API 类型支持应与 preload.ts 中的API一致
 * 你需要告诉 TypeScript,windows 类型中心增加的属性和接口情况
 * 防止运行时错误
 */
import { apiSettings } from './ipcHandlers'
import { StartReviewRequest, WorkflowRun } from '../shared/reviewWorkflow'

export interface ElectronAPI {
  // ====== 双检测循环审查 ======
  startDualReview: (request: StartReviewRequest) => Promise<{ id: string }>
  getLocalCodexInfo: () => Promise<{ found: boolean; path?: string; models?: string[]; error?: string }>
  stopDualReview: (id: string) => Promise<boolean>
  getDualReview: (id: string) => Promise<WorkflowRun>
  listDualReviews: () => Promise<{ id: string; status: string; startedAt: string; sourcePath: string }[]>
  exportDualReview: (id: string, kind: 'docx' | 'report' | 'bundle') => Promise<string | null>
  onDualReviewUpdate: (callback: (run: WorkflowRun) => void) => () => void

  // ====== 文件选择（dialog 域）======
  selectDocxFile: () => Promise<string | null>

  // ====== API 配置（apiSettings 域）======
  APISettings: (url: string, key: string, modelName: string, provider?: string) => Promise<string>
  updateAPISetting: (id: number, url: string, key: string, modelName: string, provider?: string) => Promise<boolean>
  getALLAPISettings: () => Promise<apiSettings & { id: number; created_at?: string }[]>
  deleteOneAPI: (id: number) => Promise<{ isSuccess: boolean }>
  testAPI: (url: string, key: string, modelName: string) => Promise<boolean>
  testAPIWithProvider: (provider: string, url: string, key: string, modelName: string) => Promise<boolean>
  selectAPISetting: (
    url: string,
    key: string,
    modelName: string,
    parallel?: number,
    TimeLimit?: number | null,
    provider?: string,
    requestTimeoutSec?: number | null,
    thinkingMode?: string
  ) => Promise<boolean>
  getAPISettings: () => Promise<{
    URL: string
    Key: string
    modelName: string
    provider?: string
    parallel: number
    requestsPerMinute: number | null
    requestTimeoutSec: number | null
    thinkingMode: string
  }>

  // ====== 代理设置 ======
  setProxySettings: (enabled: boolean, port: number) => Promise<{ success: boolean; error?: string }>
  getProxySettings: () => Promise<{ enabled: boolean; port: number }>

  // ====== 窗口控制（自定义标题栏按钮）======
  minimizeWindow: () => Promise<void>
  toggleMaximizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
  isWindowMaximized: () => Promise<boolean>
  onWindowMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
