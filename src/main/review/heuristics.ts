import fs from 'node:fs'
import path from 'node:path'
import { DocumentBlock, ReviewResult } from '../../shared/reviewWorkflow'

/**
 * 确定性 AI 风格启发式信号（程序侧检测，与 B/C 模型审查互补）。
 *
 * 模型容易被"读起来通顺"骗过；这些统计特征它自己数不准，由程序精确计算：
 * - 模板句式命中（首先/其次/综上所述…）：AI 生成文本的高频骨架词
 * - 逻辑连接词密度：模板化写作显著偏高
 * - 句长变异系数（burstiness）：人写句子长短起伏大，AI 句长高度均匀
 * - 4-gram 重复率：模板化表达的自我重复
 * - 标点多样性：人写常用 、；：？！ 交叉，模板文往往只有 。，
 *
 * 用途：a) 注入 B/C 审查输入作为独立证据源；b) merge 后兜底——信号强而模型
 * 给低分时按 applyHeuristicFloors 抬分并在 reason 标注，防止漏检。
 * 信号不足 40 字的短块不可靠，结果减半。
 */

// AI 生成中文文本的高频模板/骨架短语（内置基线；用户可在
// %APPDATA%/AutoDocxProofreading/heuristic-phrases.json 持续补充，无需改代码）
const TEMPLATE_PATTERNS: [RegExp, string][] = [
  [/综上所述|总而言之|总的来说|由此可见|不难看出|不难发现/g, '总结模板'],
  [/首先[，,]?[^。]{0,40}(其次|再者|接着)/g, '首先其次链'],
  [/值得(注意|关注)的是|需要(注意|指出|强调)的是|特别值得指出的是|值得强调的是/g, '提示句式'],
  [/不仅[^。，]{1,30}(而且|还|也)/g, '不仅而且句式'],
  [/与此同时|在此基础上|具体而言|换言之|换句话说|进一步地/g, '衔接套语'],
  [/随着[^。，]{1,25}的(发展|普及|进步|推进|提升|完善|不断深入)/g, '随着句式'],
  [/具有(重要|显著|积极)的?(意义|价值|作用)/g, '空泛意义句'],
  [/起到(了)?(重要|关键|至关重要)?(的)?作用|发挥着不可替代的作用/g, '空泛作用句'],
  [/(提供了|奠定了)(有力|坚实|重要)的?(支撑|保障|基础)/g, '空泛支撑句'],
  [/广阔的(应用|发展)前景|重要意义|深远影响/g, '前景套话'],
  [/旨在(通过|借助|利用)/g, '旨在句式'],
  [/(从而|进而)(实现|提升|提高|增强|优化)/g, '从而递进']
]

// ===== 外部可补充短语表 =====
// 文件不存在时自动写入带示例的种子文件；phrases 按字面子串计数，patterns 为
// 正则（非法正则跳过并告警）。修改后重启应用生效；也可调用 reload 强制重载。
interface ExternalTable { phrases: string[]; patterns: string[] }
let externalPhrases: string[] = []
let externalPatterns: RegExp[] = []
let externalLoaded = false

function externalTablePath(): string | null {
  try {
    // electron 在主进程可用；测试环境（无 electron）返回 null，外部表为空
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'heuristic-phrases.json')
  } catch {
    return null
  }
}

const SEED_TABLE = {
  _说明: '补充你的领域高频 AI 套话。phrases：字面短语，命中一次记一次；patterns：正则字符串（非法自动跳过）。修改后重启应用生效。',
  phrases: ['赋能', '抓手', '闭环', '底层逻辑'],
  patterns: ['全方位', '多维度']
}

