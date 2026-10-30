"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyExactInlineEdits = applyExactInlineEdits;
exports.replaceTextInDocx = replaceTextInDocx;
const { loadDocx } = require('docx-edit');
const { diffArrays } = require('diff');
/** Exact, block-scoped edits for the review workflow. Preserve existing run boundaries. */
function applyExactInlineEdits(paraNode, edits) {
    const segments = collectTextSegments(paraNode);
    const fullText = segments.map(s => s.text).join('');
    const located = edits.map(edit => {
        const start = fullText.indexOf(edit.original);
        if (!edit.original || start < 0 || fullText.indexOf(edit.original, start + 1) >= 0)
            throw new Error('块内原文不唯一或不存在');
        const end = start + edit.original.length;
        return { start, end, replaceText: edit.replacement };
    });
    for (let i = 0; i < located.length; i++)
        for (let j = i + 1; j < located.length; j++) {
            if (located[i].start < located[j].end && located[j].start < located[i].end)
                throw new Error('修改范围重叠');
        }
    // Word may split even identically styled text into many w:t nodes. Diff the
    // matched text first so unchanged characters stay in their original runs.
    // Newly replaced text inherits the first changed run's formatting.
    const changes = located.sort((a, b) => a.start - b.start).flatMap(edit => {
        const result = [];
        let cursor = edit.start;
        let pending;
        const flush = () => {
            if (pending)
                result.push(pending);
            pending = undefined;
        };
        // Code points avoid splitting surrogate pairs when only an emoji changes.
        const parts = diffArrays(Array.from(fullText.slice(edit.start, edit.end)), Array.from(edit.replaceText));
        for (const part of parts) {
            const text = part.value.join('');
            if (!part.added && !part.removed) {
                flush();
                cursor += text.length;
                continue;
            }
            if (!pending)
                pending = {
                    start: cursor, end: cursor, replaceText: '',
                    // At the match start use the following character; otherwise insert
                    // after the preceding character, including at the paragraph end.
                    insertionAnchor: cursor === edit.start ? cursor : cursor - 1
                };
            if (part.removed) {
                cursor += text.length;
                pending.end = cursor;
            }
            else
                pending.replaceText += text;
        }
        flush();
        return result;
    });
    // Do not set paragraph.props.text: that redistributes text by run lengths.
    applyRunLevelEdits({ segments }, changes);
}
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// 脚注占位符匹配：docx-edit 的 getText() 会将脚注引用输出为 [[FOOTNOTE_REF:id]]
// 在 run 级别的 collectTextSegments 中不会包含脚注引用节点，因此 fullText 不含这些占位符
// 需要在匹配前从 searchText 中 strip 掉
const FOOTNOTE_PLACEHOLDER_RE = /\[\[FOOTNOTE_REF:\d+\]\]/g;
// 公式占位符同理：run 级 fullText 只收集 w:t 文本节点，不含 [[MATH:...]] token
// （公式是独立的 math 子节点）。含上下角标且含公式的段落走 run 级替换时，
// 若不从 search/replace 中剥离占位符，正则里的字面 [[MATH:...]] 永远匹配不上
const MATH_PLACEHOLDER_RE = /\[\[MATH:[\s\S]*?\]\]/g;
/**
 * 零宽字符集：U+200B (零宽空格)、U+200C (零宽非连接符)、
 * U+200D (零宽连接符)、U+FEFF (BOM/零宽不换行空格)。
 *
 * docx-edit 抽取段落文本时常把公式 OMML 边界、脚注引用边界上的零宽字符
 * 带进 props.text / fullText。JS 的 \s 不包含这些字符，若不专门处理，
 * 含零宽的文档文本与不含零宽的校正 original 之间会匹配失败，导致导出时
 * 该替换静默丢失。统一在匹配前剥离零宽字符，使匹配对它们完全不敏感。
 */
