// ---------------------------------------------------------------------------
// 订阅源 adapter 层(P0-3):枚举一个发布源的最新条目。上层管线(lib/jobs 的
// feed_enum)对协议无感。设计:featured-subscription-design.md v2 §3.3 +
// thinktank-library-design.md §4(28 家实核带来的工程要点)。
//
// P0 只实现 rss(RSS 2.0 + Atom;绿灯组 10 家全是 rss)与 manual(不轮询,
// 运营手动补录);weblist/sitemap 留 P1(接口已留)。
//
// 实核硬约束(每条都有对应真实智库案例):
//  - 浏览器级 UA 默认开:NBER(Akamai)/RAND/Ada Lovelace 对非浏览器 UA 一律 403。
//  - 总时长硬断 30s:ssrfSafeFetch 的 timeout 是空闲超时,恶意源可滴灌挂死。
//  - 解析必须非回溯(indexOf 扫描切块,禁贪婪跨文本正则):8MB 畸形 XML 的
//    灾难性回溯会冻结 Next 主进程事件循环(全站冻结,不是任务失败)。
//  - item 数上限 200(轮换 guid 的恶意源每轮灌爆 feed_items)。
//  - ETag/Last-Modified 条件请求:304 空转零成本。
// ---------------------------------------------------------------------------
// 服务端专用(隔离由依赖链保证:被 lib/jobs/lib/db(pg) 引用,误进 client bundle 会构建失败;
// 不用 server-only 哨兵 —— 该包在 node:test 的 CJS require 下主动抛错,会挡掉本文件的纯函数单测)。
import { ssrfSafeFetch } from "./ssrf";
import { normalizeUrl } from "./ingest";
import type { FeedChannel } from "./db";

export interface EnumeratedItem {
  guid: string;
  url: string;
  title: string;
  publishedAt: number | null;
}

export interface EnumerateResult {
  items: EnumeratedItem[];
  /** HTTP 304:源没变,零成本空转(AIMD 记 polled 不改 interval)。 */
  notModified: boolean;
  etag: string | null;
  lastModified: string | null;
}

const MAX_ITEMS = 200;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const TOTAL_TIMEOUT_MS = 30_000;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface FeedConfig {
  /** 浏览器 UA 伪装,默认开(实核:多数智库源必需);显式 false 关闭。 */
  ua?: boolean;
  /** 标题过滤正则(不区分大小写):KFF/CSET 类混合流按标题筛掉快讯/播客等。 */
  item_filter?: string;
  /** URL 排除正则(不区分大小写):RAND new.xml 混入 external_publications(期刊
   *  存根,正文在付费期刊、站点只挂导航壳,无可提取全文)—— 按 URL 路径整类剔除。 */
  url_exclude?: string;
  /** TLS 证书链容错(腾讯研究院实核需要)—— P1 实现,P0 保留键位。 */
  tls_lax?: boolean;
}

export function parseFeedConfig(raw: string): FeedConfig {
  try {
    const v = JSON.parse(raw || "{}");
    return typeof v === "object" && v ? (v as FeedConfig) : {};
  } catch {
    return {};
  }
}

/** 枚举一个频道的最新条目(P0:kind=rss)。抛错=本轮失败(由 dispatcher 计入 fail_count)。 */
export async function enumerateChannel(ch: Pick<FeedChannel, "kind" | "url" | "config" | "etag" | "last_modified">): Promise<EnumerateResult> {
  if (ch.kind === "manual") return { items: [], notModified: false, etag: null, lastModified: null };
  if (ch.kind !== "rss") throw new Error(`该订阅源类型(${ch.kind})将在后续版本支持自动轮询`);
  const cfg = parseFeedConfig(ch.config);

  const headers: Record<string, string> = {
    accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
  };
  if (cfg.ua !== false) headers["user-agent"] = BROWSER_UA;
  if (ch.etag) headers["if-none-match"] = ch.etag;
  if (ch.last_modified) headers["if-modified-since"] = ch.last_modified;

  // 总时长硬断:ssrfSafeFetch 的 timeoutMs 是响应级空闲超时,滴灌响应能一直续命;
  // 这里外层再包一个绝对 deadline,超了直接抛(僵尸 fetch 由 GC 收,不会续写任何状态)。
  const res = await withDeadline(
    ssrfSafeFetch(ch.url, { headers }, { timeoutMs: 15_000, maxBytes: MAX_XML_BYTES }),
    TOTAL_TIMEOUT_MS,
    "订阅源抓取超时(30s 硬上限)"
  );
  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");
  if (res.status === 304) return { items: [], notModified: true, etag, lastModified };
  if (!res.ok) throw new Error(`订阅源返回 HTTP ${res.status}`);
  const xml = await withDeadline(res.text(), TOTAL_TIMEOUT_MS, "订阅源读取超时");

  let items = parseFeedXml(xml);
  const filter = safeRegex(cfg.item_filter);
  if (filter) items = items.filter((it) => filter.test(it.title));
  const exclude = safeRegex(cfg.url_exclude);
  if (exclude) items = items.filter((it) => !exclude.test(it.url));
  return { items: items.slice(0, MAX_ITEMS), notModified: false, etag, lastModified };
}

