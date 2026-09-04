import { CHAT_MODEL, getOpenAI } from "./openai";
import { decodeEntities, extractUrl } from "./extract";
import { getSetting } from "./db";
import {
  buildDiscoveryReferences,
  discoveryReferenceIndex,
  type DiscoveryReference,
} from "./discovery-report";

// 搜索源 key「库优先、回退 env」:后台 API 配置页保存即生效。
const tavilyKey = async () => (await getSetting("search.tavily.key")) || process.env.TAVILY_API_KEY || "";
const bochaKey = async () => (await getSetting("search.bocha.key")) || process.env.BOCHA_API_KEY || "";
const zhipuKey = async () => (await getSetting("search.zhipu.key")) || process.env.ZHIPU_SEARCH_KEY || "";
const serperKey = async () => (await getSetting("search.serper.key")) || process.env.SERPER_API_KEY || "";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// reason:精排 LLM 顺带产出的一句「为什么值得看」(用户视角,≤40 字);缺失不影响结果保留。
// type:按 URL 特征标注的来源类型(cleanDiscoveries 统一打标,供前端筛选展示);缺省按 article 看待。
export type Discovery = { title: string; url: string; snippet: string; date?: string; reason?: string; type?: "pdf" | "video" | "article" };

type WebSearchDepth = "basic" | "advanced";
type SearchRunState = { tavilyUnavailable?: boolean };
type WebSearchOptions = { freshness?: string; depth?: WebSearchDepth; state?: SearchRunState };

/** 既有规划档位 → Tavily 官方 time_range。oneDay 由实时聊天兜底使用。 */
export function tavilyTimeRange(freshness?: string): "day" | "week" | "month" | "year" | undefined {
  if (freshness === "oneDay") return "day";
  if (freshness === "oneWeek") return "week";
  if (freshness === "oneMonth") return "month";
  if (freshness === "oneYear") return "year";
  return undefined;
}

function normalizeDiscoveryDate(raw: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : undefined;
}