const ZERO_WIDTH_CHARS_RE = /[\u200B-\u200D\uFEFF]/g;
function stripZeroWidth(text) {
    return (text || '').replace(ZERO_WIDTH_CHARS_RE, '');
}
function stripNonTextPlaceholders(text) {
    return stripZeroWidth(text.replace(FOOTNOTE_PLACEHOLDER_RE, '').replace(MATH_PLACEHOLDER_RE, ''));
}
// 任一占位符 token（非全局版本，test() 无 lastIndex 状态问题）
const PLACEHOLDER_TOKEN_TEST_RE = /\[\[FOOTNOTE_REF:\d+\]\]|\[\[MATH:[\s\S]*?\]\]/;
// 按占位符 token 切分文本用的全局正则
const PLACEHOLDER_TOKEN_SPLIT_RE = /\[\[FOOTNOTE_REF:\d+\]\]|\[\[MATH:[\s\S]*?\]\]/g;
function containsPlaceholderToken(text) {
    return PLACEHOLDER_TOKEN_TEST_RE.test(text || '');
}
function isPlaceholderTokenPart(part) {
    return part.startsWith('[[FOOTNOTE_REF:') || part.startsWith('[[MATH:');
}
/**
 * 将文本按占位符 token 切分为 [文本块, token, 文本块, ...]。
 */
function splitByPlaceholderTokens(text) {
    const parts = [];
    let last = 0;
    PLACEHOLDER_TOKEN_SPLIT_RE.lastIndex = 0;
    let m;
    while ((m = PLACEHOLDER_TOKEN_SPLIT_RE.exec(text)) !== null) {
        parts.push(text.slice(last, m.index), m[0]);
        last = m.index + m[0].length;
    }
    parts.push(text.slice(last));
    return parts;
}
/**
 * 占位符桥接正则源码。占位符位置需同时兼容两种文档形态：
 * - run 级段落：占位符 token 不存在于 w:t 文本中，两侧可能各有真实空格
 *   （如 "测得 [[MATH:x2]] 的" 抽取后 run 级拼接为 "测得 的"）→ 匹配空白
 * - 普通段落：w:t 里可能含有字面 [[MATH:...]] 文本（占位符作为普通字符
 *   写进了文档）→ 匹配字面 token 本身
 * 两种情况下占位符两侧的空白都是可选的。
 */
const PLACEHOLDER_BRIDGE = '(?:\\s*(?:\\[\\[FOOTNOTE_REF:\\d+\\]\\]|\\[\\[MATH:[\\s\\S]*?\\]\\])?\\s*)';
function foldWhitespaceSource(text) {
    return escapeRegExp(text).replace(/[\\s\u200B-\u200D\uFEFF]+/g, '\\s+');
}
/**
 * 构建空白不敏感、占位符感知的匹配正则（供 RegExp 使用）。
 * - 零宽字符在匹配前从两端剥离，残余的作为空白吞掉
 * - 脚注/公式占位符位置替换为桥接正则（见 PLACEHOLDER_BRIDGE）
 * - 常规空白折叠为 \s+
 * - 每个含非空白内容的文本块用捕获组包裹，配合 'd' 标志可取得
 *   各块在文档中的精确区间（run 级分块替换用）
 *
 * 返回 null 表示搜索串剥掉占位符后没有实际内容（无法匹配）。
 */
function buildSearchPatternInfo(searchValue) {
    const parts = splitByPlaceholderTokens(stripZeroWidth(searchValue.trim()));
    let source = '';
    let chunkCount = 0;
    for (const part of parts) {
        if (isPlaceholderTokenPart(part)) {
            source += PLACEHOLDER_BRIDGE;
        }
        else if (part.replace(/[\\s\u200B-\u200D\uFEFF]/g, '')) {
            source += `(${foldWhitespaceSource(part)})`;
            chunkCount += 1;
        }
        else {
            source += '\\s*';
        }
    }
    if (chunkCount === 0)
        return null;
    return { source, chunkCount };
}
/**
 * 提取串中与捕获组对应的文本块（与 buildSearchPatternInfo 的切分规则一致：
 * 跳过占位符 token 与纯空白块）。run 级分块替换时与原文块按下标一一配对。
 */
