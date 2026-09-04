// 演示文稿的结构化数据模型(v2)。客户端查看器与服务端生成/导出共用,
// 不得在此引入任何 server-only 依赖。
//
// 旧版 deck(每页只有 {title,bullets})通过 normalizeSlides 自动升级:
// 首页 → cover、末页 → takeaways、其余 → bullets,保证向后兼容。

export type SlideTone = "a" | "b" | "c" | "d";

export type DeckCard = {
  icon?: string;
  label: string;
  /** 卡片彩色小标题(如「降维打击」) */
  sub?: string;
  text?: string;
  tone?: SlideTone;
};

export type DeckCompareSide = { label: string; points: string[] };
/** 按维度对齐的对比行(NotebookLM 案例页式表格) */
export type DeckCompareRow = { dim: string; left: string; right: string };
/** 同心圆/辐射版式的环上项 */
export type DeckRingItem = { label: string; text?: string; tone?: SlideTone; icon?: string };

/** 大数字版式的指标项 */
export type DeckStat = { value: string; label: string; text?: string; tone?: SlideTone };
/** 图表版式的数据点 */
export type DeckChartPoint = { label: string; value: number };
export type DeckChart = { type: "bar" | "line" | "pie"; data: DeckChartPoint[]; unit?: string };

export type DeckSlide = {
  layout:
    | "cover"
    | "cards"
    | "compare"
    | "rings"
    | "timeline"
    | "steps"
    | "stats"
    | "chart"
    | "quote"
    | "bullets"
    | "takeaways";
  title: string;
  subtitle?: string;
  bullets?: string[];
  cards?: DeckCard[];
  left?: DeckCompareSide;
  right?: DeckCompareSide;
  /** compare 可选:维度对齐的行,优先于两侧 points 展示 */
  rows?: DeckCompareRow[];
  /** rings:圆心概念;timeline/steps 复用 items */
  center?: string;
  items?: DeckRingItem[];
  /** stats:大数字指标 */
  stats?: DeckStat[];
  /** chart:图表数据 */
  chart?: DeckChart;
  /** quote:金句与出处 */
  quote?: string;
  attribution?: string;
  /** 页底金句/结论条 */
  note?: string;
};

export type DeckV2 = { title: string; theme?: string; slides: DeckSlide[]; watermark?: boolean };

/** 模型可选的语义图标名(查看器渲染为线性 SVG;PPTX 导出忽略图标)。 */
export const DECK_ICONS = [
  "trend-down",
  "trend-up",
  "spiral",
  "gem",
  "mountain",
  "bolt",
  "shield",
  "target",
  "clock",
  "users",
  "brain",
  "rocket",
  "scale",
  "alert",
  "coins",
  "layers",
  "compass",
  "book",
  "spark",
  "globe",
] as const;

const TONES: SlideTone[] = ["a", "b", "c", "d"];

function str(v: unknown): string {
  if (typeof v === "string") return v.trim();
  // 数字也接受:LLM 常把 stats.value / chart.value / compare 单元格写成数字字面量
  // (如 {"value":50})。此前只认 string → 数字被吞成空 → 整块退化成空白 bullet 幻灯片。
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}
function strArr(v: unknown, max = 8): string[] {
  return Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, max) : [];
}