/** Tavily 主搜索。快速检索用 basic；深度研究显式传 advanced。 */
async function tavilySearch(
  query: string,
  limit: number,
  key: string,
  opts?: WebSearchOptions
): Promise<Discovery[]> {
  const searchDepth = opts?.depth ?? "basic";
  const timeRange = tavilyTimeRange(opts?.freshness);
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: query.slice(0, 1500),
      search_depth: searchDepth,
      max_results: Math.min(Math.max(1, limit), 20),
      topic: "general",
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_usage: false,
      ...(searchDepth === "advanced" ? { chunks_per_source: 1 } : {}),
      ...(timeRange ? { time_range: timeRange } : {}),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Tavily 搜索失败 (${res.status})`);
  const data = (await res.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      published_date?: string;
      publishedDate?: string;
      last_updated?: string;
    }>;
  };
  const out: Discovery[] = [];
  for (const it of data?.results ?? []) {
    if (!it?.url || !/^https?:\/\//.test(it.url) || !it.title) continue;
    const rawDate = it.published_date || it.publishedDate || it.last_updated || "";
    const date = normalizeDiscoveryDate(rawDate);
    out.push({
      title: it.title,
      url: it.url,
      snippet: (it.content || "").replace(/\s+/g, " ").trim().slice(0, 600),
      ...(date ? { date } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 博查 AI 搜索(Tavily 故障/结果不足时补充；中文质量高、国内直连)。 */
async function bochaSearch(query: string, limit: number, freshness?: string): Promise<Discovery[]> {
  const res = await fetch("https://api.bochaai.com/v1/web-search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await bochaKey()}`,
      "Content-Type": "application/json",
    },
    // freshness:博查时效过滤(oneDay/oneWeek/oneMonth/oneYear/noLimit)。
    body: JSON.stringify({ query, summary: true, count: Math.min(limit, 10), ...(freshness ? { freshness } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`博查搜索失败 (${res.status})`);
  const data = (await res.json()) as {
    code?: number | string;
    data?: {
      webPages?: {
        value?: { name?: string; url?: string; summary?: string; snippet?: string; datePublished?: string; dateLastCrawled?: string }[];
      };
    };
  };
  const items = data?.data?.webPages?.value ?? [];
  const out: Discovery[] = [];
  for (const it of items) {
    if (!it?.url || !/^https?:\/\//.test(it.url) || !it.name) continue;
    // 发布日期是判断「老旧」的唯一硬依据 —— 以前直接丢弃,refine 的时效规则等于摆设。
    const rawDate = it.datePublished || it.dateLastCrawled || "";
    const date = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : undefined;
    out.push({ title: it.name, url: it.url, snippet: (it.summary || it.snippet || "").slice(0, 300), ...(date ? { date } : {}) });
    if (out.length >= limit) break;
  }
  if (!out.length) throw new Error("博查无结果");
  return out;
}

// ---------------------------------------------------------------------------
// 结果质量:低质站点确定性过滤 + 去重(不靠 LLM 凭站名猜)。
// ---------------------------------------------------------------------------

/** 文库/付费下载/内容农场类站点:内容老旧、登录墙、复制粘贴聚合,直接剔除。 */
const LOW_QUALITY_HOSTS = [
  "taodocs.com", "docin.com", "doc88.com", "book118.com", "renrendoc.com",
  "mayiwenku.com", "wenku.baidu.com", "ishare.iask.sina.com.cn", "docer.com",
  "wenku.so.com", "docs.qq.com/preview", "max.book118.com", "jinchutou.com",
  "wendangwang.com", "taowenku.com", "5ykj.com", "docsou.com",
  // SEO 蹭热点惯犯:域名主业与热点内容无关,靠关键词页收流量(refine 的 LLM 只见
  // 域名认不出「中公教育发世界杯」,黑名单兜)。实锤一个加一个,别扩大化误伤。
  "offcn.com", "wishdown.com", "world-sohu.com", "huatu.com", "gaodun.com",
  "php.cn", // PHP中文网:技术站发赛事/热点,实锤二犯
  "yixue99.com", // 医学教育站群(「中公卫生人才网」),标题蹭 sports.cctv.com 关键词骗过精排
];

function isLowQuality(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, "");
    return LOW_QUALITY_HOSTS.some((bad) => h === bad || h.endsWith("." + bad) || (u.hostname + u.pathname).includes(bad));
  } catch {
    return true;
  }
}

/** SEO 站群页确定性识别:标题/摘要里同一短语机械循环(「世界杯竞猜_世界杯足球赛竞猜
 *  2026足球世界杯竞猜_世界杯足球赛竞猜…」)。正常文章不会把 ≥6 字片段原样重复 3 次。 */
function isKeywordStuffing(r: Discovery): boolean {
  const text = `${r.title || ""} ${r.snippet || ""}`.replace(/\s+/g, " ");
  // 同一 6-30 字片段(含分隔符)在文本中出现 ≥3 次 → 堆砌
  if (/(.{6,30}?)(?:[\s_|,,-]*\1){2,}/.test(text)) return true;
  // 标题变体:下划线分段 + 同一 ≥5 字片段出现 2 次(「世界杯足球2026冠军_世界杯足球比赛冠军」)。
  // 正常标题极少用 _ 串联重复短语;仅对标题启用,避免误伤正文。
  const title = (r.title || "").trim();
  if (title.includes("_") && /(.{5,20}).*_.*\1/.test(title)) return true;
  return false;
}

/** 语言一致性:中文查询下,标题几乎不含 CJK 的候选(法语/英语官网页等)对用户无用。 */
export function matchesQueryLanguage(query: string, r: Discovery): boolean {
  const cjk = (s: string) => (s.match(/[一-鿿]/g) || []).length;
  if (cjk(query) === 0) return true; // 非中文查询不做语言过滤
  const title = r.title || "";
  if (!title.trim()) return true;
  return cjk(title) / title.length >= 0.1;
}

