import { mkdir, writeFile } from "node:fs/promises";
import { stampPngProvenance } from "./png-stamp";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { CHAT_MODEL, VISION_MODEL, getOpenAI } from "./openai";
import { buildGenerationCorpus } from "./corpus";
import { GROUNDING_RULES, multiSourcePreamble, outputLanguageClause } from "./grounding";
import { pickThemeForText } from "./slide-themes";
import { getNotebookDirective } from "./settings";
import { ossEnabled, putObject } from "./oss";
import { uploadAndMarkOss } from "./media-store";
import { checkOutputLanguage, generationRetrievalQuery, mentionedExcludedScopeTerms, missingSupportedVerbatimPhrases, requestedCount, resolveOutputLanguageRequirement, studioInstructionClause } from "./generation-contract";

export const INFOGRAPHIC_DIR = path.join(process.cwd(), ".data", "infographic");

// ---------------------------------------------------------------------------
// 「多样图解块」信息图:模型按内容给每段选图解类型(流程/金字塔/对比/数据/时间线/要点),
// 各自渲染成不同图解,而非千篇一律的文字卡。
// ---------------------------------------------------------------------------

type LT = { label: string; text: string };
type Block =
  | { type: "steps"; title: string; items: LT[] }
  | { type: "pyramid"; title: string; tiers: LT[] }
  | { type: "timeline"; title: string; items: LT[] }
  | { type: "points"; title: string; items: LT[] }
  | { type: "stats"; title: string; items: { value: string; label: string }[] }
  | { type: "compare"; title: string; left: { label: string; points: string[] }; right: { label: string; points: string[] } };
type Spec = { language: string; title: string; subtitle: string; blocks: Block[]; takeaway?: string };

function infographicVisibleText(spec: Spec): string {
  const text = [spec.title, spec.subtitle, spec.takeaway || ""];
  for (const block of spec.blocks) {
    text.push(block.title);
    if (block.type === "compare") {
      text.push(block.left.label, ...block.left.points, block.right.label, ...block.right.points);
    } else if (block.type === "pyramid") {
      for (const item of block.tiers) text.push(item.label, item.text);
    } else if (block.type === "stats") {
      for (const item of block.items) text.push(item.value, item.label);
    } else {
      for (const item of block.items) text.push(item.label, item.text);
    }
  }
  return text.filter(Boolean).join("\n");
}

const PROMPT = `You are designing a one-page infographic POSTER that visually explains the provided sources.
Reply with STRICT JSON only: {"language":"<zh or en>","title":"<punchy title>","subtitle":"<one short sentence>","blocks":[<Block>...],"takeaway":"<one-sentence key takeaway>"}

Each <Block> is exactly ONE of these diagram types — CHOOSE the type that best fits each cluster of source content:
1. {"type":"steps","title":"<short>","items":[{"label":"<step name>","text":"<short>"}]}  — a process / how-to / workflow (3-5 ordered steps).
2. {"type":"pyramid","title":"<short>","tiers":[{"label":"<short>","text":"<short>"}]}  — a hierarchy / ranking / priority (3-4 tiers, MOST important first → least).
3. {"type":"compare","title":"<short>","left":{"label":"<side A>","points":["..."]},"right":{"label":"<side B>","points":["..."]}}  — A vs B (2-4 points each).
4. {"type":"stats","title":"<short>","items":[{"value":"<number e.g. 168 / 42% / 3x>","label":"<what it measures>"}]}  — striking numbers (2-4).
5. {"type":"timeline","title":"<short>","items":[{"label":"<time/phase>","text":"<what happens>"}]}  — chronology / roadmap (3-5).
6. {"type":"points","title":"<short>","items":[{"label":"<short>","text":"<1 sentence>"}]}  — key points as cards (3-4). Use sparingly.

Rules:
- 4 to 6 blocks. VARY the types — do NOT make everything "points". A process→steps; a ranking/levels→pyramid; an A-vs-B→compare; numbers→stats; a sequence over time→timeline.
- Stay FAITHFUL to the sources: real topics, terms, numbers. If the sources are a Q&A conversation, base blocks on the actual questions/answers. A "stats" block may use ONLY numbers that literally appear in the sources — never invent, round, or estimate a figure to fill a stat; drop the stats block if there are no real numbers.

${GROUNDING_RULES}

- Use the dominant language of the sources. No markdown, no citation markers like [1].`;

