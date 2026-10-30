import { DocumentBlock, ReviewBundle, ReviewConfig, ReviewIssue, Reviewer, ReviewResult, ReviewStage, RevisionPlan, WorkflowRun } from '../../shared/reviewWorkflow'
import { decide, parseObject, qualityTasks, validateReview, validateRevision } from './validation'
import { systemPrompt } from './prompts'
import { issuesForChunk, mergeChunkReviews, partitionBlocks, stabilizeIssueIds } from './chunking'
import { applyHeuristicFloors, computeSignals, signalsForPrompt } from './heuristics'

export interface ReviewDependencies {
  call(stage: ReviewStage, system: string, input: string, signal: AbortSignal): Promise<string>
  read(filePath: string): Promise<DocumentBlock[]>
  revise(inputPath: string, round: number, stage: 'structure' | 'content', plan: RevisionPlan): Promise<string>
  persist(run: WorkflowRun): Promise<void>
  notify(run: WorkflowRun): void
}
const reviewers: Reviewer[] = ['structure', 'content']

/**
 * 有界并发池：片段审查/修改并行执行（每路 CHUNK_CONCURRENCY 个），
 * 总并发由 reviewWorkflowHandlers 的调用闸门（并发数/每分钟请求数）统一约束。
 * 串行时代一个片段一次模型调用要等上一次完成，长文档一轮要十分钟级；
 * 并行后耗时约等于"片段数 / 并发"倍压缩，token 消耗不变。
 */
const CHUNK_CONCURRENCY = 3
async function runPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index], index)
    }
  }))
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('任务已停止'))
    if (signal.aborted) { reject(new Error('任务已停止')); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function evaluateOne(reviewer: Reviewer, blocks: DocumentBlock[], config: ReviewConfig, previous: ReviewIssue[], deps: Pick<ReviewDependencies, 'call'>, signal: AbortSignal, originalBlocks?: DocumentBlock[], progress?: (completed: number, total: number) => void): Promise<ReviewResult> {
  try {
    if (signal.aborted) throw new Error('任务已停止')
    const completed: { index: number; blocks: DocumentBlock[]; result: ReviewResult }[] = []
    let completedBlocks = 0
    // 程序侧确定性信号：注入各片段审查输入，并在合并后做兜底提升
    const signals = computeSignals(blocks)
    const examine = async (chunk: DocumentBlock[], label: string, chunkIndex: number): Promise<void> => {
      const prior = issuesForChunk(previous, reviewer, chunk)
      const ids = new Set(chunk.map(b => b.id))
      const input = { blocks: chunk, discipline: config.discipline, previousIssues: prior, heuristicSignals: signalsForPrompt(chunk, signals),
        ...(reviewer === 'content' ? { originalBlocks: originalBlocks?.filter(b => ids.has(b.id)) } : {}) }
      const system = systemPrompt(reviewer) + '\n当前仅审查输入中的片段，不要求输出文档其他片段。JSON 字段中的理由保持简洁。若 previousIssues 为空，resolutions 必须是空数组 []。'
      let feedback = ''
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted) throw new Error('任务已停止')
        try {
          const text = await abortable(deps.call(reviewer, system + feedback, JSON.stringify(input), signal), signal)
          if (signal.aborted) throw new Error('任务已停止')
          const result = validateReview(reviewer, stabilizeIssueIds(parseObject(text), prior), chunk, prior)
          const threshold = reviewer === 'structure' ? config.maxRiskB : config.maxRiskC
          if (result.overallRiskScore! > threshold && !result.issues.length) throw new Error('结果校验失败：超阈值风险缺少可核实的具体修改问题')
          completed.push({ index: chunkIndex, blocks: chunk, result })
          completedBlocks += chunk.length
          progress?.(completedBlocks, blocks.length)
          return
        } catch (error) {
          if (signal.aborted) throw error
          const message = error instanceof Error ? error.message : String(error)
          const recoverable = error instanceof SyntaxError || message.startsWith('结果校验失败：')
          if (recoverable && attempt === 0) {
            feedback = `\n上次响应未通过程序校验：${message.slice(0, 240)}。请重新生成完整 JSON；逐项检查证据 quote 与原文完全一致，每段都要给出风险分；只复核 previousIssues 中真实存在的 ID。`
            continue
          }
          // Still invalid after a focused retry: reduce the request, never invent a score or evidence.
          if (recoverable && chunk.length > 1) {
            const middle = Math.ceil(chunk.length / 2)
            await examine(chunk.slice(0, middle), `${label}a`, chunkIndex)
            await examine(chunk.slice(middle), `${label}b`, chunkIndex)
            return
          }
          const reason = error instanceof SyntaxError ? '模型连续返回不完整或无效 JSON；单段无法继续拆分，请检查模型输出长度限制' : error instanceof Error ? error.message : String(error)
          throw new Error(`${label}（${chunk[0].id}–${chunk.at(-1)!.id}）失败：${reason}`)
        }
      }
    }
    const chunks = partitionBlocks(blocks, 3600, 8)
    await runPool(chunks, CHUNK_CONCURRENCY, (chunk, index) => examine(chunk, `片段 ${index + 1}/${chunks.length}`, index))
    // 并行完成顺序不定；mergeChunkReviews 的权重与结果按下标对齐，须先按片段顺序排序
    const ordered = completed.sort((a, b) => a.index - b.index)
    return applyHeuristicFloors(mergeChunkReviews(reviewer, ordered.map(c => c.result), ordered.map(c => c.blocks)), blocks)
  } catch (error) {
    return { reviewer, status: 'failed', error: error instanceof Error ? error.message : String(error), paragraphResults: [], evidence: [], issues: [], resolutions: [], summary: '调用或结构化结果校验失败，不能判定通过。' }
  }
}