/** 主流视频站(主机名精确/子域匹配,别拿 qq.com 这种母域误伤普通页面)。 */
const VIDEO_HOSTS = ["bilibili.com", "youtube.com", "youtu.be", "v.qq.com", "youku.com", "douyin.com", "ixigua.com"];

/** 按 URL 特征标注来源类型(纯函数,不发请求、不碰检索逻辑):
 *  .pdf 后缀 → pdf;视频站 → video;其余 → article。 */
export function classifyDiscoveryType(url: string): "pdf" | "video" | "article" {
  if (/\.pdf(\?|#|$)/i.test(url)) return "pdf";
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (VIDEO_HOSTS.some((v) => h === v || h.endsWith("." + v))) return "video";
  } catch {
    /* 非法 URL:当普通文章 */
  }
  return "article";
}

/** 去重(URL 级)+ 剔除低质站/SEO 堆砌页 + 单域名限流(最多 2 条,防一站霸屏)。 */
export function cleanDiscoveries(raw: Discovery[]): Discovery[] {
  const seen = new Set<string>();
  const perHost = new Map<string, number>();
  const out: Discovery[] = [];
  for (const r of raw) {
    if (!r?.url || seen.has(r.url) || isLowQuality(r.url) || isKeywordStuffing(r)) continue;
    let host = "";
    try {
      // 归一时同时剥 www./m. 前缀,否则 m.offcn.com 与 offcn.com 被当两个域名,单域名限流失效。
      host = new URL(r.url).hostname.replace(/^(www|m)\./, "");
    } catch {
      continue;
    }
    const n = perHost.get(host) ?? 0;
    if (n >= 2) continue;
    perHost.set(host, n + 1);
    seen.add(r.url);
    // 类型打标的统一单点:快速/深度两条流水线的结果都经这里收口。
    out.push({ ...r, type: classifyDiscoveryType(r.url) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 检索规划:一次轻量 LLM 调用 = 查询改写(注入年份/补充变体)+ 时效档位判定。
// 这是「搜出来老旧、不精准」的两大根因的对症修复:此前用户口语查询原样透传、
// freshness 参数从未被任何调用方使用。
// ---------------------------------------------------------------------------

type SearchPlan = { queries: string[]; freshness?: string };

export async function planSearch(query: string): Promise<SearchPlan> {
  const fallback: SearchPlan = { queries: [query] };
  try {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const res = await getOpenAI().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 160,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `你是搜索查询优化器。今天是 ${today}(东八区)。把用户的研究主题优化成 1-2 个更精准的搜索词,并判定时效档位。规则:` +
            `1) 改写要保守,绝不改变主题语义;口语补成规范搜索词;` +
            `2) 时效敏感主题(新闻/赛事/产品发布/版本/价格/政策)必须在搜索词里补上年份等限定,并选紧的时效档;` +
            `3) 【进行中/刚发生的事件用最紧档】结合今天日期判断事件所处阶段:正在进行的赛事/展会、发布不久的产品、近期政策 → oneWeek 或 oneMonth(如赛事已开赛,搜"赛程"要的是最新赛况与剩余赛程,第二个搜索词加"最新"或"今日"角度),绝不给 oneYear;` +
            `4) 常青主题(方法论/概念/历史/教程)不加年份,时效档用 noLimit;` +
            `5) freshness 只能取 oneWeek/oneMonth/oneYear/noLimit。只返回 JSON。`,
        },
        {
          role: "user",
          content: `主题:${query}\n\n只返回:{"queries":["<搜索词1>","<搜索词2(可选,换个角度)>"],"freshness":"<档位>"}`,
        },
      ],
    });
    const p = JSON.parse(res.choices[0]?.message?.content || "{}") as { queries?: unknown; freshness?: unknown };
    const queries = (Array.isArray(p.queries) ? p.queries : [])
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 2);
    const fr = String(p.freshness || "");
    const freshness = ["oneWeek", "oneMonth", "oneYear"].includes(fr) ? fr : undefined;
    return queries.length ? { queries, freshness } : fallback;
  } catch {
    return fallback;
  }
}

