import { ModelRole, ReviewConfig, ReviewModelChoice, ReviewStage } from '../../shared/reviewWorkflow'
import { ModelProvider, requiresBaseURL } from '../../shared/modelProviders'

export interface ApiModelSnapshot {
  apiKey: string
  apiURL: string
  modelName: string
  provider?: ModelProvider
}
export type ResolvedReviewModel =
  | { kind: 'api'; api: ApiModelSnapshot; label: string }
  | { kind: 'local-codex'; executable?: string; model?: string; label: string }

export const modelRoleForStage = (stage: ReviewStage): ModelRole => stage

export async function resolveReviewModels(
  config: ReviewConfig,
  current: ApiModelSnapshot,
  loadSaved: (id: number) => Promise<ApiModelSnapshot | null>
): Promise<Record<ModelRole, ResolvedReviewModel>> {
  const result = {} as Record<ModelRole, ResolvedReviewModel>
  for (const role of ['structure', 'content', 'reviseStructure', 'reviseContent'] as const) {
    const choice: ReviewModelChoice = config.models[role]
    if (choice.kind === 'local-codex') {
      result[role] = { kind: 'local-codex', executable: choice.executable, model: choice.model,
        label: `本地 Codex CLI${choice.model ? ` · ${choice.model}` : ' · 默认模型'}` }
      continue
    }
    const api = choice.kind === 'saved-api' ? await loadSaved(choice.apiSettingId) : current
    if (!api) throw new Error(`${role} 选择的 API 配置已删除，请重新选择`)
    if (!api.apiKey || !api.modelName || (requiresBaseURL(api.provider || ModelProvider.OPENAI_COMPATIBLE) && !api.apiURL)) {
      throw new Error(`${role} 缺少有效的模型名称、密钥或 API 地址`)
    }
    result[role] = { kind: 'api', api: { ...api }, label: `${api.modelName}（${choice.kind === 'saved-api' ? `已保存配置 #${choice.apiSettingId}` : '当前 API'}）` }
  }
  return result
}