async function planRevision(stage: 'structure' | 'content', current: DocumentBlock[], reviews: ReviewBundle, run: WorkflowRun, originalBlocks: DocumentBlock[], deps: Pick<ReviewDependencies, 'call' | 'notify'>, signal: AbortSignal): Promise<RevisionPlan> {
  const action = stage === 'structure' ? 'reviseStructure' : 'reviseContent'
  const stageTasks = qualityTasks(reviews).filter(t => t.reviewer === stage)
  const editableIds = new Set(current.filter(b => b.editable).map(b => b.id))
  // Protected blocks are still reviewed and reported, but are never actionable edits.
  const tasks = stageTasks.map(t => ({ ...t, evidence: t.evidence.filter(e => editableIds.has(e.blockId)) })).filter(t => t.evidence.length)
  const protectedTaskCount = stageTasks.length - tasks.length
  const chunks = partitionBlocks(current)
  const activeChunks = chunks.filter(chunk => tasks.some(t => t.evidence.some(e => chunk.some(b => b.id === e.blockId))))
  // A no-issue stage still receives one small input and must explicitly return no edits.
  if (!activeChunks.length) activeChunks.push(chunks[0])
  const plans: RevisionPlan[] = []
  const examine = async (chunk: DocumentBlock[], label: string): Promise<void> => {
    const ids = new Set(chunk.map(b => b.id))
    const relevant = (issues: ReviewIssue[]) => issues.filter(i => i.evidence.some(e => ids.has(e.blockId)))
    const compact = (r: ReviewResult) => ({ reviewer: r.reviewer, status: r.status,
      overallRiskScore: r.overallRiskScore,
      summary: r.summary.slice(0, 500), qualitativeAssessment: r.qualitativeAssessment?.slice(0, 500),
      paragraphResults: r.paragraphResults.filter(p => ids.has(p.blockId)), issues: relevant(r.issues) })
    const input = { version: run.currentPath.split(/[\\/]/).pop(), blocks: chunk, discipline: run.config.discipline,
      structure: compact(reviews.structure), content: compact(reviews.content),
      previousIssues: relevant(run.unresolvedIssues), qualityTasks: relevant(tasks),
      priorityBlockIds: run.rounds.at(-1)!.decision.risk?.priorityBlockIds.filter(id => ids.has(id) && editableIds.has(id)) || [],
      earlierRevisions: run.pendingRevisions.map(r => ({ stage: r.stage, summary: r.summary, edits: r.edits.filter(e => ids.has(e.blockId)), moves: r.moves.filter(m => ids.has(m.blockId)) })),
      originalBlocks: originalBlocks.filter(b => ids.has(b.id)) }
    const prompt = systemPrompt(action) + '\n当前仅修改输入 blocks；只能处理 qualityTasks 中有可编辑证据的段落。editable=false 的块只供审查，不得编辑；段落移动的两个 ID 都必须在本片段中且 movable=true。保持 JSON 简洁。'
    let feedback = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw new Error('任务已停止')
      try {
        const raw = await abortable(deps.call(action, prompt + feedback, JSON.stringify(input), signal), signal)
        const parsed = parseObject(raw)
        const byId = new Map(chunk.map(b => [b.id, b]))
        let ignored = 0
        if (Array.isArray(parsed.edits)) {
          const retained = parsed.edits.filter((edit: any) => {
            const block = byId.get(edit?.blockId)
            if (!block || block.editable) return true
            ignored++; return false
          })
          parsed.edits = retained
        }
        if (stage === 'structure' && Array.isArray(parsed.moves)) {
          const retained = parsed.moves.filter((move: any) => {
            const source = byId.get(move?.blockId), target = byId.get(move?.beforeBlockId)
            if (!source || !target || (source.movable && target.movable)) return true
            ignored++; return false
          })
          parsed.moves = retained
        }
        if (ignored && typeof parsed.summary === 'string') parsed.summary += `（已忽略 ${ignored} 条针对受保护块的修改提议。）`
        plans.push(validateRevision(parsed, chunk, reviews, stage))
        run.phase = `第 ${run.rounds.length} 轮${stage === 'structure' ? '结构' : '内容'}修改：已处理 ${plans.length} 个片段`
        deps.notify(run)
        return
      } catch (error) {
        if (signal.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        const recoverable = error instanceof SyntaxError || message.startsWith('结果校验失败：')
        if (recoverable && attempt === 0) {
          feedback = `\n上次修改计划未通过程序校验：${message.slice(0, 240)}。请重新输出完整 JSON；只修改当前片段可编辑的原文，保持数字、引用和事实，issueIds 必须关联输入中的具体问题。`
          continue
        }
        if (recoverable && chunk.length > 1) {
          const middle = Math.ceil(chunk.length / 2)
          await examine(chunk.slice(0, middle), `${label}a`)
          await examine(chunk.slice(middle), `${label}b`)
          return
        }
        const reason = error instanceof SyntaxError ? '模型连续返回不完整或无效 JSON；单段无法继续拆分，请检查模型输出长度限制' : error instanceof Error ? error.message : String(error)
        throw new Error(`${stage} 修改 ${label}（${chunk[0].id}–${chunk.at(-1)!.id}）失败：${reason}`)
      }
    }
  }
  await runPool(activeChunks, CHUNK_CONCURRENCY, (chunk, index) => examine(chunk, `片段 ${index + 1}/${activeChunks.length}`))
  return { edits: plans.flatMap(p => p.edits), moves: plans.flatMap(p => p.moves),
    summary: [...plans.map((p, i) => `片段 ${i + 1}：${p.summary}`), ...(protectedTaskCount ? [`${protectedTaskCount} 个问题仅涉及受保护块，保留供人工处理。`] : [])].join('\n') }
}