function textChunksOf(searchValue) {
    const parts = splitByPlaceholderTokens(stripZeroWidth(searchValue.trim()));
    return parts.filter(p => !isPlaceholderTokenPart(p) && p.replace(/[\\s\u200B-\u200D\uFEFF]/g, ''));
}
// ====== Run 级别文本替换（保留上下角标格式） ======
/**
 * 检查段落是否需要使用 run 级别替换（而非 paragraph.props.text 整段替换）。
 *
 * 必须走 run 级别的情况：
 * 1. 包含上标/下标（vertAlign）的 run → setText() 会按字符数重分配，导致角标漂移
 * 2. 包含 footnoteReference / endnoteReference 子节点 → setText() 要求
 *    [[FOOTNOTE_REF:id]] 占位符完全保留，修改 props.text 时容易丢失
 * 3. 包含数学公式（math）子节点 → docx-edit 的 patch 引擎对含 math 子节点的段落
 *    有 hasStructuredInlineContent 门：props.text 的变更会被直接忽略（静默丢弃）。
 *    只有直接修改 w:t 文本节点（children 路径）才能持久化。
 */
function needsRunLevelReplacement(paraNode) {
    function visit(parent) {
        if (!parent || !parent.children)
            return false;
        for (const child of parent.children) {
            if (child.type === 'run') {
                const style = child.props.style || {};
                if (style.vertAlign === 'superscript' || style.vertAlign === 'subscript') {
                    return true;
                }
                // run 内含脚注/尾注引用
                if (child.children) {
                    for (const rc of child.children) {
                        if (rc.type === 'footnoteReference' || rc.type === 'endnoteReference') {
                            return true;
                        }
                    }
                }
            }
            else if (child.type === 'hyperlink') {
                if (visit(child))
                    return true;
            }
            else if (child.type === 'math') {
                return true;
            }
        }
        return false;
    }
    return visit(paraNode);
}
/**
 * 收集段落中所有 w:t 文本节点及其在拼接文本中的位置。
 * 深入遍历 run 及 hyperlink 容器，跳过 tab、break 等非文本节点。
 */
function collectTextSegments(paraNode) {
    const segments = [];
    let cursor = 0;
    function visit(parent) {
        if (!parent || !parent.children)
            return;
        for (const child of parent.children) {
            if (child.type === 'run') {
                for (const textChild of child.children || []) {
                    if (textChild.type === 'text') {
                        const text = textChild.props.text || '';
                        segments.push({ node: textChild, start: cursor, end: cursor + text.length, text });
                        cursor += text.length;
                    }
                }
            }
            else if (child.type === 'hyperlink') {
                visit(child);
            }
        }
    }
    visit(paraNode);
    return segments;
}
function buildParaSnapshot(paraNode) {
    const needsRunLevel = needsRunLevelReplacement(paraNode);
    const segments = needsRunLevel ? collectTextSegments(paraNode) : [];
    const originalText = needsRunLevel ? segments.map(s => s.text).join('') : paraNode.props.text || '';
    // fullText 可能含 OMML 边界残留的零宽字符，而搜索串已被剥离。
    // 构建"剥离零宽后的文本"及其到原始文本的索引映射，在干净版本上
    // 匹配，再把匹配区间换算回原始坐标。
    let cleanText = '';
    const indexMap = [];
    for (let i = 0; i < originalText.length; i++) {
        const ch = originalText[i];
        if (/[\u200B-\u200D\uFEFF]/.test(ch))
            continue;
        indexMap[cleanText.length] = i;
        cleanText += ch;
    }
    // 末尾哨兵：cleanText.length 位置映射到 originalText.length
    indexMap[cleanText.length] = originalText.length;
    return { node: paraNode, needsRunLevel, segments, originalText, cleanText, indexMap };
}
/**
 * 枚举一个段落快照中搜索串的全部匹配（originalText 坐标系）。
 * 匹配始终基于快照的原始文本，不受先前替换影响。
 * 使用 'd' 标志取得各捕获组（文本块）的精确区间，供 run 级分块替换
 * 将 suggested 中占位符两侧的文字分别写回公式节点两侧。
 */