/** 快速搜索全流程:规划(改写+时效)→ 并行检索 → 清洗去重 → LLM 精排。 */
export async function quickDiscover(query: string, limit = 8): Promise<{ summary: string; results: Discovery[] }> {
  const plan = await planSearch(query);
  const state: SearchRunState = {};
  const hits = (
    await Promise.all(
      plan.queries.map((q) => webSearch(q, 8, { freshness: plan.freshness, state }).catch(() => [] as Discovery[]))
    )
  ).flat();
  const langOk = (list: Discovery[]) => list.filter((r) => matchesQueryLanguage(query, r));
  let pool = langOk(cleanDiscoveries(hits));
  // 规划后的检索全军覆没(改写词过窄/时效档过紧)→ 放宽回原查询兜底。
  if (pool.length < 3) {
    try {
      pool = langOk(cleanDiscoveries([...pool, ...(await webSearch(query, 12, { state }))]));
    } catch {
      /* keep whatever we have */
    }
  }
  return refineDiscovery(query, pool, limit);
}

/** 智谱 web-search-pro(国内直连,带发布日期):后台填 key 即参战。 */
async function zhipuSearch(query: string, limit: number): Promise<Discovery[]> {
  const res = await fetch("https://open.bigmodel.cn/api/paas/v4/web_search", {
    method: "POST",
    headers: { Authorization: `Bearer ${await zhipuKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ search_engine: "search-pro", search_query: query, count: Math.min(limit, 10) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`智谱搜索失败 (${res.status})`);
  const data = (await res.json()) as { search_result?: { title?: string; link?: string; content?: string; publish_date?: string }[] };
  const out: Discovery[] = [];
  for (const it of data?.search_result ?? []) {
    if (!it?.link || !/^https?:\/\//.test(it.link) || !it.title) continue;
    const date = /^\d{4}-\d{2}-\d{2}/.test(it.publish_date || "") ? it.publish_date!.slice(0, 10) : undefined;
    out.push({ title: it.title, url: it.link, snippet: (it.content || "").slice(0, 300), ...(date ? { date } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Serper(Google 真池子代理):质量天花板,后台填 key 即参战。freshness → tbs 时效映射。 */
async function serperSearch(query: string, limit: number, freshness?: string): Promise<Discovery[]> {
  const tbs = freshness === "oneWeek" ? "qdr:w" : freshness === "oneMonth" ? "qdr:m" : freshness === "oneYear" ? "qdr:y" : undefined;
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": await serperKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, gl: "cn", hl: "zh-cn", num: Math.min(limit, 10), ...(tbs ? { tbs } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Serper 搜索失败 (${res.status})`);
  const data = (await res.json()) as { organic?: { title?: string; link?: string; snippet?: string; date?: string }[] };
  const out: Discovery[] = [];
  for (const it of data?.organic ?? []) {
    if (!it?.link || !/^https?:\/\//.test(it.link) || !it.title) continue;
    // Serper 的 date 是 "Jun 23, 2026" 之类,尽力转 ISO;转不了就不带。
    const t = it.date ? Date.parse(it.date) : NaN;
    const date = Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
    out.push({ title: it.title, url: it.link, snippet: (it.snippet || "").slice(0, 300), ...(date ? { date } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Tavily 之外的补充池：有 key 的源全部参战 + DDG 免费池恒参战，失败互不影响。 */
async function supplementarySearch(query: string, limit: number, opts?: WebSearchOptions): Promise<Discovery[]> {
  const tasks: Promise<Discovery[]>[] = [];
  if (await bochaKey()) tasks.push(bochaSearch(query, limit, opts?.freshness));
  if (await zhipuKey()) tasks.push(zhipuSearch(query, limit));
  if (await serperKey()) tasks.push(serperSearch(query, limit, opts?.freshness));
  tasks.push(ddgSearch(query, Math.min(limit, 8)));
  const settled = await Promise.allSettled(tasks);
  const merged = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  const failed = settled.filter((s) => s.status === "rejected");
  if (failed.length) console.warn(`[discover] ${failed.length}/${tasks.length} 个补充搜索源失败(已忽略)`);
  return merged;
}

/**
 * Web search：配置 Tavily 后以其为唯一主源；只有主源失败，或经低质/语言/单域名
 * 清洗后不足 3 条（limit<3 时不足 limit），才调用博查、智谱、Serper 与 DDG 补齐。未配置 Tavily 时
 * 保留原多池并行行为，避免部署漏配把“发现来源”整体打断。
 */
export async function webSearch(query: string, limit = 8, opts?: WebSearchOptions): Promise<Discovery[]> {
  const requested = Math.min(Math.max(1, limit), 20);
  const primaryKey = await tavilyKey();
  if (!primaryKey) {
    const legacy = await supplementarySearch(query, requested, opts);
    if (!legacy.length) throw new Error("搜索失败(所有搜索源均无结果)");
    return legacy;
  }

  let primary: Discovery[] = [];
  if (!opts?.state?.tavilyUnavailable) {
    try {
      primary = cleanDiscoveries(await tavilySearch(query, requested, primaryKey, opts))
        .filter((result) => matchesQueryLanguage(query, result));
    } catch (error) {
      if (opts?.state) opts.state.tavilyUnavailable = true;
      console.warn(`[discover] Tavily 主搜索失败，启用补充池:${(error as Error).message}`);
    }
  }
  // 既有产品合同：可用结果达到 3 条即视为足够，不能为了凑满 8 条盲目打全部补充池。
  // limit<3 的内部调用则以 limit 为足够线。
  const sufficient = Math.min(3, requested);
  if (primary.length >= sufficient) return primary.slice(0, requested);

  const supplement = await supplementarySearch(query, requested, opts);
  const merged = cleanDiscoveries([...primary, ...supplement])
    .filter((result) => matchesQueryLanguage(query, result))
    .slice(0, requested);
  if (!merged.length) throw new Error("搜索失败(Tavily 与补充搜索源均无结果)");
  return merged;
}

/** Web search via DuckDuckGo's keyless HTML endpoint. */
async function ddgSearch(query: string, limit = 8): Promise<Discovery[]> {
  const res = await fetch(
    // kl=cn-zh:中文区域结果(默认美区对中文查询召回差)。
    "https://html.duckduckgo.com/html/?kl=cn-zh&q=" + encodeURIComponent(query),
    {
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6" },
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!res.ok) throw new Error(`搜索失败 (${res.status})`);
  const html = await res.text();

  const titles: { title: string; url: string }[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && titles.length < limit) {
    let url = m[1];
    const ud = url.match(/[?&]uddg=([^&]+)/);
    if (ud) url = decodeURIComponent(ud[1]);
    if (!/^https?:\/\//.test(url)) continue;
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    if (title) titles.push({ title, url });
  }

  const snippets: string[] = [];
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = snipRe.exec(html))) {
    snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim());
  }

  return titles.map((t, i) => ({ ...t, snippet: snippets[i] || "" }));
}

/** 用 LLM 对原始搜索结果做相关性筛选/排序 + 一句话主题总结。
 *  只从真实搜索结果里挑序号(绝不改写/编造 URL);任何失败都原样降级返回。 */
export async function refineDiscovery(
  query: string,
  raw: Discovery[],
  limit = 8
): Promise<{ summary: string; results: Discovery[] }> {
  if (raw.length <= 2) return { summary: "", results: raw.slice(0, limit) };
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  // 候选行必须带发布日期 —— 没有日期,system 提示里的时效规则就是空话。
  const lines = raw
    .map((r, i) => `${i}. 【${host(r.url)}】${r.date ? `(${r.date})` : "(日期未知)"}${r.title} — ${(r.snippet || "").slice(0, 110)}`)
    .join("\n");
  try {
    const res = await getOpenAI().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 900, // 每条多带一句 reason,给足输出空间
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `你是资料发现助手。今天是 ${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)}(东八区)。给定用户的研究主题和候选网页,挑出与主题最相关、权威、彼此不重复(同一站点只保留最佳一条)的结果,按「权威度×时效」从高到低排序。**宁缺毋滥:合格的少于 ${limit} 条就只返回合格的,绝不为凑数保留差结果。**必须剔除**:①跑题/广告/登录墙/内容农场;②「域名主业与主题明显不符的蹭流量页」——看【站点】判断:教育培训机构/技术站/人才网发体育新闻、卫生网发赛事直播,都是 SEO 蹭热点,直接剔除;③竞猜/博彩/下注类页面一律剔除;④标题或摘要机械堆砌关键词的站群页(如「X_X比赛X」式重复);⑤语言与主题不一致的页面(中文主题下的法语/英语页,即使是官网也剔除——用户读不了)。**权威优先**:同等相关下,排序权重 = 官方网站 > 权威媒体(新华社/人民网/央视网/澎湃/新浪/腾讯/网易/搜狐正牌频道、垂直领域头部如懂球帝/虎扑/36氪/丁香园)> 普通网站;门户的「正牌频道」域名是 sports.sina.com.cn 这类,仿冒域名(如 world-sohu.com)一律剔除。**时效规则**:若主题时效敏感(新闻/赛事/产品发布/版本更新/价格行情),同等相关下必须优先较新的结果,并剔除明显过时的——特别注意「事件已发生/进行中」时,早于事件开始的前瞻/预告类内容已过时(如已开赛的赛事,开赛前的赛程预告不如最新赛况),快照里的日期是你判断的依据。常青类主题(方法论/概念/教程)不受此限。再用一句话(中文,≤40 字)概括这批结果覆盖的范围。每条保留的结果附一句 reason(中文,≤40 字):站在用户视角说这条与其搜索主题的关系、为什么值得看(如角度/权威性/时效上的价值),不要复述标题。严格只返回 JSON,不要多余文字。`,
        },
        {
          role: "user",
          content:
            `研究主题:${query}\n\n候选(格式 = 序号. 【站点】标题 — 摘要):\n${lines}\n\n` +
            `只返回:{"summary":"<一句话概括>","picks":[{"i":<候选序号>,"reason":"<一句为什么值得看>"},...]}(按相关性排序,最多 ${limit} 条)`,
        },
      ],
    });
    const parsed = JSON.parse(res.choices[0]?.message?.content || "{}") as {
      summary?: string;
      picks?: unknown;
      indices?: unknown;
    };
    // 新格式 picks=[{i,reason}];容错兼容旧 indices=[序号] 或 picks 里直接给数字。
    // reason 是增强不是门槛:缺失/非法只影响该条没有注释,不影响保留。
    const rawPicks = Array.isArray(parsed.picks) ? parsed.picks : Array.isArray(parsed.indices) ? parsed.indices : [];
    const seen = new Set<number>();
    const picked: Discovery[] = [];
    for (const v of rawPicks) {
      const item = (v && typeof v === "object" ? v : { i: v }) as { i?: unknown; reason?: unknown };
      const i = Number(item.i);
      if (Number.isInteger(i) && i >= 0 && i < raw.length && !seen.has(i)) {
        seen.add(i);
        const reason = typeof item.reason === "string" ? item.reason.trim().slice(0, 60) : "";
        picked.push(reason ? { ...raw[i], reason } : raw[i]);
        if (picked.length >= limit) break;
      }
    }
    // 兜底只救「LLM 基本没选出东西」的失败态(<3 条)。以前无条件补齐到 limit,
    // 等于把 LLM 刚剔除的蹭流量页/外语页按原顺序又塞回结果 —— 垃圾回流通道。
    // 宁缺毋滥:LLM 选出 ≥3 条就尊重它的删减,结果少但干净。
    if (picked.length < 3) {
      for (let i = 0; i < raw.length && picked.length < limit; i++) {
        if (!seen.has(i)) {
          seen.add(i);
          picked.push(raw[i]);
        }
      }
    }
    return { summary: (parsed.summary || "").trim(), results: picked };
  } catch (e) {
    console.warn("[discover] refine failed:", (e as Error).message);
    return { summary: "", results: raw.slice(0, limit) };
  }
}

/** A random, research-worthy topic for the "I'm feeling curious" button. */
export async function randomTopic(): Promise<string> {
  try {
    const res = await getOpenAI().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 1,
      max_tokens: 30,
      messages: [
        {
          role: "user",
          content:
            "给我一个有趣、适合做资料研究的随机主题,只回主题短语本身(中文,不超过12字,不要标点)。",
        },
      ],
    });
    const t = (res.choices[0]?.message?.content || "").trim().replace(/^["'\s]+|["'\s。]+$/g, "");
    return t || "人工智能的未来";
  } catch {
    return "人工智能的未来";
  }
}

// ---------------------------------------------------------------------------
// 深度搜索(agentic):拆解 → 多轮检索 + 抓取阅读 → 缺口追问 → 综合出报告 + 精选来源。
// 快速搜索 = 单轮 webSearch + refineDiscovery;深度 = 下面这套多步流水线。
// ---------------------------------------------------------------------------

function jsonQueries(raw: string): string[] {
  try {
    const p = JSON.parse(raw || "{}") as { queries?: unknown };
    return Array.isArray(p.queries) ? p.queries.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 把主题拆成 3-4 个互补的检索子问题(覆盖定义/现状/对比/争议/进展等不同侧面)。 */
async function planSubQueries(query: string): Promise<string[]> {
  try {
    const res = await getOpenAI().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.4,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是研究规划助手。把用户的研究主题拆成 3-4 个互补、彼此不重复的检索子问题/角度(覆盖定义、现状、对比、争议、最新进展等不同侧面),便于分别上网检索。只返回 JSON。",
        },
        {
          role: "user",
          content: `研究主题:${query}\n\n只返回:{"queries":["<子问题1>","<子问题2>",...]}(3-4 个,中文,每个是一句可直接搜索的短语)`,
        },
      ],
    });
    return jsonQueries(res.choices[0]?.message?.content || "").slice(0, 4);
  } catch {
    return [];
  }
}

/** 读一个网页正文(截断),失败返回空串。 */
async function readPage(url: string, maxChars = 1800): Promise<string> {
  try {
    const { text } = await extractUrl(url);
    return (text || "").replace(/\s+/g, " ").trim().slice(0, maxChars);
  } catch {
    return "";
  }
}

/** 看已收集资料的标题,判断还缺哪些角度 → 至多 2 个补充检索(足够则空)。 */
async function findGaps(query: string, pool: Discovery[]): Promise<string[]> {
  try {
    const seen = pool.slice(0, 16).map((r, i) => `${i}. ${r.title}`).join("\n");
    const res = await getOpenAI().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.4,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是研究助手。根据研究主题和已找到的资料标题,判断还缺哪些角度没覆盖到,给出至多 2 个补充检索;若已足够则返回空数组。只返回 JSON。",
        },
        { role: "user", content: `主题:${query}\n\n已找到:\n${seen}\n\n只返回:{"queries":["<补充检索>", ...]}(0-2 个)` },
      ],
    });
    return jsonQueries(res.choices[0]?.message?.content || "").slice(0, 2);
  } catch {
    return [];
  }
}

