import { getSource, listSources, getNotebook } from "./db";
import { retrievePerSource } from "./rag";
import { extractTimelineEvidence } from "./timeline";
import type { SourcedTimelineEvidence } from "./timeline";
import type { RetrievedChunk } from "./types";
import { createHash } from "node:crypto";

export type GenerationCorpusBlock = {
  sourceId: string;
  sourceTitle: string;
  body: string;
};

export type GenerationCorpusBundle = {
  text: string;
  blocks: GenerationCorpusBlock[];
};

export type FrozenGenerationSource = Readonly<{
  id: string;
  title: string;
  content: string;
}>;

const serializeCorpusBlocks = (blocks: GenerationCorpusBlock[]) =>
  blocks.map((block) => `# ${block.sourceTitle}\n${block.body}`).join("\n\n---\n\n");

/** 乱码闸:GBK 等被错误解码的来源会含大量 U+FFFD,喂给模型只会污染输出。 */
function isGarbled(text: string): boolean {
  if (!text) return true;
  const repl = (text.match(/�/g) || []).length;
  return repl > 50 || repl / text.length > 0.02;
}

/**
 * 「无实质正文」闸:抓取失败的来源常把 URL 本身当正文存下(content ≈ 那串链接),
 * 或只剩极短残文。这种源喂给模型不是「无害」——模型会「按 URL / 标题猜内容」凭空
 * 编造(实测今日头条抓取失败→导图里生造出 "time management methodology" 分支)。
 * 整源剔除,宁可少一个来源也不喂空壳。
 *
 * 判据只看「去掉链接后还剩多少真实文字」,不设绝对长度地板 —— 抓取失败/URL 回显去链接
 * 后近乎为空;而用户手写的短笔记(哪怕一句中文定义)本就不含 URL,去链接后原样保留。
 * 用 <40 绝对门槛会误删这类合法短正文(对抗审查确认),故只拦「基本就是个链接/空壳」的源。
 */
export function hasSubstance(content: string): boolean {
  const t = (content || "").trim();
  if (!t) return false;
  const noUrls = t.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  return noUrls.length >= 10;
}

/** 「站点导航壳」闸:Readability 在无正文的存根页(如 RAND external_publications
 *  —— 期刊文章的落地存根,正文在付费期刊、rand.org 只挂导航框架)上解析失败时,
 *  退回全页会把整套站点导航当「正文」抓下来。这些框架短语真实文章正文从不出现,
 *  命中即判抓取失败(空壳)。句子密度识别不出(存根含摘要,密度反而偏高),
 *  唯有硬标记可靠。只扫开头 3000 字(导航永远在顶部),避免误伤正文里的偶发词。 */