const clean = (v: unknown) =>
  String(v ?? "")
    .replace(/\[\d+(?:[,，、\s]*\d+)*\]/g, "")
    .replace(/[*`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function normBlocks(raw: unknown): Block[] {
  if (!Array.isArray(raw)) return [];
  const out: Block[] = [];
  const lts = (arr: unknown, n: number): LT[] =>
    (Array.isArray(arr) ? arr : [])
      .map((it) => ({ label: clean((it as LT)?.label), text: clean((it as LT)?.text) }))
      .filter((it) => it.label || it.text)
      .slice(0, n);
  for (const b of raw) {
    const o = b as { type?: string; title?: unknown; items?: unknown; tiers?: unknown; left?: { label?: unknown; points?: unknown }; right?: { label?: unknown; points?: unknown } };
    const title = clean(o?.title);
    if (!title) continue;
    if (o.type === "steps" || o.type === "timeline" || o.type === "points") {
      const items = lts(o.items, 5);
      if (items.length >= 2) out.push({ type: o.type, title, items });
    } else if (o.type === "pyramid") {
      const tiers = lts(o.tiers, 4).filter((t) => t.label);
      if (tiers.length >= 2) out.push({ type: "pyramid", title, tiers });
    } else if (o.type === "stats") {
      const items = (Array.isArray(o.items) ? o.items : [])
        .map((it) => ({ value: clean((it as { value?: unknown }).value).slice(0, 12), label: clean((it as { label?: unknown }).label) }))
        .filter((it) => it.value)
        .slice(0, 4);
      if (items.length >= 2) out.push({ type: "stats", title, items });
    } else if (o.type === "compare") {
      const col = (c?: { label?: unknown; points?: unknown }) => ({
        label: clean(c?.label),
        points: (Array.isArray(c?.points) ? c!.points : []).map(clean).filter(Boolean).slice(0, 4),
      });
      const left = col(o.left);
      const right = col(o.right);
      if (left.points.length && right.points.length) out.push({ type: "compare", title, left, right });
    }
  }
  return out.slice(0, 6);
}

/** Core spec generation from a raw corpus string. The eval harness and the
 *  vision-critique loop drive this with fixed input; generateInfographic builds
 *  the corpus from the DB and feeds it here. `feedback` carries a prior round's
 *  critic notes so the model can correct specific problems. */
export async function generateSpecFromCorpus(
  corpus: string,
  directive = "",
  feedback = "",
  instruction?: string,
  language?: string
): Promise<Spec> {
  const effectiveLanguage = resolveOutputLanguageRequirement(language, directive);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await getOpenAI().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.5,
      max_tokens: 3600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${multiSourcePreamble(corpus, "block")}${PROMPT}${studioInstructionClause(instruction)}` },
        { role: "user", content: `Sources:\n\n${corpus}${directive}${outputLanguageClause(effectiveLanguage)}${feedback}` },
      ],
    });
    const rawTxt = res.choices[0]?.message?.content ?? "";
    let parsed: { language?: string; title?: unknown; subtitle?: unknown; blocks?: unknown; takeaway?: unknown } | null = null;
    try {
      parsed = JSON.parse(rawTxt);
    } catch {
      const m = rawTxt.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          /* retry */
        }
      }
    }
    const blocks = normBlocks(parsed?.blocks).filter(
      (block) => mentionedExcludedScopeTerms(JSON.stringify(block), corpus, instruction).length === 0
    );
    if (blocks.length >= 4) {
      const spec: Spec = {
        language: effectiveLanguage || parsed?.language || "",
        title: clean(parsed?.title) || "Infographic",
        subtitle: clean(parsed?.subtitle),
        blocks,
        takeaway: clean(parsed?.takeaway) || undefined,
      };
      const serialized = JSON.stringify(spec);
      if (missingSupportedVerbatimPhrases(serialized, instruction, corpus).length) continue;
      if (mentionedExcludedScopeTerms(serialized, corpus, instruction).length) continue;
      if (!checkOutputLanguage(infographicVisibleText(spec), effectiveLanguage).ok) continue;
      return spec;
    }
  }
  throw new Error("生成信息图失败,请重试。");
}

// ---- themes (5 套,与 PPT 同名同色) ----

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function rgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

type IgTheme = {
  id: string;
  bgs: string[];
  deco: string;
  kicker: string;
  rule: string;
  title: string;
  sub: string;
  cardBg: string;
  cardShadow: string;
  heading: string;
  detail: string;
  badgeText: string;
  takeBg: string;
  takeBorder: string;
  takeLabel: string;
  takeText: string;
  footer: string;
  fontHead: string;
  palette: { a: string; b: string }[];
  grid: string;
  bracket: string;
  radar: string;
  cardGlow: string;
  statGlow: string;
};

const SERIF = "Georgia,'Songti SC','STSong','SimSun',serif";

