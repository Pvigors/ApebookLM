// ---------------------------------------------------------------------------
// 服务端摄取入口(P0-2):把「URL → 抓取 → 判重 → 建源 → 分块嵌入 → 导读」抽成
// lib 级函数,供订阅轮询 worker(lib/jobs 的 feed_ingest)直接调用 —— 此前这条链
// 全部内联在 app/api/notebooks/[id]/sources/route.ts 的私有函数里,后台任务无法 import
// 路由文件。设计:docs/featured-subscription-design.md v2 §3.4。
//
// 与用户上传路径的差异(feed 语义):
//  - 正文上限 100_000 字(远低于用户档 2M):8MB 纯文本页按 2M 截断入库=单篇 1666 chunk,
//    配额闸拦不住体积 —— 对抗审查 econ-4。
//  - enrich 只做 sourceGuide(单篇导读),【不重写笔记本概览、不自动改名】:
//    概览重写会覆盖门面,且批量 N 篇=N 次概览 LLM 竞态(对抗审查实锤);
//    批级综述由每批一期的「更新简报」承担(lib/jobs feed_ingest 批尾)。
//  - 审计 actorKind='system'。
// ---------------------------------------------------------------------------
// 服务端专用(隔离由依赖链保证:import ./db(pg)/./rag,误进 client bundle 会构建失败;
// 不用 server-only 哨兵,原因见 lib/feeds.ts 头注)。
import { createHash } from "node:crypto";
import { extractUrl } from "./extract";
import { hasSubstance, looksBoilerplate } from "./corpus";
import { ingestSource, generateSourceGuide, generateSectionMap } from "./rag";
import {
  createSource,
  finalizeSource,
  findSourceByOrigin,
  listChunkHeads,
  setSourceContentHash,
  setSourcePages,
  setSourceGuide,
  setSourceOrigin,
  updateChunkSections,
} from "./db";
import { getNotebookDirective } from "./settings";
import { recordEvent } from "./activity";

/** feed 路径单篇正文上限(字符)。 */
export const FEED_MAX_RAW_CHARS = 100_000;

// 规范化 URL,作为去重键:补协议 + 小写 host + 去 fragment + 剥常见 tracking 参数
// + 按 key 排序剩余 query + 去尾斜杠。与 sources 路由共用同一实现(此前是路由私有函数)。
const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "ref", "ref_src", "spm", "from", "s",
];
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withProto);
    u.hostname = u.hostname.toLowerCase();
    u.hash = "";
    for (const k of TRACKING_PARAMS) u.searchParams.delete(k);
    const sorted = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const sp = new URLSearchParams();
    for (const [k, v] of sorted) sp.append(k, v);
    const qs = sp.toString();
    u.search = qs ? `?${qs}` : "";
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return withProto;
  }
}

export type AddUrlSourceResult =
  | { ok: true; sourceId: string; duplicate: boolean; title: string }
  | { ok: false; error: string; kind: "thin" | "fetch" | "ingest" };

/**
 * 服务端直接添加一个 URL 来源到笔记本(订阅轮询专用;不含用户配额/水印语义)。
 * 判重命中返回 duplicate=true(视作已入库,幂等);空壳正文返回 kind='thin'
 * (调用方应把 feed_item 标 skipped,【不重试】—— error 源每轮重抓的坑);
 * 抓取异常返回 kind='fetch'(瞬态,可下轮再试)。
 */
export async function addUrlSource(
  notebookId: string,
  url: string,
  opts?: { fallbackTitle?: string; maxChars?: number }
): Promise<AddUrlSourceResult> {
  const origin = normalizeUrl(url);
  const fetchUrl = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;

  // 判重在抓取之前:已见过的 origin 直接幂等返回,不花抓取/嵌入钱。
  const existing = await findSourceByOrigin(notebookId, origin);
  if (existing) return { ok: true, sourceId: existing.id, duplicate: true, title: existing.title };

  let title: string;
  let rawText: string;
  let pages = 0;
  try {
    const extracted = await extractUrl(fetchUrl);
    // PDF 直链的 extract 标题只是文件名兜底(RAND_RRA5013-1 之类):调用方给的
    // fallbackTitle(RSS/落地页真标题)信息量更高,PDF 场景反转优先级。
    const pdfLike = /\.pdf(\?|$)/i.test(fetchUrl);
    title = (pdfLike && opts?.fallbackTitle) || extracted.title || opts?.fallbackTitle || origin;
    rawText = extracted.text;
    pages = extracted.pages ?? 0; // PDF 页数(列表副标题「日期 · N 页」)
  } catch (err) {
    return { ok: false, error: (err as Error).message || "抓取失败", kind: "fetch" };
  }
  if (!hasSubstance(rawText) || looksBoilerplate(rawText)) {
    // 反爬占位页/纯导航页/存根页(如 RAND external_publications 期刊存根)—— 不入库
    // (空壳会诱导生成编造,有实锤案例;导航壳还会污染阅读器与检索)。
    return { ok: false, error: "未能提取到实质正文(可能为反爬页、纯导航页或期刊存根)", kind: "thin" };
  }
  const maxChars = opts?.maxChars ?? FEED_MAX_RAW_CHARS;
  if (rawText.length > maxChars) rawText = rawText.slice(0, maxChars);

  const source = await createSource(notebookId, title.slice(0, 200), "url");
  await setSourceOrigin(source.id, origin);
  await setSourceContentHash(source.id, createHash("sha256").update(rawText).digest("hex"));
  try {
    await ingestSource(source.id, notebookId, rawText, { authored: false });
  } catch (err) {
    const msg = (err as Error).message || "入库失败";
    await finalizeSource(source.id, { status: "error", error: msg });
    return { ok: false, error: msg, kind: "ingest" };
  }
  if (pages > 0) await setSourcePages(source.id, pages);

  // 单篇导读(同步做:批尾简报直接引用 guide.summary,不再等异步竞态)。
  // 公开频道:directive 的 memberId 恒 null —— 绝不注入任何人的私人上下文(不变量)。
  try {
    const directive = await getNotebookDirective(notebookId, null);
    const guide = await generateSourceGuide(title, rawText, directive);
    if (guide.summary || guide.key_topics.length) {
      await setSourceGuide(source.id, guide.summary, guide.key_topics);
    }
  } catch {
    /* 导读失败不阻断入库;简报侧会按「正文未能概括」诚实降级 */
  }

  // 章节打标(长文档才有意义):chunk 开头预览 → LLM 章节映射 → 回填 chunks.section。
  // 供只读查看器的双栏目录(方案 E)与检索签名共用;失败静默,目录是增强不是前提。
  try {
    const heads = await listChunkHeads(source.id);
    if (heads.length >= 4) {
      const map = await generateSectionMap(heads);
      if (map.length >= 2) await updateChunkSections(source.id, map);
    }
  } catch {
    /* 章节打标失败不阻断入库 */
  }

  await recordEvent({
    actorId: null,
    actorKind: "system",
    action: "feed.ingest",
    targetType: "source",
    targetId: source.id,
    notebookId,
    meta: { origin, title: title.slice(0, 120) },
  });
  return { ok: true, sourceId: source.id, duplicate: false, title };
}
