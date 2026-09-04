import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { stampPngProvenance } from "./png-stamp";
import crypto from "node:crypto";
import path from "node:path";
import { CHAT_MODEL, getOpenAI } from "./openai";
import { buildGenerationCorpus } from "./corpus";
import { GROUNDING_RULES, multiSourcePreamble, outputLanguageClause } from "./grounding";
import { getNotebookDirective } from "./settings";
import { getBrowser } from "./infographic";
import { ossEnabled, putObject } from "./oss";
import { writeOssKeySidecar } from "./media-store";
import { checkOutputLanguage, generationRetrievalQuery, mentionedExcludedScopeTerms, missingSupportedVerbatimPhrases, resolveOutputLanguageRequirement, studioInstructionClause } from "./generation-contract";

export const XHS_DIR = path.join(process.cwd(), ".data", "xhs");

// ---------------------------------------------------------------------------
// 小红书知识卡组:LLM 产出卡组 JSON(封面/内容卡/尾卡)→ HTML 模板逐张渲染成
// 1080×1440(3:4)PNG。渲染复用信息图的 Playwright 浏览器单例(见 lib/infographic.ts)。
// content 存卡组 JSON(顶层含 title 与 cards),PNG 存 .data/xhs/<outputId>/<idx>.png。
// ---------------------------------------------------------------------------

type XhsCover = { hook: string; title: string; sub: string };
type XhsCard = { heading: string; points: string[]; tip?: string };
type XhsOutro = { summary: string; cta: string };
export type XhsDeck = { title: string; cover: XhsCover; cards: XhsCard[]; outro: XhsOutro };

const PROMPT = `You are a top 小红书 (Xiaohongshu/RED) knowledge blogger turning the provided sources into a swipeable knowledge-card carousel (图文卡片).
Reply with STRICT JSON only:
{"title":"<整组卡片的标题>","cover":{"hook":"<钩子短语>","title":"<主标题,≤16字>","sub":"<副题一句>"},"cards":[{"heading":"<卡标题,≤14字>","points":["<要点1>","<要点2>","<要点3>"],"tip":"<一句加分小贴士,可省略>"}],"outro":{"summary":"<一句总结>","cta":"<行动号召一句>"}}

小红书爆款文风(务必遵守):
- cover.hook 必须有钩子感:优先用数字/反差/痛点(「90%的人都记错笔记」「3 个技巧就够了」「别再这样做了」式)。数字只能用来源里真实出现的;来源没有可用数字就写反差/痛点式钩子,绝不编造数字。
- 每张内容卡只讲 ONE 个知识点:heading 一句点破(≤14字),points 是 2-4 条口语化短句(每条 ≤40 字,像跟朋友聊天,不写书面长句),tip 可选、给一句可立刻上手的加分小贴士。
- 适量 emoji:每张卡最多 2 个,只放在 heading 或 tip 里,points 正文不放。
- outro.summary 一句话收束整组内容;outro.cta 是行动号召(如「收藏这篇,随时翻出来看」)。

${GROUNDING_RULES}

- Use the dominant language of the sources. No markdown, no citation markers like [1].`;

