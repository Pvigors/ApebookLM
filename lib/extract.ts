import { extractText, getDocumentProxy } from "unpdf";
import JSZip from "jszip";
import { ssrfSafeFetch } from "./ssrf";

/** Extract plain text from a PDF buffer. */
export async function extractPdf(buf: ArrayBuffer): Promise<{ text: string; pages: number }> {
  // pdf.js takes ownership of and detaches the input buffer, so hand it a copy
  // — this lets the caller reuse the original (e.g. for the OCR fallback).
  const pdf = await getDocumentProxy(new Uint8Array(buf.slice(0)));
  const { text } = await extractText(pdf, { mergePages: true });
  return { text: normalize(Array.isArray(text) ? text.join("\n\n") : text), pages: pdf.numPages || 0 };
}

const YT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Extract the 11-char video id from any common YouTube URL form. */
export function youTubeId(url: string): string | null {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return /^[a-zA-Z0-9_-]{11}$/.test(url.trim()) ? url.trim() : null;
}

export function isYouTubeUrl(url: string): boolean {
  return /(?:youtube\.com|youtu\.be)/i.test(url) && !!youTubeId(url);
}

// ---- Bilibili ----

const BILI_PUBLIC_HEADERS: Record<string, string> = {
  "User-Agent": YT_UA,
  Referer: "https://www.bilibili.com",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

const biliApiHeaders = (): Record<string, string> => ({
  ...BILI_PUBLIC_HEADERS,
  ...(process.env.BILIBILI_SESSDATA
    ? { Cookie: `SESSDATA=${process.env.BILIBILI_SESSDATA}` }
    : {}),
});

function urlHostIn(url: string, roots: string[]): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return roots.some((root) => parsed.hostname === root || parsed.hostname.endsWith(`.${root}`));
  } catch {
    return false;
  }
}

export function biliBvid(url: string): string | null {
  const m = url.match(/BV[0-9A-Za-z]{10}/);
  if (m) return m[0];
  return /^BV[0-9A-Za-z]{10}$/.test(url.trim()) ? url.trim() : null;
}

export function isBilibiliUrl(url: string): boolean {
  return urlHostIn(url, ["bilibili.com", "b23.tv"]) || /^BV[0-9A-Za-z]{10}$/.test(url.trim());
}

/**
 * Fetch a Bilibili video as text. Uses the subtitle track when available
 * (often only with login via BILIBILI_SESSDATA), and always falls back to the
 * title + description so there's usable content. Best-effort.
 */