/** 综合已读资料 → 一份带引用的 Markdown 报告 + 精选来源(只从真实结果里挑,绝不编造 URL)。 */
async function synthesize(
  query: string,
  pool: (Discovery & { text?: string })[]
): Promise<{ summary: string; results: Discovery[]; references: DiscoveryReference[] }> {
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const withText = pool.filter((p) => p.text && p.text.length > 80);
  const src = (withText.length ? withText : pool).slice(0, 12);
  // bare 只保留展示字段(剥掉抓取的 text);type 要留着给前端类型筛选。
  const bare = src.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, type: r.type }));
  const references = buildDiscoveryReferences(bare);
  if (!src.length) return { summary: "", results: [], references };
  const corpus = src
    .map((r, i) => `[${i + 1}] 【${host(r.url)}】${r.title}\n${(r.text || r.snippet || "").slice(0, 1600)}`)
    .join("\n\n");
  try {
    const res = await getOpenAI().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.3,
      max_tokens: 2200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是深度研究助手。根据用户主题和多个来源的正文,写一份结构化中文研究报告(Markdown:一段概述 + 几个「## 小标题」+ 要点),只用来源支持的内容、不要编造;在关键结论后用 [编号] 标注依据的来源,编号严格沿用输入中从 1 开始的编号,若来源间有分歧要点出。再挑出最有价值、彼此不重复的来源编号(用于导入)。只返回 JSON。",
        },
        {
          role: "user",
          content: `研究主题:${query}\n\n来源(格式 = [编号] 【站点】标题 + 正文):\n${corpus}\n\n只返回:{"report":"<Markdown 报告,含 [编号] 引用>","sources":[<最有价值的来源编号,最多 8 个,按重要性排序>]}`,
        },
      ],
    });
    const p = JSON.parse(res.choices[0]?.message?.content || "{}") as { report?: string; sources?: unknown };
    const idx = Array.isArray(p.sources) ? p.sources : [];
    const picked = new Set<number>();
    const results: Discovery[] = [];
    for (const v of idx) {
      const i = discoveryReferenceIndex(v, src.length);
      if (i !== null && !picked.has(i)) {
        picked.add(i);
        results.push(bare[i]);
        if (results.length >= 8) break;
      }
    }
    for (let i = 0; i < src.length && results.length < 6; i++) {
      if (!picked.has(i)) {
        picked.add(i);
        results.push(bare[i]);
      }
    }
    return { summary: (p.report || "").trim(), results, references };
  } catch (e) {
    console.warn("[deep] synthesize failed:", (e as Error).message);
    return { summary: "", results: bare.slice(0, 8), references };
  }
}