const IG_THEMES: Record<string, IgTheme> = {
  midnight: {
    id: "midnight",
    bgs: [
      "radial-gradient(900px 520px at 86% -8%,rgba(124,92,252,.22),transparent 60%),radial-gradient(720px 520px at -8% 112%,rgba(159,140,255,.14),transparent 60%),linear-gradient(160deg,#15151f,#0c0c16)",
      "radial-gradient(820px 520px at 12% -6%,rgba(99,102,241,.24),transparent 60%),radial-gradient(680px 480px at 104% 108%,rgba(124,92,252,.14),transparent 60%),linear-gradient(185deg,#141226,#0b0a16)",
      "radial-gradient(760px 560px at 50% -16%,rgba(139,124,255,.20),transparent 62%),linear-gradient(150deg,#17141f,#0c0c15)",
    ],
    deco: "rgba(124,92,252,.20)",
    kicker: "#b9abff",
    rule: "linear-gradient(90deg,#9f8cff,#7c5cfc)",
    title: "linear-gradient(180deg,#ffffff,#d2c8f8)",
    sub: "#aeb2c6",
    cardBg: "linear-gradient(165deg,rgba(255,255,255,.055),rgba(255,255,255,.012))",
    cardShadow: "0 12px 34px rgba(0,0,0,.30),inset 0 1px 0 rgba(255,255,255,.05)",
    heading: "#f3f0ff",
    detail: "#aeb2c6",
    badgeText: "#160a2e",
    takeBg: "linear-gradient(100deg,rgba(124,92,252,.18),rgba(159,140,255,.10))",
    takeBorder: "rgba(124,92,252,.42)",
    takeLabel: "#b9abff",
    takeText: "#efeaff",
    footer: "#7c7790",
    fontHead: "inherit",
    palette: [
      { a: "#9f8cff", b: "#7c5cfc" },
      { a: "#e08aa9", b: "#cf6f92" },
      { a: "#62c79e", b: "#3fae82" },
      { a: "#e0b35f", b: "#c9943c" },
      { a: "#8fb3ff", b: "#6d8fe6" },
      { a: "#d59cff", b: "#b06fe6" },
    ],
    grid: "rgba(159,140,255,.06)",
    bracket: "#7c5cfc",
    radar: "#9f8cff",
    cardGlow: "0 0 34px -14px var(--ac)",
    statGlow: "0 0 22px var(--acg)",
  },
  paper: {
    id: "paper",
    bgs: [
      "linear-gradient(160deg,#fbfbfe,#eef0f7)",
      "radial-gradient(700px 460px at 90% -10%,rgba(109,90,230,.07),transparent 60%),linear-gradient(180deg,#fcfcff,#eceef6)",
      "linear-gradient(150deg,#f7f8fc,#e9ecf5)",
    ],
    deco: "rgba(109,90,230,.12)",
    kicker: "#6d5ae6",
    rule: "linear-gradient(90deg,#6d5ae6,#9b8cf0)",
    title: "linear-gradient(180deg,#1f2230,#3b3658)",
    sub: "#6b6f7e",
    cardBg: "#ffffff",
    cardShadow: "0 10px 26px rgba(20,24,60,.08),0 1px 0 rgba(20,24,60,.03)",
    heading: "#1f2230",
    detail: "#5a5f70",
    badgeText: "#ffffff",
    takeBg: "linear-gradient(100deg,rgba(109,90,230,.10),rgba(109,90,230,.035))",
    takeBorder: "rgba(109,90,230,.28)",
    takeLabel: "#6d5ae6",
    takeText: "#2a2c39",
    footer: "#9094a0",
    fontHead: "inherit",
    palette: [
      { a: "#5b6b85", b: "#41506b" },
      { a: "#c06b4f", b: "#a8543b" },
      { a: "#5f8f6e", b: "#487556" },
      { a: "#b08a3e", b: "#94722d" },
      { a: "#6d5ae6", b: "#5544c4" },
      { a: "#4f8cd9", b: "#3a72bd" },
    ],
    grid: "rgba(30,34,80,.05)",
    bracket: "rgba(109,90,230,.45)",
    radar: "#6d5ae6",
    cardGlow: "0 0 0 rgba(0,0,0,0)",
    statGlow: "none",
  },
  aurora: {
    id: "aurora",
    bgs: [
      "radial-gradient(820px 500px at 88% -10%,rgba(255,255,255,.16),transparent 60%),linear-gradient(135deg,#6d5ae6,#7f63ea 45%,#4f8cd9)",
      "radial-gradient(760px 520px at 10% -8%,rgba(255,255,255,.16),transparent 60%),linear-gradient(150deg,#7a5cf0,#5b7ee6 55%,#48b0d8)",
      "linear-gradient(125deg,#6a4fe0,#9a5fe2 42%,#5b8be6)",
    ],
    deco: "rgba(255,255,255,.24)",
    kicker: "#ffe49a",
    rule: "linear-gradient(90deg,#ffe49a,#ffc2d4)",
    title: "linear-gradient(180deg,#ffffff,#eef3ff)",
    sub: "rgba(255,255,255,.86)",
    cardBg: "rgba(255,255,255,.13)",
    cardShadow: "0 12px 34px rgba(20,16,60,.22),inset 0 1px 0 rgba(255,255,255,.20)",
    heading: "#ffffff",
    detail: "rgba(255,255,255,.88)",
    badgeText: "#2a1d4d",
    takeBg: "rgba(255,255,255,.14)",
    takeBorder: "rgba(255,255,255,.42)",
    takeLabel: "#ffe49a",
    takeText: "#ffffff",
    footer: "rgba(255,255,255,.72)",
    fontHead: "inherit",
    palette: [
      { a: "#ffe49a", b: "#f5c95f" },
      { a: "#ffc2d4", b: "#f49bb6" },
      { a: "#b1f0d4", b: "#84d9b3" },
      { a: "#cfe4ff", b: "#a6c8f5" },
      { a: "#ffffff", b: "#dfe6ff" },
      { a: "#ffd9a6", b: "#f5b878" },
    ],
    grid: "rgba(255,255,255,.09)",
    bracket: "rgba(255,255,255,.7)",
    radar: "#ffffff",
    cardGlow: "0 0 30px -14px rgba(255,255,255,.5)",
    statGlow: "0 0 20px rgba(255,255,255,.45)",
  },
  sunrise: {
    id: "sunrise",
    bgs: [
      "radial-gradient(820px 520px at 88% -10%,rgba(232,134,46,.13),transparent 60%),linear-gradient(160deg,#fdf7ed,#f7ead6)",
      "radial-gradient(760px 500px at 8% -8%,rgba(232,134,46,.12),transparent 60%),linear-gradient(180deg,#fef9f0,#f6e6cf)",
      "linear-gradient(150deg,#fdf5e8,#f3e2c8)",
    ],
    deco: "rgba(232,134,46,.18)",
    kicker: "#c2702c",
    rule: "linear-gradient(90deg,#e8862e,#c2702c)",
    title: "linear-gradient(180deg,#7a3d12,#9a5520)",
    sub: "#8a7257",
    cardBg: "#fffdf8",
    cardShadow: "0 10px 26px rgba(120,80,20,.10)",
    heading: "#5c3a1c",
    detail: "#6b5944",
    badgeText: "#fff7ec",
    takeBg: "linear-gradient(100deg,rgba(232,134,46,.12),rgba(232,134,46,.05))",
    takeBorder: "rgba(232,134,46,.30)",
    takeLabel: "#c2702c",
    takeText: "#5c3a1c",
    footer: "#b59f8a",
    fontHead: SERIF,
    palette: [
      { a: "#c2702c", b: "#a85a1e" },
      { a: "#a8534f", b: "#8e3f3b" },
      { a: "#6e8d54", b: "#577541" },
      { a: "#7a6aa8", b: "#615190" },
      { a: "#bb8a2c", b: "#9c711e" },
      { a: "#b85c3c", b: "#9c4729" },
    ],
    grid: "rgba(120,80,20,.06)",
    bracket: "rgba(232,134,46,.5)",
    radar: "#c2702c",
    cardGlow: "0 0 0 rgba(0,0,0,0)",
    statGlow: "none",
  },
  forest: {
    id: "forest",
    bgs: [
      "radial-gradient(900px 520px at 86% -8%,rgba(47,174,132,.20),transparent 60%),radial-gradient(700px 500px at -8% 112%,rgba(143,199,232,.10),transparent 60%),linear-gradient(160deg,#103127,#0a211b)",
      "radial-gradient(820px 520px at 12% -6%,rgba(47,174,132,.20),transparent 60%),radial-gradient(680px 480px at 104% 108%,rgba(143,199,232,.10),transparent 60%),linear-gradient(175deg,#0f2f26,#08201a)",
      "radial-gradient(760px 560px at 50% -16%,rgba(63,190,148,.18),transparent 62%),linear-gradient(150deg,#123329,#0a221c)",
    ],
    deco: "rgba(47,174,132,.20)",
    kicker: "#a4e6c4",
    rule: "linear-gradient(90deg,#6fd4a8,#2fae84)",
    title: "linear-gradient(180deg,#ffffff,#c6efdb)",
    sub: "#9fbcb0",
    cardBg: "linear-gradient(165deg,rgba(255,255,255,.05),rgba(255,255,255,.012))",
    cardShadow: "0 12px 34px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.05)",
    heading: "#e8f5ee",
    detail: "#9fbcb0",
    badgeText: "#04201a",
    takeBg: "linear-gradient(100deg,rgba(47,174,132,.16),rgba(143,199,232,.08))",
    takeBorder: "rgba(47,174,132,.42)",
    takeLabel: "#a4e6c4",
    takeText: "#e8f5ee",
    footer: "#6f9486",
    fontHead: "inherit",
    palette: [
      { a: "#6fd4a8", b: "#3fae84" },
      { a: "#e8c170", b: "#c99c3c" },
      { a: "#8fc7e8", b: "#5fa3cf" },
      { a: "#e09a8a", b: "#c4756a" },
      { a: "#a4e6c4", b: "#6fd4a8" },
      { a: "#bfe08a", b: "#9cc45f" },
    ],
    grid: "rgba(47,174,132,.07)",
    bracket: "#2fae84",
    radar: "#6fd4a8",
    cardGlow: "0 0 34px -14px var(--ac)",
    statGlow: "0 0 22px var(--acg)",
  },
};

