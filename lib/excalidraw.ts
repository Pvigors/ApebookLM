import { CHAT_MODEL, getOpenAI } from "./openai";
import { buildGenerationCorpus } from "./corpus";
import { GROUNDING_RULES } from "./grounding";
import { getNotebookDirective } from "./settings";
import { genHintText, type GenHint } from "./studio";
import { assertReadableMermaidTree, pruneMermaidTreeToCount } from "./excalidraw-graph";
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

// 画板(Excalidraw)生成器 —— 服务端只产出 Mermaid 语法 + 「节点→来源」归属。
// 关键架构:LLM 擅长写 Mermaid(纯文本),不擅长直接吐 Excalidraw 元素
// (精确坐标/绑定)。所以服务端只生成 Mermaid 并存进 studio_outputs.content
// 的信封 {mermaid, nodeSources},真正的 Mermaid→Excalidraw 转换在客户端
// ExcalidrawView 首次打开时做(parseMermaidToExcalidraw 依赖 DOM,无法在 Node 跑)。
// 因此本文件【绝不】import @excalidraw/* —— 那会把浏览器专用代码拖进 SSR。
//
// nodeSources:{ "<节点可见标签>": "<来源标题>" } —— 让查看器点节点即可回溯原文,
// 这是「来源驱动(grounded)」相对 Napkin/Excalidraw 的差异点。LLM 看到的语料按
// `# <来源标题>` 分块,故它能按标题归属。该字段可缺失/不全 —— 查看器优雅降级。