function enumerateParagraphMatches(snapshot, info) {
    const regex = new RegExp(info.source, 'gd');
    const details = [];
    let m;
    while ((m = regex.exec(snapshot.cleanText)) !== null) {
        if (m[0].length === 0) {
            regex.lastIndex += 1;
            continue;
        }
        // indexMap 末尾哨兵保证 end 可指向 originalText.length（含被剥离的零宽脏字符，
        // 回写时连零宽脏字符一并清除）
        const chunkRanges = [];
        for (let g = 1; g <= info.chunkCount; g++) {
            const pair = m.indices?.[g];
            if (!pair)
                continue;
            chunkRanges.push({
                start: snapshot.indexMap[pair[0]],
                end: snapshot.indexMap[pair[1]]
            });
        }
        details.push({
            start: snapshot.indexMap[m.index],
            end: snapshot.indexMap[m.index + m[0].length],
            chunkRanges
        });
    }
    return details;
}
/**
 * 在普通段落（整段 props.text）上按 start 降序应用多处编辑。
 */
function applyNormalEdits(snapshot, edits) {
    let text = snapshot.originalText;
    for (const edit of edits) {
        text = text.slice(0, edit.start) + edit.replaceText + text.slice(edit.end);
    }
    snapshot.node.props.text = text;
}
function applyRunLevelEdits(snapshot, edits) {
    if (snapshot.segments.length === 0)
        return;
    const ordered = [...edits].sort((a, b) => a.start - b.start);
    for (const seg of snapshot.segments) {
        let out = '';
        let cursor = seg.start;
        for (const edit of ordered) {
            if (edit.start === edit.end) {
                const anchor = edit.insertionAnchor ?? edit.start;
                if (anchor >= seg.start && anchor < seg.end) {
                    out += seg.text.slice(cursor - seg.start, edit.start - seg.start) + edit.replaceText;
                    cursor = edit.end;
                }
                continue;
            }
            if (edit.end <= seg.start || edit.start >= seg.end)
                continue;
            const overlapStart = Math.max(edit.start, seg.start);
            const overlapEnd = Math.min(edit.end, seg.end);
            out += seg.text.slice(cursor - seg.start, overlapStart - seg.start);
            if (edit.start >= seg.start && edit.start < seg.end) {
                out += edit.replaceText;
            }
            cursor = overlapEnd;
        }
        out += seg.text.slice(cursor - seg.start);
        if (out !== seg.text) {
            seg.node.props.text = out;
        }
    }
}
// ====== 树遍历辅助函数 ======
/**
 * 递归收集一个节点下的所有段落节点（包括表格单元格、文本框内的段落）。
 */