function igTheme(id?: string | null): IgTheme {
  return IG_THEMES[(id as string) ?? ""] ?? IG_THEMES.midnight;
}

const ICONS = [
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V11M10 21V5M15 21V14M20 21V8"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="13" cy="18" r="2.2"/><path d="M7.8 8.2 11.3 16M16.2 7.4 13.7 16"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 16l9 5 9-5"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 1 3.8 10.6c-.6.5-.9 1-1 1.9h-5.6c-.1-.9-.4-1.4-1-1.9A6 6 0 0 1 12 3z"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>',
];

const RADAR = `<svg class="radar" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1"><circle cx="60" cy="60" r="20" stroke-opacity=".5"/><circle cx="60" cy="60" r="38" stroke-opacity=".34"/><circle cx="60" cy="60" r="56" stroke-opacity=".2"/><line x1="60" y1="60" x2="60" y2="6" stroke-opacity=".4"/><line x1="60" y1="60" x2="104" y2="80" stroke-opacity=".28"/><circle cx="60" cy="60" r="3" fill="currentColor" stroke="none"/></svg>`;

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
#poster{width:1240px;position:relative;isolation:isolate;padding:60px 56px;overflow:hidden;
  font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,"Segoe UI",Roboto,sans-serif;
  color:var(--detail);background:var(--bg)}