export function looksBoilerplate(content: string): boolean {
  const sample = (content || "").slice(0, 6000);
  if (/Skip to (page|main) content|Site-wide navigation|Toggle Menu|请开启\s*JavaScript\b/i.test(sample)) {
    return true;
  }

  // 中文高校/政务站常把整套栏目导航当正文返回，且没有 RAND 那类稳定
  // 英文框架标记。生产实锤形态是“首页 新闻动态 通知公告 学院概况 …
  // 当前位置 地址 Copyright”，数百字却没有一条可陈述事实。要求同时
  // 命中大量导航标签且找不到正常长句，避免误伤带站点页眉的真实文章。
  const normalized = sample.normalize("NFKC").replace(/\s+/g, " ").trim();
  const navPattern = /(?:网站)?首页|新闻动态|通知公告|学院概况|组织结构|师资队伍|人才培养|研究生招生|学生工作|党团建设|党建动态|工会风采|校友动态|校友捐赠|办公服务|行政办公|规章制度|常用下载|办事流程|办事指南|会议室预定|当前位置|导航菜单|联系我们|网站地图|政务公开|政务服务|互动交流|组织机构|政策法规|统计数据|专题专栏|领导信息|部门动态|信息公开|在线服务|Copyright|All Rights Reserved/gi;
  const navHits = normalized.match(navPattern)?.length ?? 0;
  if (navHits < 8) return false;
  const proseCue = /(?:应当|应该|应|须|必须|不得|需要|要求|规定|用于|用来|可以|能够|包括|包含|说明|记录|校准|验证|确保|建议|采用|形成|影响|表明|显示|发布|实施|适用于|支持|提供|完成|建立|保持|核对|回溯|定义|指出)|\b(?:must|should|requires?|provides?|states?|includes?|supports?|ensures?|defines?|describes?|is|are)\b/i;
  const stripShellLabels = (part: string) => part
    .replace(navPattern, " ")
    .replace(/(?:当前位置|地址[:：][^，。；;]{0,80}|反馈意见[:：][^，。；;]{0,80}|Copyright|All R+ights Reserved|版权所有|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 任何独立、带终止标点的非壳事实句都算正文；无需依赖封闭动词词表。
  // 这保住“摘要分中文和英文。关键词三至五个。”等短定义/名词句。
  const hasFactualSentence = sample
    .split(/[\r\n]+/)
    .flatMap((line) => line.match(/[^。！？!?.]+[。！？!?.]+/g) || [])
    .some((part) => {
      if (/(?:地址[:：]|反馈意见[:：]|Copyright|All R+ights Reserved|版权所有)/i.test(part)) return false;
      if ((part.match(navPattern)?.length ?? 0) > 2) return false;
      return stripShellLabels(part).replace(/\s+/g, "").length >= 10;
    });
  if (hasFactualSentence) return false;
  const proseSentences = sample
    .split(/[\r\n]+|[。！？!?.]+/)
    .map((part) => part.normalize("NFKC").replace(/\s+/g, " ").trim())
    .filter((part) => {
      const stripped = stripShellLabels(part);
      const compact = stripped.replace(/\s+/g, "");
      if (compact.length < 10) return false;
      const structuredFact = /\d{4}\s*年(?:\s*\d{1,2}\s*月)?(?:\s*\d{1,2}\s*[日号])?|(?:是|为|指|即|定于|截至|截止)|[:：].{2,}(?:、|，|,)/.test(stripped);
      return proseCue.test(stripped) || structuredFact || (compact.length >= 50 && /[，,；;]/.test(stripped));
    });
  return proseSentences.length === 0;
}

/** 超长来源不要只取开头(常是导航/目录/引言);改为 头 + 中 + 尾 均匀采样,
 *  让模型看到全文的不同部位而非仅文档前缀。 */
function sampleContent(content: string, budget: number): string {
  if (content.length <= budget) return content;
  const seg = Math.floor(budget / 3);
  const head = content.slice(0, seg);
  const ms = Math.max(seg, Math.floor(content.length / 2 - seg / 2));
  const mid = content.slice(ms, ms + seg);
  const tail = content.slice(content.length - seg);
  return `${head}\n……\n${mid}\n……\n${tail}`;
}

function frozenQueryTokens(query: string): string[] {
  const normalized = query.normalize("NFKC").toLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}|[a-z][a-z0-9_-]{1,}|\d+(?:\.\d+)?/giu)) {
    const token = match[0];
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 4) {
      for (let index = 0; index < token.length - 1; index++) tokens.add(token.slice(index, index + 2));
    } else {
      tokens.add(token);
    }
  }
  for (const token of ["建模", "尺寸", "长度", "宽度", "高度", "厚度", "孔径", "直径", "部件", "装配", "材料", "公差"]) {
    tokens.add(token);
  }
  return [...tokens].slice(0, 128);
}

function frozenWindows(content: string, size = 1_800, overlap = 240): Array<{ index: number; body: string }> {
  const windows: Array<{ index: number; body: string }> = [];
  const step = Math.max(400, size - overlap);
  for (let offset = 0, index = 0; offset < content.length; offset += step, index++) {
    const body = content.slice(offset, Math.min(content.length, offset + size)).trim();
    if (body) windows.push({ index, body });
  }
  return windows;
}

