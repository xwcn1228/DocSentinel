export type Reviewer = 'structure' | 'content'
export type ReviewStage = Reviewer | 'reviseStructure' | 'reviseContent'
export type ModelRole = ReviewStage
export type ReviewModelChoice =
  | { kind: 'selected-api' }
  | { kind: 'saved-api'; apiSettingId: number }
  | { kind: 'local-codex'; executable?: string; model?: string }

/** Codex CLI expects model IDs, while the desktop picker shows display names. */
export function codexModelId(value?: string): string | undefined {
  const model = value?.trim()
  if (!model) return undefined
  const aliases: Record<string, string> = {
    'gpt-6.1 sol': 'gpt-6.1-sol',
    'gpt-6.1 terra': 'gpt-6.1-terra',
    'gpt-6 astra': 'gpt-6-astra',
    'gpt-6 sol': 'gpt-6-sol',
    'gpt-6 luna': 'gpt-6-luna'
  }
  const normalized = aliases[model.toLowerCase().replace(/\s+/g, ' ')]
  if (normalized) return normalized
  if (/\s/.test(model)) throw new Error('Codex 模型请填写 CLI 模型 ID，例如 gpt-6.1-sol；不要填写 GPT-6.1 Sol 等显示名称')
  return model
}
export interface DocumentBlock {
  id: string
  text: string
  editable: boolean
  movable: boolean
  protection?: string
  /** 标题块（样式 Heading/标题/含大纲级别）。旧任务数据可能缺省，按非标题处理 */
  heading?: boolean
}
export interface Evidence { blockId: string; quote: string }
export interface ReviewIssue {
  id: string
  reviewer: Reviewer
  severity: 'minor' | 'major' | 'critical'
  reason: string
  suggestion: string
  evidence: Evidence[]
  confidence: number
}
export interface Resolution {
  issueId: string
  resolved: boolean
  reason: string
  evidence: Evidence[]
}
export interface ParagraphRisk {
  blockId: string
  riskScore: number
  reason: string
  confidence: number
  evidence: Evidence[]
}
export interface ReviewResult {
  reviewer: Reviewer
  status: 'valid' | 'failed'
  error?: string
  scoreType?: 'agent-heuristic'
  overallRiskScore?: number
  qualitativeAssessment?: string
  paragraphResults: ParagraphRisk[]
  evidence: Evidence[]
  issues: ReviewIssue[]
  resolutions: Resolution[]
  confidence?: number
  summary: string
}
export type ReviewBundle = Record<Reviewer, ReviewResult>
export interface ReviewConfig {
  maxRounds: number
  maxRiskB: number
  maxRiskC: number
  discipline: string
  codexProxy: { enabled: boolean; port: number }
  models: Record<ModelRole, ReviewModelChoice>
}
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  maxRounds: 3, maxRiskB: 80, maxRiskC: 80, discipline: '通用（学科未指定）',
  codexProxy: { enabled: true, port: 7890 },
  models: { structure: { kind: 'selected-api' }, content: { kind: 'selected-api' }, reviseStructure: { kind: 'selected-api' }, reviseContent: { kind: 'selected-api' } }
}
export interface RiskSummary {
  priorityBlockIds: string[]
  evidence: Evidence[]
  summary: string
}
export interface ReviewDecision {
  passed: boolean
  reasons: string[]
  risk?: RiskSummary
}
export interface TextEdit {
  blockId: string
  original: string
  replacement: string
  reason: string
  issueIds: string[]
}
export interface BlockMove { blockId: string; beforeBlockId: string; reason: string; issueIds: string[] }
export interface RevisionPlan { edits: TextEdit[]; moves: BlockMove[]; summary: string }
export interface RevisionRecord extends RevisionPlan {
  stage: 'structure' | 'content'
  beforePath: string
  afterPath: string
}
export interface ReviewRound {
  index: number
  candidatePath: string
  blocks: DocumentBlock[]
  reviews: ReviewBundle
  decision: ReviewDecision
  revisions: RevisionRecord[]
  unresolvedIssues: ReviewIssue[]
}
export interface WorkflowRun {
  id: string
  status: 'running' | 'passed' | 'not-passed' | 'failed' | 'stopped'
  sourcePath: string
  originalPath: string
  originalSha256: string
  currentPath: string
  directory: string
  config: ReviewConfig
  model: string
  modelLabels?: Record<ModelRole, string>
  dataOrigin: 'live' | 'mock'
  modelNotice: string
  startedAt: string
  finishedAt?: string
  phase: string
  rounds: ReviewRound[]
  pendingRevisions: RevisionRecord[]
  unresolvedIssues: ReviewIssue[]
  errors: string[]
  /** 按阶段累计的模型 token 用量（structure/content/reviseStructure/reviseContent）。本地 Codex CLI 不上报用量，不统计 */
  tokenUsage?: Record<string, number>
}
export const REVIEW_MODEL_NOTICE = 'B 评估结构风格风险，C 评估内容风格风险；分数越高表示可举证的风险特征越多。风险评分（非真实概率），不能证明 AI 作者身份。四个角色可分别选择 API 或本地 Codex CLI；Codex CLI 通常仍调用远端模型。'
export interface StartReviewRequest { filePath: string; config: ReviewConfig }