.fx{position:absolute;inset:0;z-index:0;pointer-events:none;background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:46px 46px;-webkit-mask-image:linear-gradient(180deg,#000 0%,transparent 64%);mask-image:linear-gradient(180deg,#000 0%,transparent 64%)}
.corner{position:absolute;width:26px;height:26px;z-index:0;border:0 solid var(--bracket)}
.corner.tl{top:24px;left:24px;border-top-width:2px;border-left-width:2px}
.corner.tr{top:24px;right:24px;border-top-width:2px;border-right-width:2px}
.corner.bl{bottom:24px;left:24px;border-bottom-width:2px;border-left-width:2px}
.corner.br{bottom:24px;right:24px;border-bottom-width:2px;border-right-width:2px}
.radar{position:absolute;top:40px;right:46px;width:118px;height:118px;z-index:0;color:var(--radar);opacity:.75}
header,.block,.takeaway,footer{position:relative;z-index:1}
header{margin-bottom:26px}
.kicker{display:flex;align-items:center;gap:11px;font-size:18px;font-weight:700;letter-spacing:1px;color:var(--kicker)}
.kicker i{width:28px;height:3px;border-radius:2px;background:var(--rule)}
h1{margin-top:16px;font-size:56px;font-weight:800;line-height:1.2;letter-spacing:0;font-feature-settings:"palt" 1;max-width:820px;font-family:var(--fhead);background:var(--title);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{margin-top:14px;font-size:23px;line-height:1.5;max-width:900px;color:var(--sub)}
.rule{margin-top:20px;width:124px;height:6px;border-radius:3px;background:var(--rule)}
.block{margin-top:20px;padding:28px 32px;border-radius:22px;overflow:hidden;background:var(--cardbg);border:1px solid var(--acb);box-shadow:var(--cardsh),var(--cardglow)}
.block::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--ac),transparent 80%);box-shadow:0 0 12px var(--acg)}
.bhead{display:flex;align-items:center;gap:13px;margin-bottom:20px}
.bnum{flex:none;width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:var(--badget);background:linear-gradient(150deg,var(--ac),var(--ac2));box-shadow:0 6px 15px var(--acg)}
.btitle{flex:1;font-size:27px;font-weight:700;color:var(--heading);font-family:var(--fhead);line-height:1.32}
.bico{flex:none;width:30px;height:30px;color:var(--ac);opacity:.5}
.bico svg{width:100%;height:100%}
/* steps */
.steps{display:flex;align-items:stretch}
.step{flex:1;display:flex}
.step-in{flex:1;border-radius:15px;padding:16px 18px;background:var(--acw);border:1px solid var(--acb)}
.step-n{font-size:13px;font-weight:800;letter-spacing:1px;color:var(--ac)}
.step-l{margin-top:5px;font-size:20px;font-weight:700;color:var(--heading);line-height:1.25}
.step-t{margin-top:7px;font-size:16px;line-height:1.5;color:var(--detail)}
.step-arr{flex:none;align-self:center;width:34px;text-align:center;font-size:26px;font-weight:300;color:var(--ac)}
/* pyramid */
.pyramid{display:flex;flex-direction:column;align-items:center;gap:8px}
.tier{border-radius:12px;padding:14px 24px;text-align:center;border:1px solid var(--acb)}
.tier-l{font-size:20px;font-weight:700;color:var(--heading)}
.tier-t{display:block;margin-top:3px;font-size:15px;line-height:1.4;color:var(--detail)}
/* compare */
.compare{display:grid;grid-template-columns:1fr 46px 1fr;align-items:stretch;gap:6px}
.cmp{border-radius:15px;padding:18px 20px;background:var(--acw);border:1px solid var(--acb)}
.cmp-l{font-size:20px;font-weight:700;color:var(--ac);margin-bottom:10px}
.cmp-p{position:relative;padding-left:18px;margin-top:8px;font-size:16px;line-height:1.5;color:var(--detail)}
.cmp-p::before{content:"";position:absolute;left:2px;top:9px;width:7px;height:7px;border-radius:2px;background:var(--ac)}
.vs{align-self:center;text-align:center;font-size:18px;font-weight:800;color:var(--ac)}
/* stats */
.stats{display:grid;gap:16px}
.stat-t{text-align:center;padding:14px 10px;border-radius:15px;background:var(--acw);border:1px solid var(--acb)}
.stat-v{font-size:50px;font-weight:800;letter-spacing:0;line-height:1;color:var(--ac);text-shadow:var(--statglow);font-family:"SF Pro Display",Inter,var(--fhead),sans-serif;font-variant-numeric:lining-nums tabular-nums slashed-zero}
.stat-l{margin-top:8px;font-size:16px;line-height:1.4;color:var(--detail)}
/* timeline */
.timeline{display:flex;position:relative;padding-top:30px}
.tl-line{position:absolute;top:9px;left:5%;right:5%;height:2px;background:var(--acb)}
.tl-i{flex:1;text-align:center;position:relative;padding:0 8px}
.tl-d{position:absolute;top:-26px;left:50%;transform:translateX(-50%);width:15px;height:15px;border-radius:50%;background:var(--ac);box-shadow:0 0 12px var(--acg)}
.tl-l{font-size:18px;font-weight:700;color:var(--ac)}
.tl-t{margin-top:6px;font-size:15px;line-height:1.45;color:var(--detail)}
/* points */
.points{display:grid;gap:16px}
.point{border-radius:14px;padding:16px 18px;background:var(--acw);border:1px solid var(--acb)}
.point-l{font-size:19px;font-weight:700;color:var(--heading);line-height:1.25}
.point-t{margin-top:6px;font-size:16px;line-height:1.5;color:var(--detail)}
/* takeaway / footer */
.takeaway{margin-top:22px;padding:28px 36px;border-radius:22px;background:var(--takebg);border:1px solid var(--takeborder)}
.tk-label{font-size:15px;font-weight:800;letter-spacing:1px;color:var(--takelabel)}
.tk-text{margin-top:11px;font-size:27px;font-weight:700;line-height:1.5;color:var(--taketext);font-family:var(--fhead)}
footer{margin-top:30px;font-size:17px;line-height:1.55;letter-spacing:.5px;color:var(--footer)}
`;

function renderSteps(items: LT[]): string {
  const cells = items.map(
    (it, i) =>
      `<div class="step"><div class="step-in"><div class="step-n">STEP ${i + 1}</div><div class="step-l">${esc(it.label)}</div>${it.text ? `<div class="step-t">${esc(it.text)}</div>` : ""}</div></div>`
  );
  return `<div class="steps">${cells.join('<div class="step-arr">›</div>')}</div>`;
}
function renderPyramid(tiers: LT[], ac: string): string {
  const n = tiers.length;
  const rows = tiers.map((it, i) => {
    const w = 50 + (i * 48) / Math.max(n - 1, 1);
    const op = 0.14 + (i * 0.26) / Math.max(n - 1, 1);
    return `<div class="tier" style="width:${w.toFixed(0)}%;background:${rgba(ac, op)}"><span class="tier-l">${esc(it.label)}</span>${it.text ? `<span class="tier-t">${esc(it.text)}</span>` : ""}</div>`;
  });
  return `<div class="pyramid">${rows.join("")}</div>`;
}
function renderCompare(left: { label: string; points: string[] }, right: { label: string; points: string[] }): string {
  const col = (c: { label: string; points: string[] }) =>
    `<div class="cmp"><div class="cmp-l">${esc(c.label)}</div>${c.points.map((p) => `<div class="cmp-p">${esc(p)}</div>`).join("")}</div>`;
  return `<div class="compare">${col(left)}<div class="vs">VS</div>${col(right)}</div>`;
}
function renderStats(items: { value: string; label: string }[]): string {
  const tiles = items.map((it) => `<div class="stat-t"><div class="stat-v">${esc(it.value)}</div><div class="stat-l">${esc(it.label)}</div></div>`);
  return `<div class="stats" style="grid-template-columns:repeat(${items.length},1fr)">${tiles.join("")}</div>`;
}
function renderTimeline(items: LT[]): string {
  const cells = items.map(
    (it) => `<div class="tl-i"><span class="tl-d"></span><div class="tl-l">${esc(it.label)}</div>${it.text ? `<div class="tl-t">${esc(it.text)}</div>` : ""}</div>`
  );
  return `<div class="timeline"><span class="tl-line"></span>${cells.join("")}</div>`;
}
function renderPoints(items: LT[]): string {
  const cards = items.map((it) => `<div class="point"><div class="point-l">${esc(it.label)}</div>${it.text ? `<div class="point-t">${esc(it.text)}</div>` : ""}</div>`);
  return `<div class="points" style="grid-template-columns:repeat(${Math.min(items.length, 3)},1fr)">${cards.join("")}</div>`;
}

function renderBlock(b: Block, i: number, t: IgTheme): string {
  const c = t.palette[i % t.palette.length];
  const vars = `--ac:${c.a};--ac2:${c.b};--acb:${rgba(c.a, 0.34)};--acg:${rgba(c.a, 0.3)};--acw:${rgba(c.a, 0.1)}`;
  const head = `<div class="bhead"><span class="bnum">${i + 1}</span><h2 class="btitle">${esc(b.title)}</h2><span class="bico">${ICONS[i % ICONS.length]}</span></div>`;
  let body: string;
  switch (b.type) {
    case "steps":
      body = renderSteps(b.items);
      break;
    case "pyramid":
      body = renderPyramid(b.tiers, c.a);
      break;
    case "compare":
      body = renderCompare(b.left, b.right);
      break;
    case "stats":
      body = renderStats(b.items);
      break;
    case "timeline":
      body = renderTimeline(b.items);
      break;
    default:
      body = renderPoints(b.items);
  }
  return `<section class="block" style="${vars}">${head}${body}</section>`;
}

// 基础权益水印：低透明度铺满海报（内联样式，自包含；免水印权益不注入）。
function igWatermark(t: IgTheme): string {
  const span = `<span style="color:${t.detail};font-size:58px;font-weight:800;letter-spacing:16px;white-space:nowrap">猿笔记</span>`;
  return `<div aria-hidden="true" style="position:absolute;top:-45%;left:-25%;width:150%;height:190%;transform:rotate(-26deg);display:flex;flex-wrap:wrap;align-content:center;justify-content:center;gap:70px 130px;pointer-events:none;z-index:30;opacity:.08">${span.repeat(120)}</div>`;
}

function renderHtml(spec: Spec, t: IgTheme, watermark = false): string {
  const bg = t.bgs[Math.floor(Math.random() * t.bgs.length)];
  const posterStyle = [
    `--bg:${bg}`,
    `--kicker:${t.kicker}`,
    `--rule:${t.rule}`,
    `--title:${t.title}`,
    `--sub:${t.sub}`,
    `--cardbg:${t.cardBg}`,
    `--cardsh:${t.cardShadow}`,
    `--heading:${t.heading}`,
    `--detail:${t.detail}`,
    `--badget:${t.badgeText}`,
    `--takebg:${t.takeBg}`,
    `--takeborder:${t.takeBorder}`,
    `--takelabel:${t.takeLabel}`,
    `--taketext:${t.takeText}`,
    `--footer:${t.footer}`,
    `--fhead:${t.fontHead}`,
    `--grid:${t.grid}`,
    `--bracket:${t.bracket}`,
    `--radar:${t.radar}`,
    `--cardglow:${t.cardGlow}`,
    `--statglow:${t.statGlow}`,
  ].join(";");
  const blocks = spec.blocks.map((b, i) => renderBlock(b, i, t)).join("");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${CSS}</style></head>
<body><div id="poster" style="${posterStyle}">
  ${watermark ? igWatermark(t) : ""}
  <span class="fx"></span>
  <span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>
  ${RADAR}
  <header>
    <div class="kicker"><i></i>信息图速览</div>
    <h1>${esc(spec.title)}</h1>
    ${spec.subtitle ? `<p class="sub">${esc(spec.subtitle)}</p>` : ""}
    <div class="rule"></div>
  </header>
  ${blocks}
  ${spec.takeaway ? `<div class="takeaway"><div class="tk-label">核心结论</div><div class="tk-text">${esc(spec.takeaway)}</div></div>` : ""}
  <footer>由猿笔记生成 · 信息图</footer>
</div></body></html>`;
}