/** 深度搜索主流程。返回 {summary=Markdown 研究报告, results=精选来源}。 */
export async function deepResearch(
  query: string
): Promise<{ summary: string; results: Discovery[]; references: DiscoveryReference[] }> {
  const pool = new Map<string, Discovery & { text?: string }>();
  const state: SearchRunState = {};
  const addHits = (hits: Discovery[]) => {
    // 低质文库/内容农场在入池前就剔掉,别浪费后面的正文抓取额度。
    for (const h of cleanDiscoveries(hits)) if (!pool.has(h.url)) pool.set(h.url, { ...h });
  };
  // 1. 拆解(子问题)+ 检索规划(时效档)并行;首轮多角度检索统一带 freshness。
  const [subs, plan] = await Promise.all([planSubQueries(query), planSearch(query)]);
  const freshness = plan.freshness;
  for (const q of [query, ...subs].slice(0, 5)) {
    try {
      addHits(await webSearch(q, 4, { freshness, depth: "advanced", state }));
    } catch {
      /* 单条检索失败不影响整体 */
    }
  }
  // 2. 抓取阅读首批正文
  await Promise.all([...pool.values()].slice(0, 10).map(async (d) => (d.text = await readPage(d.url))));
  // 3. 缺口追问 → 补充检索 + 阅读
  const gaps = await findGaps(query, [...pool.values()]);
  for (const g of gaps) {
    try {
      addHits(await webSearch(g, 4, { freshness, depth: "advanced", state }));
    } catch {
      /* skip */
    }
  }
  await Promise.all(
    [...pool.values()].filter((d) => d.text === undefined).slice(0, 4).map(async (d) => (d.text = await readPage(d.url)))
  );
  // 4. 综合成报告 + 精选来源
  return synthesize(query, [...pool.values()]);
}