export function loadExternalPhrases(fileOverride?: string): void {
  externalLoaded = true
  const file = fileOverride ?? externalTablePath()
  if (!file) return
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(SEED_TABLE, null, 2) + '\n', 'utf8')
    }
    const table = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ExternalTable>
    externalPhrases = Array.isArray(table.phrases) ? table.phrases.filter(p => typeof p === 'string' && p.trim()) : []
    externalPatterns = []
    for (const p of Array.isArray(table.patterns) ? table.patterns : []) {
      if (typeof p !== 'string' || !p.trim()) continue
      try { externalPatterns.push(new RegExp(p, 'g')) } catch { console.warn(`[heuristics] 外部正则无效，已跳过: ${p}`) }
    }
    console.log(`[heuristics] 外部短语表已加载：${externalPhrases.length} 短语 / ${externalPatterns.length} 正则`)
  } catch (error) {
    console.warn('[heuristics] 外部短语表读取失败（忽略，继续用内置表）:', error instanceof Error ? error.message : error)
    externalPhrases = []; externalPatterns = []
  }
}

// 逻辑连接词（密度统计用）
const CONNECTIVE_RE = /然而|因此|所以|但是|并且|同时|此外|另外|其次|首先|最后|进而|从而|由于|尽管|虽然|如果|例如|比如|即|以及/g

export interface BlockSignals {
  blockId: string
  heuristicScore: number
  summary: string
}

export function computeBlockSignals(block: DocumentBlock): BlockSignals {
  const text = block.text
  const chars = text.replace(/\s/g, '').length
  if (chars < 40) {
    return { blockId: block.id, heuristicScore: 0, summary: '短块（<40字），统计信号不可靠' }
  }
  const findings: string[] = []
  let score = 0

  // 1) 模板句式：每命中一类 +8，上限 32；外部补充表单独计分（上限 16）
  let templateCount = 0
  for (const [re, name] of TEMPLATE_PATTERNS) {
    const hits = text.match(re)
    if (hits?.length) {
      templateCount += hits.length
      findings.push(`${name}×${hits.length}`)
    }
  }
  score += Math.min(32, templateCount * 8)
  if (!externalLoaded) loadExternalPhrases()
  let externalHits = 0
  for (const phrase of externalPhrases) {
    const count = phrase ? text.split(phrase).length - 1 : 0
    if (count > 0) {
      externalHits += count
      findings.push(`自定义短语"${phrase}"×${count}`)
    }
  }
  for (const re of externalPatterns) {
    const hits = text.match(re)
    if (hits?.length) {
      externalHits += hits.length
      findings.push(`自定义模式×${hits.length}`)
    }
  }
  score += Math.min(16, externalHits * 8)

  // 2) 连接词密度（每百字）：>2 加分，上限 20
  const connectives = text.match(CONNECTIVE_RE)?.length ?? 0
  const connectiveDensity = (connectives * 100) / chars
  if (connectiveDensity > 2) {
    score += Math.min(20, (connectiveDensity - 2) * 5)
    findings.push(`连接词密度 ${connectiveDensity.toFixed(1)}/100字`)
  }

  // 3) 句长变异系数：人写通常 >0.4，AI 常 <0.3
  const sentences = text.split(/[。！？!?；;]+/).filter(s => s.trim().length > 1)
  if (sentences.length >= 4) {
    const lens = sentences.map(s => s.trim().length)
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0
    if (cv < 0.25) { score += 20; findings.push(`句长高度均匀（变异系数 ${cv.toFixed(2)}）`) }
    else if (cv < 0.35) { score += 10; findings.push(`句长偏均匀（变异系数 ${cv.toFixed(2)}）`) }
  }

  // 4) 4-gram 重复率：>3% 提示模板化自我重复
  const clean = text.replace(/\s/g, '')
  const seen = new Set<string>()
  let repeated = 0
  for (let i = 0; i + 4 <= clean.length; i++) {
    const gram = clean.slice(i, i + 4)
    if (seen.has(gram)) repeated++
    else seen.add(gram)
  }
  const gramTotal = Math.max(1, clean.length - 3)
  const repeatRate = (repeated * 100) / gramTotal
  if (repeatRate > 3) { score += Math.min(16, (repeatRate - 3) * 4); findings.push(`4-gram 重复率 ${repeatRate.toFixed(1)}%`) }

  // 5) 标点多样性：仅用 。， 视为单一
  const punctKinds = new Set((text.match(/[、；：？！“”‘’（）——…·]/g) || []).length ? [...new Set(text.match(/[、；：？！()（）——…·]/g) || [])] : [])
  if (punctKinds.size === 0 && sentences.length >= 3) { score += 12; findings.push('标点单一（仅句号逗号）') }

  return {
    blockId: block.id,
    heuristicScore: Math.min(100, Math.round(score)),
    summary: findings.length ? findings.join('；') : '未见明显统计异常'
  }
}