const PROMPT = `You turn the provided sources into ONE Excalidraw-ready Mermaid diagram, and attribute each node to the source it came from.
Reply in EXACTLY this format — a Mermaid block, then a line with three dashes + SOURCES, then a JSON object:

<mermaid block>
---SOURCES---
{ "<node label>": "<source title>", ... }

FOCUS (most important): if the user's 「额外要求」 narrows the scope (e.g. "只画研究目标" / a specific aspect,
section, goal, phase, role, or question), diagram ONLY that aspect and OMIT everything unrelated — even if the
sources cover far more. The 额外要求 OVERRIDES the default "cover all sources" behavior. With no 额外要求,
cover ALL provided sources: if they share a topic, diagram its core structure; if they are UNRELATED (several
different documents under separate "# <title>" blocks), SYNTHESIZE a REAL umbrella theme from what they actually
share (e.g. note-taking + time-management sources → 高效学习方法) as the root, then organize branches BY THEME so
every source's key ideas appear — never pick one source and ignore the rest.

LANGUAGE (hard rule): every label (root, nodes, edge labels) MUST use the EXACT language of the sources —
Simplified-Chinese sources → Simplified Chinese ONLY. NEVER drift into Japanese kanji variants (総覧/機構/設計/
対策/変換/実… are Japanese, NOT Simplified Chinese), never translate labels into another language.

FORBIDDEN meta-labels (instant failure): the root and branches must NEVER be catalog placeholders such as
资料总览 / 内容总览 / 內容概覽 / 来源汇总 / 各来源要点 / 文档列表 — always name the actual TOPIC. Likewise NEVER
structure the diagram as "one branch per source, labeled by source title" (目录式) — branches are THEMES drawn
from the content; one theme may combine evidence from several sources.

QUALITY (make it genuinely useful, not a flat outline):
- Mirror the source's REAL logic, not just its headings — e.g. 问题→成因→对策→效果, 目标→举措→结果,
  整体→组成→关系, or 流程的先后步骤. A reader should grasp the argument from the shape alone.
- Structure: a SINGLE root (the shared central topic — a synthesized REAL theme, see FORBIDDEN above) → 3–5 main
  branches → 1–3 SPECIFIC sub-points each (2–3 balanced levels, 10–16 nodes is the sweet
  spot). Don't leave a branch with a single child or pile everything on one branch.
- Labels must be SPECIFIC, substantive terms from the sources (e.g. "分层注意力增强"), never vague
  ("内容""方法""其他""分析"). Compress to ≤ 14 chars without losing meaning.
- Put a SHORT edge label (≤ 6 chars: 包含/导致/依赖/分为/对比/则/步骤…) only where it materially clarifies
  the parent→child relationship. Prefer writing secondary context into a node label over adding another edge.
- READABILITY CONTRACT (Beautiful Mermaid-inspired): the structure is a strict, single-root, top-down TREE.
  Every non-root node has exactly ONE parent and edge count = node count - 1. NO cross-branch edges, feedback
  edges, cycles, bidirectional edges, root-to-grandchild shortcuts, duplicate edges, or links that skip a layer.
  Keep siblings together under their parent so the renderer can align each layer without long return paths.

Rules for the Mermaid block:
- ONLY a single valid Mermaid block — no prose, no markdown fences, no citation markers.
- The block MUST start with exactly \`flowchart TD\`. 10–16 nodes BY DEFAULT — but if the user's 额外要求 / 补充说明 specifies an exact node/box count (e.g. 只画3个节点 / 正好5个方框), produce EXACTLY that many nodes, overriding this 10–16 default (down to a handful if asked).
- Model hierarchies as a top-down flowchart TREE (parent --> child). Do NOT use \`mindmap\` and do not add cross-links.
- Every node label is grounded in the sources and uses their dominant language; keep labels ≤ 14 chars.
- Do NOT use \`subgraph\`/\`end\`, \`style\`, \`classDef\`, \`class\`, \`click\`, or \`linkStyle\` — ONLY plain nodes
  and edges (these directives break the converter). NEVER put quotes (\`"\` \`'\`) or brackets \`()[]{}\`
  INSIDE a label — they break the parser. Write nicknames/titles as plain text: \`N7[蓝衣军团捧杯]\`,
  NOT \`N7["蓝衣军团"捧杯]\`.
- EVERY node MUST have an ID: write \`N1[label]\` — NEVER a bare quoted string as a node (e.g. \`A --> "text"\` is
  INVALID Mermaid and breaks the whole diagram; write \`A --> N1[text]\`). Do NOT put source attribution into the
  diagram as edges/nodes (no \`X -.->|Source| "..."\`) — source attribution goes ONLY in the SOURCES JSON below.
- Declare each node once, then write exactly ONE edge per line, grouped by parent from top layer to bottom layer.
  Never chain \`A --> B --> C\` on one line.
- CRITICAL: use ONLY flowchart/graph. NEVER mindmap / sequenceDiagram / classDiagram / gantt — only flowchart/graph
  convert to EDITABLE Excalidraw shapes; the others become a single non-editable blank image.

Rules for the SOURCES JSON:
- Map each node's EXACT visible label (verbatim, same characters as in the Mermaid) → the title of the \`# <title>\` source block it is grounded in.
- Use the source titles exactly as they appear after \`# \` in the provided sources. Omit a node if it has no clear single source.

${GROUNDING_RULES}`;