const clean = (v: unknown) =>
  String(v ?? "")
    .replace(/\[\d+(?:[,，、\s]*\d+)*\]/g, "")
    .replace(/[*`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function normDeck(raw: unknown, language?: string): XhsDeck | null {
  const o = raw as {
    title?: unknown;
    cover?: { hook?: unknown; title?: unknown; sub?: unknown };
    cards?: unknown;
    outro?: { summary?: unknown; cta?: unknown };
  } | null;
  const cards: XhsCard[] = (Array.isArray(o?.cards) ? o!.cards : [])
    .map((c) => {
      const cc = c as { heading?: unknown; points?: unknown; tip?: unknown };
      const points = (Array.isArray(cc?.points) ? cc.points : []).map(clean).filter(Boolean).slice(0, 4);
      const tip = clean(cc?.tip);
      return { heading: clean(cc?.heading), points, ...(tip ? { tip } : {}) };
    })
    .filter((c) => c.heading && c.points.length >= 1)
    .slice(0, 10);
  if (cards.length < 2) return null;
  const fallback = /English/i.test(language || "")
    ? { title: "Knowledge Cards", cta: "Save this post and revisit it later 📌" }
    : /日本語|Japanese/i.test(language || "")
      ? { title: "ナレッジカード", cta: "保存して、あとで見返そう 📌" }
      : /繁體|繁体|Traditional/i.test(language || "")
        ? { title: "知識卡組", cta: "收藏這篇，隨時回來看 📌" }
        : { title: "小红书卡组", cta: "收藏这篇,随时翻出来看 📌" };
  const title = clean(o?.title) || clean(o?.cover?.title) || fallback.title;
  return {
    title,
    cover: {
      hook: clean(o?.cover?.hook),
      title: clean(o?.cover?.title) || title,
      sub: clean(o?.cover?.sub),
    },
    cards,
    outro: {
      summary: clean(o?.outro?.summary) || title,
      cta: clean(o?.outro?.cta) || fallback.cta,
    },
  };
}

/** 卡组规格生成(LLM,STRICT JSON,失败重试一次)。 */
export async function generateDeckFromCorpus(
  corpus: string,
  directive: string,
  count: number,
  instruction?: string,
  language?: string
): Promise<XhsDeck> {
  const countLine = `\n- Create exactly ${count} content cards in "cards". Every card must be source-grounded; vary the angle instead of padding or returning fewer cards.`;
  const effectiveLanguage = resolveOutputLanguageRequirement(language, directive);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await getOpenAI().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.6,
      max_tokens: 3200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${multiSourcePreamble(corpus, "card")}${PROMPT}${countLine}${studioInstructionClause(instruction)}` },
        { role: "user", content: `Sources:\n\n${corpus}${directive}${outputLanguageClause(effectiveLanguage)}` },
      ],
    });
    const txt = res.choices[0]?.message?.content ?? "";
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(txt);
    } catch {
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          /* retry */
        }
      }
    }
    const rawDeck = normDeck(parsed, effectiveLanguage);
    const deck = rawDeck
      ? {
          ...rawDeck,
          cards: rawDeck.cards.filter(
            (card) => mentionedExcludedScopeTerms(JSON.stringify(card), corpus, instruction).length === 0
          ),
        }
      : null;
    if (deck && deck.cards.length === count) {
      const serialized = JSON.stringify(deck);
      if (missingSupportedVerbatimPhrases(serialized, instruction, corpus).length) continue;
      if (mentionedExcludedScopeTerms(serialized, corpus, instruction).length) continue;
      const visible = [
        deck.title,
        deck.cover.hook,
        deck.cover.title,
        deck.cover.sub,
        ...deck.cards.flatMap((card) => [card.heading, ...card.points, card.tip || ""]),
        deck.outro.summary,
        deck.outro.cta,
      ].join("\n");
      if (!checkOutputLanguage(visible, effectiveLanguage).ok) continue;
      return deck;
    }
  }
  throw new Error("生成小红书卡组失败,请重试。");
}

// ---- 配色主题(小红书系:暖米/奶油绿/雾蓝),按 title 文本 hash 稳定挑一套 ----

type XhsTheme = {
  id: string;
  bg: string; // 页面底色
  ink: string; // 主文字
  sub: string; // 次要文字
  accent: string; // 强调色(钩子/角标/序号)
  accentSoft: string; // 强调浅染(贴士底/进度角标底)
  frame: string; // 细边框
  onAccent: string; // 强调色之上的文字
};