/** 宽容解析:接受 v2 任意子集 + 旧版 {title,bullets};丢弃无效页。 */
export function normalizeSlides(raw: unknown): DeckSlide[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: DeckSlide[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const title = str(s.title);
    if (!title) continue;
    const layout = str(s.layout);
    if (layout === "cards") {
      const cards: DeckCard[] = [];
      for (const [i, c] of (Array.isArray(s.cards) ? s.cards : []).entries()) {
        if (!c || typeof c !== "object" || cards.length >= 4) continue;
        const cc = c as Record<string, unknown>;
        const label = str(cc.label);
        if (!label) continue;
        const tone = str(cc.tone) as SlideTone;
        cards.push({
          icon: str(cc.icon) || undefined,
          label,
          sub: str(cc.sub) || undefined,
          text: str(cc.text) || undefined,
          tone: TONES.includes(tone) ? tone : TONES[i % TONES.length],
        });
      }
      if (cards.length >= 2) {
        out.push({ layout: "cards", title, cards, note: str(s.note) || undefined });
        continue;
      }
      // 卡片数据不足 → 退化为要点页
      out.push({ layout: "bullets", title, bullets: strArr(s.bullets) });
      continue;
    }
    if (layout === "compare") {
      // 维度行(优先)—— {dim, left, right}
      const rows: DeckCompareRow[] = [];
      for (const r of Array.isArray(s.rows) ? s.rows : []) {
        if (!r || typeof r !== "object" || rows.length >= 6) continue;
        const rr = r as Record<string, unknown>;
        const dim = str(rr.dim);
        const lv = str(rr.left);
        const rv = str(rr.right);
        if (dim && lv && rv) rows.push({ dim, left: lv, right: rv });
      }
      const side = (v: unknown): DeckCompareSide | null => {
        if (!v || typeof v !== "object") return null;
        const sv = v as Record<string, unknown>;
        const label = str(sv.label);
        const points = strArr(sv.points, 6);
        return label && (points.length || rows.length) ? { label, points } : null;
      };
      const left = side(s.left);
      const right = side(s.right);
      if (left && right) {
        out.push({
          layout: "compare",
          title,
          left,
          right,
          rows: rows.length ? rows : undefined,
          note: str(s.note) || undefined,
        });
        continue;
      }
      out.push({ layout: "bullets", title, bullets: strArr(s.bullets) });
      continue;
    }
    if (layout === "rings") {
      const items: DeckRingItem[] = [];
      for (const [i, v] of (Array.isArray(s.items) ? s.items : []).entries()) {
        if (!v || typeof v !== "object" || items.length >= 6) continue;
        const iv = v as Record<string, unknown>;
        const label = str(iv.label);
        if (!label) continue;
        const tone = str(iv.tone) as SlideTone;
        items.push({
          label,
          text: str(iv.text) || undefined,
          icon: str(iv.icon) || undefined,
          tone: TONES.includes(tone) ? tone : TONES[i % TONES.length],
        });
      }
      const center = str(s.center) || title;
      if (items.length >= 3) {
        out.push({ layout: "rings", title, center, items, note: str(s.note) || undefined });
        continue;
      }
      out.push({ layout: "bullets", title, bullets: strArr(s.bullets) });
      continue;
    }
    if (layout === "timeline" || layout === "steps") {
      const items: DeckRingItem[] = [];
      for (const [i, v] of (Array.isArray(s.items) ? s.items : []).entries()) {
        if (!v || typeof v !== "object" || items.length >= 6) continue;
        const iv = v as Record<string, unknown>;
        const label = str(iv.label);
        if (!label) continue;
        const tone = str(iv.tone) as SlideTone;
        items.push({
          label,
          text: str(iv.text) || undefined,
          icon: str(iv.icon) || undefined,
          tone: TONES.includes(tone) ? tone : TONES[i % TONES.length],
        });
      }
      if (items.length >= 3) {
        out.push({ layout, title, items, note: str(s.note) || undefined });
        continue;
      }
      out.push({ layout: "bullets", title, bullets: strArr(s.bullets) });
      continue;
    }
    if (layout === "stats") {
      const stats: DeckStat[] = [];
      for (const [i, v] of (Array.isArray(s.stats) ? s.stats : []).entries()) {
        if (!v || typeof v !== "object" || stats.length >= 4) continue;
        const sv = v as Record<string, unknown>;
        const value = str(sv.value);
        const label = str(sv.label);
        if (!value || !label) continue;
        const tone = str(sv.tone) as SlideTone;
        stats.push({
          value,
          label,
          text: str(sv.text) || undefined,
          tone: TONES.includes(tone) ? tone : TONES[i % TONES.length],
        });
      }
      if (stats.length >= 2) {
        out.push({ layout: "stats", title, stats, note: str(s.note) || undefined });
        continue;
      }
      out.push({ layout: "bullets", title, bullets: strArr(s.bullets) });
      continue;
    }
    if (layout === "chart") {
      const c = (s.chart && typeof s.chart === "object" ? s.chart : null) as Record<
        string,
        unknown
      > | null;
      const type = str(c?.type) as DeckChart["type"];
      const data: DeckChartPoint[] = [];
      for (const v of Array.isArray(c?.data) ? (c!.data as unknown[]) : []) {
        if (!v || typeof v !== "object" || data.length >= 8) continue;
        const dv = v as Record<string, unknown>;
        const label = str(dv.label);
        const num = Number(dv.value);
        if (label && Number.isFinite(num)) data.push({ label, value: num });
      }
      if (["bar", "line", "pie"].includes(type) && data.length >= 2) {
        out.push({
          layout: "chart",
          title,
          chart: { type, data, unit: str(c?.unit) || undefined },
          note: str(s.note) || undefined,
        });
        continue;
      }
      out.push({ layout: "bullets", title, bullets: strArr(s.bullets) });
      continue;
    }
    if (layout === "quote") {
      const quote = str(s.quote);
      if (quote) {
        out.push({
          layout: "quote",
          title,
          quote,
          attribution: str(s.attribution) || undefined,
        });
        continue;
      }
      out.push({ layout: "bullets", title, bullets: strArr(s.bullets) });
      continue;
    }
    if (layout === "cover" || layout === "takeaways" || layout === "bullets") {
      out.push({
        layout,
        title,
        subtitle: str(s.subtitle) || undefined,
        bullets: strArr(s.bullets),
        note: str(s.note) || undefined,
      });
      continue;
    }
    // 旧版无 layout:按位置推断(由调用方兜底,这里先记为 bullets)
    out.push({ layout: "bullets", title, bullets: strArr(s.bullets) });
  }
  // 旧版整体推断:没有任何显式 layout 时,首页当封面、末页当回顾
  const hasExplicit = list.some(
    (i) => i && typeof i === "object" && str((i as Record<string, unknown>).layout)
  );
  if (!hasExplicit && out.length >= 2) {
    out[0] = { ...out[0], layout: "cover" };
    if (out.length > 2) out[out.length - 1] = { ...out[out.length - 1], layout: "takeaways" };
  }
  return out;
}

/** deck JSON(字符串)→ 规范化 DeckV2;解析失败返回空 slides。 */
export function parseDeck(content: string, fallbackTitle = "演示文稿"): DeckV2 {
  try {
    const d = JSON.parse(content) as Record<string, unknown>;
    return {
      title: str(d.title) || fallbackTitle,
      theme: str(d.theme) || undefined,
      slides: normalizeSlides(d.slides),
      watermark: d.watermark === true, // 免费档生成时烤入,查看端据此叠加平铺水印
    };
  } catch {
    return { title: fallbackTitle, slides: [] };
  }
}