export async function extractBilibili(
  url: string
): Promise<{ title: string; text: string }> {
  let bvid = biliBvid(url);
  if (!bvid && urlHostIn(url, ["b23.tv"])) {
    try {
      // 用户可控短链必须走 SSRF 安全 fetch:逐跳复检重定向,挡住
      // 「b23.tv.attacker.com 302 到 169.254.169.254」这类内网/元数据引流。
      // 短链解析无需登录态，绝不把服务端 SESSDATA 发给用户提供的首跳。
      const r = await ssrfSafeFetch(url, { headers: BILI_PUBLIC_HEADERS }, { timeoutMs: 12000 });
      // 主机边界锚定:最终地址必须落在 Bilibili 域族,否则视为被引流,拒绝取值。
      let finalHost = "";
      try {
        finalHost = new URL(r.url).hostname;
      } catch {
        /* r.url 异常时 finalHost 留空 → 下面白名单判定失败 */
      }
      if (/(^|\.)(bilibili\.com|b23\.tv)$/i.test(finalHost)) {
        bvid = biliBvid(r.url);
      }
    } catch {
      /* ignore */
    }
  }
  if (!bvid) throw new Error("不是有效的 Bilibili 视频链接(需要 BV 号)。");

  const viewRes = await ssrfSafeFetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    { headers: biliApiHeaders() },
    { timeoutMs: 15000 }
  );
  if (!viewRes.ok) throw new Error(`获取视频信息失败 (${viewRes.status})。`);
  const view = (await viewRes.json()) as {
    code: number;
    message?: string;
    data?: { title?: string; desc?: string; cid?: number };
  };
  if (view.code !== 0 || !view.data) {
    throw new Error(`Bilibili 接口错误:${view.message || view.code}`);
  }
  const title = view.data.title || `Bilibili ${bvid}`;
  const desc = (view.data.desc || "").trim();
  const cid = view.data.cid;

  let subtitleText = "";
  if (cid) {
    try {
      const playerRes = await ssrfSafeFetch(
        `https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`,
        { headers: biliApiHeaders() },
        { timeoutMs: 12000 }
      );
      const player = (await playerRes.json()) as {
        data?: { subtitle?: { subtitles?: { subtitle_url: string }[] } };
      };
      const subs = player?.data?.subtitle?.subtitles ?? [];
      if (subs.length && subs[0].subtitle_url) {
        const su = subs[0].subtitle_url;
        const subUrl = su.startsWith("//") ? "https:" + su : su;
        // subtitle_url 来自上游接口返回,一旦上游被污染即可指向内网 → 二次抓取
        // 必须走 SSRF 安全 fetch,并把主机锚定到 B 站字幕 CDN 域族(hdslb/bilivideo)。
        let subHost = "";
        try {
          subHost = new URL(subUrl).hostname;
        } catch {
          /* 非法 URL → 主机留空,白名单判定失败即跳过 */
        }
        if (/(^|\.)(hdslb\.com|bilivideo\.com|bilibili\.com)$/i.test(subHost)) {
          // 字幕 CDN 只需公开请求头；会话 Cookie 仅发往 bilibili.com API。
          const sr = await ssrfSafeFetch(subUrl, { headers: BILI_PUBLIC_HEADERS }, { timeoutMs: 12000 });
          const sj = (await sr.json()) as { body?: { content: string }[] };
          subtitleText = (sj.body ?? []).map((b) => b.content).join("\n");
        }
      }
    } catch {
      /* no accessible subtitles */
    }
  }

  const parts = [`# ${title}`];
  if (desc) parts.push(desc);
  if (subtitleText) parts.push("## 字幕\n" + subtitleText);
  const text = normalize(parts.join("\n\n"));
  if (!text) throw new Error("没能从该视频提取到文字(可能无简介且字幕需登录)。");
  return { title, text };
}

/** Fetch a YouTube video's transcript (manual or auto captions) as plain text. */
export async function extractYouTube(
  url: string
): Promise<{ title: string; text: string }> {
  const id = youTubeId(url);
  if (!id) throw new Error("不是有效的 YouTube 视频链接,请检查后重试。");
  const res = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, {
    headers: {
      "User-Agent": YT_UA,
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: "SOCS=CAI; CONSENT=YES+1",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`访问 YouTube 页面失败(${res.status}),请稍后重试。`);
  const html = await res.text();

  const title = decodeEntities(
    html.match(/<meta name="title" content="([^"]*)"/)?.[1] ||
      html.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1] ||
      `YouTube video ${id}`
  );

  const tracksMatch = html.match(/"captionTracks":(\[.*?\])/);
  if (!tracksMatch) {
    throw new Error("该视频没有可用的字幕/文稿,换个带字幕的视频试试。");
  }
  let tracks: { baseUrl: string; languageCode?: string }[];
  try {
    tracks = JSON.parse(tracksMatch[1].replace(/\\u0026/g, "&"));
  } catch {
    throw new Error("解析该视频的字幕列表失败,请稍后重试。");
  }
  if (!tracks.length) throw new Error("该视频没有可用的字幕/文稿,换个带字幕的视频试试。");

  const track = tracks.find((t) => t.languageCode?.startsWith("en")) || tracks[0];
  const baseUrl = track.baseUrl.replace(/\\u0026/g, "&");

  // Try the default (XML) endpoint, then the json3 format. YouTube increasingly
  // returns an empty body for caption requests that lack a session token.
  const fetchCap = async (u: string) => {
    const r = await fetch(u, {
      headers: { "User-Agent": YT_UA },
      signal: AbortSignal.timeout(15000),
    });
    return r.ok ? await r.text() : "";
  };

  let clean = "";
  const xml = await fetchCap(baseUrl);
  if (xml) {
    const text = xml
      .replace(/<text[^>]*>/g, "\n")
      .replace(/<\/text>/g, " ")
      .replace(/<[^>]+>/g, "");
    clean = normalize(decodeEntities(decodeEntities(text))); // captions are double-encoded
  }
  if (clean.replace(/\s+/g, "").length < 8) {
    const json = await fetchCap(`${baseUrl}&fmt=json3`);
    if (json) {
      try {
        const data = JSON.parse(json) as {
          events?: { segs?: { utf8?: string }[] }[];
        };
        const parts = (data.events || [])
          .flatMap((e) => e.segs || [])
          .map((s) => s.utf8 || "")
          .join("");
        clean = normalize(decodeEntities(parts));
      } catch {
        /* fall through to the error below */
      }
    }
  }

  if (clean.replace(/\s+/g, "").length < 8) {
    throw new Error(
      "YouTube 未返回该视频的字幕(平台对非浏览器请求限制越来越严)。可以换个视频试试,或将字幕文稿复制后以「粘贴文本」方式导入。"
    );
  }
  return { title, text: clean };
}