const XHS_THEMES: XhsTheme[] = [
  {
    id: "warm", // 暖米
    bg: "#faf4ea",
    ink: "#3d3428",
    sub: "#8a7d6a",
    accent: "#e07850",
    accentSoft: "rgba(224,120,80,.12)",
    frame: "rgba(224,120,80,.30)",
    onAccent: "#fffaf5",
  },
  {
    id: "cream-green", // 奶油绿
    bg: "#f0f6ee",
    ink: "#2e3b31",
    sub: "#74857a",
    accent: "#4f9d6b",
    accentSoft: "rgba(79,157,107,.13)",
    frame: "rgba(79,157,107,.30)",
    onAccent: "#f6fbf7",
  },
  {
    id: "mist-blue", // 雾蓝
    bg: "#eef3f8",
    ink: "#2b3440",
    sub: "#71808f",
    accent: "#5b87c5",
    accentSoft: "rgba(91,135,197,.14)",
    frame: "rgba(91,135,197,.30)",
    onAccent: "#f5f9ff",
  },
  {
    id: "peach", // 蜜桃粉
    bg: "#fdeff1",
    ink: "#46333a",
    sub: "#9a7d85",
    accent: "#e56b8c",
    accentSoft: "rgba(229,107,140,.12)",
    frame: "rgba(229,107,140,.28)",
    onAccent: "#fff7f9",
  },
  {
    id: "latte", // 奶咖
    bg: "#f4efe7",
    ink: "#3f3529",
    sub: "#8b7d6b",
    accent: "#a97a52",
    accentSoft: "rgba(169,122,82,.13)",
    frame: "rgba(169,122,82,.28)",
    onAccent: "#fbf7f1",
  },
  {
    id: "lavender", // 薰衣草
    bg: "#f1eff9",
    ink: "#332f45",
    sub: "#7a748f",
    accent: "#7c6bd6",
    accentSoft: "rgba(124,107,214,.13)",
    frame: "rgba(124,107,214,.28)",
    onAccent: "#f8f6ff",
  },
  {
    id: "sunset", // 暮橘
    bg: "#fbf0e4",
    ink: "#45372a",
    sub: "#97846b",
    accent: "#e08a2e",
    accentSoft: "rgba(224,138,46,.13)",
    frame: "rgba(224,138,46,.28)",
    onAccent: "#fffaf3",
  },
  {
    id: "rose", // 雾玫瑰
    bg: "#f9eef1",
    ink: "#43333a",
    sub: "#94757e",
    accent: "#c25f78",
    accentSoft: "rgba(194,95,120,.12)",
    frame: "rgba(194,95,120,.28)",
    onAccent: "#fef8fa",
  },
  {
    id: "ink-dark", // 墨黑(深色卡,浅字;与所有浅底款拉开对比)
    bg: "#22222b",
    ink: "#f2f1f7",
    sub: "#a8a7b5",
    accent: "#a99bf0",
    accentSoft: "rgba(169,155,240,.16)",
    frame: "rgba(169,155,240,.30)",
    onAccent: "#241f3a",
  },
];

/** 轻量版 pickThemeForText:按标题 hash 稳定挑一套(同一卡组重渲染配色不漂移)。 */
function pickXhsTheme(text: string): XhsTheme {
  let h = 0;
  const t = text || "";
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return XHS_THEMES[h % XHS_THEMES.length];
}

/** 用户在弹窗手选的模版 id → 主题;"auto"/未知/空 返回 null(交给 pickXhsTheme 自动挑)。 */
export function xhsThemeById(id?: string): XhsTheme | null {
  if (!id || id === "auto") return null;
  return XHS_THEMES.find((t) => t.id === id) ?? null;
}

// ---- HTML 模板(1080×1440,3:4)----

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const pad2 = (n: number) => String(n).padStart(2, "0");

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1440px}
#card{position:relative;width:1080px;height:1440px;overflow:hidden;display:flex;flex-direction:column;
  padding:120px 96px 96px;background:var(--bg);color:var(--ink);
  font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,"Segoe UI",Roboto,sans-serif}
.frame{position:absolute;inset:36px;border:3px solid var(--frame);border-radius:40px;pointer-events:none}
/* 基础权益水印：低透明度铺满整卡，免水印权益不注入。 */
.wm{position:absolute;top:-40%;left:-25%;width:150%;height:180%;transform:rotate(-26deg);
  display:flex;flex-wrap:wrap;align-content:center;justify-content:center;gap:64px 96px;
  pointer-events:none;z-index:6;opacity:.09}
.wm span{color:var(--ink);font-size:50px;font-weight:800;letter-spacing:12px;white-space:nowrap}
.progress{position:absolute;top:76px;right:88px;padding:14px 30px;border-radius:999px;background:var(--acsoft);
  color:var(--ac);font-size:32px;font-weight:800;letter-spacing:2px;font-variant-numeric:tabular-nums}
.brand{margin-top:auto;font-size:30px;letter-spacing:1px;color:var(--sub)}
.brand b{color:var(--ac);font-weight:700}
.disclaimer{position:absolute;left:72px;right:72px;bottom:48px;z-index:8;text-align:center;font-size:18px;line-height:1.4;color:var(--sub)}
/* 封面 */
/* 主内容块垂直居中:hook/标题/副题集中在上半部会让中下部大片留白(首版实证),
 * 包一层 flex:1 居中,品牌角标仍锚底部。 */
.cv-main{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-start}
.hook{align-self:flex-start;padding:20px 40px;border-radius:999px;background:var(--ac);color:var(--onac);
  font-size:42px;font-weight:800;line-height:1.3}