/**
 * CAD v3 冻结语料构建：只消费首次 planHash 复核时读到的 sources.content，
 * 绝不再读 live chunks 或 live source。这样证据哈希与 provider 真正看到的文本
 * 是同一份快照，关闭 content/chunks 更新窗口及 A→B→A 的 TOCTOU。
 */
export function buildFrozenGenerationCorpusBundle(
  sources: readonly FrozenGenerationSource[],
  query: string,
  opts?: { k?: number; maxTotal?: number; perSource?: number }
): GenerationCorpusBundle {
  const seen = new Set<string>();
  const docs = sources.flatMap((source) => {
    const content = source.content.trim();
    if (!content || isGarbled(content) || !hasSubstance(content) || looksBoilerplate(content)) return [];
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    if (seen.has(hash)) return [];
    seen.add(hash);
    return [{ id: source.id, title: source.title, content }];
  });
  if (!docs.length) return { text: "", blocks: [] };

  const tokens = frozenQueryTokens(query);
  const maxChunks = Math.max(docs.length, Math.min(64, Math.floor(opts?.k ?? 24)));
  const perDocChunks = Math.max(1, Math.ceil(maxChunks / docs.length));
  const maxTotal = opts?.maxTotal ?? 80_000;
  const perSource = opts?.perSource ?? Math.max(1_000, Math.floor(maxTotal / docs.length));
  const blocks: GenerationCorpusBlock[] = [];
  let total = 0;
  for (const doc of docs) {
    const ranked = frozenWindows(doc.content).map((window) => {
      const normalized = window.body.normalize("NFKC").toLowerCase();
      const tokenScore = tokens.reduce((score, token) => score + (normalized.includes(token) ? 2 : 0), 0);
      const dimensionScore = (normalized.match(/\d+(?:\.\d+)?\s*(?:mm|毫米|cm|厘米|m|米|in|英寸)?/g)?.length ?? 0) * 3;
      const targetScore = /(?:建模目标|设计对象|设计要求|规格书|参数表)/.test(normalized) ? 8 : 0;
      return { ...window, score: tokenScore + dimensionScore + targetScore };
    });
    const selected = ranked
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, perDocChunks)
      .sort((left, right) => left.index - right.index);
    const raw = selected.map((entry) => entry.body).join("\n……\n");
    const budget = Math.min(perSource, maxTotal - total);
    if (budget <= 0) break;
    const body = sampleContent(raw, budget);
    if (!hasSubstance(body) || looksBoilerplate(body)) continue;
    blocks.push({ sourceId: doc.id, sourceTitle: doc.title, body });
    total += Math.min(raw.length, budget);
  }
  return { text: serializeCorpusBlocks(blocks), blocks };
}

/**
 * Concatenate the (selected or all-ready) source texts into one context blob.
 * 仅作「无 embedding / 检索不可用」时的兜底 —— 生成请优先用 buildGenerationCorpus。
 * 已加固:按勾选过滤、去重、乱码闸、按来源数均分预算、长文头中尾采样。
 */