/** Decode HTML bytes honoring the page's declared charset (Content-Type header
 *  or <meta charset>), so GBK/GB2312/Big5 pages don't turn into mojibake when
 *  the default UTF-8 decode hits non-UTF-8 bytes. */
function decodeHtmlBytes(buf: ArrayBuffer, contentType: string | null): string {
  let cs = contentType?.match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  if (!cs) {
    // sniff <meta charset=…> / <meta http-equiv content="…charset=…"> from the head
    const head = new TextDecoder("latin1").decode(buf.slice(0, 4096));
    cs = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  }
  if (cs === "gb2312" || cs === "gbk") cs = "gb18030"; // superset, ICU-supported
  if (!cs || cs === "utf-8" || cs === "utf8") return new TextDecoder("utf-8").decode(buf);
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** 读取 <meta property|name=...> 的 content(不依赖属性顺序,property/content 谁先都行)。 */
function metaContent(html: string, keys: string[]): string | undefined {
  const want = keys.map((k) => k.toLowerCase());
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1] || "").toLowerCase();
    if (!want.includes(key)) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([\s\S]*?)["']/i)?.[1];
    const v = content ? decodeEntities(content).replace(/\s+/g, " ").trim() : "";
    if (v) return v;
  }
  return undefined;
}

// ---- 微信公众号文章(mp.weixin.qq.com) ----

/**
 * 解析微信公众号文章页 HTML(mp.weixin.qq.com/s/…)。纯函数,便于离线自测。
 * - 标题:og:title,回退 <title>(去「_微信公众平台」尾巴);
 * - 作者/公众号名:og:article:author,回退 #js_author_name / #js_name;
 * - 正文:id="js_content" 容器(平衡 <div> 扫描取整个容器),剥 script/style、
 *   块级闭合标签转换行、其余标签直接剥掉(微信正文是大量嵌套 span/section,
 *   剥成空串可避免中文句子里被塞进多余空格)、HTML 实体反转义;
 * - 图片是 data-src 懒加载,不下载、直接忽略(纯文本来源用不上);
 * - 发布时间:页面脚本里的 var createTime = 'YYYY-MM-DD HH:mm'(回退
 *   var ct = "秒级时间戳"),拼进头部元信息行;
 * - 产出头部保留「标题 + 作者/公众号/时间」行,便于引用与导读定位出处。
 */