.cv-title{margin-top:72px;font-size:104px;font-weight:900;line-height:1.24;letter-spacing:2px;font-feature-settings:"palt" 1}
.cv-rule{margin-top:56px;width:160px;height:10px;border-radius:5px;background:var(--ac)}
.cv-sub{margin-top:48px;font-size:42px;line-height:1.6;color:var(--sub)}
.cv-brand{margin-top:auto;align-self:flex-start;display:flex;align-items:center;gap:18px;padding:22px 36px;
  border-radius:24px;background:var(--acsoft)}
.cv-brand .dot{width:20px;height:20px;border-radius:50%;background:var(--ac)}
.cv-brand span{font-size:32px;font-weight:700;color:var(--ac)}
/* 内容卡 */
.hd{display:flex;align-items:flex-start;gap:26px;padding-right:220px}
.hd i{flex:none;margin-top:12px;width:14px;height:56px;border-radius:7px;background:var(--ac)}
.hd h2{font-size:60px;font-weight:800;line-height:1.3}
.points{margin-top:88px;display:flex;flex-direction:column;gap:56px}
.pt{display:flex;align-items:flex-start;gap:30px}
.pt-n{flex:none;width:56px;height:56px;margin-top:6px;border-radius:18px;display:flex;align-items:center;justify-content:center;
  background:var(--acsoft);color:var(--ac);font-size:30px;font-weight:800}
.pt-t{font-size:42px;line-height:1.6}
.tip{margin-top:auto;margin-bottom:44px;padding:36px 40px;border-radius:28px;background:var(--acsoft)}
.tip-l{font-size:30px;font-weight:800;letter-spacing:2px;color:var(--ac)}
.tip-t{margin-top:14px;font-size:36px;line-height:1.6}
/* 尾卡 */
.ot{display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;flex:1}
.ot-l{font-size:32px;font-weight:800;letter-spacing:6px;color:var(--ac)}
.ot-sum{margin-top:56px;font-size:72px;font-weight:800;line-height:1.5;max-width:860px}
.ot-cta{margin-top:88px;padding:30px 64px;border-radius:999px;background:var(--ac);color:var(--onac);
  font-size:44px;font-weight:800}
.ot-brand{display:flex;flex-direction:column;align-items:center;gap:14px}
.ot-brand .name{font-size:40px;font-weight:800;color:var(--ac);letter-spacing:2px}
.ot-brand .slog{font-size:30px;color:var(--sub);letter-spacing:1px}
`;

// 基础权益水印层（watermark=false 时为空）。由 .wm 对角平铺。
const WM_HTML = `<div class="wm" aria-hidden="true">${"<span>猿笔记</span>".repeat(60)}</div>`;

function wrap(inner: string, t: XhsTheme, watermark: boolean): string {
  const vars = `--bg:${t.bg};--ink:${t.ink};--sub:${t.sub};--ac:${t.accent};--acsoft:${t.accentSoft};--frame:${t.frame};--onac:${t.onAccent}`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${CSS}</style></head>
<body><div id="card" style="${vars}"><span class="frame"></span>${watermark ? WM_HTML : ""}${inner}</div></body></html>`;
}

function coverHtml(deck: XhsDeck, t: XhsTheme, watermark: boolean): string {
  const c = deck.cover;
  return wrap(
    `<div class="cv-main">
  ${c.hook ? `<div class="hook">${esc(c.hook)}</div>` : ""}
  <h1 class="cv-title">${esc(c.title)}</h1>
  <div class="cv-rule"></div>
  ${c.sub ? `<p class="cv-sub">${esc(c.sub)}</p>` : ""}
  </div>
  <div class="cv-brand"><span class="dot"></span><span>猿笔记 · 智能生成</span></div>`,
    t,
    watermark
  );
}

function cardHtml(card: XhsCard, idx: number, pages: number, t: XhsTheme, watermark: boolean): string {
  // 进度角标含封面:第 1 张内容卡 = 02/<总页数>。
  const points = card.points
    .map((p, i) => `<div class="pt"><span class="pt-n">${pad2(i + 1)}</span><span class="pt-t">${esc(p)}</span></div>`)
    .join("");
  return wrap(
    `<div class="progress">${pad2(idx + 2)}/${pad2(pages)}</div>
  <div class="hd"><i></i><h2>${esc(card.heading)}</h2></div>
  <div class="points">${points}</div>
  ${card.tip ? `<div class="tip"><div class="tip-l">小贴士</div><div class="tip-t">${esc(card.tip)}</div></div>` : ""}
  <div class="brand">猿笔记 · 智能生成</div>`,
    t,
    watermark
  );
}