async function withDeadline<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function safeRegex(pattern?: string): RegExp | null {
  if (!pattern) return null;
  // ReDoS 面收口(审查):长度钳制 + 拒绝嵌套量词的典型形态((…+)+ / (…*)* 等)。
  // 标题内容由远端源控制,病态正则的灾难性回溯会冻结主进程事件循环。P1 换线性引擎。
  if (pattern.length > 120 || /\([^)]*[+*][^)]*\)\s*[+*{]/.test(pattern)) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null; // 运营填了非法正则:不过滤,别让整个频道熔断
  }
}

// ---------------------------------------------------------------------------
// RSS 2.0 / Atom 解析 —— 非回溯:indexOf 逐块切割 <item>/<entry>,块内取字段。
// 不追求完整 XML 合规,只取 guid/link/title/日期 四件事;畸形输入最多解析出 0 条,
// 绝不回溯爆炸。
// ---------------------------------------------------------------------------

export function parseFeedXml(xml: string): EnumeratedItem[] {
  const items: EnumeratedItem[] = [];
  // RSS 2.0:<item>…</item>;Atom:<entry>…</entry>。哪种标签存在用哪种。
  const isAtom = xml.indexOf("<entry") !== -1 && xml.indexOf("<item") === -1;
  const open = isAtom ? "<entry" : "<item";
  const close = isAtom ? "</entry>" : "</item>";
  let pos = 0;
  while (items.length < MAX_ITEMS) {
    const s = xml.indexOf(open, pos);
    if (s === -1) break;
    const e = xml.indexOf(close, s);
    if (e === -1) break;
    const block = xml.slice(s, e);
    pos = e + close.length;

    const title = cleanText(tagText(block, "title"));
    const url = isAtom ? atomLink(block) : cleanText(tagText(block, "link"));
    const guidRaw = cleanText(tagText(block, isAtom ? "id" : "guid")) || url;
    const dateRaw =
      tagText(block, isAtom ? "published" : "pubDate") ||
      tagText(block, isAtom ? "updated" : "dc:date");
    if (!guidRaw && !url) continue; // 无任何稳定身份的块跳过
    items.push({
      // guid 兜底必须规范化 URL(审查修复 high):link 带轮换参数(utm/时间戳)的源
      // 否则每轮全量判「新」→ AIMD 锁死 15min + 简报/徽章无限灌水 + 绕过每日配额。
      // 与手动补录(feed_ingest_urls 也用 normalizeUrl 当 guid)统一判重键。
      guid: (guidRaw || normalizeUrl(url)).slice(0, 500),
      url: (url || guidRaw).slice(0, 1000),
      title: (title || url || guidRaw).slice(0, 300),
      publishedAt: parseDate(cleanText(dateRaw)),
    });
  }
  return items;
}

/** 取 <tag …>text</tag> 的内文(indexOf 定位,无正则回溯面)。 */
function tagText(block: string, tag: string): string {
  const openAt = block.indexOf(`<${tag}`);
  if (openAt === -1) return "";
  const gt = block.indexOf(">", openAt);
  if (gt === -1) return "";
  // 自闭合 <link href="…"/> 这类没有内文
  if (block[gt - 1] === "/") return "";
  const end = block.indexOf(`</${tag}>`, gt);
  if (end === -1) return "";
  return block.slice(gt + 1, end);
}