async function buildCorpusBundle(
  notebookId: string,
  sourceIds?: string[],
  opts?: { maxTotal?: number; perSource?: number }
): Promise<GenerationCorpusBundle> {
  const maxTotal = opts?.maxTotal ?? 80000;
  const all = (await listSources(notebookId)).filter((s) => s.status === "ready");
  // 没传 sourceIds 时只取「已勾选」的来源(与 getNotebookChunks 的 selected 过滤一致),
  // 避免用户取消勾选的来源仍被喂进模型。
  const chosen =
    sourceIds && sourceIds.length
      ? all.filter((s) => sourceIds.includes(s.id))
      : all.filter((s) => s.selected);

  const seen = new Set<string>();
  const docs: { id: string; title: string; content: string }[] = [];
  for (const s of chosen) {
    const content = (await getSource(s.id))?.content?.trim();
    if (!content || isGarbled(content) || !hasSubstance(content) || looksBoilerplate(content)) continue; // 跳过空 / 乱码 / URL 回显 / 导航壳来源
    const key = createHash("sha256").update(content, "utf8").digest("hex");
    if (seen.has(key)) continue;
    seen.add(key);
    docs.push({ id: s.id, title: s.title, content });
  }
  if (!docs.length) return { text: "", blocks: [] };

  // 按来源数均分预算,避免「最早几篇吃光预算、后续整篇被丢」。
  const perSource = opts?.perSource ?? Math.max(1_000, Math.floor(maxTotal / docs.length));
  const blocks: GenerationCorpusBlock[] = [];
  let total = 0;
  for (const d of docs) {
    const budget = Math.min(perSource, maxTotal - total);
    if (budget <= 0) break;
    blocks.push({
      sourceId: d.id,
      sourceTitle: d.title,
      body: sampleContent(d.content, budget),
    });
    total += Math.min(d.content.length, budget);
  }
  return { text: serializeCorpusBlocks(blocks), blocks };
}

export async function buildCorpus(
  notebookId: string,
  sourceIds?: string[],
  opts?: { maxTotal?: number; perSource?: number }
): Promise<string> {
  return (await buildCorpusBundle(notebookId, sourceIds, opts)).text;
}

/**
 * Timeline-specific corpus: scan the selected source BODY instead of semantic
 * snippets, and pass only sentences that explicitly contain a calendar date.
 * Source titles remain attribution labels and are never date evidence.
 */
export async function buildTimelineCorpus(
  notebookId: string,
  selectedIds?: string[]
): Promise<string> {
  const evidence = await buildTimelineEvidence(notebookId, selectedIds);
  const bySource = new Map<string, SourcedTimelineEvidence[]>();
  for (const item of evidence) {
    const group = bySource.get(item.sourceId) ?? [];
    group.push(item);
    bySource.set(item.sourceId, group);
  }
  return [...bySource.values()]
    .map((items) =>
      `# ${items[0].sourceTitle}\n${items
        .map((item) => `[证据:${item.evidenceId}] ${item.date}｜${item.excerpt}`)
        .join("\n")}`
    )
    .join("\n\n---\n\n");
}

/** Structured timeline evidence is the production source of truth. The model
 * never receives authority to rewrite its date, event text or source label. */
export async function buildTimelineEvidence(
  notebookId: string,
  selectedIds?: string[]
): Promise<SourcedTimelineEvidence[]> {
  const all = (await listSources(notebookId)).filter((source) => source.status === "ready");
  const realIds = selectedIds?.filter((id) => id && !id.startsWith("__"));
  if (selectedIds !== undefined && !realIds?.length) return [];
  const chosen = realIds?.length
    ? all.filter((source) => realIds.includes(source.id))
    : all.filter((source) => source.selected);
  const gathered: SourcedTimelineEvidence[] = [];
  for (const source of chosen) {
    const content = (await getSource(source.id))?.content?.trim() ?? "";
    if (!content || isGarbled(content) || !hasSubstance(content) || looksBoilerplate(content)) continue;
    for (const [index, item] of extractTimelineEvidence(content, 200).entries()) {
      gathered.push({
        ...item,
        evidenceId: `${source.id}:${index + 1}`,
        sourceId: source.id,
        sourceTitle: source.title,
      });
    }
  }
  return gathered
    .sort((a, b) => a.sortKey - b.sortKey || a.evidenceId.localeCompare(b.evidenceId))
    .slice(0, 200);
}