function outroHtml(deck: XhsDeck, t: XhsTheme, watermark: boolean): string {
  return wrap(
    `<div class="ot">
    <div class="ot-l">写在最后</div>
    <div class="ot-sum">${esc(deck.outro.summary)}</div>
    <div class="ot-cta">${esc(deck.outro.cta)}</div>
  </div>
  <div class="ot-brand"><span class="name">猿笔记</span><span class="slog">智能生成 · 把资料变成知识卡片</span></div>`,
    t,
    watermark
  );
}

/** 卡组 → 逐页 HTML(封面 + 内容卡 + 尾卡)。导出供自测脚本直验模板拼装。
 *  themeId:用户手选模版(暖米/奶油绿/雾蓝);"auto"/空 时按标题 hash 自动挑。 */
export function renderDeckPages(deck: XhsDeck, themeId?: string, watermark = false): string[] {
  const t = xhsThemeById(themeId) ?? pickXhsTheme(deck.title);
  const pages = deck.cards.length + 2;
  return [
    coverHtml(deck, t, watermark),
    ...deck.cards.map((c, i) => cardHtml(c, i, pages, t, watermark)),
    outroHtml(deck, t, watermark),
  ];
}

// 同一 browser 单例下的并发渲染闸门:每张卡各开独立 page(上下文互不干扰),
// 但限并发张数,避免一次性开满 10+ 个 page 撑爆内存/CPU。3 张一批经验上稳。
const XHS_RENDER_CONCURRENCY = 3;

/** 渲染单张卡:开 page → setContent → 截图写文件 → 关 page(失败也关,不泄漏 page)。 */
async function renderOneCard(browser: Awaited<ReturnType<typeof getBrowser>>, html: string, outPath: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1440 }, deviceScaleFactor: 2 });
  try {
    await page.setContent(html, { waitUntil: "load" });
    const el = await page.$("#card");
    const buf = el ? await el.screenshot({ type: "png" }) : await page.screenshot({ type: "png" });
    await writeFile(outPath, stampPngProvenance(buf as Buffer)); // 归属追溯:注入 iTXt 猿笔记指纹
  } finally {
    await page.close().catch(() => {});
  }
}

/** 逐张渲染 PNG 写入临时目录(.data/xhs/tmp-*,与最终目录同卷保证 rename 原子)。
 *  同一 browser 单例下按 XHS_RENDER_CONCURRENCY 有限并发渲染(每张独立文件名天然无冲突),
 *  单本子端到端从串行的 ~60s 压到 ~25s;任一张失败即整体抛错并清理 tmpDir。 */