export async function executeWorkflow(run: WorkflowRun, deps: ReviewDependencies, signal: AbortSignal): Promise<WorkflowRun> {
  const checkpoint = async (phase: string) => { run.phase = phase; await deps.persist(run); deps.notify(run) }
  const checkStop = () => { if (signal.aborted) throw new Error('任务已停止') }
  try {
    checkStop()
    const originalBlocks = await deps.read(run.originalPath)
    for (let round = 0; round <= run.config.maxRounds; round++) {
      checkStop()
      const blocks = await deps.read(run.currentPath)
      if (!blocks.length) throw new Error('文档没有可审查的非空文本块')
      await checkpoint(round === 0 ? '初始 B/C 双路并行审查' : `第 ${round} 轮候选版本 B/C 双路复审`)
      const progress: Record<Reviewer, number> = { structure: 0, content: 0 }
      const results = await Promise.all(reviewers.map(r => evaluateOne(r, blocks, run.config, run.unresolvedIssues, deps, signal, originalBlocks, (done, total) => {
        progress[r] = done
        run.phase = `第 ${round} 轮审查进度：B 结构 ${progress.structure}/${total}，C 内容 ${progress.content}/${total}`
        deps.notify(run)
      })))
      const reviews = Object.fromEntries(results.map(r => [r.reviewer, r])) as ReviewBundle
      const decision = decide(reviews, run.config)
      const unresolved = [...results.flatMap(r => r.issues), ...run.unresolvedIssues.filter(i => reviews[i.reviewer].status === 'failed')]
      run.rounds.push({ index: round, candidatePath: run.currentPath, blocks, reviews, decision, revisions: run.pendingRevisions, unresolvedIssues: unresolved })
      run.pendingRevisions = []
      run.unresolvedIssues = unresolved
      await checkpoint(`第 ${round} 轮 B/C 双路审查完成`)
      checkStop()
      if (results.some(r => r.status === 'failed')) {
        run.errors.push(...results.filter(r => r.status === 'failed').map(r => `${r.reviewer}: ${r.error}`))
        run.status = 'failed'; break
      }
      if (decision.passed) { run.status = 'passed'; break }
      if (round === run.config.maxRounds) { run.status = 'not-passed'; break }

      for (const stage of ['structure', 'content'] as const) {
        checkStop()
        const score = stage === 'structure' ? reviews.structure.overallRiskScore! : reviews.content.overallRiskScore!
        const threshold = stage === 'structure' ? run.config.maxRiskB : run.config.maxRiskC
        if (score <= threshold) {
          await checkpoint(`第 ${round + 1} 轮：${stage === 'structure' ? 'B 结构' : 'C 内容'}风险分 ${score} ≤ 阈值 ${threshold}，跳过该阶段修改`)
          continue
        }
        await checkpoint(`第 ${round + 1} 轮：修改${stage === 'structure' ? '结构' : '内容'}`)
        const current = await deps.read(run.currentPath)
        const plan = await planRevision(stage, current, reviews, run, originalBlocks, deps, signal)
        checkStop()
        const beforePath = run.currentPath
        // Await the save even if cancellation arrives mid-write; never expose a partial candidate.
        const afterPath = await deps.revise(beforePath, round + 1, stage, plan)
        run.currentPath = afterPath
        run.pendingRevisions.push({ ...plan, stage, beforePath, afterPath })
        await checkpoint(`第 ${round + 1} 轮${stage === 'structure' ? '结构' : '内容'}候选已保存`)
        checkStop()
      }
    }
  } catch (error) {
    run.status = signal.aborted ? 'stopped' : 'failed'
    if (!signal.aborted) run.errors.push(error instanceof Error ? error.message : String(error))
  }
  if (signal.aborted) run.status = 'stopped'
  run.finishedAt = new Date().toISOString()
  await checkpoint(run.status === 'passed' ? run.rounds.length === 1 ? 'AI率低，无需修改（内部风险评分，非真实概率）' : '双路风险分达标，修改完成' : run.status === 'stopped' ? '用户已停止，保留当前候选与未解决问题' : run.status === 'not-passed' ? '已达最大轮数，未通过' : '执行失败，保留当前候选与未解决问题')
  return run
}
