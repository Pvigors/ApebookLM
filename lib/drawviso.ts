import { CHAT_MODEL, getOpenAI } from "./openai";
import { buildGenerationCorpus } from "./corpus";
import { GROUNDING_RULES } from "./grounding";
import { getNotebookDirective } from "./settings";
import { genHintText, type GenHint } from "./studio";
import {
  checkOutputLanguage,
  DRAWING_NODE_COUNT_UNITS,
  generationRetrievalQuery,
  mentionedExcludedScopeTerms,
  missingSupportedVerbatimPhrases,
  requestedColorRequirements,
  requestedCount,
  resolveOutputLanguageRequirement,
  studioInstructionClause,
} from "./generation-contract";

// Drawviso —— 专业图表生成器(draw.io/mxGraph 路线 B)。
// 与画板(excalidraw,LLM→Mermaid→手绘风)互补:LLM 直接产 mxGraphModel XML,
// 样式/颜色/泳道全可控,面向「架构图 / 分层流程 / 泳道图」这类正式配图。
//
// 【安全与鲁棒的核心:确定性重建】LLM 输出的 XML **永远不直接进 DOM**:
// 服务端逐 <mxCell> 正则提取 → 字段白名单校验(style 字符白名单天然杀掉
// javascript:/url()/尖括号;label 重建时转义)→ 用我们自己的序列化器重新拼出
// 规范 XML。结构性坏输出(缺 root/悬空边/截断残尾)在重建时自动脱落——
// 与 mermaid 残尾修剪同一范式:prompt 禁令只能降频,确定性 sanitize 才是本命。
//
// content 信封:JSON.stringify({ xml, nodeSources })。nodeSources 与画板同约定
// (节点可见标签 → 来源标题),查看器点节点回溯原文 —— grounded 差异点不丢。

const PROMPT = `You turn the provided sources into ONE professional diagram as draw.io (mxGraph) XML, and attribute each node to the source it came from.
Reply in EXACTLY this format — an XML block, then a line with three dashes + META, then a JSON object:

<mxGraphModel dx="800" dy="600" grid="0" page="0">
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
    <mxCell id="n1" value="节点标签" style="rounded=1;whiteSpace=wrap;html=0;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
      <mxGeometry x="40" y="40" width="180" height="60" as="geometry" />
    </mxCell>
    <mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=0;" edge="1" parent="1" source="n1" target="n2">
      <mxGeometry relative="1" as="geometry" />
    </mxCell>
  </root>
</mxGraphModel>
---META---
{ "title": "<diagram title, ≤16 chars, sources' language>", "nodeSources": { "<node label>": "<source title>", ... } }

DIAGRAM TYPE — pick what fits the content (or what 额外要求 asks for):
- 架构图 (layered architecture): horizontal layers top-to-bottom, one row per layer, components as boxes in the row.
- 流程图 (flow): steps left-to-right or top-to-bottom with orthogonal edges; branches allowed.
- 泳道图 (swimlane): vertical lanes via style "swimlane;horizontal=0;..." vertices sized to contain children; children use parent="<laneId>" and coordinates RELATIVE to the lane.

LAYOUT (hard rules — you must emit explicit coordinates):
- Canvas grid: columns at x = 40 + col*220, rows at y = 40 + row*120. Default node size width=180 height=60 (lanes/containers may be bigger).
- NO overlapping boxes. Keep the whole diagram within x∈[0,1800], y∈[0,1400].
- 6–18 vertices BY DEFAULT; if 额外要求 specifies an exact count, produce EXACTLY that many.
- Every edge MUST reference existing vertex ids via source/target. Sequential ids: n1,n2,… for vertices, e1,e2,… for edges.

STYLE (this generator's strength — colors are ALLOWED and encouraged):
- Vertices: rounded=1;whiteSpace=wrap;html=0; plus a palette pair fillColor/strokeColor. Palette (pick by MEANING, group same-category nodes with the same color):
  blue #dae8fc/#6c8ebf · green #d5e8d4/#82b366 · orange #ffe6cc/#d79b00 · yellow #fff2cc/#d6b656 · red #f8cecc/#b85450 · purple #e1d5e7/#9673a6 · gray #f5f5f5/#666666
- Edges: edgeStyle=orthogonalEdgeStyle;rounded=1;html=0; optional short value label (≤6 chars).
- If 额外要求 asks for specific colors/theme, OBEY it exactly (that's what this artifact is for).
- Do NOT use images, links, html=1, or shape=mxgraph.* stencils — only plain vertices/edges/swimlanes.

CONTENT:
- Labels are SPECIFIC, substantive terms from the sources (≤ 16 chars), in the sources' dominant language; never vague placeholders (内容/其他/模块A) and never catalog roots (资料总览/来源汇总).
- Mirror the sources' REAL logic (分层/流程先后/职责泳道); a reader should grasp the structure at a glance.
- META.nodeSources: map each node's EXACT visible label → the \`# <title>\` source block it came from; omit unclear ones.

${GROUNDING_RULES}`;


