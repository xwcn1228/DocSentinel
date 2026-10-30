// stores/apiStore.ts
import { defineStore } from 'pinia'
import { reactive } from 'vue'
import { ModelProvider } from '../../shared/modelProviders'

interface ApiSettings {
  id: number | null
  URL: string
  key: string
  name: string
  provider: ModelProvider
  time: string
  parallel: number
  /** 语义为「每分钟请求数上限」（历史命名 TimeLimit 保持不变以兼容 localStorage） */
  TimeLimit: number | null
  /** 单请求超时（秒），null 表示使用主进程默认值（300s） */
  requestTimeoutSec: number | null
  /** 思考模式：default 跟随服务商默认 / enabled / disabled（DeepSeek 等兼容 thinking 参数的服务） */
  thinkingMode: 'default' | 'enabled' | 'disabled'
}

interface ApiSettingItem {
  id: number
  apiURL: string
  apiKey: string
  modelName: string
  provider: ModelProvider
}

// 默认值作为常量，便于维护
const defaultApiSettings: ApiSettings = {
  id: null,
  URL: '',
  key: '',
  name: '',
  provider: ModelProvider.OPENAI_COMPATIBLE,
  time: '',
  parallel: 30,
  TimeLimit: null,
  requestTimeoutSec: null,
  thinkingMode: 'default'
}

export const useApiStore = defineStore(
  'apiSettings',
  () => {
    // 使用默认值初始化
    const selectedApi = reactive<ApiSettings>({ ...defaultApiSettings })

    // API 设置列表
    const apiSettings = reactive<ApiSettingItem[]>([])

    function setSelectedApi(api: Partial<ApiSettings>) {
      Object.assign(selectedApi, api)
    }

    function clearSelectedApi() {
      Object.assign(selectedApi, defaultApiSettings)
    }

    function setParallel(parallelSet: number) {
      selectedApi.parallel = parallelSet
    }

    function setTimeLimit(TimeLimit: number | null) {
      selectedApi.TimeLimit = TimeLimit
    }

    // API 设置列表相关方法
    function setApiSettings(settings: ApiSettingItem[]) {
      apiSettings.splice(0, apiSettings.length)
      settings.forEach(item => apiSettings.push(item))
    }

    function addApiSetting(setting: ApiSettingItem) {
      const index = apiSettings.findIndex(s => s.id === setting.id)
      if (index !== -1) {
        apiSettings[index] = setting
      } else {
        apiSettings.push(setting)
      }
    }

    function removeApiSetting(id: number) {
      const index = apiSettings.findIndex(s => s.id === id)
      if (index !== -1) {
        apiSettings.splice(index, 1)
      }
    }

    return {
      selectedApi,
      apiSettings,
      setSelectedApi,
      clearSelectedApi,
      setParallel,
      setTimeLimit,
      setApiSettings,
      addApiSetting,
      removeApiSetting
    }
  },
  {
    persist: {
      key: 'apiSettings',
      storage: localStorage,
      pick: ['selectedApi']
    }
  }
)