function collectAllParagraphs(node, result = []) {
    if (!node || !node.children)
        return result;
    for (const child of node.children) {
        if (child.type === 'paragraph') {
            result.push(child);
        }
        else if (child.type === 'table') {
            for (const row of child.children || []) {
                if (row.type === 'table-row') {
                    for (const cell of row.children || []) {
                        if (cell.type === 'table-cell') {
                            collectAllParagraphs(cell, result);
                        }
                    }
                }
            }
        }
        else if (child.type === 'text-box') {
            collectAllParagraphs(child, result);
        }
    }
    return result;
}
async function replaceTextInDocx(inputPath, outputPath, replacements) {
    const sanitizedReplacements = replacements.filter(item => item && item.original && item.suggested !== undefined);
    const doc = await loadDocx(inputPath);
    let appliedCount = 0;
    const unmatched = [];
    // 一次取树，批量应用所有替换，最后一次 patch
    const tree = doc.toComponentTree();
    // 收集所有文档部件中的段落（body / header / footer 等），并建立替换前快照
    const allParagraphs = [];
    for (const part of tree.children) {
        collectAllParagraphs(part, allParagraphs);
    }
    const snapshots = allParagraphs.map(buildParaSnapshot);
    // ====== 定位阶段：在原始快照上按出现次序分配 ======
    // 校正列表顺序与文档顺序一致，因此同一原文的第 k 条替换分配给文档中
    // 第 k 次出现（与预览高亮的分配规则相同）。此前"逐条找第一个能匹配的
    // 段落"的做法在重复文本上会全部命中第一处，错改后续段落。
    const occurrenceCursor = new Map();
    const locatedEdits = [];
    for (const replacement of sanitizedReplacements) {
        const key = stripZeroWidth(replacement.original).trim();
        const info = buildSearchPatternInfo(replacement.original);
        if (!info) {
            unmatched.push(replacement);
            continue;
        }
        const occurrence = occurrenceCursor.get(key) || 0;
        occurrenceCursor.set(key, occurrence + 1);
        let target = null;
        let seen = 0;
        for (let paraIdx = 0; paraIdx < snapshots.length && !target; paraIdx++) {
            for (const detail of enumerateParagraphMatches(snapshots[paraIdx], info)) {
                if (seen === occurrence) {
                    target = { paraIdx, detail };
                    break;
                }
                seen += 1;
            }
        }
        if (!target) {
            unmatched.push(replacement);
            continue;
        }
        const snapshot = snapshots[target.paraIdx];
        let editsForThis;
        if (snapshot.needsRunLevel && containsPlaceholderToken(replacement.original)) {
            // run 级 + 含占位符：suggested 中的占位符是位置标记（公式/脚注节点
            // 所在的缝隙），按原文块区间对齐分块写回，避免替换文本整体塞进
            // 公式节点前的第一个 run 而使公式位置漂移。
            const suggestedChunks = textChunksOf(replacement.suggested);
            if (suggestedChunks.length === target.detail.chunkRanges.length) {
                editsForThis = target.detail.chunkRanges
                    .map((range, i) => ({
                    paraIdx: target.paraIdx,
                    start: range.start,
                    end: range.end,
                    replaceText: stripZeroWidth(suggestedChunks[i])
                }))
                    .filter(e => e.start < e.end || e.replaceText);
            }
            else {
                // 块数不齐（原文/建议的占位符数量不同）时退回整段替换
                editsForThis = [
                    {
                        paraIdx: target.paraIdx,
                        start: target.detail.start,
                        end: target.detail.end,
                        replaceText: stripNonTextPlaceholders(replacement.suggested)
                    }
                ];
            }
        }
        else if (snapshot.needsRunLevel) {
            // replaceText 中不能包含脚注/公式占位符——它们是独立的 XML 元素，
            // 不在 w:t 文本节点中。写入前必须 strip，否则 doc.patch() 会产生乱码。
            editsForThis = [
                {
                    paraIdx: target.paraIdx,
                    start: target.detail.start,
                    end: target.detail.end,
                    replaceText: stripNonTextPlaceholders(replacement.suggested)
                }
            ];
        }
        else {
            // 普通段落：占位符若存在则是 w:t 里的字面文本，替换文案中保留原样
            editsForThis = [
                {
                    paraIdx: target.paraIdx,
                    start: target.detail.start,
                    end: target.detail.end,
                    replaceText: stripZeroWidth(replacement.suggested)
                }
            ];
        }
        // 两条不同原文的匹配区间在段内重叠时放弃后者（保留先定位到的替换）
        const overlaps = editsForThis.some(e => locatedEdits.some(prev => prev.paraIdx === e.paraIdx && prev.start < e.end && e.start < prev.end));
        if (overlaps) {
            unmatched.push(replacement);
            continue;
        }
        locatedEdits.push(...editsForThis);
        appliedCount += 1;
    }
    // ====== 应用阶段：按段落分组，段内按 start 排序做多点替换 ======
    const editsByPara = new Map();
    for (const edit of locatedEdits) {
        const list = editsByPara.get(edit.paraIdx) || [];
        list.push(edit);
        editsByPara.set(edit.paraIdx, list);
    }
    for (const [paraIdx, edits] of editsByPara) {
        const snapshot = snapshots[paraIdx];
        if (snapshot.needsRunLevel) {
            applyRunLevelEdits(snapshot, edits);
        }
        else {
            applyNormalEdits(snapshot, edits);
        }
    }
    if (appliedCount > 0) {
        doc.patch(tree);
    }
    await doc.saveAs(outputPath);
    console.log('[exportCorrectedDocx] export finished:', {
        inputPath,
        outputPath,
        totalReplacements: sanitizedReplacements.length,
        appliedCount,
        unmatchedCount: unmatched.length
    });
    return { appliedCount, unmatchedCount: unmatched.length };
}