import {
  applyDrawvisoColorRequirements,
  ensureDrawvisoLayout,
  graphToXml,
  rebuildDrawioXml,
  xmlToGraph,
} from "./drawviso-graph";
export type { DrawvisoShape, DrawvisoNode, DrawvisoEdge, DrawvisoGraph } from "./drawviso-graph";
export { xmlToGraph, graphToXml } from "./drawviso-graph";

/** 元标签黑名单(与画板同源的样板病纵深防御)。 */
const META_TITLE_RE = /总览|総覧|概览|概覧|汇总|彙総|一覧|来源|资料|資料|文档列表|overview/i;

function splitXmlAndMeta(raw: string): { xmlRaw: string; title: string; nodeSources: Record<string, string> } {
  const idx = raw.search(/---\s*META\s*---/i);
  const xmlRaw = idx >= 0 ? raw.slice(0, idx) : raw;
  let title = "";
  const nodeSources: Record<string, string> = {};
  if (idx >= 0) {
    try {
      const m = raw.slice(idx).match(/\{[\s\S]*\}/);
      if (m) {
        const obj = JSON.parse(m[0]) as { title?: unknown; nodeSources?: Record<string, unknown> };
        if (typeof obj.title === "string") title = obj.title.trim().slice(0, 24);
        for (const [k, v] of Object.entries(obj.nodeSources ?? {})) {
          if (k.trim() && typeof v === "string" && v.trim()) nodeSources[k.trim()] = v.trim();
        }
      }
    } catch { /* best-effort */ }
  }
  return { xmlRaw, title, nodeSources };
}