export function computeSignals(blocks: DocumentBlock[]): BlockSignals[] {
  return blocks.map(computeBlockSignals)
}

/** 注入提示词的紧凑形式：只保留有信号的块（短块等不可靠信号不注入），避免无谓 token */
export function signalsForPrompt(blocks: DocumentBlock[], signals: BlockSignals[]) {
  const byId = new Map(signals.map(s => [s.blockId, s]))
  return blocks
    .map(b => byId.get(b.id))
    .filter((s): s is BlockSignals => !!s && s.heuristicScore > 0)
    .map(s => ({ blockId: s.blockId, score: s.heuristicScore, findings: s.summary }))
}

/**
 * 程序信号校准（三重作用，只升不降）：
 * 1) 段落兜底：程序信号 ≥60 而模型 <30 的段落抬到 30 并在 reason 标注；
 * 2) 统计托底：整体分不低于「长度加权启发分 × 0.85」——模型立场再客气，
 *    统计证据（模板句式/句长均匀等）直接给整体分设下限，专治纯 AI 文本
 *    被评出 18/22 这类"均匀低分"；
 * 3) 高分防稀释：整体分不低于「分数前 25% 段落的加权均值 × 0.75」——
 *    局部重灾段不被大量平庸段平均掉。
 * 是否放行仍由用户阈值决定；所有校准都在 summary 里注明依据。
 */
export function applyHeuristicFloors(result: ReviewResult, blocks: DocumentBlock[]): ReviewResult {
  if (result.status !== 'valid') return result
  const signals = new Map(computeSignals(blocks).map(s => [s.blockId, s]))
  const len = new Map(blocks.map(b => [b.id, Math.max(1, b.text.length)]))
  const total = blocks.reduce((sum, b) => sum + Math.max(1, b.text.length), 0)
  const weight = (p: { blockId: string }) => len.get(p.blockId) || 1

  let raisedParagraphs = 0
  for (const p of result.paragraphResults) {
    const s = signals.get(p.blockId)
    if (s && s.heuristicScore >= 60 && p.riskScore < 30) {
      p.riskScore = 30
      p.reason = `${p.reason}；程序统计信号提升（${s.summary}）`
      raisedParagraphs++
    }
  }

  const mean = Math.round(result.paragraphResults.reduce((sum, p) => sum + p.riskScore * weight(p), 0) / total * 100) / 100
  const sorted = [...result.paragraphResults].sort((a, b) => b.riskScore - a.riskScore)
  const hotCount = Math.max(1, Math.ceil(sorted.length * 0.25))
  const hotSlice = sorted.slice(0, hotCount)
  const hotWeight = hotSlice.reduce((sum, p) => sum + weight(p), 0)
  const hotspot = hotSlice.reduce((sum, p) => sum + p.riskScore * weight(p), 0) / Math.max(1, hotWeight)
  const hotspotFloor = Math.round(hotspot * 0.75)
  const signalOverall = Math.round(blocks.reduce((sum, b) => sum + (signals.get(b.id)?.heuristicScore || 0) * Math.max(1, b.text.length), 0) / total * 0.85)

  const notes: string[] = []
  let overall = Math.max(mean, result.overallRiskScore || 0)
  if (signalOverall > overall) {
    overall = signalOverall
    notes.push(`程序统计信号托底（长度加权启发分×0.85 = ${signalOverall}）`)
  }
  if (hotspotFloor > overall) {
    overall = hotspotFloor
    notes.push(`高分热点防稀释（前25%段均值 ${Math.round(hotspot)}×0.75 = ${hotspotFloor}）`)
  }
  if (raisedParagraphs > 0) notes.push(`${raisedParagraphs} 个段落执行了兜底提升（模型<30 但统计特征≥60）`)
  if (overall > (result.overallRiskScore || 0)) result.overallRiskScore = overall
  if (notes.length) result.summary += `\n程序信号校准：${notes.join('；')}。`
  return result
}