/** Atom 的 link 是属性:优先 rel="alternate" 的 href,退而取第一个 href。 */
function atomLink(block: string): string {
  let pos = 0;
  let firstHref = "";
  while (true) {
    const at = block.indexOf("<link", pos);
    if (at === -1) break;
    const gt = block.indexOf(">", at);
    if (gt === -1) break;
    const attrs = block.slice(at, gt);
    const href = attrValue(attrs, "href");
    if (href && !firstHref) firstHref = href;
    if (href && (attrs.indexOf('rel="alternate"') !== -1 || attrs.indexOf("rel='alternate'") !== -1)) {
      return href;
    }
    // 无 rel 属性的 <link> 在 Atom 里默认就是 alternate
    if (href && attrs.indexOf("rel=") === -1) return href;
    pos = gt + 1;
  }
  return firstHref;
}

function attrValue(attrs: string, name: string): string {
  const at = attrs.indexOf(`${name}=`);
  if (at === -1) return "";
  const q = attrs[at + name.length + 1];
  if (q !== '"' && q !== "'") return "";
  const end = attrs.indexOf(q, at + name.length + 2);
  if (end === -1) return "";
  return attrs.slice(at + name.length + 2, end);
}

/** 去 CDATA、去内嵌标签、解常见实体、压缩空白。 */
function cleanText(raw: string): string {
  let t = raw.trim();
  if (t.startsWith("<![CDATA[")) {
    const end = t.lastIndexOf("]]>");
    t = end === -1 ? t.slice(9) : t.slice(9, end);
  }
  // 去内嵌标签:逐字符扫描(非正则),防 <title> 里塞 HTML
  let out = "";
  let inTag = false;
  for (const chv of t) {
    if (chv === "<") inTag = true;
    else if (chv === ">") inTag = false;
    else if (!inTag) out += chv;
  }
  return out
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// 更新简报内容生成(纯函数,R1)。诚实性④「简报不编造」的机制载体:
//  - 正文 <300 字的条目【即使带 gist 也弃用】—— extractUrl 的 og:description 兜底
//    会让 LLM 基于 60 字 teaser 产出自信编造的"要点"(项目有实锤先例),字数是
//    唯一可靠的分级信号,gist 是否存在不是。
//  - 全薄批返回 null(跳过简报,只更时间线),绝不发一期全是"未能获取"的空简报。
// 抽成纯函数使该规则可被直接单测,不依赖 LLM/DB(上轮"规则做成口号"的教训)。
// ---------------------------------------------------------------------------

export const FEED_GIST_MIN_CHARS = 300;

export interface BriefItem {
  title: string;
  url?: string | null;
  /** 入库正文字数(sources.char_count)。 */
  charCount: number;
  /** 单篇导读(sources.summary,LLM 产物;可能为空)。 */
  gist?: string | null;
}

export function buildFeedBrief(items: BriefItem[]): { title: string; content: string } | null {
  if (!items.length) return null;
  const rich = items.filter((it) => it.charCount >= FEED_GIST_MIN_CHARS);
  if (rich.length === 0) return null; // 全薄:不出简报(诚实性④)
  const lines = items.map((it) => {
    const link = it.url ? `([原文](${it.url}))` : "";
    if (it.charCount < FEED_GIST_MIN_CHARS) {
      // 薄源:正文没抓全,gist(若有)是基于残片的编造面 —— 一律弃用,诚实标注。
      return `- **${it.title}**${link} —— 正文未能获取全文,请以原文为准`;
    }
    const gist = (it.gist || "").trim();
    return gist
      ? `- **${it.title}**${link}\n  ${gist.slice(0, 300)}`
      : `- **${it.title}**${link} —— 已入库,可在对话中直接提问`;
  });
  const now = new Date();
  return {
    title: `更新简报 · ${now.getMonth() + 1}月${now.getDate()}日`,
    content: `本期新增 ${items.length} 篇:\n\n${lines.join("\n")}`,
  };
}

/** 宽松解日期:标准 RFC822/ISO 直接 Date.parse;Bruegel 式非标(Thu, 07/16/2026 - 14:05)单独兜。 */
export function parseDate(raw: string): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return t;
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-?\s*(\d{2}):(\d{2})/);
  if (m) {
    const t2 = Date.parse(`${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:00Z`);
    if (!Number.isNaN(t2)) return t2;
  }
  return null;
}