/** 单次 LLM 尝试:语料入、{xml,title,nodeSources} 出;结构门禁不过则抛错(上层重试)。 */
export async function drawvisoFromCorpus(
  corpus: string,
  directive: string,
  opts?: GenHint,
  acceptTruncated = true
): Promise<{ xml: string; title: string; nodeSources: Record<string, string> }> {
  if (!corpus) throw new Error("勾选的内容暂无可用文本,请换选来源/会话/笔记。");
  const expectedNodes = requestedCount(opts?.instruction, [...DRAWING_NODE_COUNT_UNITS]);
  if (expectedNodes !== null && (expectedNodes < 3 || expectedNodes > 80)) {
    throw new Error("专业图表节点数量必须在 3–80 之间");
  }
  const srcCount = corpus.split(/\n\n---\n\n/).length;
  const multiSrc =
    srcCount >= 2
      ? `MULTI-SOURCE (highest priority): the corpus has ${srcCount} DISTINCT sources under "# <title>" blocks. The diagram MUST cover key ideas from EVERY source (group by THEME, never one-box-per-source named by source titles). If 额外要求 narrows the scope, cover only that.\n\n`
      : "";
  // 语言锁:用户显式选择永远最高优先(教训见 8441c96 —— 按语料硬锁会压死用户选择)。
  const userLang = opts?.language?.trim();
  const langLock = userLang
    ? `OUTPUT LANGUAGE = ${userLang} (explicitly chosen by the user — HIGHEST priority). Every node label, lane title, edge label and the META title MUST be in ${userLang}.\n\n`
    : "";
  const res = await getOpenAI().chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.4,
    max_tokens: 3072,
    messages: [
      { role: "system", content: `${langLock}${multiSrc}${PROMPT}${studioInstructionClause(opts?.instruction)}` },
      { role: "user", content: `Sources:\n\n${corpus}${directive}${genHintText(opts)}` },
    ],
  });
  if (res.choices[0]?.finish_reason === "length" && !acceptTruncated) {
    throw new Error("生成专业图表失败,请重试。");
  }
  const raw = res.choices[0]?.message?.content ?? "";
  const { xmlRaw, title, nodeSources } = splitXmlAndMeta(raw);
  const rebuilt = rebuildDrawioXml(xmlRaw);
  const { vertexCount, edgeCount, labels } = rebuilt;
  // 结构门禁(对齐画板):节点太少/无边/全空标签 = 劣质或失败,抛给重试环。
  if (vertexCount < 3 || edgeCount < 1 || labels.length < 3) {
    throw new Error("生成专业图表失败,请重试。");
  }
  if (expectedNodes !== null && vertexCount !== expectedNodes) {
    throw new Error(`生成专业图表未执行节点数量要求(要求 ${expectedNodes},实际 ${vertexCount})`);
  }
  const colorRequirements = requestedColorRequirements(opts?.instruction);
  const colored = applyDrawvisoColorRequirements(xmlToGraph(rebuilt.xml), colorRequirements);
  if (colored.unmatchedTargets.length) {
    throw new Error(`生成专业图表未找到颜色要求对应节点:${colored.unmatchedTargets[0]}`);
  }
  const laidOut = ensureDrawvisoLayout(colored.graph);
  if (laidOut.issues.length) {
    throw new Error(`生成专业图表布局无效:${laidOut.issues[0]}`);
  }
  const xml = graphToXml(laidOut.graph);
  // 序列化会再次经过 style 白名单；重新解析后核对颜色，避免模型或清洗器静默吞色。
  const roundTripped = xmlToGraph(xml);
  const reapplied = applyDrawvisoColorRequirements(roundTripped, colorRequirements);
  if (
    reapplied.unmatchedTargets.length ||
    reapplied.graph.nodes.some((node, index) =>
      node.fill.toLowerCase() !== roundTripped.nodes[index]?.fill.toLowerCase() ||
      node.stroke.toLowerCase() !== roundTripped.nodes[index]?.stroke.toLowerCase()
    )
  ) {
    throw new Error("生成专业图表未执行颜色要求");
  }
  const missing = missingSupportedVerbatimPhrases(`${xml}\n${labels.join("\n")}`, opts?.instruction, corpus);
  if (missing.length) throw new Error(`生成结果未执行“原样包含”要求:${missing[0]}`);
  const excluded = mentionedExcludedScopeTerms(`${xml}\n${labels.join("\n")}`, corpus, opts?.instruction);
  if (excluded.length) throw new Error(`生成结果包含已排除范围:${excluded[0]}`);
  const effectiveLanguage = resolveOutputLanguageRequirement(opts?.language, directive);
  const language = checkOutputLanguage(`${title}\n${labels.join("\n")}`, effectiveLanguage);
  if (!language.ok) throw new Error(`生成专业图表未执行输出语言要求:${language.reason}`);
  const finalTitle =
    (title && !META_TITLE_RE.test(title) && title) ||
    labels.find((l) => !META_TITLE_RE.test(l))?.slice(0, 24) ||
    "专业图表";
  return { xml, title: finalTitle, nodeSources };
}

/** jobs.ts 入口:content = JSON.stringify({ xml, nodeSources })。 */
export async function generateDrawviso(
  notebookId: string,
  sourceIds?: string[],
  opts?: GenHint
): Promise<{ title: string; content: string }> {
  const directive = await getNotebookDirective(notebookId, opts?.memberId);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const query = generationRetrievalQuery(
      opts?.instruction,
      "架构 分层 组成 模块 流程 步骤 角色 职责 关系 结构"
    );
    const corpus = await buildGenerationCorpus(notebookId, query, sourceIds, {
      k: attempt === 0 ? 24 : 12,
    });
    if (!corpus) throw new Error("勾选的内容暂无可用文本,请换选来源/会话/笔记。");
    try {
      // 首轮不接受截断(重试换小语料);末轮接受(重建器已把残尾 cell 自然丢弃)。
      const r = await drawvisoFromCorpus(corpus, directive, opts, attempt > 0);
      return { title: r.title, content: JSON.stringify({ xml: r.xml, nodeSources: r.nodeSources }) };
    } catch (e) {
      lastErr = e;
      console.warn(`[studio] drawviso attempt ${attempt + 1} failed:`, (e as Error).message);
    }
  }
  if (lastErr instanceof Error) throw lastErr;
  throw new Error("生成专业图表失败,请重试。");
}