export function extractWeChatArticle(html: string): { title: string; text: string } {
  const open = /<div\b[^>]*\bid=["']js_content["'][^>]*>/i.exec(html);
  if (!open) {
    // 验证页没有 js_content 容器。云端数据中心 IP 访问公众号文章会命中
    // 「环境异常,完成验证后即可继续访问」拦截页(链接带 poc_token 参数),
    // 把它当正文入库就是脏数据 → 报可操作中文错误(透传到来源行/批量结果面板)。
    if (
      (/环境异常/.test(html) && /(去验证|完成验证)/.test(html)) ||
      /poc_token/i.test(html)
    ) {
      throw new Error(
        "微信文章触发了访问验证,暂时无法自动抓取。请在浏览器打开原文,复制正文后用「粘贴文本」导入。"
      );
    }
    throw new Error("没能定位到微信文章正文,页面结构可能已变化。可将内容复制后以「粘贴文本」方式导入。");
  }

  // 平衡扫描 div 开闭标签,找 js_content 容器的闭合位置(容器内还有嵌套 div)。
  const divRe = /<(\/?)div\b[^>]*>/gi;
  divRe.lastIndex = open.index;
  let depth = 0;
  let end = html.length;
  for (let m; (m = divRe.exec(html)); ) {
    if (m[1]) {
      depth--;
      if (depth === 0) {
        end = m.index;
        break;
      }
    } else depth++;
  }
  const rawBody = html.slice(open.index + open[0].length, end);

  let body = normalize(
    decodeEntities(
      rawBody
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        // 块级闭合(含微信最常用的 section)与 <br> 转换行,保住段落结构。
        .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/blockquote)\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
    )
  );

  // 尾部噪声清理:部分文章模板会把「点赞/在看/分享/阅读原文」等纯 UI 短行留在
  // 正文容器结尾(样本文章没有,防御性处理)。只删结尾处的独立短行,绝不动
  // 正文句子(作者自己写的「随手点个赞、在看」这类句子要保留)。
  const lines = body.split("\n");
  const tailNoise =
    /^(点赞|在看|分享|收藏|留言|写留言|阅读原文|微信扫一扫\S*|预览时标签不可点|继续滑动看下一个|轻点两下取消(赞|在看))$/;
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (last === "" || tailNoise.test(last)) lines.pop();
    else break;
  }
  body = lines.join("\n");

  const title =
    (
      metaContent(html, ["og:title"]) ||
      decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
        .replace(/_微信公众平台\s*$/, "")
    )
      .replace(/\s+/g, " ")
      .trim() || "微信公众号文章";

  // 作者与公众号名常常同值(og:article:author 就是公众号名),重复时只留一个。
  const grab = (id: string) =>
    decodeEntities(html.match(new RegExp(`id="${id}"[^>]*>([^<]*)`))?.[1] || "")
      .replace(/\s+/g, " ")
      .trim();
  const author = metaContent(html, ["og:article:author"]) || grab("js_author_name");
  const account = grab("js_name");

  let publishTime = html.match(/var\s+createTime\s*=\s*['"]([\d][\d\s:-]+)['"]/)?.[1]?.trim();
  if (!publishTime) {
    const ts = html.match(/var\s+ct\s*=\s*["'](\d{9,11})["']/)?.[1];
    if (ts) {
      const d = new Date(Number(ts) * 1000);
      // 兜底只取日期(UTC),避免时区换算把时刻标错;createTime 命中时用页面原文。
      if (!Number.isNaN(d.getTime())) publishTime = d.toISOString().slice(0, 10);
    }
  }

  const metaBits: string[] = [];
  if (author) metaBits.push(`作者:${author}`);
  if (account && account !== author) metaBits.push(`公众号:${account}`);
  if (publishTime) metaBits.push(`发布时间:${publishTime}`);
  const header = [title, metaBits.join(" · ")].filter(Boolean).join("\n");
  return { title, text: normalize(`${header}\n\n${body}`) };
}

/** Fetch a URL and reduce the HTML to readable plain text. */
export async function extractUrl(url: string): Promise<{ title: string; text: string; pages?: number }> {
  // 微信公众号文章走专属解析(标题/作者/发布时间/正文容器)。注意:微信风控
  // 对 UA 不敏感、对来源 IP 敏感 —— 住宅/家宽 IP 可正常抓取,云端数据中心 IP
  // 会命中「环境异常」验证页(下面 extractWeChatArticle 里有对应检测与提示)。
  // 这里给微信用桌面 Chrome UA,更接近真实浏览器,降低被风控的概率。
  let isWeChat = false;
  try {
    isWeChat = new URL(url).hostname === "mp.weixin.qq.com";
  } catch {
    /* 无效链接交给 ssrfSafeFetch 统一报错 */
  }
  // H2/SSRF-1:用户可控 URL 必须走 SSRF 安全 fetch(拒私网/元数据,逐跳复检重定向)。
  // maxBytes 放宽到 25MB:论文/智库报告的 PDF 全文常在 8MB 上下(HTML 页远小于此,
  // 流式读满即断,放宽只影响真的大文件)。
  const res = await ssrfSafeFetch(
    url,
    {
      headers: {
        "User-Agent": isWeChat
          ? YT_UA
          : "Mozilla/5.0 (compatible; ApebookLM/0.1; +https://localhost)",
        Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
      },
    },
    { maxBytes: 25 * 1024 * 1024 }
  );
  if (!res.ok) {
    // 按状态码给可操作的中文提示(会直接透传到批量导入结果面板/来源行)。
    const s = res.status;
    if (s === 404 || s === 410) throw new Error(`网页返回 ${s},链接可能已失效,请检查链接是否正确。`);
    if (s === 403 || s === 401) throw new Error(`网页拒绝访问(${s}),站点可能有防爬限制。可将内容复制后以「粘贴文本」方式导入。`);
    if (s === 429) throw new Error("目标站点访问过于频繁(429),请稍后重试。");
    if (s >= 500) throw new Error(`目标站点暂时不可用(${s}),请稍后重试。`);
    throw new Error(`抓取网页失败(${s}),请检查链接或稍后重试。`);
  }
  const buf = await res.arrayBuffer();
  const ctype = res.headers.get("content-type") ?? "";
  // PDF 直链(论文/报告全文):content-type 或魔数 %PDF- 判定(部分站点给 PDF 回
  // application/octet-stream),交给 unpdf 抽全文。标题用 URL 文件名兜底 —— PDF
  // 元数据标题常为空,正文首行通常就是论文标题,导读/概览会补全语义。
  const magic = new Uint8Array(buf.slice(0, 5));
  const isPdf = /application\/pdf/i.test(ctype) || "%PDF-".split("").every((c, i) => magic[i] === c.charCodeAt(0));
  if (isPdf) {
    // 目录页残渣清洗:报告 PDF 前部的目录/图表清单是「标题.....页码」点线串,
    // 混进正文既毁阅读又污染语料。点线+页码模式在真正文里几乎不出现,全局清除。
    const parsed = await extractPdf(buf);
    const text = normalize(parsed.text.replace(/\.{6,}\s*\d+/g, " "));
    if (text.replace(/\s+/g, "").length < 80) {
      throw new Error("PDF 未能提取到文字,可能是扫描件。可下载后以「上传文件」方式导入(支持 OCR)。");
    }
    const name = decodeURIComponent((new URL(url).pathname.split("/").pop() ?? ""))
      .replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim();
    return { title: name || url, text, pages: parsed.pages };
  }
  const html = decodeHtmlBytes(buf, ctype);
  // 微信专属分支:定位 js_content 正文容器 + 验证页检测;其余域名走下方通用逻辑。
  if (isWeChat) return extractWeChatArticle(html);
  const ogTitle = metaContent(html, ["og:title", "twitter:title"]);
  const title = (
    ogTitle ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
    url
  )
    .replace(/\s+/g, " ")
    .trim();
  // Readability 优先;失败/过薄(验证页、空壳 SPA)自然落回启发式与全页,
  // 反爬检测与 og 兜底恰恰依赖全页文本,退化路径语义不变。
  const bodyText = (await readabilityExtract(html, url)) ?? htmlToText(html);
  // 反爬验证页识别:公众号/知乎等站点风控时返回「环境异常/安全验证」页,若被当
  // 正文入库就是脏数据(且 og 兜底还可能带上真实标题,误导用户以为导入成功)。
  // 特征:正文短 + 命中验证话术 → 直接报友好错,引导稍后重试或改粘贴文本。
  const compactBody = bodyText.replace(/\s+/g, "");
  if (
    compactBody.length < 400 &&
    /(环境异常|完成验证|去验证|安全验证|访问异常|访问过于频繁|verify (that )?you are (a )?human|are you a robot|请开启\s*JavaScript)/i.test(compactBody)
  ) {
    throw new Error("目标站点触发了反爬验证,未能获取正文。请稍后重试,或将文章内容复制后以「粘贴文本」方式导入。");
  }
  // 正文太薄(JS 渲染的 SPA / 图片类页面,如花瓣 huaban)时,用 <head> 的
  // og/meta 标题+描述兜底 —— 这些恰是 htmlToText 丢掉的、却往往是页面唯一可读文字。
  if (bodyText.replace(/\s+/g, "").length < 80) {
    const desc = metaContent(html, ["og:description", "twitter:description", "description"]);
    const meta = [title, desc].filter(Boolean).join("\n\n").trim();
    if (meta.replace(/\s+/g, "").length > bodyText.replace(/\s+/g, "").length) {
      return { title, text: meta };
    }
  }
  return { title, text: bodyText };
}

export function normalize(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // 越界/非法码点(如 &#x110000; / &#4294967295;,破损页面会出现)不能直接
    // String.fromCodePoint —— 会抛 RangeError 让整个 URL 不可导入。越界就保留原样。
    .replace(/&#x([0-9a-fA-F]+);/g, (whole, n) => cp(parseInt(n, 16), whole))
    .replace(/&#(\d+);/g, (whole, n) => cp(Number(n), whole));
}

/** 安全码点转字符:越界/NaN 时回退原文,不抛 RangeError。 */
function cp(code: number, fallback: string): string {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : fallback;
}

/** HTML 片段 → 纯文本(标签剥离 + 块级转行)。 */
function fragmentToText(html: string): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return normalize(decodeEntities(cleaned));
}

/** 第一性:网页 = 正文 + 模板噪声(导航/页眉脚/侧栏/推荐位),分离两者是有二十年
 *  研究史的 boilerplate-removal 问题,不该自研启发式。三级退化,每级有 300 字保底,
 *  任何站点都不会比「全页转文本」的旧逻辑差:
 *  ① Mozilla Readability(Firefox 阅读模式同款:文本密度+链接密度+类名启发式,
 *     对 div 汤等非语义化站点也有效)—— linkedom 提供轻量 DOM;
 *  ② 语义标签启发式(剔 nav/header/footer/aside/form + article/main 容器优先)——
 *     Readability 解析失败或产出过薄时兜底;
 *  ③ 剔噪后的全页转文本 —— 最终兜底。 */
async function readabilityExtract(html: string, url: string): Promise<string | null> {
  try {
    const [{ parseHTML }, { Readability }] = await Promise.all([
      import("linkedom"),
      import("@mozilla/readability"),
    ]);
    const { document } = parseHTML(html);
    // linkedom 的 document 无 location;Readability 用 baseURI 解析相对链接。
    try { Object.defineProperty(document, "baseURI", { value: url }); } catch { /* 只影响链接解析 */ }
    const article = new Readability(document as unknown as Document, { charThreshold: 250 }).parse();
    const text = article?.textContent ? normalize(article.textContent) : "";
    return text.length >= 300 ? text : null;
  } catch {
    return null; // 解析崩溃(畸形 HTML)→ 交给下一级
  }
}

function htmlToText(html: string): string {
  const scoped = html
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ");
  const articles = [...scoped.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)]
    .map((m) => fragmentToText(m[1]));
  const best = articles.sort((a, b) => b.length - a.length)[0];
  if (best && best.length >= 300) return best;
  const main = scoped.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (main) {
    const mainText = fragmentToText(main);
    if (mainText.length >= 300) return mainText;
  }
  return fragmentToText(scoped);
}

/** Extract text from a .docx (Word) file. */
export async function extractDocx(buf: ArrayBuffer): Promise<string> {
  type Extract = (o: { buffer: Buffer }) => Promise<{ value: string }>;
  const mod = (await import("mammoth")) as unknown as {
    extractRawText?: Extract;
    default?: { extractRawText?: Extract };
  };
  const extractRawText = mod.extractRawText ?? mod.default?.extractRawText;
  if (!extractRawText) throw new Error("docx 解析模块加载失败");
  const { value } = await extractRawText({ buffer: Buffer.from(buf) });
  return normalize(value || "");
}

/** Extract text from a .pptx (PowerPoint) file — slide text runs in order. */
export async function extractPptx(buf: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)![1], 10);
      const nb = parseInt(b.match(/slide(\d+)/)![1], 10);
      return na - nb;
    });
  const out: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    const xml = await zip.files[slides[i]].async("string");
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) =>
      decodeEntities(m[1])
    );
    if (texts.length) out.push(`[幻灯片 ${i + 1}]\n${texts.join(" ")}`);
  }
  return normalize(out.join("\n\n"));
}

/** Extract text from an .epub file (concatenated chapter HTML, stripped). */
export async function extractEpub(buf: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const docs = Object.keys(zip.files)
    .filter((p) => /\.x?html?$/i.test(p))
    .sort();
  const out: string[] = [];
  for (const p of docs) {
    const html = await zip.files[p].async("string");
    const text = htmlToText(html);
    if (text.trim()) out.push(text);
  }
  return normalize(out.join("\n\n"));
}