// 复用一个无头浏览器实例(每次生成都重新启动太慢)。优先用系统 Chrome/Edge。
// 缓存在 globalThis:模块级 let 在 Next.js dev 每次热重载都会重置 → 旧 Chromium 引用丢失、
// 进程泄漏(每次热重载堆一个,RSS 飙升直至 OOM)。globalThis 跨热重载复用同一实例。
const gBrowser = globalThis as unknown as { __nblm_ig_browser?: Promise<Browser> };
async function launchBrowser(): Promise<Browser> {
  const base = { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] };
  const envPath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  const attempts: Record<string, unknown>[] = [];
  if (envPath) attempts.push({ ...base, executablePath: envPath });
  attempts.push({ ...base, channel: "chrome" });
  attempts.push({ ...base, channel: "msedge" });
  attempts.push({ ...base, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  attempts.push({ ...base });
  let lastErr: unknown;
  for (const opt of attempts) {
    try {
      return await chromium.launch(opt);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `无法启动浏览器渲染信息图(请确认已安装 Chrome 或设置 CHROME_PATH):${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}
// 导出:与小红书卡组(lib/xhs.ts)共享同一个无头浏览器单例,避免每类制品各起一个 Chromium。
export async function getBrowser(): Promise<Browser> {
  const existing = gBrowser.__nblm_ig_browser ? await gBrowser.__nblm_ig_browser.catch(() => null) : null;
  if (existing && existing.isConnected()) return existing;
  const p = launchBrowser();
  gBrowser.__nblm_ig_browser = p;
  // 断连(崩溃/被杀/热重载残留)时清缓存,下次重新启动;否则会拿到已死实例。
  p.then((b) => b.on("disconnected", () => {
    if (gBrowser.__nblm_ig_browser === p) gBrowser.__nblm_ig_browser = undefined;
  })).catch(() => {});
  return p;
}

/** Render the spec to a polished infographic PNG via headless Chrome (themed). */
export async function renderInfographicPng(spec: Spec, theme?: string, watermark = false): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, deviceScaleFactor: 2 });
  try {
    await page.setContent(renderHtml(spec, igTheme(theme), watermark), { waitUntil: "load" });
    const el = await page.$("#poster");
    const buf = el ? await el.screenshot({ type: "png" }) : await page.screenshot({ type: "png", fullPage: true });
    return buf as Buffer;
  } finally {
    await page.close().catch(() => {});
  }
}

const IG_CRITIC = `你是以挑剔著称的信息图审稿人。观察【图片】并对照【来源】。只输出 JSON,不要解释。
先在 issues 里**逐条列出所有问题**(版式:文字溢出/截断/拥挤/留白失衡/对齐混乱;美观:层次弱/配色平淡/廉价感/字号失衡;忠实:出现来源没有的数字或结论),没有问题则空数组。再据此给分。
- score:0-10 综合质量分(版式+美观+忠实一起看),严格打分,平庸只给 5-6,精良才给 9-10。
- regenerate:只要 issues 非空且 score<8,就为 true;否则 false。
每条 issue 要给"可执行的修正指令"(如"X 块文案过长应精简到≤N字"/"改用对比块呈现 A 与 B"/"删掉来源没有的百分比"/"统一卡片间距与对齐")。
输出:{"issues":["..."],"score":n,"regenerate":bool}`;

/** Vision critic over a rendered infographic — returns a 0-10 quality score,
 *  whether to regenerate, and concrete fixes. Drives the critique→refine loop. */
export async function critiqueRender(
  png: Buffer,
  corpus: string
): Promise<{ regenerate: boolean; issues: string[]; score: number }> {
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const res = await getOpenAI().chat.completions.create({
    model: VISION_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: IG_CRITIC },
      {
        role: "user",
        content: [
          { type: "text", text: `【来源】\n${corpus.slice(0, 4000)}` },
          { type: "image_url", image_url: { url: dataUrl } },
        ] as never,
      },
    ],
  });
  const txt = res.choices[0]?.message?.content ?? "";
  let p: { regenerate?: unknown; issues?: unknown; score?: unknown } | null = null;
  try {
    p = JSON.parse(txt);
  } catch {
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        p = JSON.parse(m[0]);
      } catch {
        /* unparseable critique → treat as no-op below */
      }
    }
  }
  const issues = Array.isArray(p?.issues)
    ? p!.issues.map((x) => clean(x)).filter(Boolean).slice(0, 6)
    : [];
  const score = Math.max(0, Math.min(10, Number(p?.score) || 0));
  return { regenerate: !!p?.regenerate && issues.length > 0, issues, score };
}

/** Generate → render → vision-critique → (if flagged) regenerate with feedback →
 *  render → re-critique, and **keep whichever render scores higher** so a
 *  corrective pass can never make the result worse. Degrades gracefully: any
 *  critic/regen failure keeps the last good render. `rounds` = corrective passes
 *  that actually ran (0 = first take stood). */
export async function renderInfographicAssets(
  corpus: string,
  directive = "",
  theme?: string,
  opts?: { maxRounds?: number; watermark?: boolean; instruction?: string; language?: string }
): Promise<{ spec: Spec; png: Buffer; rounds: number; score: number }> {
  const maxRounds = Math.max(0, opts?.maxRounds ?? 1);
  const watermark = opts?.watermark ?? false;
  const effectiveLanguage = resolveOutputLanguageRequirement(opts?.language, directive);
  let spec = await generateSpecFromCorpus(corpus, directive, "", opts?.instruction, effectiveLanguage);
  let png = await renderInfographicPng(spec, theme, watermark);
  let rounds = 0;
  let crit: { regenerate: boolean; issues: string[]; score: number };
  try {
    crit = await critiqueRender(png, corpus);
  } catch {
    return { spec, png, rounds, score: -1 }; // critic unavailable → ship first take
  }
  for (let i = 0; i < maxRounds && crit.regenerate; i++) {
    const feedback = `\n\n上一版信息图存在以下问题,请针对性修正后重做(务必保持忠于来源、不要新增来源没有的内容):\n- ${crit.issues.join("\n- ")}`;
    let nSpec: Spec, nPng: Buffer, nCrit: { regenerate: boolean; issues: string[]; score: number };
    try {
      nSpec = await generateSpecFromCorpus(corpus, directive, feedback, opts?.instruction, effectiveLanguage);
      nPng = await renderInfographicPng(nSpec, theme, watermark);
      nCrit = await critiqueRender(nPng, corpus);
    } catch {
      break; // regen/critique failed → keep the prior good render
    }
    rounds++;
    if (nCrit.score >= crit.score) {
      spec = nSpec; png = nPng; crit = nCrit; // corrected version is as-good-or-better → adopt
    } else {
      break; // regen scored worse → keep prior, stop
    }
  }
  return { spec, png, rounds, score: crit.score };
}

/**
 * Generate a one-page infographic. Returns the title, the JSON spec (stored as
 * the studio output's content, for re-render / save-as-note), and the PNG bytes.
 * Runs a vision-critique loop so an ugly/overflowing first take gets corrected.
 */
/** Map a color/theme word in the user's 补充说明 to one of the preset palettes.
 *  The infographic's colors come from a FIXED preset (not free-form CSS), so
 *  "背景用绿色" can't literally set an arbitrary background — but it CAN pick the
 *  green (forest) palette, which is the closest honest fulfilment. Returns null
 *  when the instruction carries no color hint (→ auto-pick by content). */
function themeFromColorHint(text?: string): string | null {
  const s = (text || "").toLowerCase();
  if (!s) return null;
  if (/绿|green|forest|自然|草/.test(s)) return "forest";
  if (/蓝|青|靛|blue|cyan|aurora|科技|极光/.test(s)) return "aurora";
  if (/橙|暖|黄|红|粉|orange|warm|amber|red|yellow|pink|活力|日出/.test(s)) return "sunrise";
  if (/白|浅|亮|简约|留白|light|white|paper|clean|纸/.test(s)) return "paper";
  if (/黑|深|暗|夜|dark|midnight|午夜/.test(s)) return "midnight";
  return null;
}

export async function generateInfographic(
  notebookId: string,
  sourceIds?: string[],
  opts?: { theme?: string; language?: string; instruction?: string; memberId?: string | null; watermark?: boolean }
): Promise<{ title: string; content: string; png: Buffer }> {
  const corpus = await buildGenerationCorpus(
    notebookId,
    generationRetrievalQuery(opts?.instruction, "核心数据 关键事实 要点 对比 趋势 数量"),
    sourceIds
  );
  if (!corpus) throw new Error("勾选的内容暂无可用文本,请换选来源/会话/笔记。");
  // 逐次生成的语言选项随 directive 一路带进规格生成的 user 消息(覆盖来源主语言)。
  // 补充说明(instruction)此前在信息图这条路径被整个丢弃 —— 一并拼进 directive,
  // 让内容侧重(「重点讲X」)真正生效。
  const instr = opts?.instruction?.trim();
  const directive =
    (await getNotebookDirective(notebookId, opts?.memberId)) +
    outputLanguageClause(opts?.language) +
    studioInstructionClause(instr);
  // 配色优先级:① 用户显式选的主题 → ② 补充说明里的颜色关键词(绿→forest…)→
  // ③ 按内容主题自动挑。这样「背景用绿色」这类样式要求也能落到最接近的预设配色。
  const theme =
    opts?.theme && opts.theme !== "auto" && IG_THEMES[opts.theme]
      ? opts.theme
      : themeFromColorHint(instr) ?? pickThemeForText(corpus);
  const { spec, png } = await renderInfographicAssets(corpus, directive, theme, {
    watermark: opts?.watermark ?? false,
    instruction: instr,
    language: opts?.language,
  });
  const expectedBlocks = requestedCount(instr, ["个模块", "个图块", "个区块", "blocks", "block"]);
  if (expectedBlocks !== null && spec.blocks.length !== expectedBlocks) {
    throw new Error(`生成信息图未执行模块数量要求(要求 ${expectedBlocks},实际 ${spec.blocks.length})`);
  }
  const missing = missingSupportedVerbatimPhrases(JSON.stringify(spec), instr, corpus);
  if (missing.length) throw new Error(`生成结果未执行“原样包含”要求:${missing[0]}`);
  return { title: spec.title, content: JSON.stringify({ ...spec, theme }), png };
}

/** Persist a generated infographic PNG to its permanent id-based path.
 *  本地落盘后,若 OSS 已配置,额外尽力上传并写旁标(失败静默降级纯本地)。
 *  OSS 未配置 → ossEnabled()=false → 只写本地(与历史逐字节一致)。 */
export async function commitInfographicPng(id: string, rawPng: Buffer): Promise<void> {
  const png = stampPngProvenance(rawPng); // 归属追溯:注入 iTXt 猿笔记指纹(失败安全,非 PNG 原样返回)
  await mkdir(INFOGRAPHIC_DIR, { recursive: true });
  await writeFile(path.join(INFOGRAPHIC_DIR, `${id}.png`), png);
  if (ossEnabled()) {
    await uploadAndMarkOss(path.join(INFOGRAPHIC_DIR, id), `media/infographic/${id}.png`, png, "image/png", putObject);
  }
}