async function renderDeckToTmp(deck: XhsDeck, themeId?: string, watermark = false): Promise<string> {
  // 惰性清扫:进入渲染前顺手清掉历史崩溃(SIGKILL/OOM)残留的超龄 tmp-* 目录(见 sweepStaleXhsTmp)。
  await sweepStaleXhsTmp();
  const tmpDir = path.join(XHS_DIR, `tmp-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  try {
    const browser = await getBrowser();
    const htmls = renderDeckPages(deck, themeId, watermark);
    // 有限并发:滑动窗口,始终最多 XHS_RENDER_CONCURRENCY 张在渲染。任一张抛错向上传播。
    let next = 0;
    async function worker(): Promise<void> {
      while (next < htmls.length) {
        const i = next++;
        await renderOneCard(browser, htmls[i], path.join(tmpDir, `${i}.png`));
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(XHS_RENDER_CONCURRENCY, htmls.length) }, () => worker())
    );
    return tmpDir;
  } catch (e) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

// 崩溃残留清扫:renderDeckToTmp 已 mkdir、但进程被 SIGKILL/OOM 硬杀,tmpDir 永远清不掉,
// .data/xhs/ 下堆积成千 tmp-<uuid>(每目录含整组 PNG,几百 MB 起)。渲染前惰性扫一次,
// 删掉 mtime 早于阈值的 tmp-* 目录(阈值内的可能正被别的在途任务使用,不碰)。
const XHS_TMP_MAX_AGE_MS = 60 * 60 * 1000; // 1 小时:远超单本子渲染耗时,不会误删在途目录
let lastXhsSweep = 0;
async function sweepStaleXhsTmp(): Promise<void> {
  // 进程内节流:同一进程 10 分钟最多扫一次,避免每次生成都 readdir。
  const now = Date.now();
  if (now - lastXhsSweep < 10 * 60 * 1000) return;
  lastXhsSweep = now;
  try {
    const entries = await readdir(XHS_DIR, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.startsWith("tmp-")) continue;
      const full = path.join(XHS_DIR, ent.name);
      try {
        const st = await stat(full);
        if (now - st.mtimeMs > XHS_TMP_MAX_AGE_MS) await rm(full, { recursive: true, force: true });
      } catch {
        /* 单个目录清理失败(并发删/权限)忽略,下轮再试 */
      }
    }
  } catch {
    /* 清扫是尽力而为,失败不影响本次生成 */
  }
}

/**
 * 生成小红书卡组:取材 → LLM 卡组 JSON → 逐张渲染 PNG 到临时目录。
 * 调用方(lib/jobs.ts)createStudioOutput 后用 commitXhsCards(tmpDir, out.id) 落位;
 * 失败时负责清理 tmpDir。opts.count 为内容卡数(4/6/8,默认 6,不含封面尾卡)。
 */
export async function generateXhsCards(
  notebookId: string,
  sourceIds?: string[],
  opts?: { count?: number; language?: string; instruction?: string; memberId?: string | null; theme?: string; watermark?: boolean }
): Promise<{ title: string; content: string; pages: number; tmpDir: string }> {
  const corpus = await buildGenerationCorpus(
    notebookId,
    generationRetrievalQuery(opts?.instruction, "核心知识点 要点 步骤 技巧 数字 误区 对比"),
    sourceIds
  );
  if (!corpus) throw new Error("勾选的内容暂无可用文本,请换选来源/会话/笔记。");
  const instr = opts?.instruction?.trim();
  const directive =
    (await getNotebookDirective(notebookId, opts?.memberId)) +
    outputLanguageClause(opts?.language) +
    studioInstructionClause(instr);
  const count = [4, 6, 8].includes(Math.round(opts?.count ?? 0)) ? Math.round(opts!.count!) : 6;
  const deck = await generateDeckFromCorpus(corpus, directive, count, instr, opts?.language);
  const missing = missingSupportedVerbatimPhrases(JSON.stringify(deck), instr, corpus);
  if (missing.length) throw new Error(`生成结果未执行“原样包含”要求:${missing[0]}`);
  const tmpDir = await renderDeckToTmp(deck, opts?.theme, opts?.watermark ?? false);
  return { title: deck.title, content: JSON.stringify(deck), pages: deck.cards.length + 2, tmpDir };
}

/** 把临时目录里渲染好的整组 PNG 原子挪到永久路径 .data/xhs/<outputId>/。
 *  本地落位后,若 OSS 已配置,额外尽力整组上传并写一个组级旁标(失败静默降级纯本地)。
 *  OSS 未配置 → ossEnabled()=false → 只写本地(与历史逐字节一致)。 */
export async function commitXhsCards(tmpDir: string, outputId: string): Promise<void> {
  await mkdir(XHS_DIR, { recursive: true });
  const destDir = path.join(XHS_DIR, outputId);
  try {
    await rename(tmpDir, destDir);
  } catch (e) {
    // rename 失败(极少:跨卷/目标已存在)→ 临时目录清掉,避免磁盘堆积。
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  if (ossEnabled()) await uploadXhsGroupToOss(destDir, outputId);
}

/** 整组 PNG 逐张上传 OSS(key=media/xhs/<outputId>/<idx>.png),全部成功才写组级旁标
 *  <XHS_DIR>/<outputId>.osskey 存前缀 media/xhs/<outputId>。任一步失败 → 不写旁标 →
 *  serve 走本地(零影响)。绝不抛错。 */
async function uploadXhsGroupToOss(destDir: string, outputId: string): Promise<void> {
  try {
    const files = (await readdir(destDir)).filter((f) => /^(0|[1-9][0-9]?)\.png$/.test(f));
    if (!files.length) return;
    const prefix = `media/xhs/${outputId}`;
    for (const f of files) {
      await putObject(`${prefix}/${f}`, path.join(destDir, f), "image/png");
    }
    // 全组上传成功才落旁标,serve 才会对整组 302;部分失败则整组仍走本地,避免半上传缺页。
    await writeOssKeySidecar(path.join(XHS_DIR, outputId), prefix);
  } catch (e) {
    console.warn("[xhs] OSS 整组上传失败,降级纯本地:", (e as Error).message);
  }
}