/**
 * 生成取材:用项目已有的混合检索(向量 + BM25 + MMR)按本次生成的主题,
 * 跨「全部勾选来源、全篇」挑出最相关、彼此不重复的片段拼成语料 —— 而不是只取每篇开头。
 * 这是修复「输出无逻辑 / 取材不准」的核心:模型看到的是与主题对齐的关键内容,
 * 而非「最早添加来源的前几千字」。检索不可用(无 embedding)时回退加固版 buildCorpus。
 * 取材统一只基于「来源」:历史遗留的合成 id(__chat__/__notes__)一律忽略。
 */
export async function buildGenerationCorpusBundle(
  notebookId: string,
  query: string,
  selectedIds?: string[],
  opts?: { k?: number; maxTotal?: number; perSource?: number }
): Promise<GenerationCorpusBundle> {
  // 只认真实来源 id;丢弃任何遗留的合成项(以 "__" 开头),保证取材统一来自来源。
  const ids = Array.isArray(selectedIds) ? selectedIds.filter((i) => i && !i.startsWith("__")) : [];
  // 用笔记本标题给检索 query 锚定主题,提升相关性命中。
  const nb = await getNotebook(notebookId);
  const q = [nb?.title, query].filter(Boolean).join(" ").trim() || query || "核心内容 主要观点";
  let chunks: RetrievedChunk[] = [];
  try {
    // 按来源均衡召回:每个选中来源都取其最相关片段,保证全部来源被代表。
    chunks = await retrievePerSource(notebookId, q, opts?.k ?? 24, ids.length ? ids : undefined);
  } catch {
    chunks = [];
  }
  chunks = chunks.filter((c) => !isGarbled(c.content)); // 丢弃乱码片段
  if (chunks.length) {
    // 按来源聚合(组内按原文顺序、组间按该来源最佳相关度),便于模型理解上下文。
    const bySrc = new Map<string, { sourceId: string; title: string; best: number; items: RetrievedChunk[] }>();
    for (const c of chunks) {
      const g = bySrc.get(c.source_id) ?? {
        sourceId: c.source_id,
        title: c.source_title,
        best: -Infinity,
        items: [],
      };
      if (c.score > g.best) g.best = c.score;
      g.items.push(c);
      bySrc.set(c.source_id, g);
    }
    const groups = [...bySrc.values()].sort((a, b) => b.best - a.best);
    const maxTotal = opts?.maxTotal ?? 80_000;
    const perSource = opts?.perSource ?? Math.max(1_000, Math.floor(maxTotal / groups.length));
    const blocks: GenerationCorpusBlock[] = [];
    let total = 0;
    for (const group of groups) {
      const budget = Math.min(perSource, maxTotal - total);
      if (budget <= 0) break;
      group.items.sort((a, b) => a.chunk_index - b.chunk_index);
      const raw = group.items.map((chunk) => chunk.content.trim()).join("\n……\n");
      const body = sampleContent(raw, budget);
      // 抓取失败只剩 URL 的来源即便被检索到,也整块剔除,避免模型按 URL 猜内容。
      if (!hasSubstance(body) || looksBoilerplate(body)) continue;
      blocks.push({ sourceId: group.sourceId, sourceTitle: group.title, body });
      total += Math.min(raw.length, budget);
    }
    if (blocks.length) return { text: serializeCorpusBlocks(blocks), blocks };
    // 检索命中的全是空壳 → 落到下方 buildCorpus 兜底(也会再过滤一次)。
  }
  // 无 embedding / 检索失败 → 回退加固版 buildCorpus(仍只取来源)。
  return await buildCorpusBundle(notebookId, ids.length ? ids : undefined, opts);
}

export async function buildGenerationCorpus(
  notebookId: string,
  query: string,
  selectedIds?: string[],
  opts?: { k?: number; maxTotal?: number; perSource?: number }
): Promise<string> {
  return (await buildGenerationCorpusBundle(notebookId, query, selectedIds, opts)).text;
}