/** Pull out a clean Mermaid block: strip ```fences and any prose before the first diagram keyword. */
function extractMermaid(raw: string): string {
  const s = raw.trim().replace(/^```(?:mermaid)?\s*/i, "").replace(/```\s*$/i, "").trim();
  // 只认「行首」的图关键字(多行模式):否则前置一句 "Here is a flowchart:" 里的
  // "flowchart" 会被当成起点,把 prose 焊进 mermaid → parseMermaidToExcalidraw 抛异常 →
  // 永久坏板(报「无法转换为画板」)。
  const m = s.match(/^\s*(flowchart|graph|mindmap|sequenceDiagram|classDiagram|stateDiagram)\b[\s\S]*/mi);
  const block = (m ? m[0] : s)
    .split("\n")
    .filter((line) => !/^\s*%%/.test(line))
    .join("\n")
    .trim();
  // 标签体内的英文引号/括号是 Mermaid 语法炸弹(LLM 会把语料里的绰号引号原样搬进标签:
  // N9[德国7:1"桑巴惨案"] → 客户端 parseMermaidToExcalidraw 抛异常 → 板打不开)。
  // 落库前就替换成全角等价字符;客户端 sanitizeMermaid 有同款兜底(救存量)。
  const safeLabel = (body: string) => body
    .replace(/&/g, "＆")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/"/g, "”")
    .replace(/'/g, "’")
    .replace(/`/g, "｀");
  const quoted = block
    .replace(/\[([^\]]*)\]/g, (_m0, body: string) => `[${safeLabel(body)}]`)
    .replace(/\|([^|]*)\|/g, (_m0, body: string) => `|${safeLabel(body)}|`);
  return dropBrokenMermaidTail(quoted);
}

/** 残尾修剪:LLM 撞 max_tokens 会在任意位置硬截断(实锤案例:末行 `N118 --> N132[`,
 *  未闭合的 [ 让客户端 parseMermaidToExcalidraw 抛异常 → 整板「无法转换」死制品)。
 *  从尾部剔除「不完整」的行(括号不配对 / 边标签 | 不成对 / 悬空箭头结尾),直到遇到
 *  完整行。只修尾部,中间行不动。客户端 sanitizeMermaid 有同款(救存量坏板)。 */
function dropBrokenMermaidTail(src: string): string {
  const lines = src.split("\n");
  while (lines.length) {
    const t = lines[lines.length - 1].trim();
    if (!t) { lines.pop(); continue; }
    const opens = (t.match(/[[({]/g) || []).length;
    const closes = (t.match(/[\])}]/g) || []).length;
    const pipes = (t.match(/\|/g) || []).length; // 完整边标签 |…| 成对出现
    const dangling = opens !== closes || pipes % 2 === 1 || /[-.=]{2,}[>ox]?\s*$/.test(t);
    if (!dangling) break;
    lines.pop();
  }
  return lines.join("\n").trim();
}

/** Split the model output into the Mermaid block and the node→source map. The
 *  SOURCES JSON is best-effort: any parse failure degrades to an empty map. */
function splitMermaidAndSources(raw: string): { mermaid: string; nodeSources: Record<string, string> } {
  const idx = raw.search(/---\s*SOURCES\s*---/i);
  const mermaidPart = idx >= 0 ? raw.slice(0, idx) : raw;
  const srcPart = idx >= 0 ? raw.slice(idx).replace(/---\s*SOURCES\s*---/i, "") : "";
  const mermaid = extractMermaid(mermaidPart);
  const nodeSources: Record<string, string> = {};
  if (srcPart.trim()) {
    try {
      const m = srcPart.match(/\{[\s\S]*\}/);
      if (m) {
        const obj = JSON.parse(m[0]) as Record<string, unknown>;
        for (const [k, v] of Object.entries(obj)) {
          const key = String(k).trim();
          if (key && typeof v === "string" && v.trim()) nodeSources[key] = v.trim();
        }
      }
    } catch {
      /* best-effort: leave nodeSources empty */
    }
  }
  return { mermaid, nodeSources };
}

/** 样板/目录式元标签(含日文变体):不许当标题 —— prompt 已禁,这里是纵深防御。 */
const META_TITLE_RE = /总览|総覧|概览|概覧|汇总|彙総|一覧|来源|资料|資料|文档列表|overview/i;
/** 平假名(3040-309F)+ 片假名(30A0-30FF):检测「日文回归」—— 混着假名的标签必是日文,
 *  仅有汉字则可能是中文(不能误伤)。用户看到「ワールドカップの歴史的変遷」当标题就是这里没拦。 */
const JAPANESE_KANA_RE = /[぀-ヿ]/;

/** Derive a short title from the first NON-meta node label, else a sensible fallback.
 *  语料主导语言 = 中文时,含假名的日文标签整体拒收(纵深防御:prompt 已明说不许日文漂移,
 *  但 LLM ~5% 概率还是漂过去,尤其涉及跨文化题材如世界杯/奥运)。 */
function deriveTitle(mermaid: string, instruction?: string, corpusLang?: "zh" | "en" | "ja" | "other"): string {
  // 全局扫节点标签,跳过「资料总览」类元标签,取第一个真实主题词。
  const re = /[[({]\s*"?([^"\])}|>]{2,24})"?\s*[\])}]/g;
  let m: RegExpExecArray | null;
  let firstAny: string | null = null;
  const rejectJa = corpusLang === "zh" || corpusLang === "en";
  while ((m = re.exec(mermaid))) {
    const label = m[1]?.trim();
    if (!label) continue;
    if (rejectJa && JAPANESE_KANA_RE.test(label)) continue; // 日文假名标签整体拒收
    firstAny ??= label;
    if (!META_TITLE_RE.test(label)) return label.slice(0, 24);
  }
  const fromInstr = instruction?.trim().split(/\s+/).slice(0, 6).join(" ");
  return (fromInstr || firstAny || "画板").slice(0, 24);
}

/** 粗判语料主导语言:先片假名/平假名(日文标志)、再 CJK 汉字 vs ASCII 字母主导。 */
function detectCorpusLang(corpus: string): "zh" | "en" | "ja" | "other" {
  const sample = corpus.slice(0, 4000);
  let cjk = 0, ascii = 0, kana = 0;
  for (const ch of sample) {
    const c = ch.charCodeAt(0);
    if (c >= 0x3040 && c <= 0x30FF) kana++;
    else if (c >= 0x4E00 && c <= 0x9FFF) cjk++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) ascii++;
  }
  // 假名字符数 > 汉字的 15% → 视为日文语料;否则汉字/英文谁多算谁。
  if (kana > 0 && kana > cjk * 0.15) return "ja";
  if (cjk > ascii * 0.3) return "zh";
  if (ascii > 100) return "en";
  return "other";
}

function mermaidVisibleText(mermaid: string): string {
  const labels = [...mermaid.matchAll(/[\[({]\s*([^\])}\n]+?)\s*[\])}]/g)].map((match) => match[1]);
  const edges = [...mermaid.matchAll(/\|([^|\n]{1,24})\|/g)].map((match) => match[1]);
  return [...labels, ...edges].join("\n");
}

/** Eval entry: a fixed corpus in, a Mermaid block + node→source map out (one
 *  LLM attempt; caller retries). */
export async function mermaidFromCorpus(
  corpus: string,
  directive: string,
  opts?: GenHint,
  /** 截断输出(finish_reason=length)是否接受:首轮 false(重试,换小语料常能出正常
   *  规模的图),末轮 true(残尾修剪后能过门禁就收下 —— 大图总好过死制品)。 */
  acceptTruncated = true
): Promise<{ mermaid: string; nodeSources: Record<string, string> }> {
  if (!corpus) throw new Error("勾选的内容暂无可用文本,请换选来源/会话/笔记。");
  // Mermaid→Excalidraw 载体刻意禁止 style/classDef，客户端还会统一套固定主题。
  // 因此颜色要求在这里 fail closed，而不是让模型“答应”后生成一张完全没按颜色执行的图。
  if (requestedColorRequirements(opts?.instruction).length) {
    throw new Error("画板暂不支持自定义颜色，请改用“专业图表”生成");
  }
  const expectedNodes = requestedCount(opts?.instruction, [...DRAWING_NODE_COUNT_UNITS]);
  if (expectedNodes !== null && (expectedNodes < 3 || expectedNodes > 80)) {
    throw new Error("画板节点数量必须在 3–80 之间");
  }
  // ≥2 个来源块时前置一条最高优先级指令,压过下文「single root / 10–16 nodes」的单主题假设
  // (否则模型会挑一个最好画的来源、忽略其余)。语料块以 "\n\n---\n\n" 分隔。
  const srcCount = corpus.split(/\n\n---\n\n/).length;
  const multiSrc =
    srcCount >= 2
      ? `MULTI-SOURCE (highest priority): the corpus has ${srcCount} DISTINCT sources, each under its own "# <title>" block. The flowchart MUST cover key ideas from EVERY source. If they share a topic, build one connected flowchart around it. If they are UNRELATED, SYNTHESIZE a real umbrella theme from what they share as the root and organize branches BY THEME (a theme may combine several sources) — NEVER a catalog root like 资料总览 and NEVER one-branch-per-source labeled by source titles; never pick one source and drop the rest. (If 额外要求 names a specific source/aspect, cover only that.)\n\n`
      : "";
  // 具名化语言锁:prompt 里已说「用语料的语言」,但 LLM 遇跨文化题材(世界杯/奥运/动漫等
  // 中文语料含日语汉字借词)仍偶发漂日文(片假名+汉字混用,如「ワールドカップの歴史的変遷」)。
  // 显式给出「本次语料主导语言 = X」,压过 LLM 训练中的日文偏好。
  // 【回归修复】用户在生成弹窗显式选了输出语言(opts.language)时,锁必须锁「用户选的」
  // 而不是语料语言 —— 此前中文语料 + 选 English,顶部 system 硬锁(Simplified Chinese ONLY)
  // 压死了尾部的 outputLanguageClause,产物仍是中文。用户显式选择永远最高优先。
  const lang = detectCorpusLang(corpus);
  const userLang = opts?.language?.trim();
  const langLock = userLang
    ? `OUTPUT LANGUAGE = ${userLang} (explicitly chosen by the user — HIGHEST priority). Every node label, every edge label, and the root MUST be written in ${userLang}, regardless of the sources' language. Translate faithfully; never mix in other languages.\n\n`
    : lang === "zh"
      ? `CORPUS LANGUAGE = Simplified Chinese. Every node label, every edge label, and the root MUST be in Simplified Chinese. NEVER use Japanese katakana (ワ/ド/ス/ル etc.) or hiragana (の/は/を etc.) even for foreign proper nouns — use the Chinese rendering (e.g. 世界杯 not ワールドカップ, 历史演变 not 歴史的変遷).\n\n`
      : lang === "en"
      ? `CORPUS LANGUAGE = English. Every label MUST be in English.\n\n`
      : "";
  const res = await getOpenAI().chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.5,
    max_tokens: 2048,
    messages: [
      { role: "system", content: `${langLock}${multiSrc}${PROMPT}${studioInstructionClause(opts?.instruction)}` },
      { role: "user", content: `Sources:\n\n${corpus}${directive}${genHintText(opts)}` },
    ],
  });
  // 截断检测:模型失控超长(实锤:132 节点链式垃圾,prompt 要求 10–16)会撞
  // max_tokens 被硬切,尾部残行(如 `N118 --> N132[`)= 客户端转换必炸。
  // extractMermaid 已做残尾修剪保底;首轮仍主动重试 —— 换小语料通常能出正常规模的图。
  const truncated = res.choices[0]?.finish_reason === "length";
  if (truncated && !acceptTruncated) {
    throw new Error("生成画板失败,请重试。");
  }
  let { mermaid, nodeSources } = splitMermaidAndSources(res.choices[0]?.message?.content ?? "");
  // 结构门禁(喂上层 generateExcalidraw 的重试循环):客户端仅支持 flowchart/graph。
  // 此前唯一门禁是 length>=12 —— prose 整段回退、禁用图型(mindmap/sequence 等)、
  // 空骨架(仅 "flowchart TD")都能过 → ready 后客户端才发现「无法转换」= 死制品。
  // 行首图型 + ≥3 个节点定义 + ≥1 条边才放行。
  const validHead = /^\s*(flowchart|graph)\b/i.test(mermaid);
  let nodeCount = (mermaid.match(/\w+\s*[\[({]/g) || []).length;
  const edgeCount = (mermaid.match(/--|==>/g) || []).length;
  if (!mermaid || mermaid.length < 12 || !validHead || nodeCount < 3 || edgeCount < 1) {
    throw new Error("生成画板失败,请重试。");
  }
  if (expectedNodes !== null && nodeCount > expectedNodes) {
    mermaid = pruneMermaidTreeToCount(mermaid, expectedNodes);
    nodeCount = (mermaid.match(/\w+\s*[\[({]/g) || []).length;
  }
  if (expectedNodes !== null && nodeCount !== expectedNodes) {
    throw new Error(`生成画板未执行节点数量要求(要求 ${expectedNodes},实际 ${nodeCount})`);
  }
  const missing = missingSupportedVerbatimPhrases(mermaid, opts?.instruction, corpus);
  if (missing.length) throw new Error(`生成结果未执行“原样包含”要求:${missing[0]}`);
  const excluded = mentionedExcludedScopeTerms(mermaid, corpus, opts?.instruction);
  if (excluded.length) throw new Error(`生成结果包含已排除范围:${excluded[0]}`);
  const effectiveLanguage = resolveOutputLanguageRequirement(opts?.language, directive);
  const language = checkOutputLanguage(mermaidVisibleText(mermaid), effectiveLanguage);
  if (!language.ok) throw new Error(`生成画板未执行输出语言要求:${language.reason}`);
  assertReadableMermaidTree(mermaid);
  return { mermaid, nodeSources };
}

/**
 * DB-fronting wrapper used by jobs.ts. content = JSON.stringify({ mermaid,
 * nodeSources }) — a tiny envelope the client viewer converts to an Excalidraw
 * scene on first open (carrying nodeSources through so nodes stay clickable→来源).
 */
export async function generateExcalidraw(
  notebookId: string,
  sourceIds?: string[],
  opts?: GenHint
): Promise<{ title: string; content: string }> {
  if (requestedColorRequirements(opts?.instruction).length) {
    throw new Error("画板暂不支持自定义颜色，请改用“专业图表”生成");
  }
  const expectedNodes = requestedCount(opts?.instruction, [...DRAWING_NODE_COUNT_UNITS]);
  if (expectedNodes !== null && (expectedNodes < 3 || expectedNodes > 80)) {
    throw new Error("画板节点数量必须在 3–80 之间");
  }
  const directive = await getNotebookDirective(notebookId, opts?.memberId);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // 第二轮收缩语料预算(备用接口 TPM 限额低),与 slides/infographic 一致。
    // 检索 query:用户指令(若有,用于聚焦)+ 固定结构关键词锚定召回质量。
    // 注意:别让指令「替换」关键词 —— "只对研究目标进行画图" 这种指令式短语单独当 query 召回很差。
    const query = generationRetrievalQuery(
      opts?.instruction,
      "核心 目标 研究目标 主要分支 关键概念 步骤 关系 结构 流程"
    );
    const corpus = await buildGenerationCorpus(notebookId, query, sourceIds, {
      k: attempt === 0 ? 24 : 12,
    });
    if (!corpus) throw new Error("勾选的内容暂无可用文本,请换选来源/会话/笔记。");
    try {
      // 首轮不接受截断输出(重试换小语料再来);末轮接受(残尾修剪后过门禁即收)。
      const { mermaid, nodeSources } = await mermaidFromCorpus(corpus, directive, opts, attempt > 0);
      // 用「生效语言」参与标题选择:zh/en 时丢弃日文假名标签,防「ワールドカップ〜」这类
      // 混着假名的标签被 deriveTitle 顺手采纳(prompt 已禁,这里是纵深防御)。
      // 生效语言 = 用户显式选择(优先) > 语料主导语言 —— 用户选「日本語」时假名标签
      // 是合法产物,绝不能否决(否则标题永远兜底成「画板」)。
      const effLang = ((): "zh" | "en" | "ja" | "other" => {
        const ul = opts?.language?.trim() || "";
        if (/日本語|japanese/i.test(ul)) return "ja";
        if (/english/i.test(ul)) return "en";
        if (/中文|chinese/i.test(ul)) return "zh";
        return detectCorpusLang(corpus);
      })();
      return {
        title: deriveTitle(mermaid, opts?.instruction, effLang),
        content: JSON.stringify({ mermaid, nodeSources }),
      };
    } catch (e) {
      lastErr = e;
      console.warn(`[studio] excalidraw attempt ${attempt + 1} failed:`, (e as Error).message);
    }
  }
  if (lastErr instanceof Error) throw lastErr;
  throw new Error("生成画板失败,请重试。");
}
