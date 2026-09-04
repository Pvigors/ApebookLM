"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Note, Source, StudioKind, StudioOutput } from "@/lib/types";
import { outputToMarkdown } from "@/lib/output-text";
import { SLIDE_THEMES, slideStyle, slideTheme, type SlideTheme } from "@/lib/slide-themes";
import { parseDeck, type DeckChart, type DeckSlide } from "@/lib/deck";
import { parseMarkdownTables } from "@/lib/markdown-table";
import { CAD_JOB_STAGE_LABEL, cadJobStageFromProgress } from "@/lib/job-types";
// Defined in a dependency-free module so the home shell can import them without
// pulling this whole bundle; re-exported here for existing `from "./Studio"` call sites.
import {
  CAD_FIXED_TEMPLATE_PARAMETERS,
  CAD_MODEL_LIBRARY,
  KIND_LABEL,
  defaultCadTemplateParameters,
  sourceIdsOf,
  outputWatermark,
  XHS_THEME_META,
  type CadDraftParameters,
  type CadGenerationMode,
  type CadTemplateChoice,
  type GenJobState,
  type GenMap,
} from "./studio-shared";
import { stampImageWatermark } from "@/lib/image-watermark";
import { xmlToGraph, graphToXml, type DrawvisoGraph } from "@/lib/drawviso-graph";
import { beautifyGeneratedExcalidrawElements } from "@/lib/excalidraw-graph";
export { KIND_LABEL, sourceIdsOf, parseMarkdownTables };

// 演示文稿卡片图标(线性风格,与 NotebookLM 的卡片插画一致的克制感)。
// name 由模型从 DECK_ICONS 里选;未知名字回退为 spark。
const DECK_ICON_PATHS: Record<string, React.ReactNode> = {
  "trend-down": (<><polyline points="22 17 13.5 8.5 8.5 13.5 2 7" /><polyline points="16 17 22 17 22 11" /></>),
  "trend-up": (<><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></>),
  spiral: (<path d="M14 11a2 2 0 1 1-4 0 4 4 0 0 1 8 0 6 6 0 0 1-12 0 8 8 0 0 1 16 0 10 10 0 1 1-20 0 11.93 11.93 0 0 1 2.42-7.22" />),
  gem: (<><path d="M6 3h12l4 6-10 13L2 9Z" /><path d="M11 3 8 9l4 13 4-13-3-6" /><path d="M2 9h20" /></>),
  mountain: (<><path d="m8 9 4 8H4l4-8z" /><path d="m13 13 3-5 6 13H14" /><path d="M17 5h.01M19 3h.01M21 5h.01" /></>),
  bolt: (<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />),
  shield: (<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />),
  target: (<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>),
  clock: (<><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" /></>),
  users: (<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>),
  brain: (<><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /><path d="M12 5v13" /></>),
  rocket: (<><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" /><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" /><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /></>),
  scale: (<><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" /><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" /><path d="M7 21h10" /><path d="M12 3v18" /><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" /></>),
  alert: (<><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>),
  coins: (<><circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1 1 10.34 18" /><path d="M7 6h1v4" /><path d="m16.71 13.88.7.71-2.82 2.82" /></>),
  layers: (<><path d="m12 2 8.5 4.5-8.5 4.5L3.5 6.5 12 2z" /><path d="m3.5 12 8.5 4.5 8.5-4.5" /><path d="m3.5 17 8.5 4.5 8.5-4.5" /></>),
  compass: (<><circle cx="12" cy="12" r="9" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" /></>),
  book: (<><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></>),
  spark: (<><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" /><path d="M20 3v4" /><path d="M22 5h-4" /></>),
  globe: (<><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" /></>),
};

function DeckIcon({ name, size = 22 }: { name?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {DECK_ICON_PATHS[name ?? ""] ?? DECK_ICON_PATHS.spark}
    </svg>
  );
}

/** 浅色主题用深字,深色/渐变主题用浅字(卡片大标题)。 */
function isLightTheme(t: SlideTheme): boolean {
  return slideStyle(t.id).light ?? (t.id === "paper" || t.id === "sunrise");
}

function cardLabelColor(t: SlideTheme): string {
  return isLightTheme(t) ? "#26282e" : "#f3f2f8";
}

/** tone 色块之上的文字色(对比页横幅等)。 */
function onToneColor(t: SlideTheme): string {
  return isLightTheme(t) ? "#ffffff" : "#13151a";
}

/** 含中日韩汉字 → 用于按语言分流排版(中文撤负字距/大写字距,仅拉丁保留)。 */
function hasCJK(s?: string): boolean {
  return !!s && /[一-鿿぀-ヿ]/.test(s);
}

/** 内容页标题块:按模版规格变化的标题装饰(下划线/左竖条/通栏细线/朴素 + 衬线)。 */
function TitleBlock({ title, t }: { title: string; t: SlideTheme }) {
  const st = slideStyle(t.id);
  const left = st.titleAlign === "left";
  const h3 = (
    <h3
      className="text-balance font-extrabold leading-[1.3] cjk-display"
      style={{ color: t.titleColor, fontFamily: st.fontHead, fontSize: 36 * (st.titleScale ?? 1) }}
    >
      {title}
    </h3>
  );
  return (
    <div className={cn("mb-9 shrink-0", left ? "text-left" : "text-center")}>
      {st.titleDecor === "bar" ? (
        <div className="flex items-center gap-3.5">
          <span className="h-8 w-[5px] shrink-0 rounded-full" style={{ background: t.accent }} />
          {h3}
        </div>
      ) : (
        <>
          {h3}
          {st.titleDecor === "underline" && (
            <span className={cn("mt-3 flex items-center gap-1.5", !left && "justify-center")}>
              <span className="block h-[5px] w-12 rounded-full" style={{ background: t.accent }} />
              {t.accent2 && <span className="block h-[5px] w-4 rounded-full" style={{ background: t.accent2 }} />}
            </span>
          )}
          {st.titleDecor === "rule" && (
            <span className="mt-4 block h-px w-full" style={{ background: t.cardBorder }} />
          )}
        </>
      )}
    </div>
  );
}

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h || 1;
}

/** 封面生成式线稿：原创双色对数螺线场。
 *  以 seed 决定相位/疏密,主题 a/b 两色调交替,纯 SVG 无网络。 */
type HeroEl =
  | { t: "path"; d: string; c: string; o: number; w: number }
  | { t: "ellipse"; cx: number; cy: number; rx: number; ry: number; rot: number; c: string; o: number; w: number };

/** 封面右栏的生成式视觉 —— 6 款图案(螺旋/流场/同心轨道/放射/等高线/谐振曲线),
 *  按 deck id 哈希随机选一款:同一份固定不闪,不同 deck / 重新生成各不相同。
 *  全部沿用模版色调、细彩线风格、铺满 420×420 方框(slice)。 */
function HeroArt({ t, seed, motif }: { t: SlideTheme; seed: string; motif?: "orbit" | "grid" | "wave" | "geo" }) {
  const els = useMemo<HeroEl[]>(() => {
    let s = hashSeed(seed);
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const palette = [t.tones.a.fg, t.tones.b.fg, t.tones.c.fg, t.tones.d.fg, t.accent];
    const pick = () => palette[(rnd() * palette.length) | 0];
    const CX = 210, CY = 210;
    const out: HeroEl[] = [];
    const poly = (pts: number[][]) =>
      "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L");
    // motif 指定时固定母题(模版驱动),否则按 deck id 哈希散开。
    const MOTIF_V: Record<string, number> = { geo: 0, orbit: 2, grid: 3, wave: 4 };
    const v = motif ? (MOTIF_V[motif] ?? 2) : hashSeed(seed) % 6;

    if (v === 0) {
      // 螺旋:多臂对数螺旋
      const arms = 54;
      for (let k = 0; k < arms; k++) {
        const phase = (k / arms) * Math.PI * 2 + rnd() * 0.18;
        const squash = 0.84 + rnd() * 0.08;
        let r = 196 * (0.86 + rnd() * 0.26), a = phase;
        const pts: number[][] = [];
        for (let i = 0; i < 94; i++) {
          const wob = 1 + 0.045 * Math.sin(a * 3 + phase * 2);
          pts.push([CX + Math.cos(a) * r * wob, CY + Math.sin(a) * r * squash * wob]);
          a += 0.15; r *= 0.967;
        }
        out.push({ t: "path", d: poly(pts), c: palette[k % palette.length], o: 0.3 + rnd() * 0.38, w: k % 6 === 0 ? 1.2 : 0.6 });
      }
    } else if (v === 1) {
      // 流场:沿平滑向量场漂移的流线
      const field = (x: number, y: number) =>
        Math.sin(x * 0.013 + y * 0.009) * 2.3 + Math.cos(y * 0.014 - x * 0.007) * 1.9;
      for (let n = 0; n < 95; n++) {
        let x = rnd() * 460 - 20, y = rnd() * 460 - 20;
        const pts: number[][] = [];
        for (let i = 0; i < 80; i++) {
          pts.push([x, y]);
          const a = field(x, y);
          x += Math.cos(a) * 5.2; y += Math.sin(a) * 5.2;
          if (x < -40 || x > 460 || y < -40 || y > 460) break;
        }
        if (pts.length > 4) out.push({ t: "path", d: poly(pts), c: pick(), o: 0.22 + rnd() * 0.4, w: rnd() < 0.2 ? 1.2 : 0.65 });
      }
    } else if (v === 2) {
      // 同心轨道:层层旋转的椭圆
      const rings = 30;
      for (let k = 0; k < rings; k++) {
        const rr = 14 + k * 7 * (0.95 + rnd() * 0.1);
        out.push({ t: "ellipse", cx: CX, cy: CY, rx: rr, ry: rr * (0.6 + rnd() * 0.14), rot: rnd() * 180, c: pick(), o: 0.18 + rnd() * 0.42, w: k % 5 === 0 ? 1.1 : 0.6 });
      }
    } else if (v === 3) {
      // 放射:由中心向外的微弯光线
      const rays = 130;
      for (let k = 0; k < rays; k++) {
        const ang = (k / rays) * Math.PI * 2 + rnd() * 0.04;
        const len = 90 + rnd() * 210, curve = (rnd() - 0.5) * 0.6;
        let r = 8 + rnd() * 26, a = ang;
        const pts: number[][] = [];
        for (let i = 0; i < 26; i++) { pts.push([CX + Math.cos(a) * r, CY + Math.sin(a) * r]); r += len / 26; a += curve / 26; }
        out.push({ t: "path", d: poly(pts), c: pick(), o: 0.22 + rnd() * 0.4, w: k % 5 === 0 ? 1.1 : 0.55 });
      }
    } else if (v === 4) {
      // 等高线:层叠的波浪横线
      const lines = 38;
      for (let k = 0; k < lines; k++) {
        const baseY = -10 + k * (440 / lines);
        const amp = 12 + rnd() * 24, freq = 0.006 + rnd() * 0.006, ph = rnd() * 6.28;
        const pts: number[][] = [];
        for (let x = -20; x <= 440; x += 7)
          pts.push([x, baseY + Math.sin(x * freq + ph) * amp + Math.sin(x * freq * 2.3 + ph * 1.7) * amp * 0.32]);
        out.push({ t: "path", d: poly(pts), c: pick(), o: 0.2 + rnd() * 0.4, w: k % 4 === 0 ? 1.1 : 0.6 });
      }
    } else {
      // 谐振:多条阻尼谐振曲线 —— 两轴用「近乎相等、轻微失谐」的频率 + 阻尼,
      // 形成缓慢进动、向心收拢的玫瑰花瓣(harmonograph),比纯利萨茹更雅致。
      const curves = 6 + ((rnd() * 3) | 0);
      for (let k = 0; k < curves; k++) {
        const f = 2 + ((rnd() * 3) | 0);
        const a1 = f + (rnd() - 0.5) * 0.06, a2 = f + (rnd() - 0.5) * 0.06;
        const p1 = rnd() * 6.28, p2 = rnd() * 6.28;
        const d1 = 0.004 + rnd() * 0.005, d2 = 0.004 + rnd() * 0.005;
        const R = 170 + rnd() * 40;
        const pts: number[][] = [];
        for (let i = 0; i < 480; i++) {
          const tt = i * 0.07;
          pts.push([CX + R * Math.sin(a1 * tt + p1) * Math.exp(-d1 * i), CY + R * Math.sin(a2 * tt + p2) * Math.exp(-d2 * i)]);
        }
        out.push({ t: "path", d: poly(pts), c: pick(), o: 0.26 + rnd() * 0.3, w: 0.7 });
      }
    }
    return out;
  }, [seed, t, motif]);

  return (
    <svg viewBox="0 0 420 420" className="h-full w-full" preserveAspectRatio="xMidYMid slice" aria-hidden>
      {els.map((e, i) =>
        e.t === "ellipse" ? (
          <ellipse key={i} cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} fill="none" stroke={e.c} strokeOpacity={e.o} strokeWidth={e.w} transform={`rotate(${e.rot} ${e.cx} ${e.cy})`} />
        ) : (
          <path key={i} d={e.d} fill="none" stroke={e.c} strokeOpacity={e.o} strokeWidth={e.w} strokeLinecap="round" strokeLinejoin="round" />
        )
      )}
    </svg>
  );
}

/** 纯 SVG 迷你图表(零依赖,主题取色):bar=横向条,line=折线,pie=环形。 */
function MiniChart({ chart, t }: { chart: DeckChart; t: SlideTheme }) {
  const tones = [t.tones.a.fg, t.tones.b.fg, t.tones.c.fg, t.tones.d.fg];
  const max = Math.max(...chart.data.map((d) => d.value), 1);
  if (chart.type === "bar") {
    return (
      <div className="flex h-full w-full flex-col justify-center gap-5 px-12">
        {chart.data.map((d, i) => (
          <div key={i} className="flex items-center gap-5">
            <span
              className="w-[220px] shrink-0 truncate text-right text-[17px]"
              style={{ color: t.textColor }}
            >
              {d.label}
            </span>
            <div
              className="relative h-[30px] min-w-0 flex-1 overflow-hidden rounded-md"
              style={{ background: t.cardBg, border: `1px solid ${t.cardBorder}` }}
            >
              <div
                className="h-full rounded-md"
                style={{ width: `${(d.value / max) * 100}%`, background: tones[i % 4], opacity: 0.9 }}
              />
            </div>
            <span
              className="w-[100px] shrink-0 text-[17px] font-semibold tabular-nums"
              style={{ color: t.titleColor }}
            >
              {d.value}
              {chart.unit ?? ""}
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (chart.type === "line") {
    const W = 600;
    const H = 250;
    const PX = 46;
    const PY = 28;
    const n = chart.data.length;
    const pts = chart.data.map((d, i) => [
      PX + (i * (W - PX * 2)) / Math.max(n - 1, 1),
      H - PY - (d.value / max) * (H - PY * 2),
    ]);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto h-full w-full max-w-[680px]" preserveAspectRatio="xMidYMid meet">
        {[0.33, 0.66, 1].map((g) => (
          <line
            key={g}
            x1={PX}
            x2={W - PX}
            y1={H - PY - g * (H - PY * 2)}
            y2={H - PY - g * (H - PY * 2)}
            stroke={t.cardBorder}
            strokeDasharray="3 5"
          />
        ))}
        <line x1={PX} x2={W - PX} y1={H - PY} y2={H - PY} stroke={t.cardBorder} />
        <polyline
          points={pts.map((p) => p.join(",")).join(" ")}
          fill="none"
          stroke={t.accent}
          strokeWidth={2.2}
          strokeLinejoin="round"
        />
        {pts.map(([x, y], i) => (
          <g key={i}>
            <circle cx={x} cy={y} r={3.6} fill={t.accent} />
            <text x={x} y={y - 9} textAnchor="middle" fontSize={11} fontWeight={600} fill={t.titleColor}>
              {chart.data[i].value}
              {chart.unit ?? ""}
            </text>
            <text x={x} y={H - 9} textAnchor="middle" fontSize={10.5} fill={t.metaColor}>
              {chart.data[i].label.slice(0, 6)}
            </text>
          </g>
        ))}
      </svg>
    );
  }
  // pie → 环形 + 图例
  const total = chart.data.reduce((s, d) => s + d.value, 0) || 1;
  let acc = 0;
  const segs = chart.data.map((d, i) => {
    const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += d.value;
    const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const R = 88;
    const r0 = 47;
    const cx = 120;
    const cy = 120;
    const p = (a: number, rr: number) => `${cx + Math.cos(a) * rr},${cy + Math.sin(a) * rr}`;
    return {
      d: `M${p(a0, R)} A${R} ${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, r0)} A${r0} ${r0} 0 ${large} 0 ${p(a0, r0)} Z`,
      c: tones[i % 4],
      pct: Math.round((d.value / total) * 100),
      label: d.label,
      value: d.value,
    };
  });
  return (
    <div className="flex h-full items-center justify-center gap-16">
      <svg viewBox="0 0 240 240" className="h-[330px] w-[330px] shrink-0">
        {segs.map((s, i) => (
          <path key={i} d={s.d} fill={s.c} fillOpacity={0.9} />
        ))}
      </svg>
      <ul className="space-y-3.5">
        {segs.map((s, i) => (
          <li key={i} className="flex items-center gap-3 text-[17px]" style={{ color: t.textColor }}>
            <span className="h-3.5 w-3.5 shrink-0 rounded-sm" style={{ background: s.c }} />
            <span className="max-w-[320px] truncate">{s.label}</span>
            <span className="font-semibold tabular-nums" style={{ color: t.titleColor }}>
              {s.pct}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 页底金句条:内嵌胶囊 + 主题浅染 + 引号(设计坐标系内使用) */
function NoteStrip({ note, t }: { note: string; t: SlideTheme }) {
  return (
    <div className="mt-auto flex shrink-0 justify-center pt-5">
      <span
        className="max-w-[88%] rounded-full px-8 py-2.5 text-center text-[15.5px] leading-relaxed"
        style={{ background: t.tones.a.soft, color: t.textColor }}
      >
        <span style={{ color: t.tones.a.fg, fontWeight: 700 }}>「</span>
        {note}
        <span style={{ color: t.tones.a.fg, fontWeight: 700 }}>」</span>
      </span>
    </div>
  );
}

/** 幻灯片舞台:内容按 1280×720 设计稿排版,整体等比缩放填充容器 ——
 *  字号/间距是固定设计值,任何窗口尺寸下构图完全一致(reveal.js 式)。 */
function SlideStage({
  bg,
  fx,
  watermark,
  children,
}: {
  bg: string;
  fx?: { grid?: string; corner?: string; sharp?: boolean; glow?: string };
  /** 基础权益水印：传入主题相关的低对比色后铺满实例品牌；免水印权益不传。 */
  watermark?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / 1280);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className="relative aspect-video w-full overflow-hidden rounded-xl border border-edge"
      style={{ background: bg }}
    >
      <div
        className="lx-slide absolute left-0 top-0 origin-top-left"
        data-sharp={fx?.sharp ? "" : undefined}
        data-glow={fx?.glow ? "" : undefined}
        style={{
          width: 1280,
          height: 720,
          transform: `scale(${scale})`,
          visibility: scale ? "visible" : "hidden",
          ...(fx?.glow ? ({ "--lx-glow": fx.glow } as React.CSSProperties) : {}),
        }}
      >
        {fx?.grid && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage: `linear-gradient(${fx.grid} 1px, transparent 1px), linear-gradient(90deg, ${fx.grid} 1px, transparent 1px)`,
              backgroundSize: "56px 56px",
              WebkitMaskImage: "radial-gradient(135% 100% at 50% -8%, #000 38%, transparent 82%)",
              maskImage: "radial-gradient(135% 100% at 50% -8%, #000 38%, transparent 82%)",
            }}
          />
        )}
        {fx?.corner && (
          <span aria-hidden className="pointer-events-none absolute z-20" style={{ inset: 30 }}>
            <span className="absolute left-0 top-0 h-6 w-6 border-l-2 border-t-2" style={{ borderColor: fx.corner }} />
            <span className="absolute right-0 top-0 h-6 w-6 border-r-2 border-t-2" style={{ borderColor: fx.corner }} />
            <span className="absolute bottom-0 left-0 h-6 w-6 border-b-2 border-l-2" style={{ borderColor: fx.corner }} />
            <span className="absolute bottom-0 right-0 h-6 w-6 border-b-2 border-r-2" style={{ borderColor: fx.corner }} />
          </span>
        )}
        {watermark && (
          <span
            aria-hidden
            className="pointer-events-none absolute flex flex-wrap content-center justify-center"
            style={{
              top: "-40%",
              left: "-25%",
              width: "150%",
              height: "180%",
              transform: "rotate(-26deg)",
              gap: "70px 96px",
              opacity: 0.14,
            }}
          >
            {Array.from({ length: 60 }).map((_, wi) => (
              <span key={wi} style={{ color: watermark, fontSize: 46, fontWeight: 800, letterSpacing: 10, whiteSpace: "nowrap" }}>
                猿笔记
              </span>
            ))}
          </span>
        )}
        {children}
      </div>
    </div>
  );
}
import { MENU_PANEL, MENU_ITEM, MENU_ITEM_DANGER } from "@/components/StyledSelect";
import RichNoteEditor from "@/components/RichNoteEditor";
import MindMapEditor from "@/components/MindMapEditor";
import { toast } from "@/components/Toast";
import {
  AudioIcon,
  BoardIcon,
  CadIcon,
  CardsIcon,
  CloseIcon,
  DotsIcon,
  DownloadIcon,
  FileIcon,
  Forward10Icon,
  ImageIcon,
  MindMapIcon,
  PanelRightIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  PresentIcon,
  QuizIcon,
  Replay10Icon,
  SearchIcon,
  ShareIcon,
  SaveIcon,
  SpinnerIcon,
  GridPenIcon,
  TableIcon,
  TextIcon,
  TranscriptIcon,
  TrashIcon,
  VideoIcon,
} from "@/components/Icons";

// 相对时间统一到 lib/relative-time(此前 Studio 用 7 天阈值,而 HomeClient/
// PublicNotebook 用 30 天,同一时间戳跳「6 天前 → 日期」不一致)。保留 seconds/millis
// 兼容以防旧数据(生产环境所有 ts 都是 millis,分支形同保险)。
import { relTime as _relTime } from "@/lib/relative-time";
function relTime(ts: number): string {
  if (!ts) return "";
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return _relTime(ms);
}

/** Build the NotebookLM-style subtitle: "N 个来源 · 相对时间" (or just time). */
export function outputSubtitle(o: StudioOutput): string {
  const time = relTime(o.created_at);
  let sources = 0;
  let tutorialExample = false;
  let tutorialContext: "cad_tutorial" | "no_cad_target" | null = null;
  if (o.data) {
    try {
      const d = JSON.parse(o.data) as {
        sources?: number;
        usedSourceIds?: unknown;
        modelSelection?: { tutorialExample?: unknown; tutorialContext?: unknown };
      };
      if (Array.isArray(d.usedSourceIds)) {
        sources = new Set(d.usedSourceIds.filter((id) => typeof id === "string" && id)).size;
      } else if (typeof d.sources === "number") sources = d.sources;
      tutorialExample = d.modelSelection?.tutorialExample === true;
      tutorialContext = d.modelSelection?.tutorialContext === "cad_tutorial"
        || d.modelSelection?.tutorialContext === "no_cad_target"
        ? d.modelSelection.tutorialContext
        : null;
    } catch {
      /* ignore non-JSON data */
    }
  }
  if (tutorialExample) {
    const context = tutorialContext === "no_cad_target"
      ? "未识别出可执行建模目标"
      : sources > 0 ? `参考 ${sources} 个教程来源` : "系统教学默认尺寸";
    return time ? `教学示例 · ${context} · ${time}` : `教学示例 · ${context}`;
  }
  if (sources > 0) return time ? `${sources} 个来源 · ${time}` : `${sources} 个来源`;
  return time || (KIND_LABEL[o.kind] ?? o.kind);
}

/** Download a generated output — media kinds via their file endpoint, every
 *  other kind flattened to a Markdown file (see lib/output-text). */
export function downloadOutput(o: StudioOutput): void {
  const safe = (o.title || "下载").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "下载";
  const click = (href: string, name: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  if (o.kind === "audio") return click(`/api/studio/audio/${o.id}`, `${safe}.mp3`);
  if (o.kind === "video") return click(`/api/studio/video/${o.id}`, `${safe}.mp4`);
  if (o.kind === "infographic") return click(`/api/studio/infographic/${o.id}`, `${safe}.png`);
  // 小红书卡组是 PNG 组图:异步打成 zip(fire-and-forget,失败在 helper 内 toast),
  // 不走下方「拍平成 Markdown」的兜底(那只会导出原始 JSON)。
  if (o.kind === "xhs") { void downloadXhsZip(o); return; }
  if (o.kind === "slides") return click(`/api/studio/slides/${o.id}`, `${safe}.pptx`);
  if (o.kind === "cad") {
    toast("请打开 CAD 模型，核对尺寸与首版范围后再下载", "error");
    return;
  }
  if (o.kind === "drawviso") {
    // .drawio 文件 = <mxfile><diagram>原始 mxGraphModel</diagram></mxfile>,draw.io 直接打开。
    let xml = "";
    try { xml = (JSON.parse(o.content || "{}") as { xml?: string }).xml || ""; } catch {}
    if (!xml) { toast("图表内容为空,无法下载", "error"); return; }
    const wrapped = `<mxfile host="yuanbiji"><diagram name="${safe}">${xml.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</diagram></mxfile>`;
    const url = URL.createObjectURL(new Blob([wrapped], { type: "application/xml;charset=utf-8" }));
    click(url, `${safe}.drawio`);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if (o.kind === "excalidraw") {
    // Wrap the scene in the official .excalidraw envelope so it imports into
    // excalidraw.com; if content is still the unconverted { mermaid } envelope
    // (row never opened), fall back to the raw bytes.
    let body = o.content || "{}";
    try {
      const s = JSON.parse(body);
      if (Array.isArray(s.elements)) {
        body = JSON.stringify({ type: "excalidraw", version: 2, source: "apebooklm", elements: s.elements, appState: s.appState ?? {}, files: s.files ?? {} });
      }
    } catch {}
    const url = URL.createObjectURL(new Blob([body], { type: "application/json;charset=utf-8" }));
    click(url, `${safe}.excalidraw`);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const blob = new Blob([outputToMarkdown(o.kind, o.content || "")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  click(url, `${safe}.md`);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download a note as a Markdown file (Lexical-JSON notes are flattened first). */
export function downloadNote(n: Note): void {
  const safe = (n.title || "笔记").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "笔记";
  const blob = new Blob([outputToMarkdown(n.kind, n.content || "")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Live equalizer icon (animated bars) — the "动态" audio-row icon. */
const EQ_BARS = [
  { h: "55%", dur: "0.9s", delay: "0s" },
  { h: "100%", dur: "0.7s", delay: "0.22s" },
  { h: "78%", dur: "1.1s", delay: "0.1s" },
  { h: "92%", dur: "0.8s", delay: "0.34s" },
  { h: "60%", dur: "1s", delay: "0.16s" },
];

export function EqualizerIcon({
  className,
  size = 18,
  animated = false,
}: {
  className?: string;
  size?: number;
  /** Bars only bounce while the track is actually playing; otherwise a static waveform. */
  animated?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex items-center justify-center gap-[2px]", className)}
      style={{ width: size, height: size }}
    >
      {EQ_BARS.map((b, i) => (
        <span
          key={i}
          className="w-[2px] rounded-full bg-current"
          style={{
            height: b.h,
            transformOrigin: "center",
            animation: animated ? `eqBar ${b.dur} ease-in-out ${b.delay} infinite` : undefined,
          }}
        />
      ))}
    </span>
  );
}

const cn = (...xs: Array<string | false | null | undefined>) =>
  xs.filter(Boolean).join(" ");

// PDF 报告 — 仅保留 4 种类型(其中「时间线」必有)。glyph/hex 用于分段控件。
const REPORTS: { kind: StudioKind; label: string; hex: string; glyph: React.ReactNode }[] = [
  { kind: "briefing", label: "简报", hex: "#5466d8", glyph: (<><rect x="5" y="3" width="14" height="18" rx="2.5" /><path d="M9 8h6M9 12h6M9 16h4" /></>) },
  { kind: "study_guide", label: "学习指南", hex: "#2aa178", glyph: (<><path d="M12 4L2.5 8.5 12 13l9.5-4.5L12 4z" /><path d="M6 10.5V15c0 1.3 2.7 2.6 6 2.6s6-1.3 6-2.6v-4.5" /></>) },
  { kind: "faq", label: "常见问答", hex: "#c7912f", glyph: (<><circle cx="12" cy="12" r="9" /><path d="M9.8 9.7a2.2 2.2 0 0 1 4 1.1c0 1.4-2 1.8-2 3.2M12 17h.01" /></>) },
  { kind: "timeline", label: "时间线", hex: "#2f9bbc", glyph: (<><path d="M5 4v16" /><circle cx="5" cy="8" r="1.5" /><circle cx="5" cy="16" r="1.5" /><path d="M8.5 8h10M8.5 16h6.5" /></>) },
];

// KIND_LABEL / sourceIdsOf now live in ./studio-shared (imported + re-exported
// at the top of this file) so the home shell can pull them WITHOUT dragging the
// whole Studio bundle into the initial route chunk.

/** 小红书卡组磁贴图标:竖版卡片叠层(前卡带文案行 + 后卡浮出一角),
 *  与闪卡的横版 CardsIcon 区分。风格沿用 Icons.tsx 的 1.75 线宽描边。 */
const XhsCardsIcon = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <rect x="4" y="6" width="11.5" height="15" rx="2" />
    <path d="M8.5 3h9.5a2 2 0 0 1 2 2v11.5" />
    <path d="M7.5 12.5h4.5M7.5 16h3" />
  </svg>
);

// NotebookLM-style colorful artifact tiles (headline generators). Class strings
// are written literally so Tailwind's JIT can see them.
export const ARTIFACTS: {
  kind: StudioKind | "reports";
  label: string;
  reports?: boolean;
  beta?: boolean;
  Icon: typeof FileIcon;
  tint: string;
  fg: string;
}[] = [
  // 主创作链路优先:文档 → 专业图表 → 结构梳理 → 数据 → 音频。
  { kind: "reports", label: "PDF 报告", reports: true, Icon: FileIcon, tint: "bg-art-report/10", fg: "text-art-report" },
  // 专业图表(draw.io/mxGraph 引擎)——架构图/流程图/泳道图,与手绘风画板互补。
  { kind: "drawviso", label: "专业图表", Icon: BoardIcon, tint: "bg-art-table/10", fg: "text-art-table" },
  { kind: "mindmap", label: "思维导图", Icon: MindMapIcon, tint: "bg-art-mindmap/10", fg: "text-art-mindmap" },
  { kind: "table", label: "数据表格", Icon: TableIcon, tint: "bg-art-table/10", fg: "text-art-table" },
  { kind: "audio", label: "音频概览", Icon: AudioIcon, tint: "bg-art-audio/10", fg: "text-art-audio" },
  { kind: "cad", label: "CAD 模型", Icon: CadIcon, tint: "bg-accentSoft", fg: "text-accent" },
  { kind: "quiz", label: "测验", Icon: QuizIcon, tint: "bg-art-quiz/10", fg: "text-art-quiz" },
  { kind: "flashcards", label: "闪卡", Icon: CardsIcon, tint: "bg-art-cards/10", fg: "text-art-cards" },
  { kind: "excalidraw", label: "画板", Icon: BoardIcon, tint: "bg-art-board/10", fg: "text-art-board" },
  { kind: "slides", label: "演示文稿", Icon: PresentIcon, tint: "bg-art-slides/10", fg: "text-art-slides" },
  // 小红书卡组:资料 → 可直接发布的图文卡组(色 token 复用 art-info——信息图磁贴已下线,网格里不撞色)。
  { kind: "xhs", label: "小红书卡组", Icon: XhsCardsIcon, tint: "bg-art-info/10", fg: "text-art-info" },
  // 图片概述已下线(不再作为生成入口;已生成的仍可正常查看/下载)。
  { kind: "video", label: "视频概览", Icon: VideoIcon, tint: "bg-art-video/10", fg: "text-art-video" },
];

// Icon + tint for an artifact shown in the generated-outputs list.
export function outputVisual(kind: string): { Icon: typeof FileIcon; iconText: string; tint: string } {
  switch (kind) {
    case "audio": return { Icon: AudioIcon, iconText: "text-art-audio", tint: "bg-art-audio/10" };
    case "video": return { Icon: VideoIcon, iconText: "text-art-video", tint: "bg-art-video/10" };
    case "mindmap": return { Icon: MindMapIcon, iconText: "text-art-mindmap", tint: "bg-art-mindmap/10" };
    case "flashcards": return { Icon: CardsIcon, iconText: "text-art-cards", tint: "bg-art-cards/10" };
    case "quiz": return { Icon: QuizIcon, iconText: "text-art-quiz", tint: "bg-art-quiz/10" };
    case "infographic": return { Icon: ImageIcon, iconText: "text-art-info", tint: "bg-art-info/10" };
    case "xhs": return { Icon: XhsCardsIcon, iconText: "text-art-info", tint: "bg-art-info/10" };
    case "slides": return { Icon: PresentIcon, iconText: "text-art-slides", tint: "bg-art-slides/10" };
    case "table": return { Icon: TableIcon, iconText: "text-art-table", tint: "bg-art-table/10" };
    case "excalidraw": return { Icon: BoardIcon, iconText: "text-art-board", tint: "bg-art-board/10" };
    case "drawviso": return { Icon: BoardIcon, iconText: "text-art-table", tint: "bg-art-table/10" };
    case "cad": return { Icon: CadIcon, iconText: "text-accent", tint: "bg-accentSoft" };
    default: return { Icon: FileIcon, iconText: "text-art-report", tint: "bg-art-report/10" };
  }
}

/** Markdown-backed artifacts — everything except media (audio / video) and
 *  JSON-structured outputs (slides, infographic, flashcards, quiz). Used to
 *  decide whether an output can become a citable source ("转入来源"), and
 *  inversely whether "查看来源" is offered. */
function isMarkdownArtifact(o: StudioOutput): boolean {
  if (o.kind === "audio" || o.kind === "video" || o.kind === "cad") return false;
  const t = (o.content || "").trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      JSON.parse(t);
      return false; // valid JSON → structured artifact, not editable text
    } catch {
      /* starts with a brace but isn't JSON → treat as plain text */
    }
  }
  return true;
}

/** Only text/document artifacts (reports) become an editable note via
 *  "转入我的笔记". Media (audio / video), visual or structured outputs (mind
 *  map, slides, infographic, flashcards, quiz) and data tables are distinct
 *  types — not text — so they can't be turned into a plain note. */
const TEXT_NOTE_KINDS: ReadonlySet<string> = new Set([
  "study_guide",
  "briefing",
  "faq",
  "timeline",
  "toc",
  "blog",
  "custom",
]);
export function canConvertToNote(o: StudioOutput): boolean {
  return TEXT_NOTE_KINDS.has(o.kind) && (o.content || "").trim().length > 0;
}

// ---------------------------------------------------------------------------
// Studio panel (right column)
// ---------------------------------------------------------------------------

/** 列表加载中的骨架占位:模拟 StudioRow 的图标方块 + 两行文字,逐行错位更自然。 */
function PanelSkeleton() {
  return (
    <ul className="mt-3 space-y-1" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex items-center gap-3 rounded-xl px-2 py-2">
          <span className="h-9 w-9 shrink-0 animate-pulse rounded-xl bg-panel2" />
          <div className="min-w-0 flex-1 space-y-2">
            <span className="block h-3 animate-pulse rounded bg-panel2" style={{ width: `${72 - i * 9}%` }} />
            <span className="block h-2.5 w-1/3 animate-pulse rounded bg-panel2" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** 「我的笔记」空态插画:便签 + 铅笔 + 轻点缀,双层柔光底(线性、薰衣草色,无 ✦)。 */
function NotesEmptyArt() {
  return (
    <svg width="108" height="108" viewBox="0 0 108 108" fill="none" aria-hidden>
      <circle cx="54" cy="54" r="52" className="fill-accentSoft" opacity="0.45" />
      <circle cx="54" cy="54" r="39" className="fill-accentSoft" />
      <rect x="34" y="27" width="40" height="50" rx="6" className="fill-panel stroke-edge" strokeWidth="2.3" />
      <path d="M42 41h24M42 51h24M42 61h14" className="stroke-muted" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M62 62l12-12 6 6-12 12-8 2z" className="fill-panel stroke-accent" strokeWidth="2.3" strokeLinejoin="round" />
      <path d="M71 53l5 5" className="stroke-accent" strokeWidth="2.3" strokeLinecap="round" />
      <circle cx="28" cy="36" r="3" className="fill-accent" opacity="0.45" />
      <circle cx="82" cy="78" r="3.5" className="fill-accent" opacity="0.3" />
    </svg>
  );
}

/** 「智能笔记」空态插画:三张扇形叠放的制品卡(音频波形 / 数据柱 / 思维导图节点),双层柔光底。 */
function StudioEmptyArt() {
  return (
    <svg width="108" height="108" viewBox="0 0 108 108" fill="none" aria-hidden>
      <circle cx="54" cy="54" r="52" className="fill-accentSoft" opacity="0.45" />
      <circle cx="54" cy="54" r="39" className="fill-accentSoft" />
      <g transform="rotate(-15 54 88)">
        <rect x="39" y="30" width="30" height="44" rx="6" className="fill-panel stroke-edge" strokeWidth="2.3" strokeLinejoin="round" />
        <line x1="44" y1="47" x2="44" y2="57" className="stroke-muted" strokeWidth="2.3" strokeLinecap="round" />
        <line x1="49" y1="43" x2="49" y2="61" className="stroke-muted" strokeWidth="2.3" strokeLinecap="round" />
        <line x1="54" y1="39" x2="54" y2="65" className="stroke-muted" strokeWidth="2.3" strokeLinecap="round" />
        <line x1="59" y1="43" x2="59" y2="61" className="stroke-muted" strokeWidth="2.3" strokeLinecap="round" />
        <line x1="64" y1="47" x2="64" y2="57" className="stroke-muted" strokeWidth="2.3" strokeLinecap="round" />
      </g>
      <g transform="rotate(0 54 88)">
        <rect x="39" y="30" width="30" height="44" rx="6" className="fill-panel stroke-edge" strokeWidth="2.3" strokeLinejoin="round" />
        <line x1="44" y1="63.5" x2="64" y2="63.5" className="stroke-muted" strokeWidth="2.3" strokeLinecap="round" opacity="0.6" />
        <line x1="44.2" y1="63" x2="44.2" y2="57" className="stroke-muted" strokeWidth="2.3" strokeLinecap="round" />
        <line x1="50.8" y1="63" x2="50.8" y2="50" className="stroke-muted" strokeWidth="2.3" strokeLinecap="round" />
        <line x1="57.2" y1="63" x2="57.2" y2="44" className="stroke-muted" strokeWidth="2.3" strokeLinecap="round" />
        <line x1="63.8" y1="63" x2="63.8" y2="53" className="stroke-muted" strokeWidth="2.3" strokeLinecap="round" />
      </g>
      <g transform="rotate(15 54 88)">
        <rect x="39" y="30" width="30" height="44" rx="6" className="fill-panel stroke-accent" strokeWidth="2.3" strokeLinejoin="round" />
        <line x1="51" y1="44" x2="48" y2="60" className="stroke-accent" strokeWidth="2.3" strokeLinecap="round" />
        <line x1="51" y1="44" x2="62" y2="57" className="stroke-accent" strokeWidth="2.3" strokeLinecap="round" />
        <circle cx="51" cy="44" r="4.2" className="fill-accent stroke-accent" strokeWidth="2.3" />
        <circle cx="48" cy="61" r="3.4" className="fill-panel stroke-accent" strokeWidth="2.3" />
        <circle cx="62" cy="57" r="3.4" className="fill-panel stroke-accent" strokeWidth="2.3" />
      </g>
      <circle cx="29" cy="30" r="2.6" className="fill-accent" opacity="0.35" />
      <circle cx="83" cy="80" r="2.2" className="fill-accent" opacity="0.35" />
    </svg>
  );
}

/** 空态:垂直居中(填满空白区,不再上挤一行)+ 大插画 + 标题 + 提示 + 可选 CTA。 */
function PanelEmpty({
  art,
  title,
  hint,
  action,
}: {
  art: "notes" | "studio";
  title: string;
  hint: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex min-h-[46vh] flex-col items-center justify-center px-6 py-8 text-center">
      <div className="mb-5">{art === "notes" ? <NotesEmptyArt /> : <StudioEmptyArt />}</div>
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      <p className="mt-2 max-w-[17rem] text-[12.5px] leading-relaxed text-muted">{hint}</p>
      {action && (
        <button
          onClick={action.onClick}
          className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accentSoft px-4 py-2 text-[13px] font-medium text-accent transition hover:bg-accent hover:text-onAccent"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** 生成中那行的阶段文案。CAD 的 progress 是服务端写入的稳定阶段边界；
 *  其他旧制品仍保持历史分段语义。 */
function genStageLabel(g: GenJobState, kind?: StudioKind): string {
  if (g.status === "queued") return "排队中…";
  if (kind === "cad") {
    return `${CAD_JOB_STAGE_LABEL[cadJobStageFromProgress(g.progress)]}…`;
  }
  return g.progress < 30 ? "取材中…" : g.progress < 70 ? "撰写中…" : "整理中…";
}

export function StudioPanel({
  outputs,
  activeOutputId,
  notes,
  loading,
  generating,
  onCancelGenerate,
  banner,
  sourceCount,
  readySourceCount,
  hasSources,
  hasChat,
  hasNotes,
  overQuota,
  onOpenConfig,
  onAddSource,
  onRequireSources,
  onOpenOutput,
  onDeleteOutput,
  onShareOutput,
  onRenameOutput,
  onConvertOutput,
  onConvertOutputToSource,
  onViewSources,
  onNewNote,
  onOpenNote,
  onDeleteNote,
  onRenameNote,
  onConvertNoteToSource,
  onConvertAllNotes,
  onDeleteAllNotes,
  collapsed,
  onToggleCollapse,
  playingAudio,
  onClosePlayer,
  playingId,
  onPlayerPlayingChange,
  onShareNotebook,
  activeQuiz,
  onCloseQuiz,
  onQuizSaveNote,
  onQuizOpenSource,
  hiddenArtifacts,
  userHiddenTiles,
  onSaveUserHiddenTiles,
}: {
  outputs: StudioOutput[];
  /** 当前在主窗口展示的智能制品；右栏保留选中态作为导航反馈。 */
  activeOutputId?: string | null;
  notes: Note[];
  /** 笔记本数据加载中 → 列表显示骨架占位,而非空态。 */
  loading: boolean;
  /** 并行生成:kind → 在途任务(排队/运行 + 假进度);不再有全局唯一生成位。 */
  generating: GenMap;
  /** 点生成中那行的「取消」→ DELETE /api/jobs/{jobId}(由 HomeClient 落地)。 */
  onCancelGenerate?: (kind: StudioKind) => void;
  /** 一次性提示横幅(如课代表包完成),渲染在列表滚动区顶部;空 = 不显示。 */
  banner?: React.ReactNode;
  sourceCount: number;
  /** 已就绪来源总数，用于区分“没有资料”和“资料未勾选”。 */
  readySourceCount: number;
  /** 当前至少勾选了一个已就绪来源。 */
  hasSources: boolean;
  /** 本次会话/我的笔记是否有内容(决定生成弹窗里对应取材项是否可选)。 */
  hasChat: boolean;
  hasNotes: boolean;
  /** 今日积分已用完:磁贴置灰,点击不开生成弹窗(由 onOpenConfig 侧给出提示)。 */
  overQuota?: boolean;
  onAddSource: () => void;
  /** 已有来源但未勾选时，展开并切换到来源栏。 */
  onRequireSources: () => void;
  /** 点击磁贴 → 打开生成配置弹窗。 */
  onOpenConfig: (tile: "mindmap" | "reports" | "table" | "slides" | "audio" | "video" | "infographic" | "quiz" | "flashcards" | "excalidraw" | "xhs" | "drawviso" | "cad") => void;
  onOpenOutput: (o: StudioOutput) => void;
  onDeleteOutput: (id: string) => void;
  onShareOutput?: (o: StudioOutput) => void;
  onRenameOutput?: (id: string, title: string) => void;
  /** "转入我的笔记" — copy a generated output into the notes list. */
  onConvertOutput?: (o: StudioOutput) => void;
  /** "转入来源" — turn a generated output into a citable source. */
  onConvertOutputToSource?: (o: StudioOutput) => void;
  /** "查看来源" — show which sources a generated artifact was made from. */
  onViewSources?: (o: StudioOutput) => void;
  onNewNote: () => void;
  onOpenNote: (n: Note) => void;
  onDeleteNote: (id: string) => void;
  onRenameNote?: (id: string, title: string) => void;
  /** "转入来源" — turn a note into a citable source. */
  onConvertNoteToSource?: (id: string) => void;
  onConvertAllNotes: () => void;
  onDeleteAllNotes: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  playingAudio?: StudioOutput | null;
  onClosePlayer?: () => void;
  /** id of the audio output that is actively playing (null when paused/none). */
  playingId?: string | null;
  onPlayerPlayingChange?: (playing: boolean) => void;
  onShareNotebook?: () => void;
  /** 测验在右栏内联作答(NotebookLM 式):非空即用测验面板替换整个右栏内容。 */
  activeQuiz?: StudioOutput | null;
  onCloseQuiz?: () => void;
  onQuizSaveNote?: (title: string, content: string) => boolean | void | Promise<boolean | void>;
  onQuizOpenSource?: (title: string) => boolean;
  /** 管理员在后台隐藏的智能输出 kind 列表;对应磁贴不渲染(服务端另有二次拦截)。 */
  hiddenArtifacts?: string[];
  /** 用户自定义隐藏的磁贴(tile id 列表,个人偏好);与后台下架相互独立。 */
  userHiddenTiles?: string[];
  /** 保存用户磁贴偏好(乐观更新 + PATCH 持久化);不传则不显示「自定义」入口。 */
  onSaveUserHiddenTiles?: (next: string[]) => void;
}) {
  // 正在生成的 kind 列表(并行:可能同时多个,各自一行进度)。
  const genKinds = Object.keys(generating) as StudioKind[];
  // Right panel = 合并的「笔记」:顶部生成磁贴,下方用切换器在「智能笔记 / 我的笔记」间切换。
  // 取材范围已统一由左栏勾选驱动(来源/会话/我的笔记 都是可勾选条目)。
  const [view, setView] = useState<"smart" | "mine">("mine");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 点击生成后自动切到「智能笔记」,让用户看到生成进度与结果。
  // 键用 kind 集合(而非个数):并行时「一个收尾同时另一个开始」个数不变也要触发。
  const genKey = genKinds.join(",");
  useEffect(() => {
    if (genKey) setView("smart");
  }, [genKey]);
  // 删除测验要等确认弹窗「确认」后才生效:查看器里点「删除」只发起确认(onDelete →
  // HomeClient pendingDel),这里监听结果——某个测验在列表里「原地消失」(loading 未
  // 翻转,排除切本/重载的整表更换)即视为删除成功,此时才清答题进度;若被删的正是
  // 右栏打开的测验,同时收起面板。确认框点「取消」时 outputs 不变,查看器与进度原地不动。
  const prevQuizIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (loading) {
      prevQuizIdsRef.current = null; // 切本/重载:整表更换不算删除,别误清进度
      return;
    }
    const ids = new Set(outputs.filter((o) => o.kind === "quiz").map((o) => o.id));
    const prev = prevQuizIdsRef.current;
    prevQuizIdsRef.current = ids;
    if (!prev) return;
    for (const id of prev) {
      if (ids.has(id)) continue;
      try { localStorage.removeItem(`quiz-progress:${id}`); } catch { /* 隐私模式/配额满,忽略 */ }
      if (activeQuiz?.id === id) onCloseQuiz?.();
    }
  }, [outputs, loading, activeQuiz, onCloseQuiz]);
  const q = query.trim().toLowerCase();
  const shownOutputs = q ? outputs.filter((o) => o.title.toLowerCase().includes(q)) : outputs;
  const shownNotes = q ? notes.filter((n) => n.title.toLowerCase().includes(q)) : notes;
  const reportGenerating = genKinds.some(
    // toc/blog 不在 REPORTS 分段控件里,但同属报告弹窗可选格式,生成中也要点亮报告磁贴。
    (k) => REPORTS.some((r) => r.kind === k) || k === "custom" || k === "toc" || k === "blog"
  );
  // 合并面板:全部生成磁贴,两层过滤——
  // ① 管理员后台隐藏(hiddenArtifacts = 被隐藏的 kind;「能不能用」,服务端另有拦截);
  // ② 用户自定义隐藏(userHiddenTiles = tile id;「想不想看见」,仅个人显示偏好)。
  // 「PDF 报告」是聚合磁贴:其任一报告子类仍可见就保留(具体格式在弹窗里再过滤)。
  const artHidden = new Set(hiddenArtifacts ?? []);
  const userHidden = new Set(userHiddenTiles ?? []);
  const REPORT_KINDS = ["briefing", "study_guide", "faq", "timeline", "toc", "blog", "custom"];
  // 管理端可用的磁贴(自定义弹层只列这些——被后台下架的类型用户无从打开)。
  const ADMIN_TILES = ARTIFACTS.filter((a) =>
    a.reports ? REPORT_KINDS.some((k) => !artHidden.has(k)) : !artHidden.has(a.kind as string)
  );
  const TILES = ADMIN_TILES.filter((a) => !userHidden.has(a.kind as string));
  // 「自定义磁贴」底部弹层开合。
  const [tilesConfigOpen, setTilesConfigOpen] = useState(false);
  // ref 镜像最新偏好:同一事件循环内连续 toggle(快速连点)也基于最新值计算,
  // 不会因渲染闭包滞后而互相覆盖。
  const userHiddenRef = useRef(userHiddenTiles ?? []);
  userHiddenRef.current = userHiddenTiles ?? [];
  const toggleTile = (tileId: string) => {
    if (!onSaveUserHiddenTiles) return;
    const next = new Set(userHiddenRef.current);
    if (next.has(tileId)) next.delete(tileId);
    else {
      // 至少保留一个可见磁贴(以管理端可用集为基数),防全隐藏后找不到生成入口。
      const visibleCount = ADMIN_TILES.filter((a) => !next.has(a.kind as string)).length;
      if (visibleCount <= 1) { toast("至少保留一个磁贴"); return; }
      next.add(tileId);
    }
    const arr = [...next];
    userHiddenRef.current = arr; // 立即同步,后续同-tick 调用不丢前一次改动
    onSaveUserHiddenTiles(arr);
  };
  const smartCount = shownOutputs.length;
  const noteCount = shownNotes.length;

  // 测验在右栏内联作答:替换整个右栏；“具体解析”直接展开制品内的逐项依据。
  if (activeQuiz) {
    return (
      <QuizView
        // key by artifact id: switching to a different quiz (or a newly-generated
        // one replacing the open one) must remount, else the reused instance keeps
        // a stale question index that overruns the shorter quiz → cur=undefined →
        // cur.q / cur.options.map throws and the whole panel crashes. Mirrors the
        // modal QuizView (key={openDoc.id}) in HomeClient.
        key={activeQuiz.id}
        variant="panel"
        output={activeQuiz}
        onClose={onCloseQuiz ?? (() => {})}
        onSaveNote={onQuizSaveNote}
        onDelete={() => onDeleteOutput(activeQuiz.id)}
        onOpenSource={onQuizOpenSource}
        onShareNotebook={onShareNotebook}
      />
    );
  }

  if (collapsed) {
    return (
      // 收起态是桌面专属交互(56px 竖条在移动 tab 里无意义)→ 保持 <lg 隐藏;
      // 移动布局下 HomeClient 应传 collapsed=false
      <aside className="hidden w-14 shrink-0 flex-col items-center gap-1.5 rounded-[22px] bg-panel elev-soft py-3 lg:flex">
        <button
          onClick={onToggleCollapse}
          title="展开笔记"
          aria-label="展开笔记"
          className="grid h-9 w-9 place-items-center rounded-xl text-ink2 transition hover:bg-panel2 hover:text-accent"
        >
          <PanelRightIcon width={18} height={18} />
        </button>
        {/* Studio actions — soft-tinted tiles mirroring the expanded grid;
            a tap expands the panel so generation progress stays visible. */}
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TILES.map((a) => {
            const Icon = a.Icon;
            return (
              <button
                key={a.kind}
                onClick={onToggleCollapse}
                title={a.label}
                aria-label={a.label}
                className={cn(
                  "group relative grid h-9 w-9 shrink-0 place-items-center rounded-xl transition hover:brightness-95 active:scale-95",
                  a.tint
                )}
              >
                <Icon width={17} height={17} className={a.fg} />
                <span className="absolute -bottom-1 -right-1 grid h-3.5 w-3.5 place-items-center rounded-full bg-panel text-ink2 shadow-sm ring-1 ring-edge">
                  <PlusIcon width={9} height={9} />
                </span>
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    // 窄屏(<lg 单栏+底部tab):不再自带 hidden/固定宽,w-full 交给父容器(HomeClient
    // 的 tab 布局决定显隐与高度);≥lg 恢复固定右栏宽,桌面不变
    <aside className="flex w-full shrink-0 flex-col overflow-hidden rounded-[22px] bg-panel elev-soft lg:w-[360px] xl:w-[384px]">
      {/* tab bar — icon-only tabs that expand to a labelled pill when active
          (Feishu/NotebookLM style), plus quick search + collapse */}
      <div className="px-3 pt-3 pb-1.5">
        <div className="flex items-center gap-1">
          <span className="px-2 py-1.5 text-[15px] font-semibold text-ink">笔记</span>
          <div className="ml-auto flex items-center gap-0.5">
            {onSaveUserHiddenTiles && (
              <button
                onClick={() => setTilesConfigOpen(true)}
                title="自定义磁贴"
                aria-label="自定义磁贴"
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-full transition",
                  tilesConfigOpen ? "bg-panel2 text-accent" : "text-ink2 hover:bg-panel2 hover:text-accent"
                )}
              >
                <GridPenIcon width={17} height={17} />
              </button>
            )}
            <button
              onClick={() => {
                setSearchOpen((v) => !v);
                if (searchOpen) setQuery("");
              }}
              title="快速搜索"
              aria-label="快速搜索"
              className={cn(
                "grid h-9 w-9 place-items-center rounded-full transition",
                searchOpen ? "bg-panel2 text-accent" : "text-ink2 hover:bg-panel2 hover:text-accent"
              )}
            >
              <SearchIcon width={17} height={17} />
            </button>
            <button
              onClick={onToggleCollapse}
              title="收起笔记"
              aria-label="收起笔记"
              className="grid h-9 w-9 place-items-center rounded-full text-ink2 transition hover:bg-panel2 hover:text-accent"
            >
              <PanelRightIcon width={17} height={17} />
            </button>
          </div>
        </div>
        {searchOpen && (
          <div className="mt-2 flex items-center gap-2 rounded-full border border-edge bg-panel2/60 px-3.5 py-2">
            <SearchIcon width={15} height={15} className="shrink-0 text-muted" />
            <input
              autoFocus
              name="search"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索笔记…"
              className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                aria-label="清除"
                className="shrink-0 text-muted transition hover:text-ink"
              >
                <CloseIcon width={14} height={14} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
       <div className="h-full overflow-y-auto px-3 pb-24 pt-1">
        {banner}
        {!q && (
        <div className={cn("grid grid-cols-2 gap-2 transition-opacity", overQuota && "opacity-55")} title={overQuota ? "今日积分已用完,明日自动恢复" : undefined}>
          {TILES.map((a) => (
            <ArtifactTile
              key={a.kind}
              label={a.label}
              Icon={a.Icon}
              tint={a.tint}
              fg={a.fg}
              beta={a.beta}
              active={false}
              loading={a.reports ? reportGenerating : !!generating[a.kind as StudioKind]}
              // 点击磁贴 → 打开生成配置弹窗(取材/指令/语言/特有项都在弹窗里)。
              // 并行生成:只禁用「正在生成的那个 kind」,其余磁贴照常可点。
              disabled={a.reports ? reportGenerating : !!generating[a.kind as StudioKind]}
              onClick={() => {
                if (!hasSources && a.kind !== "cad" && !hasChat && !hasNotes) {
                  if (readySourceCount > 0) {
                    toast("请先在左侧勾选至少一个已就绪来源", "error");
                    onRequireSources();
                  } else {
                    // 零来源点磁贴:先说明为什么弹的是「添加来源」,别让用户点 A 出 B 摸不着头脑。
                    toast("生成需要先添加来源,先把资料放进来吧", "error");
                    onAddSource();
                  }
                } else {
                  onOpenConfig(a.reports ? "reports" : a.kind as ConfigTile);
                }
              }}
            />
          ))}
        </div>
        )}

        {/* 切换器:智能笔记 / 我的笔记 —— 放在磁贴下方,列表随之切换 */}
        <div className={cn(!q ? "mt-5 border-t border-edge pt-4" : "mt-1")}>
          <div className="flex rounded-lg bg-panel2 p-0.5 text-[13px]">
            <button
              onClick={() => setView("smart")}
              className={cn(
                "flex-1 rounded-md py-1.5 font-medium transition",
                view === "smart" ? "bg-panel text-accent shadow-sm" : "text-ink2 hover:text-ink"
              )}
            >
              智能笔记<span className="ml-1 text-[11px] font-normal text-muted">{smartCount}</span>
            </button>
            <button
              onClick={() => setView("mine")}
              className={cn(
                "flex-1 rounded-md py-1.5 font-medium transition",
                view === "mine" ? "bg-panel text-accent shadow-sm" : "text-ink2 hover:text-ink"
              )}
            >
              我的笔记<span className="ml-1 text-[11px] font-normal text-muted">{noteCount}</span>
            </button>
          </div>

          {/* 加载中:两个视图都先显示骨架占位,而非空态 */}
          {loading && <PanelSkeleton />}

          {/* 智能笔记视图 */}
          {view === "smart" && !loading && (shownOutputs.length > 0 || (genKinds.length > 0 && !q)) && (
            <ul className="mt-3 space-y-0.5">
              {!q && genKinds.map((k) => {
                const g = generating[k]!;
                return (
                <li key={`gen-${k}`} className="relative flex items-center gap-3 overflow-hidden rounded-xl bg-panel2/70 px-2 py-2">
                  <span className="pointer-events-none absolute inset-0 animate-[shimmerSweep_1.8s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/55 to-transparent" />
                  <span className={cn("relative grid h-9 w-9 shrink-0 place-items-center rounded-xl", outputVisual(k).tint)}>
                    <svg
                      className={cn("animate-spin", outputVisual(k).iconText)}
                      width="19"
                      height="19"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 2v6h-6" />
                      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                      <path d="M3 22v-6h6" />
                      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                    </svg>
                  </span>
                  <div className="relative min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">
                      正在生成{KIND_LABEL[k] || "内容"}…
                    </p>
                    <p className="truncate text-xs text-muted">
                      {/* CAD 使用服务端真实阶段；其他存量类型保留历史分段。 */}
                      {k === "audio" || k === "video"
                        ? `${genStageLabel(g, k)} · 请过几分钟后再来查看`
                        : `${genStageLabel(g, k)} · ${g.sourceLabel ?? `基于 ${sourceCount} 个来源`}`}
                    </p>
                  </div>
                  {onCancelGenerate && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancelGenerate(k);
                      }}
                      aria-label="取消生成"
                      title="取消"
                      className="relative grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-black/[0.055] text-ink2 transition hover:bg-red-50 hover:text-red-600"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden>
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  )}
                </li>
                );
              })}
              {shownOutputs.map((o) => {
                const v = outputVisual(o.kind);
                const storedSourceIds = sourceIdsOf(o);
                const hasViewableSources = o.kind !== "cad"
                  || storedSourceIds === undefined
                  || storedSourceIds.length > 0;
                return (
                  <StudioRow
                    key={o.id}
                    icon={
                      <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl", v.tint)}>
                        {o.kind === "audio" ? (
                          <EqualizerIcon size={19} className={v.iconText} animated={playingId === o.id} />
                        ) : (
                          <v.Icon width={20} height={20} className={v.iconText} />
                        )}
                      </span>
                    }
                    title={o.title}
                    subtitle={outputSubtitle(o)}
                    playable={o.kind === "audio"}
                    active={activeOutputId === o.id || (o.kind === "audio" && playingAudio?.id === o.id)}
                    onOpen={() => onOpenOutput(o)}
                    onDelete={() => onDeleteOutput(o.id)}
                    // CAD 原生规格/制造文件首版不进入匿名公开分享，避免按钮产生
                    // “链接可分享但访客看不到”的误导。
                    onShare={onShareOutput && o.kind !== "cad" ? () => onShareOutput(o) : undefined}
                    onRename={onRenameOutput ? (t) => onRenameOutput(o.id, t) : undefined}
                    onConvertToNote={
                      // 所有「可转成文字」的智能笔记都能转入我的笔记(移动);
                      // 音频/视频/画板这类非文字制品除外(画板内容是场景 JSON,不能当文字笔记)。
                      onConvertOutput &&
                      o.kind !== "audio" &&
                      o.kind !== "video" &&
                      o.kind !== "excalidraw" &&
                      o.kind !== "cad" &&
                      outputToMarkdown(o.kind, o.content).trim()
                        ? () => onConvertOutput(o)
                        : undefined
                    }
                    onConvertToSource={
                      onConvertOutputToSource && isMarkdownArtifact(o)
                        ? () => onConvertOutputToSource(o)
                        : undefined
                    }
                    convertedToSource={!!o.converted_to_source}
                    onViewSources={
                      onViewSources && !isMarkdownArtifact(o) && hasViewableSources
                        ? () => onViewSources(o)
                        : undefined
                    }
                    onDownload={o.kind === "cad" ? undefined : () => downloadOutput(o)}
                  />
                );
              })}
            </ul>
          )}
          {/* 智能笔记视图 · 空态 */}
          {view === "smart" && !loading && !(shownOutputs.length > 0 || (genKinds.length > 0 && !q)) && (
            q ? (
              <p className="px-1 py-10 text-center text-sm text-muted">
                未找到匹配「{query.trim()}」的智能笔记
              </p>
            ) : (
              <PanelEmpty
                art="studio"
                title="智能笔记将保存在此处"
                hint="点击上方磁贴,可生成音频概览、思维导图、PDF 报告、CAD 模型等制品。"
              />
            )
          )}

          {/* 我的笔记视图 */}
          {view === "mine" && !loading &&
            (shownNotes.length > 0 ? (
              <ul className="mt-3 space-y-1">
                {shownNotes.map((n) => (
                  <StudioRow
                    key={n.id}
                    icon={
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accentSoft">
                        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden>
                          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                          <path d="M14 3v5h6" />
                          <path d="M9 13h6" />
                          <path d="M9 17h3.5" />
                        </svg>
                      </span>
                    }
                    title={n.title}
                    subtitle={`${
                      n.kind === "chat" ? "来自对话" : n.kind === "report" ? "来自智能笔记" : "笔记"
                    }${n.created_at ? ` · ${relTime(n.created_at)}` : ""}`}
                    onOpen={() => onOpenNote(n)}
                    onRename={onRenameNote ? (t) => onRenameNote(n.id, t) : undefined}
                    onConvertToSource={
                      onConvertNoteToSource ? () => onConvertNoteToSource(n.id) : undefined
                    }
                    convertedToSource={!!n.converted_to_source}
                    onDownload={() => downloadNote(n)}
                    onDelete={() => onDeleteNote(n.id)}
                  />
                ))}
              </ul>
            ) : q ? (
              <p className="mt-6 px-1 py-5 text-center text-sm text-muted">
                未找到匹配「{query.trim()}」的笔记
              </p>
            ) : (
              <PanelEmpty
                art="notes"
                title="还没有笔记"
                hint="点下方「添加笔记」记录想法,或把对话、智能笔记里的回答存为笔记。"
              />
            ))}
        </div>
       </div>
       {/* 浮动「添加笔记」按钮(始终可用) */}
       <button
         onClick={onNewNote}
         className="absolute bottom-5 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-accent px-3.5 py-2 text-[13px] font-medium text-onAccent shadow-[0_10px_26px_-8px_rgba(109, 90, 230,0.5)] transition hover:brightness-110 active:scale-[0.97]"
       >
         <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
           <rect x="4" y="3.5" width="16" height="17" rx="3" />
           <path d="M8 9h8M8 13h8M8 17h4.5" />
         </svg>
         添加笔记
       </button>
      </div>
      {playingAudio && onClosePlayer && (
        <AudioDockPlayer
          key={playingAudio.id}
          output={playingAudio}
          onClose={onClosePlayer}
          onDelete={() => onDeleteOutput(playingAudio.id)}
          onPlayingChange={onPlayerPlayingChange}
          onShare={onShareNotebook}
        />
      )}

      {/* 自定义生成磁贴 —— 全屏居中弹窗(方案H:宫格预览勾选):弹窗内容就是右栏宫格的
          缩影,点磁贴切换显隐(灰化+虚线边+右上角勾选圆点),所见即所得;改动即存(乐观 + PATCH)。
          只列管理端可用的磁贴;被后台下架的类型不出现(用户无从打开)。portal 到 body,
          盖在整个工作台上(StudioPanel 经 next/dynamic ssr:false 加载,document 恒可用)。 */}
      {tilesConfigOpen && onSaveUserHiddenTiles && createPortal(
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4"
          onMouseDown={() => setTilesConfigOpen(false)}
        >
          <div
            className="max-h-[86vh] w-full max-w-[420px] overflow-y-auto rounded-2xl bg-panel p-5 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="text-[15px] font-semibold text-ink">自定义生成磁贴</p>
            <p className="mb-3.5 mt-0.5 text-xs text-muted">点选切换显示;灰色虚线为隐藏,可随时恢复。</p>
            <div className="grid grid-cols-2 gap-2.5">
              {ADMIN_TILES.map((a) => {
                const on = !userHidden.has(a.kind as string);
                const Icon = a.Icon;
                return (
                  <button
                    key={a.kind}
                    aria-pressed={on}
                    aria-label={`${on ? "隐藏" : "显示"}${a.label}`}
                    onClick={() => toggleTile(a.kind as string)}
                    className={cn(
                      "relative flex items-center gap-2.5 rounded-2xl border p-3 text-left transition",
                      on ? "border-edge bg-panel hover:border-accent/45" : "border-dashed border-edge bg-panel opacity-45"
                    )}
                  >
                    <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl", a.tint, a.fg)}>
                      <Icon width={18} height={18} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{a.label}</span>
                    <span
                      className={cn(
                        "absolute -right-1.5 -top-1.5 grid h-[19px] w-[19px] place-items-center rounded-full border-2 border-panel transition-colors",
                        on ? "bg-accent" : "bg-edge"
                      )}
                    >
                      {on && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" className="text-onAccent" aria-hidden>
                          <path d="m5 12 5 5L20 7" />
                        </svg>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-4 flex gap-2.5">
              <button
                onClick={() => onSaveUserHiddenTiles([])}
                className="flex-1 rounded-xl bg-panel2 py-2.5 text-[13px] font-semibold text-ink2 transition hover:bg-edge/60"
              >
                恢复默认
              </button>
              <button
                onClick={() => setTilesConfigOpen(false)}
                className="flex-1 rounded-xl bg-accent py-2.5 text-[13px] font-semibold text-onAccent transition hover:brightness-110"
              >
                完成
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </aside>
  );
}

export function ArtifactTile({
  label,
  Icon,
  tint,
  fg,
  beta,
  loading,
  disabled,
  active,
  title,
  onClick,
  onCustomize,
}: {
  label: string;
  Icon: typeof FileIcon;
  tint: string;
  fg: string;
  beta?: boolean;
  loading: boolean;
  disabled: boolean;
  active?: boolean;
  title?: string;
  onClick: () => void;
  /** Optional hover affordance: open the customize dialog instead of generating. */
  onCustomize?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "group flex items-center gap-2.5 rounded-2xl border px-3 py-3 text-left transition duration-150 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50",
        active ? "border-accent bg-accentSoft/40" : "border-edge bg-panel hover:border-accent/40"
      )}
    >
      <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-xl", tint)}>
        {loading ? <SpinnerIcon width={17} height={17} className={fg} /> : <Icon width={17} height={17} className={fg} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{label}</span>
      {beta && (
        <span className="shrink-0 rounded bg-solid px-1 py-0.5 text-[9px] font-semibold leading-none text-onSolid">
          Beta
        </span>
      )}
      {onCustomize && !loading && !disabled && (
        <span
          role="button"
          tabIndex={0}
          title={`自定义${label}`}
          aria-label={`自定义${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onCustomize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              e.preventDefault();
              onCustomize();
            }
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted opacity-0 transition hover:bg-panel2 hover:text-accent focus-visible:opacity-100 group-hover:opacity-100"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </span>
      )}
      <span className="shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-accent">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </span>
    </button>
  );
}

export function StudioRow({
  icon,
  title,
  subtitle,
  playable,
  active,
  onOpen,
  onDelete,
  onShare,
  onRename,
  onConvertToNote,
  onConvertToSource,
  convertedToSource,
  onViewSources,
  onDownload,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  playable?: boolean;
  /** This row's audio is the one loaded in the player → frame it & drop the play button. */
  active?: boolean;
  onOpen: () => void;
  onDelete?: () => void;
  onShare?: () => void;
  onRename?: (title: string) => void;
  /** "转入我的笔记" — copy this generated item into the user's notes. */
  onConvertToNote?: () => void;
  /** "转入来源" — turn this generated item into a citable source. */
  onConvertToSource?: () => void;
  /** Already turned into a source → show "转入来源" greyed/disabled. */
  convertedToSource?: boolean;
  /** "查看来源" — show which sources this artifact was generated from. */
  onViewSources?: () => void;
  /** "下载" — download the item (media file or markdown). */
  onDownload?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // 靠近视口底部的卡片:菜单向下展开会溢出/被底部「添加笔记」浮钮遮住 → 打开时按剩余空间
  // 决定向上翻转(bottom-9)还是向下(top-9)。
  const [flipUp, setFlipUp] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const toggleMenu = () => {
    setMenuOpen((v) => {
      if (!v) {
        const r = menuBtnRef.current?.getBoundingClientRect();
        if (r) setFlipUp(window.innerHeight - r.bottom < 300);
      }
      return !v;
    });
  };
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const hasMenu = !!(
    onRename || onConvertToNote || onConvertToSource || onViewSources || onDownload || onShare || onDelete
  );

  const startRename = () => {
    setMenuOpen(false);
    setDraft(title);
    setRenaming(true);
  };
  const commitRename = () => {
    setRenaming(false);
    const t = draft.trim();
    if (t && t !== title) onRename?.(t);
  };

  return (
    <li
      className={cn(
        "group flex items-center gap-3 rounded-xl px-2 py-2 transition",
        active ? "bg-panel2 ring-2 ring-accent ring-inset" : "hover:bg-panel2"
      )}
    >
      <span className="shrink-0">{icon}</span>
      {renaming ? (
        <input
          autoFocus
          name="title"
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              setRenaming(false);
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-accent bg-panel px-2 py-1 text-[13.5px] font-medium text-ink outline-none ring-2 ring-accentSoft"
        />
      ) : (
        <button
          onClick={onOpen}
          aria-current={active && !playable ? "page" : undefined}
          className="flex min-w-0 flex-1 flex-col text-left"
        >
          <span className="block truncate text-[13.5px] font-medium text-ink" title={title}>
            {title}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted">{subtitle}</span>
        </button>
      )}
      {playable && !active && !renaming && (
        <button
          onClick={onOpen}
          className="group/play grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accentSoft text-accent transition hover:bg-accent hover:text-onAccent"
          aria-label="播放"
        >
          <PlayIcon
            width={13}
            height={13}
            className="transition-transform group-hover/play:scale-110"
          />
        </button>
      )}
      {hasMenu && !renaming && (
        <div className="relative shrink-0">
          <button
            ref={menuBtnRef}
            onClick={toggleMenu}
            className={cn(
              "grid h-8 w-8 place-items-center rounded-full text-muted transition hover:bg-edge/50 hover:text-ink",
              menuOpen && "bg-edge/50 text-ink"
            )}
            aria-label="更多操作"
          >
            <DotsIcon width={16} height={16} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
              <div className={`absolute right-0 z-50 w-max min-w-[9.5rem] overflow-hidden ${flipUp ? "bottom-9" : "top-9"} ${MENU_PANEL}`}>
                {onRename && (
                  <button
                    onClick={startRename}
                    className={MENU_ITEM}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                    </svg>
                    重命名
                  </button>
                )}
                {onConvertToNote && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onConvertToNote();
                    }}
                    className={MENU_ITEM}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
                      <path d="M19 12V8l-5-5H7a2 2 0 0 0-2 2v7" />
                      <path d="M12 13v8" />
                      <path d="m9 18 3 3 3-3" />
                    </svg>
                    转入我的笔记
                  </button>
                )}
                {onConvertToSource && (
                  <button
                    onClick={() => {
                      if (convertedToSource) return;
                      setMenuOpen(false);
                      onConvertToSource();
                    }}
                    disabled={convertedToSource}
                    title={convertedToSource ? "已转入来源" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2.5 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-left text-sm transition",
                      convertedToSource
                        ? "cursor-not-allowed text-muted"
                        : "text-ink hover:bg-panel2"
                    )}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                      <path d="M12 18v-6" />
                      <path d="m9 15 3 3 3-3" />
                    </svg>
                    {convertedToSource ? "已转入来源" : "转入来源"}
                  </button>
                )}
                {onViewSources && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onViewSources();
                    }}
                    className={MENU_ITEM}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    查看来源
                  </button>
                )}
                {onDownload && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onDownload();
                    }}
                    className={MENU_ITEM}
                  >
                    <DownloadIcon width={14} height={14} />
                    下载
                  </button>
                )}
                {onShare && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onShare();
                    }}
                    className={MENU_ITEM}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="18" cy="5" r="3" />
                      <circle cx="6" cy="12" r="3" />
                      <circle cx="18" cy="19" r="3" />
                      <path d="m8.6 13.5 6.8 4" />
                      <path d="m15.4 6.5-6.8 4" />
                    </svg>
                    分享
                  </button>
                )}
                {onDelete && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete();
                    }}
                    className={MENU_ITEM_DANGER}
                  >
                    <TrashIcon width={14} height={14} /> 删除
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// modal shell
// ---------------------------------------------------------------------------

/** Source count stored on an output's data sidecar (new generations only). */
function sourcesOf(o: StudioOutput): number | undefined {
  if (!o.data) return undefined;
  try {
    const d = JSON.parse(o.data) as { sources?: number };
    return typeof d.sources === "number" ? d.sources : undefined;
  } catch {
    return undefined;
  }
}

/** 查看器副标题:取材是会话/笔记时显示对应文案,否则「基于 N 个来源」(无来源则不显示)。 */
function sourceCaption(o: StudioOutput): string | undefined {
  let scope: string | undefined;
  try {
    scope = (JSON.parse(o.data || "{}") as { scope?: string }).scope;
  } catch {
    /* ignore */
  }
  if (scope === "chat") return "基于本次会话";
  if (scope === "notes") return "基于我的笔记";
  const n = sourcesOf(o);
  return typeof n === "number" && n > 0 ? `基于 ${n} 个来源` : undefined;
}

/** The exact source ids an artifact was generated from (newer generations only). */
/** Share an artifact — copy the notebook's read-only share link (in-app, no OS share sheet). */
async function shareOutput(o: StudioOutput) {
  const url =
    typeof window !== "undefined" ? `${window.location.origin}/share/${o.notebook_id}` : "";
  try {
    await navigator.clipboard.writeText(url);
    toast("已复制分享链接");
  } catch {
    toast("复制失败", "error");
  }
}

function Modal({
  title,
  subtitle,
  sourceCaption: caption,
  onClose,
  children,
  footer,
  headerActions,
  onDownload,
  onShare,
  wide,
  fill,
  noExpand,
  narrow,
  full: fullProp,
  onFullChange,
}: {
  title: React.ReactNode;
  subtitle?: string;
  /** 副标题第二行文案(如「基于本次会话 / 我的笔记 / N 个来源」)。 */
  sourceCaption?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Action buttons placed in the header's right cluster, before the window controls. */
  headerActions?: React.ReactNode;
  /** 统一的「下载」按钮:所有查看器都放在头部右侧,图标与位置一致。 */
  onDownload?: () => void;
  /** Show a 分享 button in the footer (NotebookLM-style artifact viewer). */
  onShare?: () => void;
  wide?: boolean;
  /** Make the content area a flex column so a child can grow to fill the
   *  modal's height (used by the mind-map viewer so it expands when maximised). */
  fill?: boolean;
  /** 隐藏顶部「展开/还原」按钮(生成配置弹窗不需要放大)。 */
  noExpand?: boolean;
  /** 窄版(~600px):生成配置弹窗用,内容两列正好不空旷;内容查看器仍用宽版。 */
  narrow?: boolean;
  /** 受控展开态(可选):思维导图「节点提问」需要程序化退全屏(参照 QuizShell);
   *  不传则内部自管,既有调用方零改动。 */
  full?: boolean;
  onFullChange?: (v: boolean) => void;
}) {
  const [fullSelf, setFullSelf] = useState(false);
  const full = fullProp ?? fullSelf;
  const setFull = (v: boolean) => {
    setFullSelf(v);
    onFullChange?.(v);
  };
  // Close only when press+release both land on the backdrop itself — prevents a
  // text-selection drag that releases on the dim margin from closing the modal.
  const downOnBackdrop = useRef(false);
  // 审查 #16:Modal 此前无 Esc 关闭(FlashcardsView 有,其它查看器无 → 一致性缺口)。
  // 全局挂 keydown,豁免输入控件(输入框自己的 Esc 语义不受影响)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      // 窄屏(<lg 移动布局):去掉外边距让弹窗满屏;≥lg 恢复居中留边
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-0 lg:p-4"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          // 窄屏满屏化:整宽整高(dvh 适配移动地址栏)、去圆角/边框;≥lg 恢复卡片样式
          "flex h-dvh w-full flex-col overflow-hidden rounded-none bg-panel shadow-2xl lg:rounded-2xl lg:border lg:border-edge",
          full
            ? "lg:h-[94vh] lg:max-w-[96vw]"
            : narrow
              ? "lg:h-auto lg:max-h-[88vh] lg:max-w-[600px]"
              : fill
                ? // fill 查看器(画板/思维导图/幻灯片)需要确定高度,否则内部 flex-1
                  // 撑不开、子组件(如 Excalidraw)拿不到高度会塌缩。画板保持与其它查看器
                  // 一致的 max-w-4xl;窄/矮容器下 Excalidraw 切移动端,其底栏已由 globals.css
                  // 收成左下角紧凑控件(.excalidraw--mobile .App-bottom-bar)。
                  "lg:h-[86vh] lg:max-w-4xl"
                : "lg:h-auto lg:max-h-[88vh] lg:max-w-4xl"
        )}
      >
        {/* header: title + window controls (clean top-left — no breadcrumb, NotebookLM style) */}
        {/* 窄屏收紧左右内边距;标题 truncate 防长标题多行挤压右侧按钮群 */}
        <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3 lg:px-6">
          <div className="min-w-0 flex-1">
            {typeof title === "string" ? (
              <h2 className="truncate text-[19px] font-semibold leading-tight text-ink">{title}</h2>
            ) : (
              title
            )}
            {caption && (
              <p className="mt-0.5 text-[13px] text-muted">{caption}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {headerActions}
            {onDownload && (
              <button
                onClick={onDownload}
                className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-accent"
                title="下载"
                aria-label="下载"
              >
                <DownloadIcon width={20} height={20} />
              </button>
            )}
            {onShare && (
              <button
                onClick={onShare}
                className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-accent"
                title="分享"
                aria-label="分享"
              >
                <ShareIcon width={19} height={19} />
              </button>
            )}
            {!noExpand && (
              <button
                onClick={() => setFull(!full)}
                // 窄屏本就满屏,展开/还原无意义 → 隐藏,省出头部空间
                className="hidden rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-accent lg:block"
                title={full ? "还原" : "展开"}
                aria-label={full ? "还原" : "展开"}
              >
                <svg
                  width="19"
                  height="19"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.9}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {full ? (
                    <>
                      <path d="M4 14h6v6" />
                      <path d="M20 10h-6V4" />
                      <path d="m14 10 7-7" />
                      <path d="m3 21 7-7" />
                    </>
                  ) : (
                    <>
                      <path d="M15 3h6v6" />
                      <path d="M9 21H3v-6" />
                      <path d="m21 3-7 7" />
                      <path d="m3 21 7-7" />
                    </>
                  )}
                </svg>
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-ink"
              aria-label="关闭"
            >
              <CloseIcon width={19} height={19} />
            </button>
          </div>
        </div>

        {/* scrollable content */}
        <div
          className={cn(
            // 窄屏收紧左右内边距,给内容(卡片图/画布)让出宽度
            "min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-4 lg:px-6",
            fill && "flex flex-col"
          )}
        >
          {children}
        </div>

        {/* footer: right-aligned actions (分享 now lives in the header) */}
        {footer && (
          // flex-wrap:窄屏按钮多(如小红书卡组三个)时换行,不横向溢出
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-edge px-4 py-3 lg:px-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** Unified viewer footer actions — 存为笔记 / 删除 (secondary, left) + 下载
 *  (primary, right). Same pill style as the report/table editors so every
 *  viewer's footer is consistent. */
function ViewerActions({
  onSaveNote,
  onDelete,
  onDownload,
  downloadLabel = "下载",
}: {
  onSaveNote?: () => boolean | void | Promise<boolean | void>;
  onDelete?: () => void;
  onDownload: () => void;
  downloadLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveRef = useRef(false);
  return (
    // 提示与删除/下载同属一个 footer，不再额外占一条带边框的行。
    // 窄屏确实放不下全文时可在同一 footer 内换行，不产生横向溢出。
    <div className="flex w-full flex-wrap items-center gap-2">
      {onSaveNote && (
        <button
          onClick={async () => {
            if (saveRef.current || saved) return;
            saveRef.current = true;
            setSaving(true);
            try {
              const ok = await onSaveNote();
              if (ok === false) throw new Error("save failed");
              setSaved(true);
              toast("已存为笔记");
            } catch {
              saveRef.current = false;
              toast("存为笔记失败,请重试", "error");
            } finally {
              setSaving(false);
            }
          }}
          disabled={saved || saving}
          className="inline-flex items-center gap-1.5 rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-accent hover:bg-accentSoft hover:text-accent disabled:opacity-50"
        >
          <SaveIcon width={15} height={15} /> {saved ? "已存为笔记" : saving ? "正在保存…" : "存为笔记"}
        </button>
      )}
      {onDelete && (
        <button
          onClick={onDelete}
          className="inline-flex items-center gap-1.5 rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-red-300 hover:text-red-600"
        >
          <TrashIcon width={15} height={15} /> 删除
        </button>
      )}
      <button
        onClick={onDownload}
        className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-medium text-onAccent transition hover:brightness-110"
      >
        <DownloadIcon width={15} height={15} /> {downloadLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// editor shell — the "我的笔记" page layout, shared by the note editor AND the
// report viewer so editable text documents all use the same page.
// ---------------------------------------------------------------------------

function EditorShell({
  title,
  onShare,
  onClose,
  footer,
  children,
}: {
  title: React.ReactNode;
  onShare?: () => void;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [full, setFull] = useState(false);
  // Close on backdrop click ONLY when the press *and* release both land on the
  // backdrop itself — otherwise a text-selection drag that starts inside the
  // editor and releases on the dim margin would fire a backdrop click and
  // close the note mid-edit ("闪退"). The floating format toolbar makes such
  // edge drags common.
  const downOnBackdrop = useRef(false);
  // 审查 #16:EditorShell 此前无 Esc 关闭。这里比 Modal 更谨慎——contenteditable
  // 内 Esc 不关(编辑器自己的语义:退出 IME/取消选择等);只有焦点不在编辑区才关。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tgt?.isContentEditable) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      // 窄屏(<lg 移动布局):去掉外边距让编辑器满屏;≥lg 恢复居中留边
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-0 lg:p-4"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          // 窄屏满屏化:整宽整高(dvh 适配移动地址栏)、去圆角/边框;≥lg 恢复卡片样式
          "flex h-dvh w-full flex-col overflow-hidden rounded-none bg-panel shadow-2xl lg:rounded-2xl lg:border lg:border-edge",
          full ? "lg:h-[94vh] lg:max-w-[96vw]" : "lg:h-[88vh] lg:max-w-4xl"
        )}
      >
        {/* header: 标题即生成内容的名称(单行)+ 窗口控件 —— 与其它查看器统一 */}
        {/* 窄屏收紧左右内边距 */}
        <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3 lg:px-6">
          <div className="min-w-0 flex-1">{title}</div>
          <div className="flex shrink-0 items-center gap-1">
            {onShare && (
              <button
                onClick={onShare}
                title="分享"
                aria-label="分享"
                className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-accent"
              >
                <ShareIcon width={18} height={18} />
              </button>
            )}
            <button
              onClick={() => setFull((v) => !v)}
              title={full ? "还原" : "放大"}
              aria-label={full ? "还原" : "放大"}
              // 窄屏本就满屏,放大/还原无意义 → 隐藏
              className="hidden rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-accent lg:block"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {full ? (
                  <>
                    <path d="M4 14h6v6" />
                    <path d="M20 10h-6V4" />
                    <path d="m14 10 7-7" />
                    <path d="m3 21 7-7" />
                  </>
                ) : (
                  <>
                    <path d="M15 3h6v6" />
                    <path d="M9 21H3v-6" />
                    <path d="m21 3-7 7" />
                    <path d="m3 21 7-7" />
                  </>
                )}
              </svg>
            </button>
            <button
              onClick={onClose}
              title="关闭"
              aria-label="关闭"
              className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-ink"
            >
              <CloseIcon width={19} height={19} />
            </button>
          </div>
        </div>

        {/* body — the rich editor fills the remaining space */}
        {children}

        {/* footer actions */}
        {footer && (
          // flex-wrap:窄屏「删除 + 导出 Excel + 导出 PDF」放不下时换行,不横向溢出
          <div className="flex flex-wrap items-center gap-2 border-t border-edge px-4 py-3 lg:px-5">{footer}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// document viewer (reports)
// ---------------------------------------------------------------------------

/** Render the report's (edited) HTML into a clean A4 layout and download it as
 *  a .pdf file directly (no print dialog). Uses html2canvas + jsPDF, both
 *  lazy-loaded so they stay out of the main bundle. CJK renders via the
 *  system fonts (no font bundling); pages are split to A4. */
async function exportReportToPdf(title: string, bodyHtml: string, watermark = false) {
  const [{ jsPDF }, html2canvasMod] = await Promise.all([
    import("jspdf"),
    import("html2canvas"),
  ]);
  const html2canvas = html2canvasMod.default;

  // Strip the editor's own class/style attributes so only our clean print CSS
  // applies (and so html2canvas never meets an unsupported color function).
  const tmp = document.createElement("div");
  tmp.innerHTML = bodyHtml;
  tmp.querySelectorAll("*").forEach((el) => {
    el.removeAttribute("class");
    el.removeAttribute("style");
  });
  const esc = (s: string) => s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
  const d = new Date();
  const dateStr = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;

  const holder = document.createElement("div");
  holder.id = "pdf-export-holder";
  holder.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;background:#ffffff;z-index:-1;";
  holder.innerHTML =
    `<style>` +
    `#pdf-export-holder *{box-sizing:border-box;}` +
    `#pdf-export-holder{padding:56px 60px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1b1b1f;font-size:14px;line-height:1.78;}` +
    `#pdf-export-holder .t{font-size:24px;font-weight:700;margin:0 0 6px;}` +
    `#pdf-export-holder .m{color:#9aa0b4;font-size:12px;margin:0 0 22px;padding-bottom:14px;border-bottom:1px solid #ececf3;}` +
    `#pdf-export-holder h1{font-size:21px;font-weight:700;margin:22px 0 10px;}` +
    `#pdf-export-holder h2{font-size:17px;font-weight:700;margin:20px 0 8px;}` +
    `#pdf-export-holder h3{font-size:15px;font-weight:700;margin:16px 0 6px;}` +
    `#pdf-export-holder p{margin:9px 0;}` +
    `#pdf-export-holder ul,#pdf-export-holder ol{padding-left:22px;margin:9px 0;}` +
    `#pdf-export-holder li{margin:5px 0;}` +
    `#pdf-export-holder strong{font-weight:700;}` +
    `#pdf-export-holder table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px;}` +
    `#pdf-export-holder th,#pdf-export-holder td{border:1px solid #e2e2ea;padding:6px 10px;text-align:left;}` +
    `#pdf-export-holder th{background:#f6f6f9;font-weight:600;}` +
    `#pdf-export-holder blockquote{border-left:3px solid #d9d9e3;margin:10px 0;padding:2px 14px;color:#555;}` +
    `</style>` +
    `<div class="t">${esc(title)}</div><div class="m">${dateStr}</div><div class="b">${tmp.innerHTML}</div>`;
  document.body.appendChild(holder);

  // 免费档:按 holder 实际高度铺满对角平铺「猿笔记」水印(真实 <span>,html2canvas 可靠渲染),
  // 6% 黑字压在正文之上、不影响阅读;付费档不注入。holder 是 position:fixed → 绝对定位子元素的定位上下文。
  if (watermark) {
    const wm = document.createElement("div");
    wm.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;";
    const H = holder.scrollHeight || 1123;
    const W = 794;
    const stepX = 210, stepY = 156;
    let html = "";
    let row = 0;
    for (let y = -40; y < H + 120; y += stepY, row++) {
      const off = row % 2 ? stepX / 2 : 0;
      for (let x = -40 + off; x < W + 120; x += stepX) {
        html += `<span style="position:absolute;left:${x}px;top:${y}px;transform:rotate(-26deg);transform-origin:center;font-size:22px;font-weight:800;color:#000000;opacity:0.06;white-space:nowrap;font-family:'PingFang SC','Microsoft YaHei',sans-serif;">猿笔记</span>`;
      }
    }
    wm.innerHTML = html;
    holder.appendChild(wm);
  }

  try {
    const canvas = await html2canvas(holder, { scale: 2, backgroundColor: "#ffffff", windowWidth: 794 });
    const img = canvas.toDataURL("image/jpeg", 0.92);
    const pdf = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });
    const pageW = 210;
    const pageH = 297;
    const imgH = (canvas.height * pageW) / canvas.width;
    let heightLeft = imgH;
    let pos = 0;
    pdf.addImage(img, "JPEG", 0, pos, pageW, imgH, undefined, "FAST");
    heightLeft -= pageH;
    while (heightLeft > 0) {
      pos -= pageH;
      pdf.addPage();
      pdf.addImage(img, "JPEG", 0, pos, pageW, imgH, undefined, "FAST");
      heightLeft -= pageH;
    }
    const fileName = (title || "报告").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    pdf.save(`${fileName}.pdf`);
  } finally {
    holder.remove();
  }
}

/** Download the report's tables as a real .xlsx (one worksheet per table).
 *  Lazy-loads SheetJS so it stays out of the main bundle. */
export async function exportTablesToExcel(fileName: string, sheets: { name: string; rows: string[][] }[]) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  sheets.forEach((s, i) => {
    let name = (s.name || `表${i + 1}`).replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 28) || `表${i + 1}`;
    while (used.has(name)) name = `${name.slice(0, 25)}_${i + 1}`;
    used.add(name);
    const ws = XLSX.utils.aoa_to_sheet(s.rows);
    const cols = (s.rows[0] || []).map((_, c) => ({
      wch: Math.min(48, Math.max(8, ...s.rows.map((r) => (r[c] || "").length + 2))),
    }));
    if (cols.length) ws["!cols"] = cols;
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  const safe = (fileName || "数据表格").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  // Build the bytes and trigger the download ourselves — XLSX.writeFile()
  // auto-detects a node-like `fs` under the bundler and silently no-ops in the
  // browser, so we go through a Blob + <a download> instead.
  const data = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([data], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}.xlsx`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

export function DocViewer({
  output,
  onClose,
  onSaveNote,
  onDelete,
  onSaved,
  onShareNotebook,
  watermark,
}: {
  output: StudioOutput;
  onClose: () => void;
  onSaveNote?: (title: string, content: string) => boolean | void | Promise<boolean | void>;
  onDelete?: () => void;
  /** Persist edited report markdown back to the notebook's state. */
  onSaved?: (content: string) => void;
  onShareNotebook?: () => void;
  /** 当前下载者套餐是否要求水印；登录工作台传值，分享页缺省走制品原标志。 */
  watermark?: boolean;
}) {
  const [savedContent, setSavedContent] = useState(output.content);
  const [edited, setEdited] = useState(output.content);
  const editedRef = useRef(edited);
  editedRef.current = edited;
  const savedRef = useRef(savedContent);
  savedRef.current = savedContent;
  // Export the report as a PDF: grab what the user currently sees in the rich
  // editor (their edits included) and download it directly as a .pdf file.
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const exportPdf = useCallback(async () => {
    if (pdfBusy) return;
    const ce = editorWrapRef.current?.querySelector('[contenteditable="true"]') as HTMLElement | null;
    const html = ce?.innerHTML?.trim();
    setPdfBusy(true);
    try {
      await exportReportToPdf(output.title || "报告", html || "<p>(空报告)</p>", outputWatermark(output, watermark));
    } catch {
      toast("导出 PDF 失败,请重试", "error");
    } finally {
      setPdfBusy(false);
    }
  }, [output, pdfBusy, watermark]);

  // Export the data-table report as a real .xlsx — read each rendered <table>
  // out of the editor (edits included) into a worksheet.
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const exportExcel = useCallback(async () => {
    if (xlsxBusy) return;
    // Lexical keeps the markdown table rows as text, so parse the source the
    // user currently sees (innerText preserves the `| a | b |` lines).
    const ce = editorWrapRef.current?.querySelector('[contenteditable="true"]') as HTMLElement | null;
    const md = (ce?.innerText || output.content || "").trim();
    const sheets = parseMarkdownTables(md);
    if (!sheets.length) {
      toast("没有可导出的表格", "error");
      return;
    }
    setXlsxBusy(true);
    try {
      await exportTablesToExcel(output.title || "数据表格", sheets);
    } catch {
      toast("导出 Excel 失败,请重试", "error");
    } finally {
      setXlsxBusy(false);
    }
  }, [output.title, xlsxBusy]);

  const persist = useCallback(
    async (content: string) => {
      try {
        const r = await fetch(`/api/studio/${output.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        // 审查修复:非 2xx(会话过期/无权限)不能当保存成功,否则本地标记已存、
        // 服务端却没落库,编辑静默丢失。保持 dirty 待重试,并提示一次。
        if (!r.ok) {
          toast("自动保存失败,请检查登录状态", "error");
          return;
        }
        setSavedContent(content);
        onSaved?.(content);
      } catch {
        /* leave dirty — next edit (or close-flush) retries */
      }
    },
    [output.id, onSaved]
  );

  // Auto-save the editable preview (NotebookLM-style — no manual save button).
  useEffect(() => {
    if (edited.trim() === savedContent.trim()) return;
    const t = setTimeout(() => void persist(edited), 700);
    return () => clearTimeout(t);
  }, [edited, savedContent, persist]);

  // Flush a still-pending edit when the viewer closes/unmounts.
  useEffect(() => {
    return () => {
      if (editedRef.current.trim() === savedRef.current.trim()) return;
      try {
        fetch(`/api/studio/${output.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editedRef.current }),
          keepalive: true,
        });
      } catch {
        /* noop */
      }
    };
  }, [output.id]);

  return (
    <EditorShell
      title={
        <h2 className="truncate text-[19px] font-semibold leading-tight text-ink" title={output.title}>
          {output.title}
        </h2>
      }
      onShare={onShareNotebook ?? (() => shareOutput(output))}
      onClose={onClose}
      footer={
        <>
          {onDelete && (
            <button
              // 只发起删除确认(HomeClient pendingDel 流程);确认后 doDeleteOutput 会
              // 自动关掉本查看器,取消则原地不动——别在这里提前 onClose()。
              onClick={onDelete}
              className="inline-flex items-center gap-1.5 rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-red-300 hover:text-red-600"
            >
              <TrashIcon width={15} height={15} /> 删除
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {output.kind === "table" && (
              <button
                onClick={exportExcel}
                disabled={xlsxBusy}
                title="把表格下载为 Excel 文件(.xlsx)"
                className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-medium text-onAccent transition hover:brightness-110 disabled:opacity-60"
              >
                {xlsxBusy ? (
                  <SpinnerIcon width={15} height={15} />
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M3 9.5h18M9.5 4v16M15.5 4v16" />
                  </svg>
                )}
                {xlsxBusy ? "导出中…" : "导出 Excel"}
              </button>
            )}
            <button
              onClick={exportPdf}
              disabled={pdfBusy}
              title="把当前报告(含你的编辑)下载为 PDF 文件"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition disabled:opacity-60",
                output.kind === "table"
                  ? "border border-edge text-ink2 hover:border-accent hover:text-accent"
                  : "bg-accent text-onAccent hover:brightness-110"
              )}
            >
              {pdfBusy ? (
                <SpinnerIcon width={15} height={15} />
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.85} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v11M8 10.5l4 4 4-4M5 21h14" />
                </svg>
              )}
              {pdfBusy ? "导出中…" : "导出 PDF"}
            </button>
          </div>
        </>
      }
    >
      {/* editable preview — same rich editor as the note page; ref lets us grab
          the rendered HTML for PDF export */}
      <div ref={editorWrapRef} style={{ display: "contents" }}>
        <RichNoteEditor value={output.content} onChange={setEdited} placeholder="报告内容…" format="json" stripTitle={output.title} />
      </div>
    </EditorShell>
  );
}

// ---------------------------------------------------------------------------
// mind map viewer
// ---------------------------------------------------------------------------

export function MindMapView({
  output,
  onClose,
  onSaveNote,
  onDelete,
  onSaved,
  onShareNotebook,
  editable = true,
  onAsk,
  watermark,
}: {
  output: StudioOutput;
  onClose: () => void;
  onSaveNote?: (title: string, content: string) => boolean | void | Promise<boolean | void>;
  onDelete?: () => void;
  /** Persist edited markdown back to the notebook's state. */
  onSaved?: (content: string) => void;
  onShareNotebook?: () => void;
  editable?: boolean;
  /** 「就这个节点在对话中提问」——把选中节点(含父链上下文)递进中栏对话(同 QuizView);
   *  不传(分享页 PublicNotebook)则完全不挂监听、不渲染提问浮条,零影响。 */
  onAsk?: (text: string) => void;
  watermark?: boolean;
}) {
  const [savedContent, setSavedContent] = useState(output.content);
  const [edited, setEdited] = useState(output.content);
  const editedRef = useRef(edited);
  editedRef.current = edited;
  const savedRef = useRef(savedContent);
  savedRef.current = savedContent;
  // 思维导图的 PNG 导出由编辑器内部实现;暴露出来,放进统一的头部「下载」。
  const dlRef = useRef<(() => void) | null>(null);

  // ---- 节点提问(C3):选中节点后浮出「就「×××」在对话中提问」轻量条 ------------
  // mind-elixir 实例封在 MindMapEditor 内部,这里走保守方案:在包裹容器上捕获
  // click/keyup,事后从 DOM 读选中节点(mind-elixir 给选中的 me-tpc 加 .selected,
  // 元素上挂着 nodeObj,其 parent 链可回溯到根)。全程 try/catch,读不到就不显示
  // 浮条——绝不让提问逻辑抛错炸掉查看器(有 ViewerErrorBoundary 也不依赖它)。
  const mapWrapRef = useRef<HTMLDivElement>(null);
  const [askSel, setAskSel] = useState<{ label: string; chain: string[] } | null>(null);
  const [askHidden, setAskHidden] = useState(false);
  const askKeyRef = useRef("");
  // 展开态上提为受控(Modal full/onFullChange):提问要先退全屏(参照 QuizView 的
  // askAndDock),否则中栏对话被放大的浮层挡住,点了像没反应。
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (!onAsk) return; // 分享页未传 onAsk:不挂监听、零影响
    const host = mapWrapRef.current;
    if (!host) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      try {
        type AskNode = { topic?: unknown; parent?: AskNode };
        const el = host.querySelector("me-tpc.selected") as
          | (HTMLElement & { nodeObj?: AskNode })
          | null;
        const label = (
          typeof el?.nodeObj?.topic === "string" ? el.nodeObj.topic : el?.textContent || ""
        ).trim();
        if (!el || !label) {
          // 取消选中/读不到:收起浮条,并清 key 使「再次选同一节点」能重新弹出
          askKeyRef.current = "";
          setAskSel(null);
          return;
        }
        // 父链 root→…→父(不含自身);guard 防御异常数据成环
        const chain: string[] = [];
        let p = el.nodeObj?.parent;
        let guard = 0;
        while (p && guard++ < 16) {
          if (typeof p.topic === "string" && p.topic.trim()) chain.unshift(p.topic.trim());
          p = p.parent;
        }
        const key = `${label} ${chain.join("→")}`;
        if (key !== askKeyRef.current) {
          askKeyRef.current = key;
          setAskHidden(false); // 切换节点时浮条跟随更新并重新出现
          setAskSel({ label, chain });
        }
      } catch {
        setAskSel(null);
      }
    };
    // 捕获阶段监听 + 零延时:让 mind-elixir 自己的 selectNode/unselect 先处理完再读
    const schedule = () => {
      if (t) clearTimeout(t);
      t = setTimeout(read, 0);
    };
    host.addEventListener("click", schedule, true);
    host.addEventListener("keyup", schedule, true); // 方向键选中 / Delete 删除后跟随
    return () => {
      if (t) clearTimeout(t);
      host.removeEventListener("click", schedule, true);
      host.removeEventListener("keyup", schedule, true);
    };
  }, [onAsk]);

  const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  // 构造问题:能取到父链则带上下文,取不到只问节点本身;文案过长截断护 token。
  const askNode = () => {
    if (!askSel || !onAsk) return;
    const label = clipText(askSel.label, 60);
    const chainText = clipText(askSel.chain.join(" → "), 80);
    const q = chainText ? `结合上下文:${chainText},详细讲讲「${label}」` : `详细讲讲「${label}」`;
    setFull(false); // 参照 askAndDock:全屏先还原,再把问题递给中栏对话
    onAsk(q);
  };

  const persist = useCallback(
    async (content: string) => {
      try {
        const r = await fetch(`/api/studio/${output.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        // 审查修复:非 2xx(会话过期/无权限/5xx)不能当保存成功,否则本地标记已存、服务端
        // 没落库,刷新后思维导图编辑静默丢失。保持 dirty 待重试,并提示一次。
        if (!r.ok) {
          toast("自动保存失败,请检查登录状态", "error");
          return;
        }
        setSavedContent(content);
        onSaved?.(content);
      } catch {
        /* leave dirty — the next edit (or the close-flush) retries */
      }
    },
    [output.id, onSaved]
  );

  // Auto-save, NotebookLM-style: debounce committed edits and persist silently —
  // no manual "保存" button. The mind-map editor owns its own state, so this only
  // mirrors changes back to the server.
  useEffect(() => {
    if (!editable) return;
    if (edited.trim() === savedContent.trim()) return;
    const t = setTimeout(() => void persist(edited), 700);
    return () => clearTimeout(t);
  }, [edited, editable, savedContent, persist]);

  // Flush any still-pending change when the viewer closes/unmounts so a fast
  // close never drops the last edit.
  useEffect(() => {
    return () => {
      if (!editable) return;
      if (editedRef.current.trim() === savedRef.current.trim()) return;
      try {
        fetch(`/api/studio/${output.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editedRef.current }),
          keepalive: true,
        });
      } catch {
        /* noop */
      }
    };
  }, [editable, output.id]);

  return (
    <Modal
      title={output.title}
      subtitle="思维导图"
      sourceCaption={sourceCaption(output)}
      onShare={onShareNotebook ?? (() => shareOutput(output))}
      onClose={onClose}
      fill
      full={full}
      onFullChange={setFull}
      footer={
        <ViewerActions
          onDelete={onDelete}
          onDownload={() => dlRef.current?.()}
          downloadLabel="下载 PNG"
        />
      }
    >
      {/* 包裹层:给节点提问浮条一个定位上下文,同时承接选中侦测的 click/keyup 捕获 */}
      <div ref={mapWrapRef} className="relative flex min-h-0 w-full flex-1 flex-col">
        <MindMapEditor
          content={output.content}
          onContentChange={editable ? setEdited : undefined}
          readOnly={!editable}
          downloadRef={dlRef}
          watermark={outputWatermark(output, watermark)}
        />
        {onAsk && askSel && !askHidden && (
          // 底部居中浮条:z-20 盖过编辑器右侧 z-10 的缩放控件层,不遮节点主体
          <div className="absolute bottom-14 left-1/2 z-20 flex max-w-[92%] -translate-x-1/2 items-center gap-0.5 rounded-full border border-edge bg-panel py-1 pl-1 pr-1 shadow-lg sm:bottom-3">
            <button
              onClick={askNode}
              title="把这个节点(含上下文)带进对话提问"
              className="min-w-0 truncate rounded-full px-3 py-1.5 text-[13px] text-ink2 transition hover:bg-accentSoft hover:text-accent"
            >
              就「{clipText(askSel.label, 24)}」在对话中提问
            </button>
            <button
              onClick={() => setAskHidden(true)}
              title="关闭"
              aria-label="关闭提问浮条"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted transition hover:bg-panel2 hover:text-ink"
            >
              <CloseIcon width={14} height={14} />
            </button>
          </div>
        )}
      </div>
      <div className="mt-2.5 flex shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted">
        {editable ? (
          <span>
            双击节点<b className="text-ink2">改名</b> · 选中后{" "}
            <kbd className="rounded bg-panel2 px-1 font-mono text-[11px]">Tab</kbd> 加子节点、
            <kbd className="rounded bg-panel2 px-1 font-mono text-[11px]">Enter</kbd> 加同级、
            <kbd className="rounded bg-panel2 px-1 font-mono text-[11px]">Delete</kbd> 删除 · 右键拖动画布 · 底部左右查看
          </span>
        ) : (
          <span>拖拽平移 · 底部左右查看 · 右侧缩放</span>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// audio overview player
// ---------------------------------------------------------------------------

export function AudioPlayer({
  output,
  onClose,
  onSaveNote,
  onDelete,
  onShareNotebook,
}: {
  output: StudioOutput;
  onClose: () => void;
  onSaveNote?: (title: string, content: string) => boolean | void | Promise<boolean | void>;
  onDelete?: () => void;
  onShareNotebook?: () => void;
}) {
  return (
    <Modal
      title={output.title}
      subtitle="音频概览"
      onClose={onClose}
      footer={
        <ViewerActions
          onSaveNote={onSaveNote ? () => onSaveNote(output.title, output.content) : undefined}
          onDelete={onDelete}
          onDownload={() => downloadOutput(output)}
          downloadLabel="下载音频"
        />
      }
    >
      <audio
        controls
        autoPlay
        src={`/api/studio/audio/${output.id}`}
        className="mb-4 w-full"
      />
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
        文字稿
      </p>
      <div className="prose-chat">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{output.content}</ReactMarkdown>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// audio overview — bottom-docked mini-player (NotebookLM-style)
// ---------------------------------------------------------------------------

const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2, 0.75];

// Speaker palette for the transcript (system accent + art colors).
const SPEAKER_PALETTE = [
  { chip: "bg-accentSoft text-accent", name: "text-accent" },
  { chip: "bg-art-info/15 text-art-info", name: "text-art-info" },
  { chip: "bg-art-mindmap/15 text-art-mindmap", name: "text-art-mindmap" },
  { chip: "bg-art-report/15 text-art-report", name: "text-art-report" },
];

/** Parse a "**Host A:** …" style transcript into speaker turns. */
function parseDialogue(md: string): { speaker: string; text: string }[] {
  const turns: { speaker: string; text: string }[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\*{0,2}\s*([^\n:：*]{1,16}?)\s*[:：]\*{0,2}\s*(.+)$/);
    if (m) {
      turns.push({ speaker: m[1].trim(), text: m[2].replace(/\*\*/g, "").trim() });
    } else if (turns.length) {
      turns[turns.length - 1].text += " " + line.replace(/\*\*/g, "");
    } else {
      turns.push({ speaker: "", text: line.replace(/\*\*/g, "") });
    }
  }
  return turns.filter((t) => t.text);
}

/** Transcript rendered as a styled conversation; falls back to markdown if not dialogue. */
function TranscriptBody({ content }: { content: string }) {
  const turns = useMemo(() => parseDialogue(content), [content]);
  const speakers = useMemo(
    () => [...new Set(turns.map((t) => t.speaker).filter(Boolean))],
    [turns]
  );
  if (turns.filter((t) => t.speaker).length < 2) {
    return (
      <div className="prose-chat">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }
  const initialOf = (sp: string) => {
    const alnum = sp.match(/[A-Za-z0-9]/g);
    return (alnum ? alnum[alnum.length - 1] : sp[0]) || "·";
  };
  return (
    <div className="space-y-5">
      {turns.map((t, i) =>
        t.speaker ? (
          <div key={i} className="flex gap-3">
            <span
              className={cn(
                "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold",
                SPEAKER_PALETTE[Math.max(0, speakers.indexOf(t.speaker)) % SPEAKER_PALETTE.length].chip
              )}
            >
              {initialOf(t.speaker)}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "mb-1 text-xs font-semibold tracking-wide",
                  SPEAKER_PALETTE[Math.max(0, speakers.indexOf(t.speaker)) % SPEAKER_PALETTE.length].name
                )}
              >
                {t.speaker}
              </p>
              <p className="text-[15px] leading-relaxed text-ink">{t.text}</p>
            </div>
          </div>
        ) : (
          <p key={i} className="text-[15px] leading-relaxed text-ink2">
            {t.text}
          </p>
        )
      )}
    </div>
  );
}

export function AudioDockPlayer({
  output,
  onClose,
  onDelete,
  onPlayingChange,
  onShare,
}: {
  output: StudioOutput;
  onClose: () => void;
  onDelete?: () => void;
  /** Fired on play/pause/ended so the list can animate only the playing track. */
  onPlayingChange?: (playing: boolean) => void;
  /** Opens the notebook share dialog; falls back to copying the link. */
  onShare?: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [rate, setRate] = useState(1);
  const [transcript, setTranscript] = useState(false);
  // 审查 #14:音频文件 404/失效时 <audio> 此前静默,只显示不能播的进度条(用户以为是网络卡)。
  const [mediaErr, setMediaErr] = useState(false);

  const setPlay = (v: boolean) => {
    setPlaying(v);
    onPlayingChange?.(v);
  };

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  // Make sure the list stops animating when the player unmounts (closed).
  useEffect(() => {
    return () => onPlayingChange?.(false);
  }, [onPlayingChange]);

  const fmt = (s: number) => {
    if (!Number.isFinite(s) || s < 0) return "00:00";
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  };

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };
  const skip = (d: number) => {
    const a = audioRef.current;
    if (!a) return;
    // Clamp just shy of the end — seeking exactly to duration on an ended clip
    // makes browsers reset to 0. Also push the UI immediately (no timeupdate when paused).
    const dur = Number.isFinite(a.duration) ? a.duration : 0;
    const next = Math.max(0, Math.min(dur ? dur - 0.25 : 0, a.currentTime + d));
    a.currentTime = next;
    setCur(next);
  };
  const seek = (e: React.MouseEvent) => {
    const el = trackRef.current;
    const a = audioRef.current;
    if (!el || !a || !a.duration) return;
    const rect = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    a.currentTime = frac * a.duration;
    setCur(a.currentTime);
  };
  const cycleRate = () =>
    setRate((r) => PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(r) + 1) % PLAYBACK_RATES.length] ?? 1);

  const pct = dur > 0 ? (cur / dur) * 100 : 0;

  return (
    <div className="shrink-0 border-t border-edge bg-panel px-5 pb-5 pt-3.5">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={`/api/studio/audio/${output.id}`}
        autoPlay
        onPlay={() => setPlay(true)}
        onPause={() => setPlay(false)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => { setDur(e.currentTarget.duration); setMediaErr(false); }}
        onError={() => setMediaErr(true)}
        onEnded={() => setPlay(false)}
      />
      {mediaErr && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3.5 py-2.5 text-[13px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          音频未能加载,可能是生成失败或文件已失效。请删除后重新生成。
        </div>
      )}


      {/* header: title + 分享 / 更多 / 关闭 */}
      <div className="flex items-center gap-0.5">
        <p
          className="min-w-0 flex-1 truncate pr-2 text-[15px] font-semibold text-ink"
          title={output.title}
        >
          {output.title}
        </p>
        <DockIconBtn label="分享" onClick={() => (onShare ? onShare() : shareOutput(output))}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <path d="m8.6 13.5 6.8 4" />
            <path d="m15.4 6.5-6.8 4" />
          </svg>
        </DockIconBtn>
        <a
          href={`/api/studio/audio/${output.id}`}
          download={`${output.title || "audio"}.mp3`}
          title="下载"
          aria-label="下载"
          className="grid h-8 w-8 place-items-center rounded-full text-ink2 transition hover:bg-panel2 hover:text-accent"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
        </a>
        <DockIconBtn label="关闭" onClick={onClose}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </DockIconBtn>
      </div>

      {/* progress bar + time */}
      <div className="mt-4">
        <div
          ref={trackRef}
          onClick={seek}
          className="group relative h-1.5 cursor-pointer rounded-full bg-edge"
        >
          <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
          <div
            className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_1px_5px_rgba(91,75,214,0.5)] ring-[3px] ring-panel transition-transform group-hover:scale-110"
            style={{ left: `${pct}%` }}
          />
        </div>
        <div className="mt-2 text-xs tabular-nums text-muted">
          {fmt(cur)} / {fmt(dur)}
        </div>
      </div>

      {/* transport: 倍速 | -10 | play/pause | +10 | 文字稿 */}
      <div className="mt-3.5 flex items-center justify-between">
        <button
          onClick={cycleRate}
          className="flex w-12 flex-col items-center gap-0.5 leading-none text-accent transition hover:opacity-75"
          title="播放速度"
        >
          <span className="text-[15px] font-semibold tabular-nums">
            {rate % 1 === 0 ? rate.toFixed(1) : rate}
          </span>
          <span className="text-[10px] tracking-wide">倍</span>
        </button>

        <div className="flex items-center gap-6">
          <button
            onClick={() => skip(-10)}
            className="text-ink2 transition hover:text-accent active:scale-95"
            title="后退 10 秒"
            aria-label="后退 10 秒"
          >
            <Replay10Icon width={26} height={26} />
          </button>
          <button
            onClick={toggle}
            className="grid h-14 w-14 place-items-center rounded-full bg-brand text-onAccent shadow-[0_10px_24px_-8px_rgba(91,75,214,0.6)] transition hover:brightness-105 active:scale-95"
            aria-label={playing ? "暂停" : "播放"}
          >
            {playing ? (
              <PauseIcon width={28} height={28} />
            ) : (
              <PlayIcon width={28} height={28} />
            )}
          </button>
          <button
            onClick={() => skip(10)}
            className="text-ink2 transition hover:text-accent active:scale-95"
            title="前进 10 秒"
            aria-label="前进 10 秒"
          >
            <Forward10Icon width={26} height={26} />
          </button>
        </div>

        <button
          onClick={() => setTranscript(true)}
          className="grid w-12 place-items-center text-ink2 transition hover:text-accent"
          title="文字稿"
          aria-label="文字稿"
        >
          <TranscriptIcon width={19} height={19} />
        </button>
      </div>

      {transcript && (
        <Modal title={output.title} subtitle="文字稿" onClose={() => setTranscript(false)}>
          <TranscriptBody content={output.content} />
        </Modal>
      )}
    </div>
  );
}

function DockIconBtn({
  label,
  active,
  danger,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-full text-ink2 transition hover:bg-panel2",
        active && (danger ? "text-red-500" : "text-accent"),
        !active && (danger ? "hover:text-red-500" : "hover:text-accent")
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// video overview player
// ---------------------------------------------------------------------------

export function VideoPlayer({
  output,
  onClose,
  onSaveNote,
  onDelete,
  onShareNotebook,
}: {
  output: StudioOutput;
  onClose: () => void;
  onSaveNote?: (title: string, content: string) => boolean | void | Promise<boolean | void>;
  onDelete?: () => void;
  onShareNotebook?: () => void;
}) {
  // 审查 #14:视频文件 404/失效时 <video> 静默,只显 controls 无法播放。
  const [mediaErr, setMediaErr] = useState(false);
  return (
    <Modal
      title={output.title}
      subtitle="视频概览"
      sourceCaption={sourceCaption(output)}
      onShare={onShareNotebook ?? (() => shareOutput(output))}
      onClose={onClose}
      footer={
        <ViewerActions
          onSaveNote={onSaveNote ? () => onSaveNote(output.title, output.content) : undefined}
          onDelete={onDelete}
          onDownload={() => downloadOutput(output)}
          downloadLabel="下载视频"
        />
      }
    >
      {mediaErr ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/60 px-3.5 py-4 text-[13px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          视频未能加载,可能是生成失败或文件已失效。请删除后重新生成。
        </div>
      ) : (
        <video
          controls
          autoPlay
          src={`/api/studio/video/${output.id}`}
          className="mb-4 max-h-[55vh] w-full rounded-lg bg-black"
          onError={() => setMediaErr(true)}
        />
      )}
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
        大纲与旁白
      </p>
      <div className="prose-chat">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{output.content}</ReactMarkdown>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// flashcards
// ---------------------------------------------------------------------------

export function FlashcardsView({
  output,
  onClose,
  onSaveNote,
  onDelete,
  onShareNotebook,
}: {
  output: StudioOutput;
  onClose: () => void;
  onSaveNote?: (title: string, content: string) => boolean | void | Promise<boolean | void>;
  onDelete?: () => void;
  onShareNotebook?: () => void;
}) {
  const cards = useMemo(() => {
    try {
      // 审查修复:只校验 c.front 真值不够 —— 若 LLM 把 front/back 吐成对象({text:…}),
      // 直接 {card.front} 渲染会触发 React「Objects are not valid as a React child」崩掉整个
      // 闪卡模态。这里要求 front/back 都是字符串,畸形卡直接丢弃。
      return ((JSON.parse(output.content).cards as { front: string; back: string }[]) || []).filter(
        (c) => typeof c?.front === "string" && typeof c?.back === "string"
      );
    } catch {
      return [];
    }
  }, [output.content]);
  const [flipped, setFlipped] = useState(false);
  // 弹窗内容容器:打开时把键盘焦点收到这里。否则焦点滞留在「触发弹窗的 studio row 按钮」
  //(在弹窗背后)或用户点过的浮层箭头按钮上 —— 真机按空格/1/2 会被那个 <button> 的原生
  // 激活吞掉(表现为「无反应」),而不是走我们的 window keydown。收拢焦点后行为确定。
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // setTimeout 而非 rAF:后台标签页会暂停 rAF(不 fire),focus 就永远不执行
    //(见预览 rAF 节流坑);小延迟等 modal 入场后再收拢焦点,避开开场动画/双挂载。
    const id = setTimeout(() => panelRef.current?.focus(), 60);
    return () => clearTimeout(id);
  }, []);
  // ---- 掌握度 + 错卡重练(C2)------------------------------------------------
  // 有意取舍:掌握状态只存组件 state(会话内),不落库、不加 API——关闭查看器即
  // 重置。轻量零后端成本,且与分享页(PublicNotebook 只读渲染)天然兼容。
  // roundIdx=null 表示首轮(全部卡片);重练轮只装入上一轮标记「不熟」的卡片下标。
  const [roundIdx, setRoundIdx] = useState<number[] | null>(null);
  const [pos, setPos] = useState(0);
  // 本轮标记:key=cards 全局下标,true=会了 / false=不熟;开新一轮时清空。
  const [marks, setMarks] = useState<Record<number, boolean>>({});
  // 存为笔记反馈:与 ViewerActions/对话气泡统一(变已存+禁用+toast),防连点存重复。
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const noteSaveRef = useRef(false);
  const round = useMemo(() => roundIdx ?? cards.map((_, k) => k), [roundIdx, cards]);
  // 全部标完 → 派生出小结页(不设独立 state,天然与标记数同步)。
  const done = round.length > 0 && round.every((k) => marks[k] !== undefined);
  const knownN = round.filter((k) => marks[k] === true).length;
  const unknownM = round.filter((k) => marks[k] === false).length;
  const curKey = round[Math.min(pos, Math.max(0, round.length - 1))];
  const card = cards[curKey];
  const curMark = marks[curKey];

  const go = useCallback(
    (d: number) => {
      setFlipped(false);
      setPos((v) => (round.length ? (v + d + round.length) % round.length : 0));
    },
    [round.length]
  );
  // 标记当前卡并环形跳到下一张「未标记」的卡;全标完后 done 派生为 true,自动进小结页。
  const markCard = useCallback(
    (ok: boolean) => {
      if (!round.length) return;
      const next = { ...marks, [curKey]: ok };
      setMarks(next);
      setFlipped(false);
      for (let step = 1; step <= round.length; step++) {
        const p = (pos + step) % round.length;
        if (next[round[p]] === undefined) {
          setPos(p);
          return;
        }
      }
    },
    [round, pos, marks, curKey]
  );
  // 只装入本轮「不熟」的卡再来一轮;轮内可继续标,直到全会或用户关闭。
  const retryUnknown = () => {
    const bad = round.filter((k) => marks[k] === false);
    if (!bad.length) return;
    setRoundIdx(bad);
    setMarks({});
    setPos(0);
    setFlipped(false);
  };
  const asNote = () => cards.map((c) => `**${c.front}**\n\n${c.back}`).join("\n\n---\n\n");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 中文输入法合成期间(keyCode 229 / isComposing):空格是「选词」、数字是「选候选」,
      // 别被闪卡抢走 —— 直接放行给输入法。
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (done) return; // 小结页只响应 Esc
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      // 与翻卡/切卡快捷键并列:翻开答案后 1=会了 / 2=不熟
      else if (flipped && (e.key === "1" || e.key === "2")) { e.preventDefault(); markCard(e.key === "1"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose, done, flipped, markCard]);

  const navCircle =
    "flex h-12 w-12 items-center justify-center rounded-full border border-edge text-ink2 transition hover:border-accent hover:bg-accentSoft hover:text-accent";
  const navPill =
    "flex h-12 items-center gap-2 rounded-full border border-edge px-5 text-sm font-medium text-ink2 transition hover:border-accent";

  return (
    // 窄屏(<lg 移动布局):去掉外边距让闪卡满屏;≥lg 恢复居中留边
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-0 lg:p-4" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        // 窄屏满屏化:整宽整高(dvh)、去圆角/边框;≥lg 恢复卡片样式
        // outline-none:tabIndex=-1 只为可编程 focus(收拢键盘焦点),不显示聚焦描边。
        className="flex h-dvh w-full max-w-4xl flex-col overflow-hidden rounded-none bg-panel shadow-2xl outline-none lg:h-[88vh] lg:rounded-2xl lg:border lg:border-edge"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header —— 审查 #17:闪卡此前是唯一无下载/无分享的查看器。这里保留自建外壳
            (键盘/进度/掌握度深度定制,改造为 Modal 风险高),补上 header 右侧的
            分享 + 下载,与其它查看器视觉对齐。 */}
        <div className="flex items-start justify-between gap-3 px-4 py-4 lg:px-6">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-semibold text-ink">{output.title}</h2>
            <p className="mt-0.5 text-sm text-ink2">闪卡 · 基于 {cards.length} 张卡片</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => (onShareNotebook ? onShareNotebook() : shareOutput(output))}
              title="分享"
              aria-label="分享"
              className="rounded-lg p-1.5 text-ink2 transition hover:bg-panel2 hover:text-ink"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
            </button>
            <button
              onClick={() => downloadOutput(output)}
              title="下载"
              aria-label="下载"
              className="rounded-lg p-1.5 text-ink2 transition hover:bg-panel2 hover:text-ink"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
            <button
              onClick={onClose}
              title="关闭"
              aria-label="关闭"
              className="rounded-lg p-1.5 text-ink2 transition hover:bg-panel2 hover:text-ink"
            >
              <CloseIcon width={20} height={20} />
            </button>
          </div>
        </div>

        {cards.length === 0 || !card ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">没有可显示的闪卡。</div>
        ) : done ? (
          /* 小结页:本轮全部标完 —— 会了 N / 不熟 M;M>0 可只装入不熟卡再练一轮 */
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm text-muted">
              {roundIdx ? "这一轮重练" : "这一轮"} {round.length} 张已全部过完
            </p>
            <p className="text-2xl font-semibold text-ink">
              会了 <span className="text-emerald-600">{knownN}</span> · 不熟{" "}
              <span className="text-red-500">{unknownM}</span>
            </p>
            {unknownM > 0 ? (
              <button
                onClick={retryUnknown}
                className="mt-2 rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-onAccent transition hover:brightness-110"
              >
                重练不熟的 {unknownM} 张
              </button>
            ) : (
              <p className="mt-1 text-sm text-ink2">全部掌握,太棒了!这套卡片你已经拿下。</p>
            )}
          </div>
        ) : (
          <>
            {/* 键盘快捷键提示对触屏无意义,窄屏隐藏省纵向空间 */}
            <p className="hidden px-6 text-center text-xs text-muted lg:block">
              按 <kbd className="rounded bg-panel2 px-1.5 py-0.5 font-mono">空格</kbd> 翻面 ·{" "}
              <kbd className="rounded bg-panel2 px-1.5 py-0.5 font-mono">←</kbd>{" "}
              <kbd className="rounded bg-panel2 px-1.5 py-0.5 font-mono">→</kbd> 浏览 · 翻开后{" "}
              <kbd className="rounded bg-panel2 px-1.5 py-0.5 font-mono">1</kbd> 会了 /{" "}
              <kbd className="rounded bg-panel2 px-1.5 py-0.5 font-mono">2</kbd> 不熟
            </p>

            {/* card —— 用户反馈:左右切换按钮不再放底部,而是浮在卡片左右两侧
                (阅读器/相册常见做法),让底部只留「掌握度」评价,视觉焦点集中。 */}
            <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 py-5 lg:px-6">
              <div
                className="pointer-events-none absolute h-[55%] w-[58%] rounded-full opacity-60 blur-[80px]"
                style={{ background: "radial-gradient(circle, #7d5fd855, #2aa17833 60%, transparent)" }}
              />
              <button
                onClick={(e) => { (e.currentTarget as HTMLElement).blur(); setFlipped((f) => !f); }}
                // 窄屏:16/10 比例按 343px 宽只剩 ~200px 高,长答案会溢出 → 改为撑满可用高度
                //(竖屏空间充裕);≥lg 恢复原比例卡片。padding/字号同步收敛。
                className="group relative flex h-full max-h-full w-full max-w-3xl flex-col rounded-3xl bg-[#26272e] p-5 text-left shadow-[0_30px_70px_-30px_rgba(0,0,0,0.6)] transition hover:bg-[#2c2d35] lg:aspect-[16/10] lg:h-auto lg:p-7"
              >
                <div className="flex items-center justify-between text-sm text-white/45">
                  <span className="tabular-nums">
                    {roundIdx ? "重练 · " : ""}
                    {pos + 1} / {round.length}
                  </span>
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">
                    {flipped ? "答案" : "问题"}
                  </span>
                </div>
                <div className="flex flex-1 items-center justify-center px-2">
                  {/* 窄屏字号收敛,避免 26px 大字在 343px 宽下几字一行 */}
                  <p className="line-clamp-[8] whitespace-pre-wrap text-center text-[21px] font-medium leading-snug text-white lg:text-[26px]">
                    {flipped ? card.back : card.front}
                  </p>
                </div>
                <p className="text-center text-sm text-white/55 transition group-hover:text-white/80">
                  {flipped ? "查看问题" : "查看答案"}
                </p>
              </button>

              {/* 左右切换:浮层圆按钮,嵌入卡片左右边(与卡片是兄弟元素,不是嵌套 button,
                  避免 button 内嵌 button 的 HTML 非法。stopPropagation 防止穿透触发翻面。
                  半透明白 + backdrop-blur:在深色卡片上可见,hover 变实。z-10 保证在卡片之上。
                  桌面 lg 更靠近卡片边缘(容器有留白);窄屏卡片满宽,按钮紧贴内边。 */}
              <button
                onClick={(e) => { e.stopPropagation(); (e.currentTarget as HTMLElement).blur(); go(-1); }}
                title="上一张"
                aria-label="上一张"
                className="absolute left-4 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/30 bg-white/[0.06] text-white/90 backdrop-blur-md transition hover:border-white/50 hover:bg-white/15 hover:text-white lg:left-10 lg:h-12 lg:w-12"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); (e.currentTarget as HTMLElement).blur(); go(1); }}
                title="下一张"
                aria-label="下一张"
                className="absolute right-4 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/30 bg-white/[0.06] text-white/90 backdrop-blur-md transition hover:border-white/50 hover:bg-white/15 hover:text-white lg:right-10 lg:h-12 lg:w-12"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
              </button>
            </div>

            {/* 底部只留「掌握度」评价(翻面后);翻面前显示引导文案避免留空。
                同时保留原键盘/触屏习惯:1=会了 / 2=不熟。 */}
            <div className="flex items-center justify-center gap-3 px-3 pb-5">
              {flipped ? (
                <>
                  <button
                    onClick={(e) => { (e.currentTarget as HTMLElement).blur(); markCard(false); }}
                    title="不熟,之后重练(快捷键 2)"
                    className={cn(navPill, curMark === false && "border-red-300 text-red-600")}
                  >
                    <span className="text-base text-red-500">✗</span> 不熟
                  </button>
                  <button
                    onClick={(e) => { (e.currentTarget as HTMLElement).blur(); markCard(true); }}
                    title="会了(快捷键 1)"
                    className={cn(navPill, curMark === true && "border-emerald-300 text-emerald-700")}
                  >
                    会了 <span className="text-base text-emerald-600">✓</span>
                  </button>
                </>
              ) : (
                <p className="text-sm text-muted">点击卡片查看答案</p>
              )}
            </div>
          </>
        )}

        {/* footer */}
        {/* flex-wrap:窄屏「存为笔记 + 删除 + 免责文案」放不下时换行,不横向溢出 */}
        <div className="flex flex-wrap items-center gap-2 border-t border-edge px-4 py-3 lg:px-6">
          {onSaveNote && (
            <button
              onClick={async () => {
                if (noteSaveRef.current || noteSaved) return;
                noteSaveRef.current = true;
                setNoteSaving(true);
                try {
                  const ok = await onSaveNote(output.title, asNote());
                  if (ok === false) throw new Error("save failed");
                  setNoteSaved(true);
                  toast("已存为笔记");
                } catch {
                  noteSaveRef.current = false;
                  toast("存为笔记失败,请重试", "error");
                } finally {
                  setNoteSaving(false);
                }
              }}
              disabled={noteSaved || noteSaving}
              className="inline-flex items-center gap-1.5 rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-accent hover:bg-accentSoft hover:text-accent disabled:opacity-50"
            >
              <SaveIcon width={15} height={15} /> {noteSaved ? "已存为笔记" : noteSaving ? "正在保存…" : "存为笔记"}
            </button>
          )}
          {onDelete && (
            <button
              // 只发起删除确认(HomeClient pendingDel 流程);确认后 doDeleteOutput 会
              // 自动关掉本查看器,取消则原地不动——别在这里提前 onClose()。
              onClick={onDelete}
              className="inline-flex items-center gap-1.5 rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-red-300 hover:text-red-600"
            >
              <TrashIcon width={15} height={15} /> 删除
            </button>
          )}
          <div className="ml-auto text-right">
            <p className="text-xs text-muted">闪卡为智能生成,可能有误,请结合来源核对。</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// quiz
// ---------------------------------------------------------------------------

/** 测验外壳:modal=中栏弹窗(公开页用);panel=右栏内联(主应用用,可与中栏对话并存)。 */
function QuizShell({
  variant,
  title,
  subtitle,
  sourceCaption: caption,
  onShare,
  onClose,
  footer,
  children,
  full,
  onFullChange,
}: {
  variant: "modal" | "panel";
  title: string;
  subtitle?: string;
  sourceCaption?: string;
  onShare?: () => void;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
  /** 展开态由 QuizView 托管,使「解释/查看来源」在展开时能先收回右栏再触发。 */
  full?: boolean;
  onFullChange?: (v: boolean) => void;
}) {
  const setFull = (v: boolean) => onFullChange?.(v);
  if (variant === "modal") {
    return (
      <Modal title={title} subtitle={subtitle} sourceCaption={caption} onShare={onShare} onClose={onClose} footer={footer}>
        {children}
      </Modal>
    );
  }
  // 参考 NotebookLM 的双排顶栏:第一排=面包屑 + 关闭(border-b,与对话/来源头部同高对齐);
  // 第二排=制品标题 + 展开(放大/还原)+ 更多(分享)。
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-edge px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <button onClick={onClose} title="返回智能笔记" className="shrink-0 text-ink transition hover:text-accent">
            智能笔记
          </button>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted" aria-hidden>
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span className="truncate font-normal text-ink">测验</span>
        </div>
        <button
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
          className="-mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink2 transition hover:bg-panel2 hover:text-ink"
        >
          <CloseIcon width={18} height={18} />
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
        <h2 className="min-w-0 truncate text-[17px] font-semibold leading-tight text-ink">{title}</h2>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => setFull(!full)}
            title={full ? "还原" : "展开"}
            aria-label={full ? "还原" : "展开"}
            className="grid h-8 w-8 place-items-center rounded-lg text-ink2 transition hover:bg-panel2 hover:text-accent"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {full ? (
                <>
                  <path d="M4 14h6v6" />
                  <path d="M20 10h-6V4" />
                  <path d="m14 10 7-7" />
                  <path d="m3 21 7-7" />
                </>
              ) : (
                <>
                  <path d="M15 3h6v6" />
                  <path d="M9 21H3v-6" />
                  <path d="m21 3-7 7" />
                  <path d="m3 21 7-7" />
                </>
              )}
            </svg>
          </button>
          {onShare && (
            <button
              onClick={onShare}
              title="更多 · 分享"
              aria-label="更多"
              className="grid h-8 w-8 place-items-center rounded-lg text-ink2 transition hover:bg-panel2 hover:text-accent"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <circle cx="12" cy="5" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="12" cy="19" r="1.6" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-3 pt-1">{children}</div>
      {footer && <div className="flex items-center gap-2 border-t border-edge px-5 py-2.5">{footer}</div>}
    </>
  );
  if (full) {
    // 展开:用「原来的」内容查看器弹窗呈现——单行标题 + 关闭,不再带面包屑;
    // 左侧加一个「还原」按钮收回到右栏。
    return (
      <Modal
        title={title}
        subtitle={subtitle}
        sourceCaption={caption}
        onShare={onShare}
        onClose={onClose}
        footer={footer}
        fill
        noExpand
        headerActions={
          <button
            onClick={() => setFull(false)}
            title="还原"
            aria-label="还原"
            className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-accent"
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 14h6v6" />
              <path d="M20 10h-6V4" />
              <path d="m14 10 7-7" />
              <path d="m3 21 7-7" />
            </svg>
          </button>
        }
      >
        {children}
      </Modal>
    );
  }
  // 答题时右栏变宽(参考 NotebookLM)——给题目/选项更多空间,选项基本不再换行。
  return (
    // 窄屏(<lg 单栏+底部tab):同 StudioPanel,不自带 hidden/固定宽,显隐交给父容器
    <aside className="flex w-full shrink-0 flex-col overflow-hidden rounded-[22px] bg-panel elev-soft lg:w-[440px] xl:w-[520px] 2xl:w-[560px]">
      {inner}
    </aside>
  );
}

export function QuizView({
  output,
  variant = "modal",
  onClose,
  onSaveNote,
  onDelete,
  onShareNotebook,
  onOpenSource,
}: {
  output: StudioOutput;
  variant?: "modal" | "panel";
  onClose: () => void;
  onSaveNote?: (title: string, content: string) => boolean | void | Promise<boolean | void>;
  onDelete?: () => void;
  onShareNotebook?: () => void;
  /** 「查看来源」——按来源标题跳回原文 */
  onOpenSource?: (title: string) => boolean;
}) {
  type QItem = { q: string; options: string[]; answer: number; explanations?: string[]; explanation?: string; hint?: string; source?: string; sources?: string[]; type?: string };
  const questionTypeLabel = (type?: string) => ({
    recall: "记忆",
    application: "应用",
    comparison: "对比",
    rationale: "原理",
  }[type || ""] || "");
  const questions = useMemo(() => {
    try {
      return ((JSON.parse(output.content).questions as QItem[]) || []).filter((q) => q?.q && Array.isArray(q.options));
    } catch {
      return [];
    }
  }, [output.content]);
  const generation = useMemo(() => {
    try {
      const raw = JSON.parse(output.data || "{}") as {
        generation?: { difficulty?: unknown; count?: unknown; language?: unknown; instructionPresent?: unknown };
      };
      const item = raw.generation ?? {};
      return {
        difficulty: typeof item.difficulty === "string" ? item.difficulty : "",
        count: typeof item.count === "number" ? item.count : null,
        language: typeof item.language === "string" ? item.language : "",
        instructionPresent: item.instructionPresent === true,
      };
    } catch {
      return { difficulty: "", count: null, language: "", instructionPresent: false };
    }
  }, [output.data]);
  const difficultyLabel = generation.difficulty === "easy" ? "简单" : generation.difficulty === "hard" ? "困难" : generation.difficulty === "medium" ? "中等" : "";
  const configSummary = [
    generation.count ? `题量设置 ${generation.count}` : "",
    difficultyLabel,
    generation.language,
    generation.instructionPresent ? "含补充说明" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // 选项 oi 的解析:优先逐项 explanations,回退旧单 explanation(只对正确项)。
  const expl = (q: QItem, oi: number) =>
    (q.explanations && q.explanations[oi]) || (oi === q.answer ? q.explanation || "" : "");
  const sourceTitles = (q: QItem) => q.sources?.length ? q.sources : q.source ? [q.source] : [];
  const analysisCompleteFor = (q: QItem) =>
    q.options.length > 0 && q.options.every((_, optionIndex) => expl(q, optionIndex).trim().length > 0);
  // 答题进度持久化:关闭再进继续上次(按 output.id 存 localStorage);「重做一遍」/删除时清除。
  const progressKey = `quiz-progress:${output.id}`;
  const readSaved = (): { picks?: Record<number, number>; idx?: number; showResults?: boolean } => {
    try { return JSON.parse(localStorage.getItem(progressKey) || "null") || {}; } catch { return {}; }
  };
  // 存为笔记反馈:与 ViewerActions/对话气泡统一(变已存+禁用+toast),防连点存重复。
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const noteSaveRef = useRef(false);
  const [picks, setPicks] = useState<Record<number, number>>(() => {
    const p = readSaved().picks; return p && typeof p === "object" ? p : {};
  });
  const [idx, setIdx] = useState(() => {
    const s = readSaved(); return Math.min(Math.max(0, s.idx ?? 0), Math.max(0, questions.length - 1));
  });
  const [showHint, setShowHint] = useState(false);
  const [analysisIdx, setAnalysisIdx] = useState<number | null>(null);
  const [showResults, setShowResults] = useState(() => !!readSaved().showResults && questions.length > 0);
  // 每次答题/翻页/出结果都落盘,关闭(组件卸载)后再进仍在原处。
  useEffect(() => {
    try { localStorage.setItem(progressKey, JSON.stringify({ picks, idx, showResults })); } catch { /* 隐私模式/配额满,忽略 */ }
  }, [progressKey, picks, idx, showResults]);
  // 展开态(右栏 ↔ 居中浮层)上提到此,使「查看来源」在展开时先收回右栏——
  // 否则来源查看器被浮层挡住,点了像没反应。
  const [full, setFull] = useState(false);
  const openSourceAndDock = (title: string) => { setFull(false); return onOpenSource ? onOpenSource(title) : false; };
  const total = questions.length;
  const score = questions.reduce((acc, q, i) => acc + (picks[i] === q.answer ? 1 : 0), 0);
  // Clamp the lookup so a stale idx that overran a now-shorter `questions` can
  // never yield undefined here — rendering cur.q / cur.options.map on undefined
  // would crash the whole panel. When total===0 the empty-state renders before
  // cur is used. (The key={activeQuiz.id} remount is the primary fix for
  // switching artifacts; this clamp guards an in-place content shrink too.)
  const cur = questions[Math.min(idx, Math.max(0, total - 1))];
  const picked = cur ? picks[idx] : undefined;
  const answered = picked !== undefined;
  const analysisOpen = analysisIdx === idx;
  const analysisComplete = cur ? analysisCompleteFor(cur) : false;
  const isLast = idx === total - 1;
  const asNote = () =>
    questions
      .map((q, i) => {
        const letters = q.options.map((o, oi) => `${String.fromCharCode(65 + oi)}. ${o}`);
        const analyses = q.options
          .map((o, oi) => {
            const detail = expl(q, oi);
            return detail ? `> ${String.fromCharCode(65 + oi)}. ${o}: ${detail}` : "";
          })
          .filter(Boolean);
        return [
          `${i + 1}. ${q.q}`,
          questionTypeLabel(q.type) ? `题型:${questionTypeLabel(q.type)}` : "",
          ...letters,
          `✅ 正确答案:${String.fromCharCode(65 + q.answer)}. ${q.options[q.answer] ?? ""}`,
          analyses.length ? "逐项解析:" : "",
          ...analyses,
          q.hint ? `💡 提示:${q.hint}` : "",
          sourceTitles(q).length ? `来源:${sourceTitles(q).join("、")}` : "",
        ].filter(Boolean).join("\n");
      })
      .join("\n\n");

  return (
    <QuizShell
      variant={variant}
      full={full}
      onFullChange={setFull}
      title={output.title}
      subtitle={`测验 · ${questions.length} 题${configSummary ? ` · ${configSummary}` : ""}`}
      sourceCaption={sourceCaption(output)}
      onShare={onShareNotebook ?? (() => shareOutput(output))}
      onClose={onClose}
      footer={
        onDelete || onSaveNote ? (
          <>
            {onSaveNote && (
              <button
                onClick={async () => {
                  if (noteSaveRef.current || noteSaved) return;
                  noteSaveRef.current = true;
                  setNoteSaving(true);
                  try {
                    const ok = await onSaveNote(output.title, asNote());
                    if (ok === false) throw new Error("save failed");
                    setNoteSaved(true);
                    toast("已存为笔记");
                  } catch {
                    noteSaveRef.current = false;
                    toast("存为笔记失败,请重试", "error");
                  } finally {
                    setNoteSaving(false);
                  }
                }}
                disabled={noteSaved || noteSaving}
                className="inline-flex items-center gap-1.5 rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-accent hover:bg-accentSoft hover:text-accent disabled:opacity-50"
              >
                <SaveIcon width={15} height={15} /> {noteSaved ? "已存为笔记" : noteSaving ? "正在保存…" : "存为笔记(含完整解析)"}
              </button>
            )}
            {onDelete && (
              <button
                // 只发起删除确认(HomeClient pendingDel 流程);确认成功后才由外层关闭
                // 查看器并清答题进度(见 StudioPanel 的「原地消失」监听),取消则原地
                // 不动——别在这里提前 onClose()/清 progressKey,否则「取消」形同虚设。
                onClick={onDelete}
                className="inline-flex items-center gap-1.5 rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-red-300 hover:text-red-600"
              >
                <TrashIcon width={15} height={15} /> 删除
              </button>
            )}
          </>
        ) : undefined
      }
    >
      {total === 0 ? (
        <p className="py-10 text-center text-sm text-muted">没有可显示的题目。</p>
      ) : showResults ? (
        /* 结果页:得分 + 逐题回顾 + 重做 */
        <div className={cn("space-y-5", variant === "panel" && "min-h-0 flex-1 overflow-y-auto pr-1")}>
          <div className="flex flex-col items-center gap-1.5 py-3">
            <div className="text-[42px] font-semibold leading-none tabular-nums text-ink">
              {Math.round((score / total) * 100)}
              <span className="text-xl text-muted">%</span>
            </div>
            <p className="text-sm text-ink2">答对 {score} / {total} 题</p>
            <p className="text-xs text-muted">
              {score === total ? "全部答对,掌握得很扎实。" : score / total >= 0.6 ? "不错,重点看下方标红的题。" : "建议再过一遍来源,然后重做一次。"}
            </p>
          </div>
          <div className="space-y-2.5">
            {questions.map((q, qi) => {
              const ok = picks[qi] === q.answer;
              return (
                <div key={qi} className="rounded-xl border border-edge p-3.5">
                  <div className="flex items-start gap-2.5">
                    <span className={cn("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white", ok ? "bg-emerald-500" : "bg-red-500")}>
                      {ok ? "✓" : "✗"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">{qi + 1}. {q.q}</p>
                      {questionTypeLabel(q.type) && <p className="mt-0.5 text-[11px] text-muted">题型:{questionTypeLabel(q.type)}</p>}
                      <p className="mt-1 text-xs text-emerald-600">正确:{String.fromCharCode(65 + q.answer)}. {q.options[q.answer]}</p>
                      {!ok && picks[qi] !== undefined && (
                        <p className="mt-0.5 text-xs text-red-500">你的答案:{String.fromCharCode(65 + picks[qi])}. {q.options[picks[qi]]}</p>
                      )}
                      {analysisCompleteFor(q) && expl(q, q.answer) && <p className="mt-1 text-xs leading-relaxed text-ink2">解析:{expl(q, q.answer)}</p>}
                      {analysisCompleteFor(q) && !ok && picks[qi] !== undefined && expl(q, picks[qi]) && (
                        <p className="mt-0.5 text-xs leading-relaxed text-red-500/90">你的选项:{expl(q, picks[qi])}</p>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        {onOpenSource && sourceTitles(q).map((title) => (
                          <button
                            key={title}
                            onClick={() => openSourceAndDock(title)}
                            className="inline-flex items-center gap-1 rounded-full bg-panel2 px-2.5 py-1 text-[11px] text-ink2 transition hover:text-accent"
                          >
                            <FileIcon width={12} height={12} /> 来源:{title}
                          </button>
                        ))}
                        <button
                          onClick={() => { setIdx(qi); setShowResults(false); setAnalysisIdx(qi); }}
                          className="inline-flex items-center gap-1 rounded-full bg-accentSoft px-2.5 py-1 text-[11px] font-medium text-accent transition hover:brightness-105"
                        >
                          具体解析
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => { setPicks({}); setIdx(0); setShowResults(false); setAnalysisIdx(null); }}
            className="w-full rounded-xl border border-edge py-2.5 text-sm font-medium text-ink2 transition hover:border-accent hover:bg-accentSoft hover:text-accent"
          >
            重做一遍
          </button>
        </div>
      ) : (
        /* 答题页:modal=固定高度(选完不跳);panel=填满右栏列。选项区内部滚动、底栏钉底。 */
        <div className={cn("flex flex-col", variant === "modal" ? "h-[clamp(380px,60vh,580px)]" : "min-h-0 flex-1")}>
          <div className="mb-4 shrink-0">
            <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
              <span>第 {idx + 1} / {total} 题</span>
              <span className="tabular-nums">已答对 {score}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel2">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${((idx + (answered ? 1 : 0)) / total) * 100}%` }} />
            </div>
          </div>
          {questionTypeLabel(cur.type) && <p className="mb-1 shrink-0 text-[11px] font-medium text-accent">题型:{questionTypeLabel(cur.type)}</p>}
          <p className="mb-4 shrink-0 text-[15px] font-medium leading-relaxed text-ink">{cur.q}</p>
          {/* 选项:答题前可点;答题后每项展示标记 + 逐项解析。内部滚动,使答前/答后弹窗高度一致、不跳。 */}
          <div className="-mr-1 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {cur.options.map((opt, oi) => {
              const isCorrect = oi === cur.answer;
              const isPicked = picked === oi;
              let box = "border-edge";
              let marker: { icon: string; label: string; color: string } | null = null;
              if (answered) {
                if (isCorrect) {
                  box = "border-emerald-500/50 bg-emerald-500/10";
                  marker = { icon: "✓", label: isPicked ? "回答正确!" : "正确答案", color: "text-emerald-600" };
                } else if (isPicked) {
                  box = "border-red-500/50 bg-red-500/10";
                  marker = { icon: "✗", label: "不太对", color: "text-red-600" };
                } else {
                  box = "border-edge bg-panel2/40";
                }
              }
              const e = expl(cur, oi);
              // 圆形字母徽章随状态着色:未答=灰,答对=绿,选错=红,其余=灰。
              let badgeCls = "bg-panel2 text-ink2";
              if (answered) {
                if (isCorrect) badgeCls = "bg-emerald-500 text-white";
                else if (isPicked) badgeCls = "bg-red-500 text-white";
                else badgeCls = "bg-panel2 text-muted";
              }
              return (
                <button
                  key={oi}
                  disabled={answered}
                  onClick={() => setPicks((p) => ({ ...p, [idx]: oi }))}
                  className={cn(
                    "block w-full rounded-xl border px-4 py-3 text-left text-sm transition",
                    box,
                    !answered && "text-ink2 hover:border-accent/50 hover:bg-accentSoft/40 hover:text-ink"
                  )}
                >
                  <span className="flex items-start gap-3">
                    <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12.5px] font-medium", badgeCls)}>
                      {String.fromCharCode(65 + oi)}
                    </span>
                    <span className={cn("min-w-0 flex-1 pt-0.5", answered ? "text-ink" : "")}>{opt}</span>
                  </span>
                  {marker && (
                    <span className={cn("mt-1.5 flex items-center gap-1 pl-9 text-xs font-semibold", marker.color)}>
                      <span aria-hidden>{marker.icon}</span> {marker.label}
                    </span>
                  )}
                  {answered && analysisOpen && analysisComplete && e && <span className="mt-1 block pl-9 text-xs leading-relaxed text-ink2">{e}</span>}
                </button>
              );
            })}
          </div>
          {answered && analysisOpen && !analysisComplete && (
            <div className="mt-3 shrink-0 rounded-xl bg-panel2 px-3.5 py-2.5 text-xs leading-relaxed text-ink2">
              这道旧测验没有保存逐项解析，建议重新生成测验以获得“判定标准、选项对照与易错点”解析。
            </div>
          )}
          {/* 提示(答题前,可展开) */}
          {!answered && showHint && cur.hint && (
            <div className="mt-3 shrink-0 rounded-xl bg-panel2 px-3.5 py-2.5 text-xs leading-relaxed text-ink2">💡 {cur.hint}</div>
          )}
          {/* 底栏:左=提示/解释+来源,右=上一题 / 下一个 / 查看结果(固定在底部,不随选项滚动) */}
          <div className="flex shrink-0 items-center justify-between gap-2 pt-3">
            <div className="flex min-w-0 items-center gap-2">
              {!answered && cur.hint && (
                <button
                  onClick={() => setShowHint((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[13px] text-ink2 transition hover:bg-panel2"
                >
                  提示
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={cn("transition", showHint && "rotate-180")} aria-hidden><path d="m6 9 6 6 6-6" /></svg>
                </button>
              )}
              {answered && (
                <button
                  onClick={() => setAnalysisIdx((current) => (current === idx ? null : idx))}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-[13px] text-ink2 transition hover:border-accent hover:text-accent"
                >
                  {analysisOpen ? "收起解析" : "具体解析"}
                </button>
              )}
              {answered && onOpenSource && sourceTitles(cur).map((title) => (
                <button
                  key={title}
                  onClick={() => openSourceAndDock(title)}
                  className="inline-flex max-w-[180px] items-center gap-1 truncate rounded-full bg-panel2 px-2.5 py-1 text-[11px] text-ink2 transition hover:text-accent"
                >
                  <FileIcon width={12} height={12} /> <span className="truncate">{title}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {idx > 0 && (
                <button
                  onClick={() => { setIdx((i) => Math.max(0, i - 1)); setShowHint(false); }}
                  className="rounded-xl px-4 py-2 text-sm text-ink2 transition hover:bg-panel2"
                >
                  上一题
                </button>
              )}
              {isLast ? (
                <button
                  disabled={!answered}
                  onClick={() => setShowResults(true)}
                  className="rounded-xl bg-accent px-5 py-2 text-sm font-medium text-white transition enabled:hover:brightness-110 disabled:cursor-not-allowed"
                >
                  查看结果
                </button>
              ) : (
                <button
                  disabled={!answered}
                  onClick={() => { setIdx((i) => i + 1); setShowHint(false); }}
                  className="rounded-xl bg-accent px-5 py-2 text-sm font-medium text-white transition enabled:hover:brightness-110 disabled:cursor-not-allowed"
                >
                  下一个
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </QuizShell>
  );
}

// ---------------------------------------------------------------------------
// infographic
// ---------------------------------------------------------------------------

export function InfographicView({
  output,
  onClose,
  onSaveNote,
  onDelete,
  onShareNotebook,
}: {
  output: StudioOutput;
  onClose: () => void;
  onSaveNote?: (title: string, content: string) => void;
  onDelete?: () => void;
  onShareNotebook?: () => void;
}) {
  // 加载占位:图片是异步 PNG,未加载完先显示竖版骨架占位图,避免「0 高度→撑开」的横跳。
  const [loaded, setLoaded] = useState(false);
  const [imgErr, setImgErr] = useState(false); // PNG 缺失/失败:显示错误卡而非浏览器破图 glyph
  useEffect(() => { setLoaded(false); setImgErr(false); }, [output.id]);
  return (
    <Modal
      title={output.title}
      subtitle="信息图"
      sourceCaption={sourceCaption(output)}
      onShare={onShareNotebook ?? (() => shareOutput(output))}
      onClose={onClose}
      fill
      footer={
        <ViewerActions
          onDelete={onDelete}
          onDownload={() => downloadOutput(output)}
          downloadLabel="下载图片"
        />
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-1 [scrollbar-gutter:stable]">
        <div className="relative mx-auto w-full max-w-[820px]">
          {imgErr && (
            <div className="flex aspect-[2/3] w-full flex-col items-center justify-center gap-3 rounded-xl border border-edge bg-panel2/40 p-6 text-center">
              <p className="text-[14px] text-ink2">信息图未能加载(图片可能生成失败或已失效)。</p>
              <p className="text-[12.5px] text-muted">请删除后重新生成。</p>
            </div>
          )}
          {!loaded && !imgErr && (
            /* 占位图:与信息图同宽的竖版骨架(标题条 + 堆叠卡片)+ 脉冲,替代加载过程、占住高度避免横跳 */
            <div className="aspect-[2/3] w-full animate-pulse overflow-hidden rounded-xl border border-edge bg-gradient-to-b from-accent/15 to-panel2 p-6">
              <div className="h-3 w-24 rounded bg-accent/30" />
              <div className="mt-3 h-7 w-3/4 rounded bg-accent/25" />
              <div className="mt-2 h-4 w-1/2 rounded bg-accent/15" />
              <div className="mt-7 space-y-3">
                <div className="h-16 rounded-lg bg-white/45" />
                <div className="h-16 rounded-lg bg-white/35" />
                <div className="h-16 rounded-lg bg-white/25" />
              </div>
            </div>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {!imgErr && (
            <img
              src={`/api/studio/infographic/${output.id}`}
              alt={output.title}
              onLoad={() => setLoaded(true)}
              onError={() => { setLoaded(true); setImgErr(true); }}
              className={cn(
                "block h-auto w-full rounded-xl border border-edge shadow-xl transition-opacity duration-300",
                loaded ? "opacity-100" : "absolute inset-0 opacity-0"
              )}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 小红书卡组(xhs)
// ---------------------------------------------------------------------------

/** 行 data JSON 里的卡组张数(pages);缺失/非法回 0(按无图处理)。 */
function xhsPages(o: StudioOutput): number {
  try {
    const d = JSON.parse(o.data || "{}") as { pages?: unknown };
    if (typeof d.pages === "number" && Number.isFinite(d.pages) && d.pages > 0) return Math.floor(d.pages);
  } catch { /* data 非 JSON */ }
  return 0;
}

/** 卡组标题:content JSON 顶层 title,缺失/非 JSON 回退行标题。 */
function xhsTitle(o: StudioOutput): string {
  try {
    const c = JSON.parse(o.content || "{}") as { title?: unknown };
    if (typeof c.title === "string" && c.title.trim()) return c.title.trim();
  } catch { /* content 非 JSON */ }
  return o.title;
}

/** 小红书卡组打包下载:jszip 动态 import(防拖首包)抓全部 PNG 打成 <title>.zip。
 *  urlOf 可注入(查看器带重试版本号);列表行菜单/downloadOutput 用默认 URL。
 *  失败统一 toast(fire-and-forget 场景也有反馈)。 */
async function downloadXhsZip(o: StudioOutput, urlOf?: (i: number) => string): Promise<void> {
  const pages = xhsPages(o);
  if (pages <= 0) {
    toast("卡组图片不可用,无法打包", "error");
    return;
  }
  const at = urlOf ?? ((i: number) => `/api/studio/xhs/${o.id}/${i}`);
  try {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    // 弱网/单张 500 不该整包丢弃:allSettled 收集成功张、跳过失败张,每张 15s 超时
    // 兜底(否则某张挂住会让整包永远 pending、UI 无反馈)。
    const results = await Promise.allSettled(
      Array.from({ length: pages }, async (_, i) => {
        const r = await fetch(at(i), { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`第 ${i + 1} 张下载失败`);
        return r.arrayBuffer();
      })
    );
    const failed: number[] = [];
    results.forEach((res, i) => {
      if (res.status === "fulfilled") {
        zip.file(`${String(i + 1).padStart(2, "0")}.png`, res.value);
      } else {
        failed.push(i + 1);
      }
    });
    if (failed.length === pages) {
      // 全挂:没有任何一张可打包,不生成空 zip,直接报错让用户重试。
      toast("打包下载失败,请检查网络后重试", "error");
      return;
    }
    if (failed.length > 0) {
      toast(`第 ${failed.join("、")} 张下载失败,已导出其余 ${pages - failed.length} 张`, "error");
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const safe = (xhsTitle(o) || "小红书卡组").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "小红书卡组";
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safe}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    toast("打包下载失败,请重试", "error");
  }
}

/** 缩略条里的一张小图:自带失败态(失败显示页码占位,不渲染浏览器破图 glyph)。 */
function XhsThumb({
  src,
  page,
  active,
  onClick,
}: {
  src: string;
  page: number;
  active: boolean;
  onClick: () => void;
}) {
  const [err, setErr] = useState(false);
  useEffect(() => setErr(false), [src]);
  return (
    <button
      onClick={onClick}
      title={`第 ${page} 张`}
      aria-label={`第 ${page} 张`}
      aria-current={active || undefined}
      className={cn(
        // 窄屏缩略图收窄(高度随 3/4 比例收敛),给中央大图多留纵向空间
        "aspect-[3/4] w-[44px] overflow-hidden rounded-lg bg-panel2 transition lg:w-[52px]",
        active ? "ring-2 ring-accent" : "opacity-70 ring-1 ring-edge hover:opacity-100"
      )}
    >
      {err ? (
        <span className="grid h-full w-full place-items-center text-[11px] text-muted">{page}</span>
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={src} alt="" loading="lazy" onError={() => setErr(true)} className="h-full w-full object-cover" />
      )}
    </button>
  );
}

/** 小红书卡组查看器:中央 3:4 大图(第 idx 张)+ 左右箭头/键盘 ←→ 翻页 + 底部
 *  圆点与页码 + 缩略条可点跳。张数取行 data JSON 的 pages,标题取 content JSON 的
 *  title(均容错回退);图片 URL=/api/studio/xhs/<outputId>/<idx>(idx 从 0 起)。
 *  下载:「下载本张」直接 a[download] 当前 PNG;「打包下载」动态 import jszip
 *  (防拖首包)拉全部 PNG 打成 <title>.zip。 */
export function XhsCardsView({
  output,
  onClose,
  onDelete,
  onShareNotebook,
}: {
  output: StudioOutput;
  onClose: () => void;
  onDelete?: () => void;
  onShareNotebook?: () => void;
}) {
  const pages = useMemo(() => xhsPages(output), [output]);
  const cardTitle = useMemo(() => xhsTitle(output), [output]);
  const [idx, setIdx] = useState(0);
  // 大图加载失败标记(按张);「重试」自增版本号刷 URL 重新拉取。
  const [errs, setErrs] = useState<Record<number, boolean>>({});
  const [ver, setVer] = useState(0);
  const [zipping, setZipping] = useState(false);
  useEffect(() => { setIdx(0); setErrs({}); }, [output.id]);
  const urlOf = useCallback(
    (i: number) => `/api/studio/xhs/${output.id}/${i}${ver ? `?r=${ver}` : ""}`,
    [output.id, ver]
  );
  const go = useCallback(
    (d: number) => setIdx((v) => Math.min(pages - 1, Math.max(0, v + d))),
    [pages]
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const safeTitle = (cardTitle || "小红书卡组").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "小红书卡组";
  const clickDownload = (href: string, name: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const downloadZip = async () => {
    if (zipping || pages <= 0) return;
    setZipping(true);
    try {
      await downloadXhsZip(output, urlOf); // 失败在 helper 内 toast
    } finally {
      setZipping(false);
    }
  };

  return (
    <Modal
      title={cardTitle}
      subtitle="小红书卡组"
      sourceCaption={sourceCaption(output)}
      onShare={onShareNotebook ?? (() => shareOutput(output))}
      onClose={onClose}
      fill
      footer={
        // flex-wrap:窄屏「删除 + 下载本张 + 打包下载」三个按钮放不下时换行,不横向溢出
        <div className="flex w-full flex-wrap items-center gap-2">
          {onDelete && (
            <button
              onClick={onDelete}
              className="inline-flex items-center gap-1.5 rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-red-300 hover:text-red-600"
            >
              <TrashIcon width={15} height={15} /> 删除
            </button>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              onClick={() => clickDownload(urlOf(idx), `${safeTitle}-${idx + 1}.png`)}
              disabled={pages <= 0}
              className="inline-flex items-center gap-1.5 rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-accent hover:bg-accentSoft hover:text-accent disabled:opacity-50"
            >
              <DownloadIcon width={15} height={15} /> 下载本张
            </button>
            <button
              onClick={downloadZip}
              disabled={zipping || pages <= 0}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-medium text-onAccent transition hover:brightness-110 disabled:opacity-50"
            >
              {zipping ? <SpinnerIcon width={15} height={15} /> : <DownloadIcon width={15} height={15} />}
              {zipping ? "打包中…" : "打包下载"}
            </button>
          </div>
        </div>
      }
    >
      {pages <= 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-[14px] text-ink2">卡组图片不可用(可能生成失败或已失效)。</p>
          <p className="text-[12.5px] text-muted">请删除后重新生成。</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 大图区:3:4 竖版 object-contain 限高;左右箭头悬浮两侧 */}
          <div className="relative flex min-h-0 flex-1 items-center justify-center">
            {errs[idx] ? (
              <div className="flex aspect-[3/4] h-full flex-col items-center justify-center gap-3 rounded-xl border border-edge bg-panel2/40 p-6 text-center">
                <p className="text-[14px] text-ink2">这张图片未能加载。</p>
                <button
                  onClick={() => { setErrs((m) => ({ ...m, [idx]: false })); setVer((v) => v + 1); }}
                  className="rounded-full border border-edge px-4 py-1.5 text-[13px] text-ink2 transition hover:border-accent hover:text-accent"
                >
                  重试
                </button>
              </div>
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                key={`${idx}-${ver}`}
                src={urlOf(idx)}
                alt={`${cardTitle} 第 ${idx + 1} 张`}
                onError={() => setErrs((m) => ({ ...m, [idx]: true }))}
                className="max-h-full w-auto max-w-full rounded-xl border border-edge object-contain shadow-xl"
              />
            )}
            {idx > 0 && (
              <button
                onClick={() => go(-1)}
                aria-label="上一张"
                // 窄屏大图几乎占满宽度,箭头缩小贴边,少遮卡片内容
                className="absolute left-0.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-panel/90 text-ink2 shadow ring-1 ring-edge transition hover:text-accent lg:left-1 lg:h-10 lg:w-10"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
              </button>
            )}
            {idx < pages - 1 && (
              <button
                onClick={() => go(1)}
                aria-label="下一张"
                // 窄屏大图几乎占满宽度,箭头缩小贴边,少遮卡片内容
                className="absolute right-0.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-panel/90 text-ink2 shadow ring-1 ring-edge transition hover:text-accent lg:right-1 lg:h-10 lg:w-10"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
              </button>
            )}
          </div>
          {/* 圆点 + 页码「3 / 8」 */}
          <div className="mt-3 flex shrink-0 items-center justify-center gap-2.5">
            <span className="flex items-center gap-1.5">
              {Array.from({ length: pages }, (_, i) => (
                <button
                  key={i}
                  onClick={() => setIdx(i)}
                  aria-label={`跳到第 ${i + 1} 张`}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    i === idx ? "w-4 bg-accent" : "w-1.5 bg-edge hover:bg-muted"
                  )}
                />
              ))}
            </span>
            <span className="text-[12.5px] tabular-nums text-muted">{idx + 1} / {pages}</span>
          </div>
          {/* 缩略条:横向小图可点跳(overflow-x 连带竖裁,补 py 防选中环被切;
              内层 w-max + mx-auto:装得下时居中、放不下时从左起可滚,不裁首张) */}
          <div className="mt-1.5 shrink-0 overflow-x-auto px-0.5 py-1.5">
            <div className="mx-auto flex w-max gap-2">
              {Array.from({ length: pages }, (_, i) => (
                <XhsThumb key={i} src={urlOf(i)} page={i + 1} active={i === idx} onClick={() => setIdx(i)} />
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// slide deck
// ---------------------------------------------------------------------------

// 双轨 PPT「在线演示」:reveal.js 渲染器,浏览器专用 + 包较大,懒加载。
const RevealDeckView = dynamic(() => import("./RevealDeck"), { ssr: false });

export function SlidesView({
  output,
  onClose,
  onSaveNote,
  onDelete,
  onSaved,
  onShareNotebook,
  watermark,
}: {
  output: StudioOutput;
  onClose: () => void;
  onSaveNote?: (title: string, content: string) => void;
  onDelete?: () => void;
  /** Persist the deck (e.g. theme switch) back to the notebook's state. */
  onSaved?: (content: string) => void;
  onShareNotebook?: () => void;
  watermark?: boolean;
}) {
  const deck = useMemo(
    () => parseDeck(output.content, output.title),
    [output.content, output.title]
  );
  const effectiveWatermark = outputWatermark(output, watermark);
  const slides = deck.slides;
  const [i, setI] = useState(0);
  // 模版在生成时选定;查看器锁定为该模版,不再切换。
  const t = slideTheme(deck.theme);
  const st = slideStyle(t.id);
  const [playing, setPlaying] = useState(false);
  const [title, setTitle] = useState(output.title);
  const total = slides.length;
  const slide = slides[i];
  const go = useCallback(
    (d: number) => setI((v) => Math.min(total - 1, Math.max(0, v + d))),
    [total]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (playing) return; // 演示态由 reveal 接管键盘;Esc 退出在 RevealDeck 内处理
      if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") {
        if (e.key === " ") e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Home") setI(0);
      else if (e.key === "End") setI(total - 1);
      else if (e.key === "Escape" && playing) {
        e.stopPropagation();
        setPlaying(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, total, playing]);

  // 双轨:点「演示」→ reveal.js 全屏渲染(转场 + 逐项动画);嵌入弹窗预览仍用下方 React 渲染。
  if (playing) {
    return <RevealDeckView deck={{ ...deck, watermark: effectiveWatermark }} theme={t} onClose={() => setPlaying(false)} />;
  }

  return (
    <Modal
      title={
        <input
          name="title"
          autoComplete="off"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            const v = title.trim();
            if (v && v !== output.title) {
              // 审查修复:此前 fire-and-forget,失败时本地显示新名、DB 还是旧名,刷新即打回。
              void (async () => {
                try {
                  const r = await fetch(`/api/studio/${output.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ title: v }),
                  });
                  if (!r.ok) throw new Error();
                } catch {
                  setTitle(output.title);
                  toast("重命名失败,请重试", "error");
                }
              })();
            } else if (!v) {
              setTitle(output.title);
            }
          }}
          aria-label="演示文稿标题"
          className="-ml-1 w-full truncate rounded border-0 bg-transparent px-1 text-[19px] font-semibold leading-tight text-ink outline-none transition focus:bg-panel2/70"
        />
      }
      subtitle={`幻灯片 · ${total} 页`}
      sourceCaption={sourceCaption(output)}
      onShare={onShareNotebook ?? (() => shareOutput(output))}
      onClose={onClose}
      fill
      footer={
        <ViewerActions
          onDelete={onDelete}
          onDownload={() => downloadOutput(output)}
          downloadLabel="下载 PPTX"
        />
      }
      headerActions={
        <button
          onClick={() => setPlaying(true)}
          title="放映"
          aria-label="放映"
          className="inline-flex items-center gap-1.5 rounded-full border border-edge px-3.5 py-1.5 text-sm text-ink transition hover:border-accent hover:text-accent"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="2.5" y="4.5" width="19" height="12" rx="2" />
            <path d="M12 16.5V20M8.5 20h7" />
            <path d="M10.6 8.2v5l4-2.5z" fill="currentColor" />
          </svg>
          放映
        </button>
      }
    >
      {total === 0 || !slide ? (
        <p className="py-10 text-center text-sm text-muted">没有可显示的幻灯片。</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {/* slide canvas — 1280×720 设计坐标系,SlideStage 整体等比缩放。
              模版在生成时已选定(deck.theme),查看器不再换皮,与 NotebookLM 一致。 */}
          <div className="flex min-h-0 flex-1 gap-3">
          <div
            className={cn(
              playing
                ? "fixed inset-0 z-[70] flex items-center justify-center bg-black/95 px-10"
                : "min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto px-0.5 py-1"
            )}
          >
            {(playing ? [slide] : slides).map((slide, mi) => (
            <div
              key={mi}
              id={`sld-${output.id}-${mi}`}
              className={cn("animate-popin", playing && "mx-auto w-full max-w-[1480px]")}
            >
            <SlideStage
              bg={t.bg}
              watermark={effectiveWatermark ? t.metaColor : undefined}
              fx={{
                grid: st.bgGrid ? "rgba(139,123,255,0.07)" : undefined,
                corner: st.corners && slide.layout !== "cover" ? t.accent : undefined,
                sharp: st.sharp,
                glow: st.glow ? t.accent : undefined,
              }}
            >
            {slide.layout === "cover" ? (
              // NotebookLM 式分栏封面:左标题块 + 右生成式视觉 + 四角裁切角标(技术框)。
              // 布局统一,配色/字体仍随模版变。
              <div className={cn("relative flex h-full w-full items-stretch", (st.density ?? "normal") === "airy" ? "px-20 py-16" : "px-12 py-10")}>
                {(st.coverCorners ?? true) && (
                  <span aria-hidden className="pointer-events-none absolute inset-9 z-20">
                    <span className="absolute left-0 top-0 h-5 w-5 border-l-2 border-t-2" style={{ borderColor: t.accent }} />
                    <span className="absolute right-0 top-0 h-5 w-5 border-r-2 border-t-2" style={{ borderColor: t.accent }} />
                    <span className="absolute bottom-0 left-0 h-5 w-5 border-b-2 border-l-2" style={{ borderColor: t.accent }} />
                    <span className="absolute bottom-0 right-0 h-5 w-5 border-b-2 border-r-2" style={{ borderColor: t.accent }} />
                  </span>
                )}
                <div className={cn("relative z-10 flex flex-col justify-center px-8", (st.coverDecor ?? "orbit") === "none" ? "w-full" : "w-[53%]")}>
                  {slide.bullets?.[0] && (
                    <span
                      className={cn("mb-4 text-[15px] font-bold", hasCJK(slide.bullets[0]) ? "" : "uppercase tracking-[2px]")}
                      style={{ color: t.accent, fontFamily: st.fontHead }}
                    >
                      {slide.bullets[0]}
                    </span>
                  )}
                  <h3 className="text-balance font-extrabold leading-[1.16] cjk-display" style={{ color: t.titleColor, fontFamily: st.fontHead, fontSize: 52 * (st.titleScale ?? 1) }}>
                    {slide.title}
                  </h3>
                  <span className="mt-6 flex items-center gap-1.5">
                    <span className="block h-[6px] w-20 rounded-full" style={{ background: t.accent }} />
                    {t.accent2 && <span className="block h-[6px] w-6 rounded-full" style={{ background: t.accent2 }} />}
                  </span>
                  {slide.subtitle && (
                    <p className="mt-7 max-w-[560px] text-[21px] leading-[1.75] text-pretty" style={{ color: t.textColor, fontFamily: st.fontHead }}>
                      {slide.subtitle}
                    </p>
                  )}
                  {slide.bullets && slide.bullets.length > 1 && (
                    <div className="mt-9 flex flex-wrap gap-2.5">
                      {slide.bullets.slice(1, 4).map((b, k) => (
                        <span
                          key={k}
                          className="rounded-full px-3.5 py-1.5 text-[14px] font-medium"
                          style={{ background: t.cardBg, border: `1px solid ${t.cardBorder}`, color: t.textColor }}
                        >
                          {b}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {(st.coverDecor ?? "orbit") !== "none" && (
                  <div className="relative w-[47%] self-stretch">
                    <div
                      className="absolute inset-3 overflow-hidden rounded-2xl"
                      style={{ background: t.cardBg, border: `1px solid ${t.cardBorder}` }}
                    >
                      <HeroArt t={t} seed={output.id} motif={st.coverDecor && st.coverDecor !== "none" ? (st.coverDecor as "orbit" | "grid" | "wave" | "geo") : undefined} />
                    </div>
                  </div>
                )}
              </div>
            ) : slide.layout === "rings" ? (
              <div className="flex h-full w-full flex-col px-16 pb-14 pt-12">
                <TitleBlock title={slide.title} t={t} />
                <div className="relative min-h-0 flex-1">
                  {/* 装饰环 + 中心概念 */}
                  <svg className="absolute inset-0 h-full w-full" aria-hidden>
                    <ellipse
                      cx="50%"
                      cy="50%"
                      rx="32%"
                      ry="33%"
                      fill="none"
                      stroke={t.cardBorder}
                      strokeWidth={1.5}
                      strokeDasharray="4 7"
                    />
                  </svg>
                  <div
                    className="absolute left-1/2 top-1/2 flex h-[136px] w-[136px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[3px] px-3 text-center text-[21px] font-bold leading-tight"
                    style={{ borderColor: t.accent, color: t.titleColor, background: t.cardBg }}
                  >
                    {slide.center}
                  </div>
                  {slide.items!.map((it, k) => {
                    const n = slide.items!.length;
                    const ang = ((-90 + (k * 360) / n) * Math.PI) / 180;
                    const x = 50 + Math.cos(ang) * 32;
                    const y = 50 + Math.sin(ang) * 33;
                    const tone = t.tones[it.tone ?? "a"];
                    return (
                      <div
                        key={k}
                        className="absolute flex w-[260px] -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center"
                        style={{ left: `${x}%`, top: `${y}%` }}
                      >
                        <span
                          className="flex h-14 w-14 items-center justify-center rounded-full border-2"
                          style={{ borderColor: tone.fg, color: tone.fg, background: t.cardBg }}
                        >
                          <DeckIcon name={it.icon} size={24} />
                        </span>
                        <span className="mt-2 text-[20px] font-bold" style={{ color: cardLabelColor(t) }}>
                          {it.label}
                        </span>
                        {it.text && (
                          <span
                            className="mt-1 line-clamp-2 text-[14px] leading-snug opacity-90"
                            style={{ color: t.textColor }}
                          >
                            {it.text}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {slide.note && <NoteStrip note={slide.note} t={t} />}
              </div>
            ) : slide.layout === "steps" ? (
              <div className="flex h-full w-full flex-col px-14 pb-14 pt-12">
                <TitleBlock title={slide.title} t={t} />
                {st.card === "bare" || st.card === "flat" ? (
                  // 简约白/杂志:竖排编号步骤清单
                  <div className="flex min-h-0 flex-1 flex-col justify-center">
                    {slide.items!.map((it, k) => {
                      const tone = t.tones[it.tone ?? "a"];
                      return (
                        <div key={k} className="flex items-baseline gap-7 py-3.5" style={{ borderTop: k ? `1px solid ${t.cardBorder}` : undefined }}>
                          <span className={cn("num-display shrink-0 font-extrabold leading-none", st.card === "flat" ? "w-[66px] text-[44px]" : "w-[52px] text-[30px]")} style={{ color: tone.fg, fontFamily: st.fontHead }}>
                            {String(k + 1).padStart(2, "0")}
                          </span>
                          <div className="min-w-0">
                            <span className="text-[23px] font-bold leading-tight" style={{ color: cardLabelColor(t), fontFamily: st.fontHead }}>{it.label}</span>
                            {it.text && <p className="mt-1 text-[16px] leading-relaxed" style={{ color: t.textColor }}>{it.text}</p>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 items-center gap-3">
                    <div className="flex w-full items-stretch gap-3">
                    {slide.items!.map((it, k) => {
                      const tone = t.tones[it.tone ?? "a"];
                      const edge = st.accentEdge;
                      return (
                        <Fragment key={k}>
                          <div
                            className={cn("relative flex min-w-0 flex-1 flex-col items-center overflow-hidden rounded-2xl border pb-8 pt-8 text-center", edge === "left" ? "pl-6 pr-4" : "px-4")}
                            style={{ background: t.cardBg, borderColor: t.cardBorder, boxShadow: st.card === "outline" ? "none" : "0 2px 14px rgba(15,18,35,0.05)" }}
                          >
                            {edge === "left" ? (
                              <span className="absolute inset-y-0 left-0 w-[5px]" style={{ background: tone.fg }} />
                            ) : edge !== "none" ? (
                              <span className={cn("absolute inset-x-0 h-[5px]", edge === "top" ? "top-0" : "bottom-0")} style={{ background: tone.fg }} />
                            ) : null}
                            <span
                              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-2 text-[26px] font-bold"
                              style={{ borderColor: tone.fg, color: tone.fg, background: tone.soft }}
                            >
                              {k + 1}
                            </span>
                            <span className="mt-4 text-[21px] font-bold leading-tight" style={{ color: cardLabelColor(t) }}>
                              {it.label}
                            </span>
                            {it.text && (
                              <span className="mt-2 line-clamp-4 text-[14.5px] leading-relaxed opacity-90" style={{ color: t.textColor }}>
                                {it.text}
                              </span>
                            )}
                          </div>
                          {k < slide.items!.length - 1 && (
                            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={t.metaColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 self-center" aria-hidden>
                              <path d="M5 12h14" />
                              <path d="m13 6 6 6-6 6" />
                            </svg>
                          )}
                        </Fragment>
                      );
                    })}
                    </div>
                  </div>
                )}
                {slide.note && <NoteStrip note={slide.note} t={t} />}
              </div>
            ) : slide.layout === "timeline" ? (
              <div className="flex h-full w-full flex-col px-20 pb-14 pt-12">
                <TitleBlock title={slide.title} t={t} />
                <div className="mx-auto flex min-h-0 w-full max-w-[1000px] flex-1 flex-col justify-center">
                  <div className="relative space-y-8">
                    <span className="absolute bottom-3 left-[185px] top-3 w-[2px]" style={{ background: t.cardBorder }} />
                    {slide.items!.map((it, k) => {
                      const tone = t.tones[it.tone ?? "a"];
                      return (
                        <div key={k} className="flex items-start gap-6">
                          <span className="w-[152px] shrink-0 pt-0.5 text-right text-[19px] font-bold leading-snug" style={{ color: tone.fg }}>
                            {it.label}
                          </span>
                          <span
                            className="relative z-10 mt-1.5 h-4 w-4 shrink-0 rounded-full border-[3px]"
                            style={{ borderColor: tone.fg, background: t.cardBg }}
                          />
                          <span className="min-w-0 text-[18px] leading-relaxed" style={{ color: t.textColor }}>
                            {it.text}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {slide.note && <NoteStrip note={slide.note} t={t} />}
              </div>
            ) : slide.layout === "stats" ? (
              <div className="flex h-full w-full flex-col px-16 pb-14 pt-12">
                <TitleBlock title={slide.title} t={t} />
                {st.card === "bare" || st.card === "flat" ? (
                  // 简约白/杂志:大数清单(无卡,细线分隔)
                  <div className="flex min-h-0 flex-1 flex-col justify-center">
                    {slide.stats!.map((s, i) => {
                      const tone = t.tones[s.tone ?? "a"];
                      return (
                        <div key={i} className="flex items-baseline gap-8 py-5" style={{ borderTop: i ? `1px solid ${t.cardBorder}` : undefined }}>
                          <span className="num-display w-[210px] shrink-0 font-extrabold leading-none" style={{ color: tone.fg, fontFamily: st.fontHead, fontSize: 54 }}>
                            {s.value}
                          </span>
                          <div className="min-w-0 pt-1">
                            <span className="text-[22px] font-bold" style={{ color: cardLabelColor(t), fontFamily: st.fontHead }}>{s.label}</span>
                            {s.text && <p className="mt-1 text-[15.5px] leading-relaxed" style={{ color: t.textColor }}>{s.text}</p>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div
                    className={cn(
                      "grid min-h-0 flex-1 content-center gap-6",
                      slide.stats!.length === 2 ? "mx-40 grid-cols-2" : slide.stats!.length === 3 ? "mx-10 grid-cols-3" : "grid-cols-4"
                    )}
                  >
                    {slide.stats!.map((s, i) => {
                      const tone = t.tones[s.tone ?? "a"];
                      const edge = st.accentEdge;
                      return (
                        <div
                          key={i}
                          className={cn("relative flex flex-col items-center justify-center overflow-hidden rounded-2xl border py-12 text-center", edge === "left" ? "pl-6 pr-5" : "px-5")}
                          style={{ background: t.cardBg, borderColor: t.cardBorder, boxShadow: st.card === "outline" ? "none" : "0 2px 14px rgba(15,18,35,0.05)" }}
                        >
                          {edge === "left" ? (
                            <span className="absolute inset-y-0 left-0 w-[5px]" style={{ background: tone.fg }} />
                          ) : edge !== "none" ? (
                            <span className={cn("absolute inset-x-0 h-[5px]", edge === "top" ? "top-0" : "bottom-0")} style={{ background: tone.fg }} />
                          ) : null}
                          <span className="num-display text-[64px] font-extrabold leading-none" style={{ color: tone.fg }}>
                            {s.value}
                          </span>
                          <span className="mt-4 text-[19px] font-semibold" style={{ color: cardLabelColor(t) }}>
                            {s.label}
                          </span>
                          {s.text && (
                            <span className="mt-1.5 text-[14px] leading-snug opacity-85" style={{ color: t.textColor }}>
                              {s.text}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {slide.note && <NoteStrip note={slide.note} t={t} />}
              </div>
            ) : slide.layout === "chart" ? (
              <div className="flex h-full w-full flex-col px-16 pb-14 pt-12">
                <TitleBlock title={slide.title} t={t} />
                <div className="min-h-0 flex-1">
                  <MiniChart chart={slide.chart!} t={t} />
                </div>
                {slide.note && <NoteStrip note={slide.note} t={t} />}
              </div>
            ) : slide.layout === "quote" ? (
              <div className="relative flex h-full w-full flex-col items-center justify-center px-28 text-center">
                {/* 背景大引号 */}
                <span
                  className="pointer-events-none absolute left-1/2 top-[6%] -translate-x-1/2 font-serif text-[260px] leading-none"
                  style={{ color: t.accent, opacity: 0.08 }}
                  aria-hidden
                >
                  “
                </span>
                {slide.title && (
                  <span
                    className="mb-9 rounded-full px-5 py-2 text-[16px] font-bold"
                    style={{ background: t.tones.a.soft, color: t.tones.a.fg }}
                  >
                    {slide.title}
                  </span>
                )}
                <p
                  className="max-w-[88%] text-balance text-[38px] font-bold leading-[1.5] cjk-display"
                  style={{ color: t.titleColor }}
                >
                  {slide.quote}
                </p>
                {slide.attribution && (
                  <div className="mt-10 flex items-center gap-3">
                    <span className="h-[2px] w-8" style={{ background: t.accent }} />
                    <p className="text-[17px]" style={{ color: t.metaColor }}>
                      {slide.attribution}
                    </p>
                  </div>
                )}
              </div>
            ) : slide.layout === "cards" ? (
              <div className="flex h-full w-full flex-col px-14 pb-14 pt-12">
                <TitleBlock title={slide.title} t={t} />
                {st.card === "bare" || st.card === "flat" ? (
                  // 简约白 / 杂志暖刊:无卡,行式清单(巨号 + 标签 + 说明 + 细线分隔)
                  <div className="flex min-h-0 flex-1 flex-col justify-center">
                    {slide.cards!.map((c, ci) => {
                      const tone = t.tones[c.tone ?? "a"];
                      return (
                        <div
                          key={ci}
                          className="flex items-baseline gap-7 py-4"
                          style={{ borderTop: ci ? `1px solid ${t.cardBorder}` : undefined }}
                        >
                          <span
                            className={cn("num-display shrink-0 font-extrabold leading-none", st.card === "flat" ? "w-[66px] text-[48px]" : "w-[50px] text-[31px]")}
                            style={{ color: tone.fg, fontFamily: st.fontHead }}
                          >
                            {String(ci + 1).padStart(2, "0")}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-baseline gap-3">
                              <span className="text-[25px] font-bold leading-tight" style={{ color: cardLabelColor(t), fontFamily: st.fontHead }}>
                                {c.label}
                              </span>
                              {c.sub && <span className="text-[15px] font-semibold" style={{ color: tone.fg }}>{c.sub}</span>}
                            </div>
                            {c.text && <p className="mt-1.5 text-[16px] leading-relaxed" style={{ color: t.textColor }}>{c.text}</p>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  // 深空玻璃 / 极光磨砂 / 墨绿描边:卡片网格(强调边位置随模版)
                  <div
                    className={cn(
                      "grid min-h-0 flex-1 content-center gap-7",
                      (slide.cards?.length ?? 0) === 2 ? "mx-36 grid-cols-2" : (slide.cards?.length ?? 0) === 3 ? "grid-cols-3" : "grid-cols-4"
                    )}
                  >
                    {slide.cards!.map((c, ci) => {
                      const tone = t.tones[c.tone ?? "a"];
                      const edge = st.accentEdge;
                      return (
                        <div
                          key={ci}
                          className={cn(
                            "relative flex min-h-0 flex-col items-center overflow-hidden rounded-2xl border pb-9 pt-9 text-center",
                            edge === "left" ? "pl-9 pr-6" : "px-6"
                          )}
                          style={{ background: t.cardBg, borderColor: t.cardBorder, boxShadow: st.card === "outline" ? "none" : "0 2px 14px rgba(15,18,35,0.05)" }}
                        >
                          {edge === "left" ? (
                            <span className="absolute inset-y-0 left-0 w-[5px]" style={{ background: tone.fg }} />
                          ) : edge !== "none" ? (
                            <span className={cn("absolute inset-x-0 h-[5px]", edge === "top" ? "top-0" : "bottom-0")} style={{ background: tone.fg }} />
                          ) : null}
                          <span
                            className="flex h-[84px] w-[84px] shrink-0 items-center justify-center rounded-full border-2"
                            style={{ borderColor: tone.fg, color: tone.fg, background: tone.soft }}
                          >
                            <DeckIcon name={c.icon} size={36} />
                          </span>
                          <span className="mt-5 text-[24px] font-bold leading-tight" style={{ color: cardLabelColor(t) }}>
                            {c.label}
                          </span>
                          {c.sub && <span className="mt-1 text-[16px] font-semibold" style={{ color: tone.fg }}>{c.sub}</span>}
                          {c.text && <p className="mt-3 text-[15px] leading-relaxed opacity-90" style={{ color: t.textColor }}>{c.text}</p>}
                        </div>
                      );
                    })}
                  </div>
                )}
                {slide.note && <NoteStrip note={slide.note} t={t} />}
              </div>
            ) : slide.layout === "compare" ? (
              <div className="flex h-full w-full flex-col px-16 pb-14 pt-12">
                <TitleBlock title={slide.title} t={t} />
                <div className="relative grid min-h-0 flex-1 grid-cols-2 gap-9">
                  {[slide.left!, slide.right!].map((side, si) => {
                    const tone = si === 0 ? t.tones.a : t.tones.b;
                    return (
                      <div
                        key={si}
                        className="flex min-h-0 flex-col overflow-hidden rounded-2xl border"
                        style={{
                          background: t.cardBg,
                          borderColor: t.cardBorder,
                          boxShadow: "0 2px 14px rgba(15,18,35,0.05)",
                        }}
                      >
                        {/* 色块横幅头 */}
                        <div
                          className="flex shrink-0 items-center justify-center px-7 py-3.5 text-[21px] font-bold"
                          style={{ background: tone.fg, color: onToneColor(t) }}
                        >
                          {side.label}
                        </div>
                        {slide.rows?.length ? (
                          // 维度对齐表(两栏同序,中央 ⚡ 分隔)
                          <div className="min-h-0 flex-1 overflow-y-auto px-7 py-3">
                            {slide.rows.map((r, ri) => (
                              <div
                                key={ri}
                                className="flex items-baseline gap-4 py-3.5"
                                style={{ borderTop: ri ? `1px solid ${t.cardBorder}` : undefined }}
                              >
                                <span
                                  className="w-[88px] shrink-0 text-[14.5px] font-medium"
                                  style={{ color: t.metaColor }}
                                >
                                  {r.dim}
                                </span>
                                <span className="text-[17px] leading-snug" style={{ color: t.textColor }}>
                                  {si === 0 ? r.left : r.right}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <ul className="min-h-0 flex-1 space-y-4 overflow-y-auto px-7 py-5">
                            {side.points.map((p, pi) => (
                              <li
                                key={pi}
                                className="flex gap-3 text-[17px] leading-relaxed"
                                style={{ color: t.textColor }}
                              >
                                <span
                                  className="mt-[11px] h-1.5 w-1.5 shrink-0 rounded-full"
                                  style={{ background: tone.fg }}
                                />
                                <span>{p}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                  <span
                    className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 shadow-sm"
                    style={{ background: t.cardBg, borderColor: t.cardBorder, color: t.accent, backdropFilter: "blur(6px)" }}
                  >
                    <DeckIcon name="bolt" size={24} />
                  </span>
                </div>
                {slide.note && <NoteStrip note={slide.note} t={t} />}
              </div>
            ) : (
              <div className="flex h-full w-full flex-col px-20 pb-14 pt-14">
                {st.card !== "bare" && st.card !== "flat" && (
                  <div className="absolute left-0 top-0 h-2 w-full" style={{ background: t.accent }} />
                )}
                {slide.layout === "takeaways" && (
                  <span
                    className="mb-4 w-fit rounded-full px-4 py-1.5 text-[15px] font-semibold"
                    style={{ background: t.accent, color: t.onAccent }}
                  >
                    要点回顾
                  </span>
                )}
                <h3
                  className={cn("mb-9 text-[34px] font-bold", slide.layout !== "takeaways" && "mt-1")}
                  style={{ color: t.titleColor, fontFamily: st.fontHead }}
                >
                  {slide.title}
                </h3>
                <ul
                  className={cn(
                    "min-h-0 flex-1 overflow-y-auto",
                    slide.layout === "bullets" && (slide.bullets?.length ?? 0) >= 5
                      ? "grid grid-cols-2 content-start gap-x-14 gap-y-5"
                      : "space-y-5"
                  )}
                >
                  {(slide.bullets ?? []).map((b, bi) => (
                    <li
                      key={bi}
                      className="flex gap-4 text-[20px] leading-relaxed"
                      style={{ color: t.textColor }}
                    >
                      {slide.layout === "takeaways" ? (
                        <span
                          className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[14px] font-bold"
                          style={{ background: t.accent, color: t.onAccent }}
                        >
                          {bi + 1}
                        </span>
                      ) : st.marker === "dash" ? (
                        <span className="mt-[15px] h-[3px] w-3.5 shrink-0 rounded-full" style={{ background: t.accent }} />
                      ) : st.marker === "bar" ? (
                        <span className="mt-[7px] h-4 w-[3px] shrink-0 rounded-sm" style={{ background: t.accent }} />
                      ) : st.marker === "check" ? (
                        <svg className="mt-[3px] shrink-0" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={t.accent} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      ) : (
                        <span className="mt-[13px] h-2 w-2 shrink-0 rounded-full" style={{ background: t.accent }} />
                      )}
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                {slide.note && <NoteStrip note={slide.note} t={t} />}
              </div>
            )}
            <span
              className="absolute bottom-5 right-8 text-[15px] tabular-nums"
              style={{ color: t.metaColor }}
            >
              {(playing ? i : mi) + 1} / {total}
            </span>
            </SlideStage>
            </div>
            ))}
            {playing && (
              <>
                <button
                  onClick={() => setPlaying(false)}
                  aria-label="退出放映"
                  className="fixed right-6 top-6 z-[71] rounded-full bg-white/10 px-4 py-2 text-sm text-white/90 backdrop-blur transition hover:bg-white/20"
                >
                  退出
                </button>
                <button
                  onClick={() => go(-1)}
                  disabled={i === 0}
                  aria-label="上一页"
                  className="fixed left-5 top-1/2 z-[71] -translate-y-1/2 rounded-full bg-white/10 p-2.5 text-white/80 backdrop-blur transition hover:bg-white/20 disabled:opacity-25"
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="m15 6-6 6 6 6" /></svg>
                </button>
                <button
                  onClick={() => go(1)}
                  disabled={i === total - 1}
                  aria-label="下一页"
                  className="fixed right-5 top-1/2 z-[71] -translate-y-1/2 rounded-full bg-white/10 p-2.5 text-white/80 backdrop-blur transition hover:bg-white/20 disabled:opacity-25"
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                </button>
                <span className="fixed bottom-6 left-1/2 z-[71] -translate-x-1/2 text-[13px] text-white/55">
                  {i + 1} / {total} · ← → 翻页 · Esc 退出
                </span>
              </>
            )}
          </div>
          {!playing && (
            // 窄屏隐藏 120px 缩略图侧栏(否则画布只剩 ~200px 宽);主区已是全片纵向滚动可浏览
            <div className="hidden min-h-0 w-[120px] shrink-0 flex-col gap-2 overflow-y-auto pr-0.5 lg:flex">
              {slides.map((s, si) => (
                <button
                  key={si}
                  onClick={() => {
                    setI(si);
                    document.getElementById(`sld-${output.id}-${si}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                  }}
                  title={s.title}
                  className={cn(
                    "relative aspect-video w-full shrink-0 overflow-hidden rounded-md border transition",
                    si === i
                      ? "border-accent ring-2 ring-accent/30"
                      : "border-edge opacity-75 hover:opacity-100"
                  )}
                  style={{ background: t.bg }}
                >
                  <span className="absolute left-0 top-0 h-[2px] w-full" style={{ background: t.accent }} />
                  <span
                    className="absolute inset-x-1.5 top-2 line-clamp-3 text-left text-[8px] font-semibold leading-[1.3]"
                    style={{ color: t.titleColor }}
                  >
                    {s.title}
                  </span>
                  <span className="absolute bottom-1 right-1.5 text-[8px]" style={{ color: t.metaColor }}>
                    {si + 1}
                  </span>
                </button>
              ))}
            </div>
          )}
          </div>

        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// note editor
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 画板(Excalidraw)查看器 —— 一等公民制品。content 是服务端产出的 { mermaid }
// 信封;首次打开时在客户端把 Mermaid 转成真正的 Excalidraw 场景
// ({elements,appState,files})并回写 content,后续打开即纯加载、下载得到真场景;
// 手绘编辑在关闭时自动保存。复用 Modal/ViewerActions + 编辑器同款 ExcalidrawCanvas。
// ---------------------------------------------------------------------------
const ExcalidrawCanvasView = dynamic(() => import("./editor-nodes/ExcalidrawCanvas"), { ssr: false });

type BoardScene = { elements: unknown[]; appState: Record<string, unknown>; files: Record<string, unknown> | null };
type BoardApi = {
  getSceneElements: () => unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
  scrollToContent?: (target?: unknown, opts?: { fitToViewport?: boolean; viewportZoomFactor?: number; animate?: boolean }) => void;
  updateScene?: (data: { appState?: Record<string, unknown> }) => void;
  /** 重新测量容器尺寸进 appState —— 容器被程序化改宽(展开弹窗)后 Excalidraw
   *  不自动感知,不先 refresh 的话 scrollToContent 会按旧宽度算 zoom(实测踩过)。 */
  refresh?: () => void;
};

/** 归一化节点标签做匹配(去空白 + 小写),容忍 Mermaid 标签与画布文本的细微差异。 */
const normLabel = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** 画板「文档态 appState」白名单:elements/files 之外,只有背景色算文档的一部分。
 *  getAppState() 的其余 80+ 键(activeTool、isLoading、openDialog、selected…、
 *  editing…、width/height、scroll、zoom 等)全是会话状态 —— 持久化再回放 = 把关闭
 *  瞬间的 UI 状态冷冻复活,症状随机(抓手提示/选中态/空视口)。存端读端统一走这里。 */
function sceneAppState(raw: unknown): { viewBackgroundColor: string } {
  const bg = (raw as Record<string, unknown> | null | undefined)?.viewBackgroundColor;
  return { viewBackgroundColor: typeof bg === "string" && bg ? bg : "#ffffff" };
}

/** 场景里是否有可编辑形状(矩形/椭圆/菱形/文本)。只有图片 / 空 = 失效场景
 *  (旧版 mindmap/subgraph 退化成的空白图片),应提示重新生成而非给空白画布。 */
function hasEditableShapes(elements: unknown[]): boolean {
  return (elements as Array<Record<string, unknown>>).some(
    (e) => e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond" || e.type === "text"
  );
}

/** 清洗 Mermaid:剥掉 mermaid-to-excalidraw 解析器会崩溃/不支持的指令
 *  (subgraph/end、style/classDef/class/click/linkStyle),把 subgraph 扁平化成普通节点。
 *  覆盖新生成 + 已存的旧 mermaid,避免「SubGraph element not found」之类的转换崩溃。 */
function sanitizeMermaid(src: string): string {
  // Mermaid 里节点端点必须是「ID」或「ID[label]」;一个**裸引号字符串**当端点是非法语法。
  // 模型偶尔把「来源归属」写成 `A -.->|Source| "农视网"`(目标是裸字符串而非节点 ID),
  // 会让 parseMermaidToExcalidraw 直接抛异常 → 整个画板转换失败(报「无法转换为画板」)。
  // 来源归属本应走 content 里的 nodeSources JSON(见 lib/excalidraw.ts),故这类非法边
  // 删掉无损。EDGE 覆盖 --> / -.-> / ==> / --x / --o / --- 等常见连线。
  const EDGE = "[-.=]{2,}[>ox]?";
  const badTail = new RegExp(`${EDGE}\\s*(?:\\|[^|]*\\|)?\\s*"[^"]*"\\s*$`); // X --> "裸串"
  const badHead = new RegExp(`^\\s*"[^"]*"\\s*(?:\\|[^|]*\\|)?\\s*${EDGE}`); // "裸串" --> X
  const cleaned = src
    .split("\n")
    .filter((ln) => {
      const t = ln.trim();
      // Mermaid init/config directives can mutate parser configuration and CSS;
      // generated boards never need them, so fail closed before the vulnerable parser sees them.
      if (/^%%/.test(t)) return false;
      if (/^subgraph\b/i.test(t) || t.toLowerCase() === "end") return false;
      if (/^(style|classDef|class|click|linkStyle|direction)\b/i.test(t)) return false;
      if (badTail.test(t) || badHead.test(t)) return false; // 剔除裸引号端点的非法边
      return true;
    })
    // 标签体内的英文引号/括号是 Mermaid 语法炸弹(LLM 会从语料把绰号引号原样搬进来:
    // N9[德国7:1"桑巴惨案"] → 解析直接抛异常 → 整板「无法转换」)。替换成全角等价
    // 字符,视觉无损、语法安全。救存量坏板 + 兜底新生成。
    .map((ln) => {
      const safeLabel = (body: string) => body
        .replace(/&/g, "＆")
        .replace(/</g, "＜")
        .replace(/>/g, "＞")
        .replace(/"/g, "”")
        .replace(/'/g, "’")
        .replace(/`/g, "｀");
      return ln
        .replace(/\[([^\]]*)\]/g, (_m, body: string) => `[${safeLabel(body)}]`)
        .replace(/\|([^|]*)\|/g, (_m, body: string) => `|${safeLabel(body)}|`);
    })
    .join("\n")
    .trim();
  // 残尾修剪:LLM 撞 max_tokens 会在任意位置硬截断(实锤案例:末行 `N118 --> N132[`,
  // 未闭合的 [ 让 parseMermaidToExcalidraw 抛异常 → 整板「无法转换」)。救活存量截断板。
  return dropBrokenMermaidTail(cleaned);
}

/** 从尾部剔除「不完整」的行(括号不配对 / 边标签 | 不成对 / 以悬空箭头结尾),直到
 *  遇到完整行为止。只修尾部 —— 中间的行不动,避免误伤正文。 */
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

/** 选中节点文本 → 它归属的来源(经 nodeSources 的来源标题 + 笔记本来源列表解析)。 */
function lookupBoardSource(
  text: string,
  nodeSources: Record<string, string>,
  sources?: Source[]
): { label: string; source: Source } | null {
  const n = normLabel(text);
  for (const [label, title] of Object.entries(nodeSources)) {
    if (normLabel(label) !== n) continue;
    const src =
      sources?.find((s) => s.title === title) ??
      sources?.find((s) => normLabel(s.title) === normLabel(title));
    return src ? { label, source: src } : null;
  }
  return null;
}

/** 给 Excalidraw 导出的 SVG 注入对角平铺「猿笔记」水印(免费档)。按 viewBox 坐标系铺 <text>,
 *  和 PNG/画布水印同款观感;水印只进导出的 SVG,不动编辑场景。 */
function injectSvgWatermark(svg: SVGSVGElement) {
  const NS = "http://www.w3.org/2000/svg";
  const vb = (svg.getAttribute("viewBox") || "").split(/\s+/).map(Number);
  const [x0, y0, w, h] =
    vb.length === 4 && vb.every((n) => Number.isFinite(n))
      ? vb
      : [0, 0, parseFloat(svg.getAttribute("width") || "0") || 0, parseFloat(svg.getAttribute("height") || "0") || 0];
  if (!w || !h) return;
  const g = document.createElementNS(NS, "g");
  g.setAttribute("opacity", "0.13");
  g.setAttribute("aria-hidden", "true");
  const fs = Math.max(16, Math.round(Math.min(w, h) / 16));
  const stepX = fs * 6.5;
  const stepY = fs * 4.5;
  let row = 0;
  for (let y = y0; y < y0 + h + stepY; y += stepY, row++) {
    const off = row % 2 ? stepX / 2 : 0;
    for (let x = x0 - stepX; x < x0 + w + stepX; x += stepX) {
      const cx = x + off;
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(cx));
      t.setAttribute("y", String(y));
      t.setAttribute("fill", "#8a8a8a");
      t.setAttribute("font-size", String(fs));
      t.setAttribute("font-weight", "800");
      t.setAttribute("font-family", "PingFang SC, Microsoft YaHei, sans-serif");
      t.setAttribute("transform", `rotate(-26 ${cx} ${y})`);
      t.textContent = "猿笔记";
      g.appendChild(t);
    }
  }
  svg.appendChild(g);
}

export function ExcalidrawView({
  output,
  onClose,
  onDelete,
  onSaved,
  onShareNotebook,
  sources,
  onOpenSource,
  watermark,
}: {
  output: StudioOutput;
  onClose: () => void;
  onDelete?: () => void;
  /** Promote the { mermaid } envelope → a real scene (and persist edits) in the host. */
  onSaved?: (content: string) => void;
  onShareNotebook?: () => void;
  /** Notebook sources, to resolve a node's attributed 来源标题 → a real source. */
  sources?: Source[];
  /** Open the source viewer when a cited node is selected (来源驱动差异点). */
  onOpenSource?: (s: Source) => void;
  watermark?: boolean;
}) {
  const [title, setTitle] = useState(output.title);
  const [scene, setScene] = useState<BoardScene | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const apiRef = useRef<BoardApi | null>(null);
  // 本查看器的画板宿主:fit 时在它内部找 .excalidraw,不用全局 querySelector
  //(页面可能同时存在笔记内嵌画板等第二个实例,全局查会量错容器)。
  const boardHostRef = useRef<HTMLDivElement>(null);
  // 最新的 fitBoard(在 excalidrawAPI 回调闭包里定义,挂到 ref 供容器尺寸监听调用)。
  const fitRef = useRef<() => void>(() => {});
  // 容器尺寸显著变化(点 header 的「展开/收起」、拖窗口等)→ 自动重新 fit 填充新视口。
  // 阈值 12%:展开/收起是 30%+ 的跳变必触发;微小抖动不触发,避免打断用户手动缩放。
  // 注:ResizeObserver 在后台标签页会被暂停(预览环境验证不了),真实前台正常。
  useEffect(() => {
    if (!scene) return;
    const host = boardHostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    let last = { w: host.clientWidth, h: host.clientHeight };
    let t: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth, h = host.clientHeight;
      if (w < 50 || h < 50) return;
      const dw = Math.abs(w - last.w) / Math.max(last.w, 1);
      const dh = Math.abs(h - last.h) / Math.max(last.h, 1);
      if (dw < 0.12 && dh < 0.12) return;
      last = { w, h };
      if (t) clearTimeout(t);
      t = setTimeout(() => fitRef.current(), 180); // 等展开动画结束、尺寸稳定再 fit
    });
    ro.observe(host);
    return () => { ro.disconnect(); if (t) clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!scene]);
  // 节点标签 → 来源标题(原样保留,用于回写持久化);点节点回溯原文用。
  const nodeSrcRef = useRef<Record<string, string>>({});
  const sourceMermaidRef = useRef("");
  const layoutVersionRef = useRef<number | null>(null);
  const [cited, setCited] = useState<{ label: string; source: Source } | null>(null);
  const citedKeyRef = useRef<string>("");

  // First open: detect { mermaid } envelope vs an already-converted scene.
  // Convert mermaid → Excalidraw client-side (needs the DOM), then PATCH the
  // scene back so subsequent opens are a pure load.
  useEffect(() => {
    let alive = true;
    (async () => {
      let parsed: { mermaid?: string; sourceMermaid?: string; layoutVersion?: number; nodeSources?: Record<string, string>; elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> } = {};
      try { parsed = JSON.parse(output.content || "{}"); } catch {}
      nodeSrcRef.current = parsed.nodeSources && typeof parsed.nodeSources === "object" ? parsed.nodeSources : {};
      sourceMermaidRef.current = typeof parsed.sourceMermaid === "string" ? parsed.sourceMermaid : typeof parsed.mermaid === "string" ? parsed.mermaid : "";
      layoutVersionRef.current = typeof parsed.layoutVersion === "number" ? parsed.layoutVersion : null;
      if (Array.isArray(parsed.elements)) {
        // 已是转换好的场景:但旧版本可能持久化了「空白图片」场景(mindmap/subgraph 退化),
        // 没有可编辑形状就提示重新生成,而不是加载一张空白图。
        if (!hasEditableShapes(parsed.elements)) {
          if (alive) setErr("该画板是旧版本生成的、内容已失效,请删除后重新生成。");
          return;
        }
        // 【第一性原理:白名单,不是黑名单】旧 saveScene 曾把 getAppState() 的全部 85+ 键
        // 腌进 DB —— 那是「会话状态」(activeTool/isLoading/openDialog/selectedElementIds/
        // editing*/width/height/scrolledOutside…),不是文档状态。原样回放的症状随关闭瞬间
        // 的状态而变:抓手工具被回放 → 中央出现「要移动画布…」提示;选中/编辑态复现;
        // 别的窗口尺寸顶掉本次布局 —— 这就是「时好时坏、过段时间又正常」的根源。
        // 文档状态只有 elements + files + 背景色;其余一律丢弃(也顺带治好存量污染行)。
        // 已保存的旧场景可能包含用户手工配色/线宽，打开查看时绝不能静默覆盖。
        // 新布局只用于重新生成的画板；旧场景保持原样，用户数据优先。
        if (alive) setScene({ elements: parsed.elements, appState: sceneAppState(parsed.appState), files: parsed.files ?? null });
        return;
      }
      const mermaid = typeof parsed.mermaid === "string" ? parsed.mermaid : "";
      if (!mermaid) { if (alive) setErr("画板内容为空,请重新生成。"); return; }
      try {
        const [m2e, exc] = await Promise.all([
          import("@excalidraw/mermaid-to-excalidraw"),
          import("@excalidraw/excalidraw"),
        ]);
        const cleanMermaid = sanitizeMermaid(mermaid);
        const { elements: skeleton, files } = await m2e.parseMermaidToExcalidraw(cleanMermaid, { themeVariables: { fontSize: "20px" } });
        // skeleton → full elements (REQUIRED; cast across the two package entry points).
        const elements = beautifyGeneratedExcalidrawElements(
          (exc.convertToExcalidrawElements as (s: unknown) => unknown[])(skeleton)
        );
        // mindmap / 不受支持的类型会被 mermaid-to-excalidraw 退化成「单张 SVG 图片」
        // (不可编辑、常空白)。检测到没有任何可编辑形状就明确报错,而不是给空白画布。
        if (!hasEditableShapes(elements)) {
          if (alive) setErr("该图示类型暂不支持转为可编辑画板,请重新生成(会用流程图)。");
          return;
        }
        const next: BoardScene = { elements, appState: { viewBackgroundColor: "#ffffff" }, files: (files as Record<string, unknown>) ?? null };
        if (!alive) return;
        sourceMermaidRef.current = cleanMermaid;
        layoutVersionRef.current = 2;
        setScene(next);
        const json = JSON.stringify({
          ...next,
          nodeSources: nodeSrcRef.current,
          sourceMermaid: cleanMermaid,
          layoutVersion: 2,
        });
        fetch(`/api/studio/${output.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: json }),
        }).catch(() => {});
        onSaved?.(json);
      } catch {
        if (alive) setErr("无法将图示转换为画板,请重试或重新生成。");
      }
    })();
    return () => { alive = false; };
  }, [output.id, output.content, onSaved]);

  // Auto-save manual edits on close (like the other editable viewers); strips
  // the non-serializable collaborators map, same shape as ExcalidrawNode.
  const saveScene = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    try {
      const elements = api.getSceneElements();
      // NEVER persist an empty scene. getSceneElements() can momentarily return
      // [] while Excalidraw is tearing down (this component saves on BOTH close
      // and unmount) — a fresh save then WIPES the real drawing, which is exactly
      // how boards ended up stored as {elements:[]} and reopened as
      // 「内容已失效」. A blank board never needs saving anyway.
      if (!elements || elements.length === 0) return;
      // 白名单收口(见 sceneAppState):文档态只有背景色。此前黑名单只剥
      // collaborators + scroll/zoom,把 activeTool/isLoading/openDialog 等 80+ 个
      // 会话键全部腌进 DB,下次打开被回放 → 「时好时坏」。
      const appState = sceneAppState(api.getAppState());
      const files = api.getFiles();
      const json = JSON.stringify({
        elements,
        appState,
        files,
        nodeSources: nodeSrcRef.current,
        ...(sourceMermaidRef.current ? { sourceMermaid: sourceMermaidRef.current } : {}),
        ...(layoutVersionRef.current ? { layoutVersion: layoutVersionRef.current } : {}),
      });
      if (json === output.content) return;
      fetch(`/api/studio/${output.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: json }),
      }).catch(() => {});
      onSaved?.(json);
    } catch {}
  }, [output.id, output.content, onSaved]);

  const handleClose = useCallback(() => { saveScene(); onClose(); }, [saveScene, onClose]);
  // 审查修复:unmount 兜底保存(对齐 NoteEditor/DocViewer 的自动保存范式)。
  // 此前只有点「关闭」才保存,点「分享」或切换笔记本直接卸载会丢掉本次全部手动编辑。
  const saveSceneRef = useRef(saveScene);
  saveSceneRef.current = saveScene;
  useEffect(() => () => { saveSceneRef.current(); }, []);
  // 底部「导出图片」:付费档打开 Excalidraw 自带对话框(PNG/SVG/复制 + 缩放/背景高级项);
  // 免费档改开自建小菜单,三种格式(PNG/SVG/复制)导出时都叠加「猿笔记」水印 —— 水印只进
  // 导出产物、不碰编辑画布(exportToBlob/exportToSvg 快照当前场景后再加水印)。库对话框内部
  // 导出无法拦截,故免费档不用它。
  const [wmMenu, setWmMenu] = useState(false);
  const [wmBusy, setWmBusy] = useState(false);
  const openExport = useCallback(() => {
    // 所有档位统一走可控导出：品牌水印可按权益去除，风险提示不可去除。
    setWmMenu(true);
  }, []);
  const wmExportOpts = useCallback(() => {
    const api = apiRef.current!;
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      elements: (api.getSceneElements?.() ?? []) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      appState: { ...(api.getAppState?.() ?? {}), exportBackground: true, exportScale: 2 } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      files: (api.getFiles?.() ?? null) as any,
    };
  }, []);
  const wmFileBase = () => (title || "画板").replace(/[\\/:*?"<>|]+/g, "_");
  const wmDownload = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const wmExport = useCallback(
    async (kind: "png" | "svg" | "copy") => {
      const api = apiRef.current;
      const els = api?.getSceneElements?.() ?? [];
      if (!api || !Array.isArray(els) || !els.length) {
        toast("画板为空,无法导出", "error");
        setWmMenu(false);
        return;
      }
      setWmBusy(true);
      try {
        const mod = await import("@excalidraw/excalidraw");
        if (kind === "svg") {
          const svg = await mod.exportToSvg(wmExportOpts());
          if (outputWatermark(output, watermark)) injectSvgWatermark(svg);
          const str = new XMLSerializer().serializeToString(svg);
          wmDownload(new Blob([str], { type: "image/svg+xml" }), `${wmFileBase()}.svg`);
        } else {
          const blob = await mod.exportToBlob({ ...wmExportOpts(), mimeType: "image/png" });
          const branded = outputWatermark(output, watermark) ? await stampImageWatermark(blob) : blob;
          if (kind === "png") {
            wmDownload(branded, `${wmFileBase()}.png`);
          } else {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": branded })]);
            toast("已复制到剪贴板", "success");
          }
        }
        setWmMenu(false);
      } catch (e) {
        console.warn("[excalidraw] 水印导出失败:", (e as Error).message);
        toast(kind === "copy" ? "复制失败,请重试" : "导出失败,请重试", "error");
      } finally {
        setWmBusy(false);
      }
    },
    [wmExportOpts, output, title, watermark]
  );

  return (
    <Modal
      title={
        <input
          name="title"
          autoComplete="off"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            const v = title.trim();
            if (v && v !== output.title) {
              // 审查修复:此前 fire-and-forget,失败时本地显示新名、DB 还是旧名,刷新即打回。
              void (async () => {
                try {
                  const r = await fetch(`/api/studio/${output.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ title: v }),
                  });
                  if (!r.ok) throw new Error();
                } catch {
                  setTitle(output.title);
                  toast("重命名失败,请重试", "error");
                }
              })();
            } else if (!v) {
              setTitle(output.title);
            }
          }}
          aria-label="画板标题"
          className="-ml-1 w-full truncate rounded border-0 bg-transparent px-1 text-[19px] font-semibold leading-tight text-ink outline-none transition focus:bg-panel2/70"
        />
      }
      subtitle="画板"
      sourceCaption={sourceCaption(output)}
      onShare={onShareNotebook ?? (() => shareOutput(output))}
      onClose={handleClose}
      fill
      // 点 header「展开/还原」→ 确定性重 fit(不赌 ResizeObserver):类切换后布局
      // 在下一帧完成,80ms 首fit + 两档复核把内容重新铺满新视口。
      onFullChange={() => {
        for (const d of [80, 250, 600]) setTimeout(() => fitRef.current(), d);
      }}
      footer={
        <ViewerActions
          onDelete={onDelete}
          onDownload={openExport}
          downloadLabel="导出图片"
        />
      }
    >
      {err ? (
        <p className="py-10 text-center text-sm text-red-600">{err}</p>
      ) : !scene ? (
        <div className="flex min-h-[420px] flex-1 items-center justify-center gap-2 text-sm text-muted">
          <SpinnerIcon className="animate-spin" width={18} height={18} /> 正在生成画板…
        </div>
      ) : (
        // w-full 必须显式给:本容器唯一子元素是 absolute(不贡献尺寸),高度有 min-h
        // 撑着、宽度没约束会塌成 0 —— Excalidraw 拿 0 宽容器算 fit,zoom 永远失效
        // (实测 .excalidraw clientWidth=0、内容全靠溢出渲染)。
        <div className="relative min-h-[420px] w-full flex-1">
          {wmMenu && (
            <div
              className="fixed inset-0 z-[80] flex items-end justify-center pb-24"
              onClick={() => !wmBusy && setWmMenu(false)}
            >
              <div className={cn(MENU_PANEL, "w-[248px]")} onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-1.5 px-3.5 py-1.5 text-[11.5px] text-muted">
                  {wmBusy && <SpinnerIcon className="animate-spin" width={13} height={13} />}
                  {wmBusy ? "导出中…" : "导出(含「猿笔记」水印)"}
                </div>
                <button type="button" disabled={wmBusy} onClick={() => wmExport("png")} className={cn(MENU_ITEM, wmBusy && "opacity-50")}>
                  下载 PNG
                </button>
                <button type="button" disabled={wmBusy} onClick={() => wmExport("svg")} className={cn(MENU_ITEM, wmBusy && "opacity-50")}>
                  下载 SVG
                </button>
                <button type="button" disabled={wmBusy} onClick={() => wmExport("copy")} className={cn(MENU_ITEM, wmBusy && "opacity-50")}>
                  复制到剪贴板
                </button>
              </div>
            </div>
          )}
          {cited && (
            <div className="absolute left-3 top-3 z-10 flex max-w-[80%] items-center gap-2 rounded-lg border border-edge bg-panel/95 px-3 py-1.5 text-xs text-ink2 shadow-sm backdrop-blur">
              <span className="truncate">来源:<span className="font-medium text-ink">{cited.source.title}</span></span>
              {onOpenSource && (
                <button
                  type="button"
                  onClick={() => onOpenSource(cited.source)}
                  className="shrink-0 rounded-md border border-edge px-2 py-0.5 text-accent transition hover:border-accent hover:bg-accentSoft"
                >
                  查看原文
                </button>
              )}
            </div>
          )}
          <div ref={boardHostRef} className="absolute inset-0">
          <ExcalidrawCanvasView
            // scrollToContent:true 让 Excalidraw 自己在挂载时把场景适配进视口
            // (程序化场景的稳妥做法,且避开手动调用 scrollToContent 的未挂载时序告警)。
            initialData={{ elements: scene.elements, appState: scene.appState, files: scene.files ?? undefined, scrollToContent: true }}
            excalidrawAPI={(api) => {
              apiRef.current = api as BoardApi;
              // 双保险 fit:initialData.scrollToContent 可能被场景 appState 或加载时序顶掉
              // (实证:内容在 x≈2000+ 时打开只见「巨大菱形」一角)。API 就绪后显式适配;
              // 两档延迟:60ms 先粗对准,700ms 等 modal 开场动画结束、容器到最终尺寸后再精确
              // fit(过早 fit 会按动画中的小容器算 zoom,内容显得又小又偏 —— mind-elixir
              // fitView 同款时序坑)。幂等,失败静默。
              // 确定性 fit:不赌 scrollToContent 的版本语义(实测两代参数名都不生效),
              // 自己算元素包围盒 + 视口尺寸,直接 updateScene 设 scroll/zoom(Excalidraw
              // 的 scrollX/Y 语义:视口原点在画布坐标系的偏移;内容居中 = 余量对半)。
              const fitBoard = () => {
                try {
                  const a = apiRef.current;
                  if (!a) return;
                  const els = (a.getSceneElements?.() || []) as { x: number; y: number; width?: number; height?: number; isDeleted?: boolean }[];
                  if (!els.length) return;
                  // 容器还没布局(clientWidth=0,modal 开场中)时 fit 会把 zoom 算成 1、
                  // 位置乱飘(实测埋点 contW:0 → zoomAfter:1)—— 没有宽度就不 fit,交给
                  // 外层重试循环等容器就绪。
                  const cont = boardHostRef.current?.querySelector(".excalidraw") as HTMLElement | null;
                  if (!cont || cont.clientWidth < 50 || cont.clientHeight < 50) return;
                  // 【关键】先 refresh 让 Excalidraw 重新量容器:弹窗展开/还原把容器改宽后
                  // Excalidraw 的 appState.width/height 还是旧值,scrollToContent 按旧宽度
                  // 算 zoom → 展开后内容只铺了旧视口的比例(真前台实测:1361 宽容器只铺 846*0.98)。
                  a.refresh?.();
                  // 官方 fit:fitToViewport 与 fitToContent 是互斥联合类型,只能传一个
                  // (同传会走保守的 fitToContent 分支 = 只滚不缩,实测踩过)。
                  if (a.scrollToContent) {
                    // 0.98:用户反馈默认打开「太小」—— 尽量占满视口(留 2% 呼吸边)。
                    a.scrollToContent(els as never, { fitToViewport: true, viewportZoomFactor: 0.98 });
                    return;
                  }
                  // 兜底:老版本无 scrollToContent → 手写包围盒 fit。
                  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                  for (const e of els) {
                    if (e.isDeleted || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
                    minX = Math.min(minX, e.x); minY = Math.min(minY, e.y);
                    maxX = Math.max(maxX, e.x + (e.width || 0)); maxY = Math.max(maxY, e.y + (e.height || 0));
                  }
                  if (!Number.isFinite(minX)) return;
                  const st = a.getAppState() as { width?: number; height?: number };
                  let vw = Number(st.width) || 0, vh = Number(st.height) || 0;
                  if (vw < 50 || vh < 50) {
                    // 部分版本 appState 不带画布尺寸 → 直接量 DOM(查看器同时只开一个画板)。
                    const el = boardHostRef.current?.querySelector(".excalidraw");
                    if (el) { vw = (el as HTMLElement).clientWidth; vh = (el as HTMLElement).clientHeight; }
                  }
                  if (vw < 50 || vh < 50) return; // modal 开场动画中容器未定型,等下一档
                  const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
                  // 0.98 同主路径:尽量占满;上限仍 1(小图放大到 >1 会字大得夸张)。
                  const zoom = Math.max(0.1, Math.min(1, Math.min(vw / bw, vh / bh) * 0.98));
                  const scrollX = (vw / zoom - bw) / 2 - minX;
                  const scrollY = (vh / zoom - bh) / 2 - minY;
                  a.updateScene?.({ appState: { scrollX, scrollY, zoom: { value: zoom } } });
                } catch { /* fit 失败不影响查看器 */ }
              };
              // 挂给容器尺寸监听(展开/收起弹窗时自动重 fit 填充新视口)。
              fitRef.current = fitBoard;
              // 等容器真正布局好(clientWidth>0)再 fit:固定延迟赌不赢 modal 动画/
              // StrictMode 双挂载的时序(实测 60/700ms 双档都能撞上 0 宽容器)。每 150ms
              // 重试直到首次 fit 成功;之后 400/900/1800ms 三档复核 —— 首次 fit 常发生在
              // 弹窗开场动画中途(容器只有最终宽度的一半),按中途尺寸算的 zoom 偏小,
              // 用户看到「默认打开太小」。多档复核随容器变宽逐步校正到占满。
              let tries = 0;
              const tryFit = () => {
                const cont = boardHostRef.current?.querySelector(".excalidraw") as HTMLElement | null;
                if (cont && cont.clientWidth >= 50 && cont.clientHeight >= 50) {
                  fitBoard();
                  for (const delay of [400, 900, 1800]) setTimeout(fitBoard, delay); // 收敛复核
                  return;
                }
                if (++tries < 20) setTimeout(tryFit, 150);
              };
              setTimeout(tryFit, 60);
            }}
            onChange={(elements, appState) => {
              // 选中某个节点 → 找它的文本标签 → 查 nodeSources → 弹「来源」条。
              const selIds = appState?.selectedElementIds as Record<string, boolean> | undefined;
              if (!selIds || Object.keys(selIds).length === 0) {
                if (citedKeyRef.current) { citedKeyRef.current = ""; setCited(null); }
                return;
              }
              const byId = new Map((elements as Array<Record<string, unknown>>).map((e) => [e.id as string, e]));
              let hit: { label: string; source: Source } | null = null;
              for (const id of Object.keys(selIds)) {
                const el = byId.get(id);
                if (!el) continue;
                const texts: string[] = [];
                if (typeof el.text === "string") texts.push(el.text);
                const bound = Array.isArray(el.boundElements) ? (el.boundElements as Array<{ id?: string }>) : [];
                for (const b of bound) {
                  const t = b.id ? byId.get(b.id) : undefined;
                  if (t && typeof t.text === "string") texts.push(t.text);
                }
                for (const tx of texts) {
                  const r = lookupBoardSource(tx, nodeSrcRef.current, sources);
                  if (r) { hit = r; break; }
                }
                if (hit) break;
              }
              const key = hit ? hit.label : "";
              if (key !== citedKeyRef.current) { citedKeyRef.current = key; setCited(hit); }
            }}
          />
          </div>
        </div>
      )}
    </Modal>
  );
}

export function NoteEditor({
  note,
  onClose,
  onSave,
  onToSource,
  onShareNotebook,
}: {
  note: Note;
  onClose: () => void;
  onSave: (id: string, title: string, content: string) => boolean | void | Promise<boolean | void>;
  onToSource: (id: string) => Promise<void>;
  onShareNotebook?: () => void;
}) {
  const [savedTitle, setSavedTitle] = useState(note.title);
  const [savedContent, setSavedContent] = useState(note.content);
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [converting, setConverting] = useState(false);

  // Refs mirror the latest values every render so the unmount cleanup (a stale
  // closure otherwise) can flush whatever the user last typed.
  const titleRef = useRef(title);
  titleRef.current = title;
  const contentRef = useRef(content);
  contentRef.current = content;
  const savedTitleRef = useRef(savedTitle);
  savedTitleRef.current = savedTitle;
  const savedContentRef = useRef(savedContent);
  savedContentRef.current = savedContent;

  // Whether the note has any readable text — a table/image-only or empty note
  // can't become a source, so don't offer it.
  const noteHasText = (() => {
    const t = content.trim();
    if (!t) return false;
    if (t.startsWith("{")) return /"text":"[^"]/.test(t);
    return true;
  })();

  // Persist through the parent;仅在真正落库成功时更新 saved* 基线,失败保持 dirty 让
  // 700ms 防抖与 unmount flush 自然重试(审查修复:此前无条件 setSaved* → 网络失败也
  // 被当作成功,窗口关闭前的重试永远不会命中,数据静默丢失)。
  const persist = useCallback(
    async (t: string, c: string): Promise<boolean> => {
      const ok = (await onSave(note.id, t, c)) !== false;
      if (ok) {
        setSavedTitle(t);
        setSavedContent(c);
      }
      return ok;
    },
    [note.id, onSave]
  );

  // Auto-save while editing — NotebookLM-style, no manual save button. 700ms
  // debounce; trim-compare so an unchanged note never PATCHes.
  useEffect(() => {
    if (title === savedTitle && content.trim() === savedContent.trim()) return;
    const t = setTimeout(() => void persist(title, content), 700);
    return () => clearTimeout(t);
  }, [title, content, savedTitle, savedContent, persist]);

  // Last-resort flush on unmount — this is what catches the edits that the
  // debounce hasn't written yet when the editor is torn down WITHOUT the close
  // button: switching notebooks (clearNotebookOverlays → setOpenNote(null)),
  // opening another/new note (key remount), back-to-home, refresh, tab close.
  // keepalive lets the request complete even as the component/page goes away.
  useEffect(() => {
    return () => {
      if (
        titleRef.current === savedTitleRef.current &&
        contentRef.current.trim() === savedContentRef.current.trim()
      )
        return;
      try {
        fetch(`/api/notes/${note.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: titleRef.current, content: contentRef.current }),
          keepalive: true,
        });
      } catch {
        /* noop — best-effort */
      }
    };
  }, [note.id]);

  // Explicit close: persist through the parent (so the notes list stays fresh),
  // and mark saved synchronously so the unmount cleanup doesn't double-PATCH.
  const close = () => {
    if (title !== savedTitle || content.trim() !== savedContent.trim()) {
      void persist(title, content);
    }
    savedTitleRef.current = title;
    savedContentRef.current = content;
    onClose();
  };

  return (
    <EditorShell
      title={
        <input
          name="title"
          autoComplete="off"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题"
          className="w-full truncate bg-transparent text-[19px] font-semibold leading-tight text-ink outline-none placeholder:text-muted"
        />
      }
      onShare={onShareNotebook}
      onClose={close}
      footer={
        <>
          <button
            onClick={async () => {
              setConverting(true);
              try {
                // persist the latest edits first — the server reads the note from
                // the DB, so an unsaved note would convert as empty
                await onSave(note.id, title, content);
                await onToSource(note.id);
                onClose();
              } catch {
                /* failure already surfaced via toast — keep the editor open */
              } finally {
                setConverting(false);
              }
            }}
            disabled={converting || !noteHasText}
            title={!noteHasText ? "笔记内容为空,无法转为来源" : undefined}
            className="inline-flex items-center gap-2 rounded-full border border-edge px-4 py-2 text-sm text-ink transition hover:border-accent hover:bg-accentSoft hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-edge disabled:hover:bg-transparent disabled:hover:text-ink"
          >
            {converting ? <SpinnerIcon width={15} height={15} /> : <FileIcon width={15} height={15} />}
            转换为来源
          </button>
        </>
      }
    >
      <RichNoteEditor value={content} onChange={setContent} format="json" stripTitle={note.title} />
    </EditorShell>
  );
}

// ---------------------------------------------------------------------------
// Drawviso(draw.io)编辑器 —— 自托管完整 draw.io webapp + iframe embed 协议。
// 打开即【完整可编辑】编辑器(左侧图形库 / 顶部工具栏 / 右侧格式面板 / 拖拽画布),
// 编辑经 autosave 事件回写 content。content = { xml, nodeSources };编辑后 nodeSources
// 原样保留(标签可能改动、失配不强求——用户选完整编辑器已接受丢「点节点看来源」回溯)。
// 自托管资源在 public/drawio(不进 git,scripts/fetch-drawio.mjs 部署时拉取)。
// ---------------------------------------------------------------------------
// embed 协议参数:proto=json 走 JSON postMessage;offline=1 断外部;noSaveBtn/noExitBtn
// 因为保存(autosave)与关闭(Modal)由我们接管;modified 提示未保存。
// ---------------------------------------------------------------------------
// Drawviso 专业图表查看器/编辑器 —— 自研 React Flow(DrawvisoCanvas),取代 draw.io
// iframe。content = { xml(mxGraphModel), nodeSources };打开时 xmlToGraph 转成
// {nodes,edges} 交给 DrawvisoCanvas 渲染/编辑;编辑 graph→graphToXml 回写 content。
// UI 100% 猿笔记原生(节点/工具栏/检查器全自建),无第三方外壳,grounded 回溯恢复。
// ---------------------------------------------------------------------------
const DrawvisoCanvasView = dynamic(() => import("./editor-nodes/DrawvisoCanvas"), { ssr: false });

export function DrawvisoView({
  output,
  onClose,
  onDelete,
  onSaved,
  onShareNotebook,
  sources,
  onOpenSource,
  watermark,
}: {
  output: StudioOutput;
  onClose: () => void;
  onDelete?: () => void;
  /** 编辑 autosave 回写 content;未提供 = 只读(分享页)。 */
  onSaved?: (content: string) => void;
  onShareNotebook?: () => void;
  /** grounded 回溯:节点→来源。 */
  sources?: Source[];
  onOpenSource?: (s: Source) => void;
  watermark?: boolean;
}) {
  const readOnly = !onSaved;
  const graph0 = useMemo(() => {
    try {
      const p = JSON.parse(output.content || "{}") as { xml?: string };
      return p.xml ? xmlToGraph(p.xml) : { nodes: [], edges: [] };
    } catch { return { nodes: [], edges: [] }; }
  }, [output.content]);
  const nodeSrcRef = useRef<Record<string, string>>({});
  try {
    const p = JSON.parse(output.content || "{}") as { nodeSources?: Record<string, string> };
    nodeSrcRef.current = p.nodeSources && typeof p.nodeSources === "object" ? p.nodeSources : {};
  } catch { /* keep */ }
  const savedRef = useRef(output.content || "");
  const wm = outputWatermark(output, watermark);
  const [cited, setCited] = useState<{ label: string; source: Source } | null>(null);
  const exportRef = useRef<(() => Promise<Blob | null>) | null>(null);

  const handleChange = useCallback((graph: DrawvisoGraph) => {
    const content = JSON.stringify({ xml: graphToXml(graph), nodeSources: nodeSrcRef.current });
    if (content === savedRef.current) return;
    savedRef.current = content;
    fetch(`/api/studio/${output.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }),
    }).catch(() => {});
    onSaved?.(content);
  }, [output.id, onSaved]);

  const handleOpenNode = useCallback((label: string) => {
    setCited(lookupBoardSource(label, nodeSrcRef.current, sources));
  }, [sources]);

  const fileBase = () => (output.title || "Drawviso").replace(/[\\/:*?"<>|]+/g, "_");
  const exportPng = useCallback(async () => {
    const fn = exportRef.current;
    if (!fn) { toast("图表尚未就绪", "error"); return; }
    try {
      let blob = await fn();
      if (!blob) { toast("导出失败,请重试", "error"); return; }
      if (wm) blob = await stampImageWatermark(blob);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${fileBase()}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { toast("导出失败,请重试", "error"); }
  }, [wm]);

  return (
    <Modal
      title={output.title}
      subtitle="Drawviso 图表"
      sourceCaption={sourceCaption(output)}
      onShare={onShareNotebook ?? (() => shareOutput(output))}
      onClose={onClose}
      fill
      footer={<ViewerActions onDelete={onDelete} onDownload={exportPng} downloadLabel="导出 PNG" />}
    >
      {graph0.nodes.length === 0 ? (
        <p className="py-10 text-center text-sm text-red-600">图表内容为空或已损坏,请删除后重新生成。</p>
      ) : (
        <div className="relative min-h-[420px] w-full flex-1 bg-white">
          {cited && (
            <div className="absolute left-3 top-3 z-20 flex max-w-[70%] items-center gap-2 rounded-lg border border-edge bg-panel/95 px-3 py-1.5 text-xs text-ink2 shadow-sm backdrop-blur">
              <span className="truncate">来源:<span className="font-medium text-ink">{cited.source.title}</span></span>
              {onOpenSource && (
                <button type="button" onClick={() => onOpenSource(cited.source)}
                  className="shrink-0 rounded-md border border-edge px-2 py-0.5 text-accent transition hover:border-accent hover:bg-accentSoft">查看原文</button>
              )}
            </div>
          )}
          <DrawvisoCanvasView
            graph={graph0}
            readOnly={readOnly}
            onChange={handleChange}
            onOpenNode={handleOpenNode}
            registerExport={(fn) => { exportRef.current = fn; }}
          />
        </div>
      )}
    </Modal>
  );
}
type ConfigTile = "mindmap" | "reports" | "table" | "slides" | "audio" | "video" | "infographic" | "quiz" | "flashcards" | "excalidraw" | "xhs" | "drawviso" | "cad";

type FmtOpt = { k: string; l: string; d: string };

/** 每种生成类型的弹窗配置 —— 沿用 NotebookLM 的 configurable-form-dialog 骨架:
 *  标题(图标 + 名称)+ 取材范围 + 格式卡片 + 语言/时长 + 描述 + 生成。
 *  各类型只换「格式」那组卡片;思维导图/数据表格无格式。 */
const CONFIG_META: Record<
  ConfigTile,
  {
    title: string;
    /** 标题下的一行说明(可选;目前仅小红书卡组用,交代这是能直接发布的产物)。 */
    subtitle?: string;
    Icon: typeof FileIcon;
    tint: string;
    fg: string;
    formats?: FmtOpt[];
    lengths?: { k: string; l: string }[];
    promptLabel: string;
    placeholder: string;
  }
> = {
  audio: {
    title: "自定义音频概览",
    Icon: AudioIcon,
    tint: "bg-art-audio/10",
    fg: "text-art-audio",
    formats: [
      { k: "deep_dive", l: "深入探究", d: "两位主持人生动对谈,层层深入并串联主题。" },
      { k: "brief", l: "摘要", d: "单人简短概述,帮你快速抓住核心要点。" },
      { k: "critique", l: "评论", d: "以专家视角点评来源,并给出建设性反馈。" },
      { k: "debate", l: "辩论", d: "两位主持人针锋相对,呈现不同立场与观点。" },
    ],
    lengths: [
      { k: "shorter", l: "短" },
      { k: "default", l: "默认" },
      { k: "longer", l: "长" },
    ],
    promptLabel: "主持人应着重哪些方面?",
    placeholder: `示例提示
• 面向投资者,聚焦业务重构与回购信号,语气专业克制
• 用通勤路上能听懂的方式,讲清三个关键结论
• 多举资料里的具体数字与同比变化`,
  },
  // 视频概览:lib/video.ts 仅收 focus/language(无格式/时长档位)→ 只留语言 + 补充说明。
  video: {
    title: "自定义视频概览",
    Icon: VideoIcon,
    tint: "bg-art-video/10",
    fg: "text-art-video",
    promptLabel: "视频应着重哪些方面?",
    placeholder: `示例提示
• 聚焦三个最关键的结论,每页讲透一个
• 面向新手,用类比和例子讲清核心概念
• 多引用资料里的具体数字与对比`,
  },
  reports: {
    title: "自定义报告",
    Icon: FileIcon,
    tint: "bg-art-report/10",
    fg: "text-art-report",
    formats: [
      { k: "briefing", l: "简报", d: "快速掌握要点的高层概览。" },
      { k: "study_guide", l: "学习指南", d: "便于复习的结构化要点与问题。" },
      { k: "faq", l: "常见问答", d: "把来源整理成一问一答。" },
      { k: "timeline", l: "时间线", d: "按时间梳理关键事件脉络。" },
      { k: "toc", l: "目录", d: "梳理全部材料的层级大纲。" },
      { k: "blog", l: "博客文章", d: "面向大众读者的成文叙述。" },
      { k: "custom", l: "自定义", d: "完全按你的目标组织一份来源驱动报告。" },
    ],
    promptLabel: "补充说明",
    placeholder: `示例提示
• 从投资者角度,突出业务重构与主要风险
• 面向新手,分步骤讲解并在每节配要点小结
• 提炼可执行的下一步行动清单`,
  },
  quiz: {
    title: "自定义测验",
    Icon: QuizIcon,
    tint: "bg-art-quiz/10",
    fg: "text-art-quiz",
    promptLabel: "想重点考哪些方面?",
    placeholder: `示例提示
• 帮我为面试 / 复习做准备,重点考最常被问到的点
• 只围绕某一个来源(或某一章)出题,例如《第三章·部署》
• 重点考易错点和应用场景,少考死记硬背的定义
• 多出需要推理判断的情景题,少出纯名词解释`,
  },
  flashcards: {
    title: "自定义闪卡",
    Icon: CardsIcon,
    tint: "bg-art-cards/10",
    fg: "text-art-cards",
    promptLabel: "想重点记哪些方面?",
    placeholder: `示例提示
• 只围绕某一个来源(或某一章)做卡,例如《第三章·部署》
• 侧重易错点和数字参数,少做纯名词解释
• 面向考前突击,聚焦最常考的知识点`,
  },
  slides: {
    title: "自定义演示文稿",
    Icon: PresentIcon,
    tint: "bg-art-slides/10",
    fg: "text-art-slides",
    promptLabel: "请描述您要创建的演示文稿",
    placeholder: `示例提示
• 面向客户的路演风格,强调成果与下一步
• 为新手创建,大胆活泼,注重分步说明
• 每页一个核心论点,配关键数据`,
  },
  mindmap: {
    title: "自定义思维导图",
    Icon: MindMapIcon,
    tint: "bg-art-mindmap/10",
    fg: "text-art-mindmap",
    promptLabel: "想怎么组织?",
    placeholder: `示例提示
• 以「问题→对策」为主线梳理
• 按主题分支,突出因果与依赖关系
• 控制在三层以内,先骨架后细节`,
  },
  table: {
    title: "自定义数据表格",
    Icon: TableIcon,
    tint: "bg-art-table/10",
    fg: "text-art-table",
    promptLabel: "想统计或对比哪些维度?",
    placeholder: `示例提示
• 列出主要发现,含「标题 / 作者 / 主要结果」列
• 按厂商 × 指标整理成对比表
• 提取关键引文,并按主题、作者分组`,
  },
  infographic: {
    title: "自定义图片概述",
    Icon: ImageIcon,
    tint: "bg-art-info/10",
    fg: "text-art-info",
    promptLabel: "想重点呈现什么?",
    placeholder: `示例提示
• 提炼 5-6 个关键要点,每点配一个关键数字
• 面向外行,用最直白的话讲清核心结论
• 配色用绿色 / 蓝色科技风 / 暖色调(可指定主题色)`,
  },
  drawviso: {
    title: "自定义 Drawviso 图表",
    Icon: BoardIcon,
    tint: "bg-art-table/10",
    fg: "text-art-table",
    promptLabel: "想画哪类图?有什么样式要求?",
    placeholder: `示例提示
• 画一张分层架构图,按「接入层/服务层/数据层」分组
• 用泳道图梳理各角色的职责与交接
• 核心模块用蓝色,风险点用红色标出`,
  },
  excalidraw: {
    title: "自定义画板",
    Icon: BoardIcon,
    tint: "bg-art-board/10",
    fg: "text-art-board",
    promptLabel: "想画成什么样?",
    placeholder: `示例提示
• 用流程图梳理「问题 → 对策 → 结果」
• 按主题分支画成思维导图,控制在三层内
• 突出关键环节之间的依赖与因果关系`,
  },
  xhs: {
    title: "自定义小红书卡组",
    subtitle: "把资料做成可直接发布的小红书图文卡组",
    Icon: XhsCardsIcon,
    tint: "bg-art-info/10",
    fg: "text-art-info",
    promptLabel: "补充说明",
    placeholder: `示例提示
• 只围绕XX主题
• 面向考研人群的口吻
• 每张卡突出一个要点,多用资料里的数字`,
  },
  cad: {
    title: "生成 CAD 模型",
    subtitle: "先完成免费预检，确认对象、尺寸和假设后再入队",
    Icon: CadIcon,
    tint: "bg-accentSoft",
    fg: "text-accent",
    promptLabel: "建模目标",
    placeholder: `请明确说明对象和关键尺寸，例如：
• 生成 120×80×5 mm 的四孔安装板
• 生成一个可评审的电子设备外壳
• 不确定尺寸请列为假设，不要静默补齐`,
  },
};
const LANGS = [
  { v: "", l: "使用笔记本默认" },
  { v: "简体中文", l: "简体中文" },
  { v: "繁體中文", l: "繁體中文" },
  { v: "English", l: "English" },
  { v: "日本語", l: "日本語" },
] as const;

/** 模版缩略图:按每款规格画出标题装饰 + 内容版式(卡片网格 / 行式清单),
 *  让生成弹窗里"选模版"所见即所得,而不只是一个色点。 */
function SlideThumb({ t }: { t: SlideTheme }) {
  const st = slideStyle(t.id);
  const left = st.titleAlign === "left";
  const tones = [t.tones.a, t.tones.b, t.tones.c];
  const isList = st.card === "bare" || st.card === "flat";
  return (
    <div className="w-full overflow-hidden rounded" style={{ aspectRatio: "16 / 9", background: t.bg }}>
      <div className="flex h-full flex-col p-[7px]">
        <div className={cn("flex flex-col", left ? "items-start" : "items-center")}>
          <div className="flex items-center gap-1">
            {st.titleDecor === "bar" && <span className="h-2.5 w-[2px] rounded-sm" style={{ background: t.accent }} />}
            <span className="block h-[3px] rounded-full" style={{ width: left ? 32 : 40, background: t.titleColor }} />
          </div>
          {st.titleDecor === "underline" && <span className="mt-[2px] h-[2px] w-2.5 rounded-full" style={{ background: t.accent }} />}
          {st.titleDecor === "rule" && <span className="mt-[3px] h-px w-full" style={{ background: t.cardBorder }} />}
        </div>
        {isList ? (
          <div className="my-auto space-y-[4px]">
            {tones.map((tn, i) => (
              <div
                key={i}
                className="flex items-center gap-1"
                style={{ borderTop: i ? `0.5px solid ${t.cardBorder}` : undefined, paddingTop: i ? 3 : 0 }}
              >
                <span className="text-[6px] font-bold leading-none" style={{ color: tn.fg, fontFamily: st.fontHead }}>
                  0{i + 1}
                </span>
                <span className="block h-[2.5px] flex-1 rounded-full" style={{ background: t.textColor, opacity: 0.45 }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="my-auto flex gap-[4px]">
            {tones.map((tn, i) => (
              <div
                key={i}
                className="relative flex-1 overflow-hidden rounded-[2px]"
                style={{ height: 24, background: t.cardBg, border: `0.5px solid ${t.cardBorder}` }}
              >
                {st.accentEdge === "left" ? (
                  <span className="absolute inset-y-0 left-0 w-[2px]" style={{ background: tn.fg }} />
                ) : st.accentEdge === "bottom" ? (
                  <span className="absolute inset-x-0 bottom-0 h-[2px]" style={{ background: tn.fg }} />
                ) : st.accentEdge === "top" ? (
                  <span className="absolute inset-x-0 top-0 h-[2px]" style={{ background: tn.fg }} />
                ) : null}
                <span className="absolute left-1/2 top-[5px] h-2 w-2 -translate-x-1/2 rounded-full border" style={{ borderColor: tn.fg }} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 信息图模版缩略图:迷你海报(标题条 + 2×2 彩条卡片),与演示文稿同 5 套主题。 */
function IgThumb({ t }: { t: SlideTheme }) {
  const tones = [t.tones.a.fg, t.tones.b.fg, t.tones.c.fg, t.tones.d.fg];
  return (
    <div className="w-full overflow-hidden rounded" style={{ aspectRatio: "16 / 9", background: t.bg }}>
      <div className="flex h-full flex-col gap-[4px] p-[7px]">
        <div className="flex items-center gap-1">
          <span className="h-[3px] w-2 rounded-full" style={{ background: t.accent }} />
          <span className="h-[3.5px] w-[44%] rounded-full" style={{ background: t.titleColor }} />
        </div>
        <div className="grid flex-1 grid-cols-2 gap-[4px]">
          {tones.map((c, i) => (
            <div
              key={i}
              className="relative overflow-hidden rounded-[2px]"
              style={{ background: t.cardBg, border: `0.5px solid ${t.cardBorder}` }}
            >
              <span className="absolute inset-x-0 top-0 h-[2px]" style={{ background: c }} />
              <span className="absolute left-[3px] top-[5px] h-[2px] w-[55%] rounded-full" style={{ background: c }} />
              <span className="absolute left-[3px] top-[9px] h-[1.5px] w-[72%] rounded-full" style={{ background: t.textColor, opacity: 0.5 }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** CAD 建模方式缩略图：只做快速识别，不冒充最终几何预览。 */
function CadModelThumb({ id }: { id: CadTemplateChoice }) {
  const shared = {
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg viewBox="0 0 96 56" className="h-14 w-full" fill="none" aria-hidden>
      {id === "auto" && (
        <>
          <rect x="12" y="11" width="24" height="16" rx="3" {...shared} />
          <circle cx="69" cy="18" r="9" {...shared} />
          <path d="M36 19h21M51 15l6 4-6 4M20 36h55M26 31v10M48 31v10M70 31v10" {...shared} />
        </>
      )}
      {id === "text2cad" && (
        <>
          <path d="m48 7 24 12v23L48 51 24 39V16Z" fill="currentColor" fillOpacity="0.08" {...shared} />
          <path d="m24 16 24 12 24-9M48 28v23M34 22l14-8 14 7" {...shared} />
        </>
      )}
      {id === "plate" && (
        <>
          <rect x="14" y="10" width="68" height="36" rx="5" fill="currentColor" fillOpacity="0.08" {...shared} />
          {[[23, 19], [73, 19], [23, 37], [73, 37]].map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3.5" {...shared} />
          ))}
        </>
      )}
      {id === "mounting_bracket" && (
        <>
          <path d="M18 45h56V35H38V10H18Z" fill="currentColor" fillOpacity="0.08" {...shared} />
          <path d="m38 10 10 6v19M74 35l8 5v10H27l-9-5" {...shared} />
          <circle cx="28" cy="22" r="3.5" {...shared} />
        </>
      )}
      {id === "enclosure" && (
        <>
          <path d="m21 17 21-9 34 10-21 10Z" fill="currentColor" fillOpacity="0.08" {...shared} />
          <path d="M21 17v25l34 9 21-9V18M55 28v23" {...shared} />
          <rect x="29" y="25" width="17" height="11" rx="2" {...shared} />
        </>
      )}
      {id === "flange" && (
        <>
          <circle cx="48" cy="28" r="22" fill="currentColor" fillOpacity="0.08" {...shared} />
          <circle cx="48" cy="28" r="8" {...shared} />
          {[0, 60, 120, 180, 240, 300].map((angle) => {
            const radians = (angle * Math.PI) / 180;
            return <circle key={angle} cx={48 + Math.cos(radians) * 16} cy={28 + Math.sin(radians) * 16} r="2.2" {...shared} />;
          })}
        </>
      )}
      {id === "shaft_adapter" && (
        <>
          <ellipse cx="27" cy="28" rx="12" ry="17" fill="currentColor" fillOpacity="0.08" {...shared} />
          <path d="M27 11h35c10 0 18 8 18 17s-8 17-18 17H27" {...shared} />
          <ellipse cx="62" cy="28" rx="18" ry="17" {...shared} />
          <ellipse cx="62" cy="28" rx="7" ry="8" {...shared} />
        </>
      )}
      {id === "humanoid_robot" && (
        <>
          <rect x="40" y="4" width="16" height="11" rx="3" fill="currentColor" fillOpacity="0.08" {...shared} />
          <rect x="34" y="19" width="28" height="18" rx="4" fill="currentColor" fillOpacity="0.08" {...shared} />
          <path d="M34 23 21 34M62 23l13 11M41 37l-8 14M55 37l8 14" {...shared} />
          <circle cx="20" cy="35" r="3" {...shared} /><circle cx="76" cy="35" r="3" {...shared} />
          <circle cx="32" cy="51" r="3" {...shared} /><circle cx="64" cy="51" r="3" {...shared} />
        </>
      )}
      {id === "concept_car" && (
        <>
          <path d="M13 36h7l8-15h35l13 15h7v9H13Z" fill="currentColor" fillOpacity="0.08" {...shared} />
          <path d="M34 21 43 11h16l9 10" {...shared} />
          <circle cx="29" cy="44" r="7" fill="rgb(var(--c-panel))" {...shared} />
          <circle cx="69" cy="44" r="7" fill="rgb(var(--c-panel))" {...shared} />
        </>
      )}
    </svg>
  );
}

type CadFixedTemplateId = Exclude<CadTemplateChoice, "auto" | "text2cad">;

type CadPreflightIssueView = {
  code?: string;
  field?: string;
  message: string;
  severity?: string;
  objectIds?: string[];
};

const CAD_OBJECT_LABELS: Readonly<Record<string, string>> = {
  robotic_arm: "机械臂",
  humanoid_robot: "人形机器人",
  concept_car: "概念汽车",
  mounting_bracket: "安装支架",
  enclosure: "设备外壳",
  flange: "法兰",
  shaft_adapter: "轴径转接套",
  plate: "安装板",
};

type CadPlanPreview = {
  planHash: string;
  targetLabel: string;
  mode: string;
  constraints: string[];
  missingFields: string[];
  limitations: string[];
};

type GenerateAdmissionResult = {
  accepted: boolean;
  error?: string;
};

const CAD_MODE_OPTIONS: ReadonlyArray<{
  id: CadGenerationMode;
  label: string;
  description: string;
}> = [
  { id: "source_driven", label: "按资料建模", description: "从已选来源提取对象、尺寸与约束" },
  { id: "prompt_driven", label: "描述模型", description: "明确输入对象、尺寸、孔位或用途" },
  { id: "fixed_template", label: "标准模板", description: "使用经过验证的受控结构和参数" },
] as const;

const CAD_FIXED_MODELS = CAD_MODEL_LIBRARY.filter(
  (model): model is (typeof CAD_MODEL_LIBRARY)[number] & { id: CadFixedTemplateId } => (
    model.id !== "auto" && model.id !== "text2cad"
  )
);

function defaultCadDraft(mode: CadGenerationMode): {
  instruction: string;
  templateId: CadFixedTemplateId | null;
  parameters: CadDraftParameters;
  allowAssumptions: boolean;
  tutorialExample: boolean;
} {
  const templateId = mode === "fixed_template" ? "plate" : null;
  return {
    instruction: "",
    templateId,
    parameters: templateId ? defaultCadTemplateParameters(templateId) : {},
    allowAssumptions: false,
    tutorialExample: false,
  };
}

function cadDraftStorageKey(notebookId: string, mode: CadGenerationMode): string {
  return `apebook:cad-draft:${notebookId}:${mode}`;
}

function cadLastModeStorageKey(notebookId: string): string {
  return `apebook:cad-draft:${notebookId}:last-mode`;
}

function readCadDraft(notebookId: string, mode: CadGenerationMode) {
  const fallback = defaultCadDraft(mode);
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(cadDraftStorageKey(notebookId, mode));
    if (!raw) return fallback;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    const draft = value as Record<string, unknown>;
    const templateId = CAD_FIXED_MODELS.some((model) => model.id === draft.templateId)
      ? draft.templateId as CadFixedTemplateId
      : fallback.templateId;
    const parameters = draft.parameters && typeof draft.parameters === "object" && !Array.isArray(draft.parameters)
      ? Object.fromEntries(
          Object.entries(draft.parameters)
            .filter((entry): entry is [string, string | number] => typeof entry[1] === "string" || typeof entry[1] === "number")
            .map(([key, item]) => [key, String(item)])
        )
      : fallback.parameters;
    return {
      instruction: typeof draft.instruction === "string" ? draft.instruction.slice(0, 4_000) : "",
      templateId,
      parameters,
      allowAssumptions: draft.allowAssumptions === true,
      tutorialExample: mode === "fixed_template" && draft.tutorialExample === true,
    };
  } catch {
    return fallback;
  }
}

function normalizeCadPreflightIssues(value: unknown): CadPreflightIssueView[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [{ message: item.trim().slice(0, 500) }];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const issue = item as Record<string, unknown>;
    const message = typeof issue.message === "string"
      ? issue.message.trim()
      : typeof issue.error === "string"
        ? issue.error.trim()
        : "";
    if (!message) return [];
    return [{
      code: typeof issue.code === "string" ? issue.code.slice(0, 80) : undefined,
      field: typeof issue.field === "string" ? issue.field.slice(0, 80) : undefined,
      severity: typeof issue.severity === "string" ? issue.severity.slice(0, 40) : undefined,
      message: message.slice(0, 500),
      objectIds: issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
        && Array.isArray((issue.details as Record<string, unknown>).objectIds)
        ? ((issue.details as Record<string, unknown>).objectIds as unknown[])
            .filter((value): value is string => typeof value === "string" && !!CAD_OBJECT_LABELS[value])
            .slice(0, 8)
        : undefined,
    }];
  });
}

/**
 * 统一生成配置弹窗(思维导图 / PDF 报告 / 数据表格 / 演示文稿 / 音频概览 / 视频概览 / 图片概述 / 测验 / 闪卡 / 画板)。
 * NotebookLM configurable-form-dialog 骨架:取材范围(我们特有)+ 格式卡片 +
 * 主题(演示/信息图)+ 语言 + 时长(音频)+ 自定义描述。各类型由 CONFIG_META 驱动。
 */
export function GenerateConfigModal({
  tile,
  notebookId,
  selectedSourceIds,
  hasSources,
  creditCosts,
  onClose,
  onConfirm,
}: {
  tile: ConfigTile;
  notebookId: string;
  selectedSourceIds: string[];
  hasSources: boolean;
  creditCosts: Record<string, number>;
  onClose: () => void;
  onConfirm: (
    kind: StudioKind,
    opts: {
      sourceIds: string[];
      instruction?: string;
      focus?: string;
      language?: string;
      theme?: string;
      format?: string;
      length?: string;
      difficulty?: string;
      count?: number;
      cadTemplate?: CadTemplateChoice;
      cadMode?: CadGenerationMode;
      cadParameters?: Record<string, number | boolean>;
      cadTargetObjectId?: string;
      cadAllowAssumptions?: boolean;
      cadTutorialExample?: boolean;
      cadPreflightPlanHash?: string;
      cadIdempotencyKey?: string;
    }
  ) => void | GenerateAdmissionResult | Promise<void | GenerateAdmissionResult>;
}) {
  const meta = CONFIG_META[tile];
  const isAudio = tile === "audio";
  // 音频与视频的补充说明都注入 focus(lib/video.ts 只读 focus,jobs.ts 的
  // focus||instruction 只是兜底);前端显式走 focus 让路由收敛为一处,避免
  // 「后端兜底、前端走 instruction」的通道分裂,日后加独立 focus 字段不致重复。
  const usesFocus = tile === "audio" || tile === "video";
  const isQuiz = tile === "quiz";
  const isCards = tile === "flashcards";
  const isXhs = tile === "xhs";
  const isCad = tile === "cad";
  // 取材统一只基于「来源」(在左栏勾选);不再有会话/笔记取材范围。
  const [format, setFormat] = useState(meta.formats?.[0]?.k ?? "");
  const [length, setLength] = useState("default");
  // 模版:演示/信息图默认选第一套;小红书卡组默认「auto」(按内容自动挑,用户可手选配色)。
  const [theme, setTheme] = useState<string>(isXhs ? "auto" : SLIDE_THEMES[0].id);
  const [instruction, setInstruction] = useState("");
  const [language, setLanguage] = useState("");
  const [difficulty, setDifficulty] = useState("medium");
  const [cadTemplate, setCadTemplate] = useState<CadTemplateChoice>("auto");
  const [cadMode, setCadMode] = useState<CadGenerationMode>("source_driven");
  const [cadParameters, setCadParameters] = useState<CadDraftParameters>({});
  const [cadTargetObjectId, setCadTargetObjectId] = useState<string | null>(null);
  const [cadAllowAssumptions, setCadAllowAssumptions] = useState(false);
  const [cadTutorialExample, setCadTutorialExample] = useState(false);
  const [cadDraftHydrated, setCadDraftHydrated] = useState(false);
  const [cadIssues, setCadIssues] = useState<CadPreflightIssueView[]>([]);
  const [cadPlanPreview, setCadPlanPreview] = useState<CadPlanPreview | null>(null);
  const [cadIdempotencyKey, setCadIdempotencyKey] = useState<string | null>(null);
  const [cadSubmitting, setCadSubmitting] = useState(false);
  // 数量:测验(题量)/闪卡/小红书卡组(卡量)共用;闪卡默认 12 张(生成侧 8-16 的中档),
  // 小红书卡组默认 6 张(4/6/8 的中档)。
  const [count, setCount] = useState(isCards ? 12 : isXhs ? 6 : 10);
  const availableSlideThemes = tile === "infographic"
    ? SLIDE_THEMES.filter((item) => ["midnight", "paper", "aurora", "sunrise", "forest"].includes(item.id))
    : SLIDE_THEMES;
  const selectedKind = tile === "reports" ? format : tile;
  const isTimeline = selectedKind === "timeline";
  const isCustom = selectedKind === "custom";
  const reservedCredits = Math.max(0, Number(creditCosts[selectedKind] ?? 5));
  const fixedTemplateId = cadMode === "fixed_template" && cadTemplate !== "auto" && cadTemplate !== "text2cad"
    ? cadTemplate
    : null;
  const fixedParameterFields = fixedTemplateId ? CAD_FIXED_TEMPLATE_PARAMETERS[fixedTemplateId] ?? [] : [];

  useEffect(() => {
    if (!isCad) return;
    let mode: CadGenerationMode = "source_driven";
    try {
      const storedMode = window.localStorage.getItem(cadLastModeStorageKey(notebookId));
      if (storedMode === "source_driven" || storedMode === "prompt_driven" || storedMode === "fixed_template") {
        mode = storedMode;
      }
    } catch {
      // localStorage 不可用时仍可在本轮使用，只是不做跨弹窗恢复。
    }
    const draft = readCadDraft(notebookId, mode);
    setCadMode(mode);
    setInstruction(draft.instruction);
    setCadTemplate(mode === "source_driven" ? "auto" : mode === "prompt_driven" ? "text2cad" : draft.templateId ?? "plate");
    setCadParameters(draft.parameters);
    setCadAllowAssumptions(draft.allowAssumptions);
    setCadTutorialExample(draft.tutorialExample);
    setCadIssues([]);
    setCadTargetObjectId(null);
    setCadDraftHydrated(true);
  }, [isCad, notebookId]);

  useEffect(() => {
    if (!isCad || !cadDraftHydrated) return;
    try {
      window.localStorage.setItem(cadLastModeStorageKey(notebookId), cadMode);
      window.localStorage.setItem(cadDraftStorageKey(notebookId, cadMode), JSON.stringify({
        instruction,
        templateId: fixedTemplateId,
        parameters: cadParameters,
        allowAssumptions: cadAllowAssumptions,
        tutorialExample: cadTutorialExample,
      }));
    } catch {
      // 草稿保存是恢复优化，不应阻断当前生成。
    }
  }, [
    cadAllowAssumptions,
    cadDraftHydrated,
    cadMode,
    cadParameters,
    cadTutorialExample,
    fixedTemplateId,
    instruction,
    isCad,
    notebookId,
  ]);

  // 统一选项「胶囊」:选中=浅薰衣草填充 + ✓(无描边),未选=描边;两者同尺寸(选中描边透明)。
  const pillCls = (active: boolean) =>
    cn(
      "inline-flex items-center gap-1.5 rounded-full border px-5 py-2 text-sm transition",
      active
        ? "border-transparent bg-accentSoft font-medium text-accent"
        : "border-edge text-ink2 hover:border-accent/50 hover:text-ink"
    );
  const sectionLabel = "mb-3 text-[15px] font-medium text-ink";
  const check = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );

  const switchCadMode = (nextMode: CadGenerationMode) => {
    if (cadSubmitting || nextMode === cadMode) return;
    const draft = readCadDraft(notebookId, nextMode);
    setCadMode(nextMode);
    setInstruction(draft.instruction);
    setCadTemplate(nextMode === "source_driven" ? "auto" : nextMode === "prompt_driven" ? "text2cad" : draft.templateId ?? "plate");
    setCadParameters(draft.parameters);
    setCadAllowAssumptions(draft.allowAssumptions);
    setCadTutorialExample(draft.tutorialExample);
    setCadIssues([]);
    setCadTargetObjectId(null);
    setCadPlanPreview(null);
    setCadIdempotencyKey(null);
  };

  const selectFixedCadTemplate = (templateId: CadFixedTemplateId) => {
    if (cadSubmitting) return;
    setCadTemplate(templateId);
    setInstruction("");
    setCadParameters(defaultCadTemplateParameters(templateId));
    setCadTutorialExample(false);
    setCadIssues([]);
    setCadTargetObjectId(null);
    setCadPlanPreview(null);
    setCadIdempotencyKey(null);
  };

  const chooseCadTutorialExample = () => {
    if (cadSubmitting) return;
    setCadMode("fixed_template");
    setCadTemplate("plate");
    setCadParameters(defaultCadTemplateParameters("plate"));
    setInstruction("生成四孔安装平板教学示例，使用界面中明确列出的系统默认尺寸。");
    setCadAllowAssumptions(false);
    setCadTutorialExample(true);
    setCadIssues([]);
    setCadTargetObjectId(null);
    setCadPlanPreview(null);
    setCadIdempotencyKey(null);
  };

  const submitCad = async () => {
    if (cadSubmitting) return;
    const localIssues: CadPreflightIssueView[] = [];
    if (cadMode === "source_driven" && (!hasSources || selectedSourceIds.length === 0)) {
      localIssues.push({ field: "sourceIds", message: "请先在左侧勾选至少一个已就绪来源。" });
    }
    const normalizedInstruction = instruction.trim();
    if (cadMode === "prompt_driven" && !normalizedInstruction) {
      localIssues.push({ field: "instruction", message: "「描述模型」需要输入具体对象和关键尺寸。" });
    }
    if (cadMode === "fixed_template" && !fixedTemplateId) {
      localIssues.push({ field: "templateId", message: "请选择一个标准模板。" });
    }
    const normalizedParameters: Record<string, number | boolean> = {};
    if (cadMode === "fixed_template") {
      for (const field of fixedParameterFields) {
        const raw = cadParameters[field.key]?.trim() ?? "";
        const value = Number(raw);
        if (!raw || !Number.isFinite(value)) {
          localIssues.push({ field: `parameters.${field.key}`, message: `${field.label}必须是有效数值。` });
          continue;
        }
        if (value < field.min || value > field.max || (field.unit === "count" && !Number.isInteger(value))) {
          localIssues.push({
            field: `parameters.${field.key}`,
            message: `${field.label}需在 ${field.min}–${field.max} ${field.unit === "mm" ? "mm" : "个"}之间${field.unit === "count" ? "，且必须是整数" : ""}。`,
          });
          continue;
        }
        normalizedParameters[field.key] = value;
      }
    }
    if (localIssues.length > 0) {
      setCadIssues(localIssues);
      setCadPlanPreview(null);
      setCadIdempotencyKey(null);
      return;
    }

    setCadSubmitting(true);
    setCadIssues([]);
    try {
      const response = await fetch(`/api/notebooks/${encodeURIComponent(notebookId)}/cad/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          mode: cadMode,
          sourceIds: cadMode === "source_driven" ? [...selectedSourceIds] : [],
          instruction: cadMode === "prompt_driven" ? normalizedInstruction || undefined : undefined,
          templateId: fixedTemplateId,
          targetObjectId: cadMode === "source_driven" ? cadTargetObjectId ?? undefined : undefined,
          parameters: normalizedParameters,
          allowAssumptions: cadAllowAssumptions,
          tutorialExample: cadTutorialExample,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const record = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
      const responseIssues = normalizeCadPreflightIssues(record?.issues);
      if (!response.ok) {
        const fallback = response.status === 404 || response.status === 405
          ? "CAD 预检服务尚未部署或当前版本不兼容。为避免误扣积分，本次未创建任务。"
          : typeof record?.error === "string"
            ? record.error.slice(0, 500)
            : `CAD 预检失败（HTTP ${response.status}），本次未创建任务。`;
        setCadIssues(responseIssues.length > 0 ? responseIssues : [{ message: fallback }]);
        setCadPlanPreview(null);
        setCadIdempotencyKey(null);
        return;
      }
      const status = typeof record?.status === "string" ? record.status.toLowerCase() : "";
      const ready = status === "ready" || status === "ok" || status === "approved" || status === "pass";
      if (!ready || responseIssues.some((issue) => issue.severity === "error")) {
        setCadIssues(responseIssues.length > 0
          ? responseIssues
          : [{ message: "CAD 预检未通过，请按提示补充目标、尺寸或确认假设。" }]);
        setCadPlanPreview(null);
        setCadIdempotencyKey(null);
        return;
      }
      const planHash = typeof record?.planHash === "string" ? record.planHash.trim() : "";
      const hasPlan = !!record?.plan && typeof record.plan === "object" && !Array.isArray(record.plan);
      if (!planHash || !hasPlan) {
        setCadIssues([{ message: "CAD 预检响应缺少完整计划或校验值，可能是旧版服务。为避免错配和误扣积分，本次未创建任务。" }]);
        return;
      }
      const plan = record?.plan as Record<string, unknown>;
      const target = plan.target && typeof plan.target === "object" && !Array.isArray(plan.target)
        ? plan.target as Record<string, unknown>
        : {};
      const capability = plan.capability && typeof plan.capability === "object" && !Array.isArray(plan.capability)
        ? plan.capability as Record<string, unknown>
        : {};
      const nextPreview: CadPlanPreview = {
        planHash,
        targetLabel: typeof target.label === "string" ? target.label.slice(0, 100) : "已识别建模对象",
        mode: typeof plan.mode === "string" ? plan.mode : cadMode,
        constraints: Array.isArray(plan.constraints)
          ? plan.constraints.slice(0, 12).flatMap((item) => (
              item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).expression === "string"
                ? [String((item as Record<string, unknown>).expression).slice(0, 160)]
                : []
            ))
          : [],
        missingFields: Array.isArray(plan.missingFields)
          ? plan.missingFields.filter((item): item is string => typeof item === "string").slice(0, 12)
          : [],
        limitations: Array.isArray(capability.limitations)
          ? capability.limitations.filter((item): item is string => typeof item === "string").slice(0, 8)
          : [],
      };
      // 免费预检结果先展示给用户。只有用户再次点击“确认并生成”，
      // 且服务端重算得到同一 planHash，才进入扣分入队。
      if (cadPlanPreview?.planHash !== planHash) {
        setCadPlanPreview(nextPreview);
        setCadIdempotencyKey(globalThis.crypto?.randomUUID?.() ?? null);
        setCadIssues([]);
        return;
      }
      if (!cadIdempotencyKey) {
        setCadPlanPreview(null);
        setCadIssues([{ message: "无法创建安全的生成请求编号，请重新预检。" }]);
        return;
      }
      const admission = await onConfirm("cad", {
        sourceIds: cadMode === "source_driven" ? [...selectedSourceIds] : [],
        instruction: cadMode === "prompt_driven" ? normalizedInstruction || undefined : undefined,
        cadTemplate: cadMode === "source_driven"
          ? "auto"
          : cadMode === "prompt_driven"
            ? "text2cad"
            : fixedTemplateId ?? undefined,
        cadMode,
        cadParameters: normalizedParameters,
        cadTargetObjectId: cadMode === "source_driven" ? cadTargetObjectId ?? undefined : undefined,
        cadAllowAssumptions,
        cadTutorialExample,
        cadPreflightPlanHash: planHash,
        cadIdempotencyKey,
      });
      if (!admission || admission.accepted !== true) {
        setCadIssues([{ message: admission?.error || "服务端未返回有效的入队确认，已保留草稿；请稍后重试。" }]);
        return;
      }
      try {
        window.localStorage.removeItem(cadDraftStorageKey(notebookId, cadMode));
      } catch {
        // 入队已成功，清理本地草稿失败不影响任务。
      }
      onClose();
    } catch (error) {
      setCadIssues([{
        message: error instanceof Error && error.message
          ? `CAD 预检请求失败：${error.message.slice(0, 420)}。本次未创建任务。`
          : "CAD 预检请求失败，本次未创建任务。",
      }]);
    } finally {
      setCadSubmitting(false);
    }
  };

  const submitStandardConfig = () => {
    const ids: string[] = [...selectedSourceIds];
    const kind: StudioKind = tile === "reports" ? (format as StudioKind) : (tile as StudioKind);
    const text = instruction.trim() || undefined;
    void onConfirm(kind, {
      sourceIds: ids,
      instruction: usesFocus || isTimeline ? undefined : text,
      focus: usesFocus ? text : undefined,
      language: isTimeline ? undefined : language || undefined,
      theme: tile === "slides" || tile === "infographic" || tile === "xhs" ? theme : undefined,
      format: isAudio ? format : undefined,
      length: isAudio ? length : undefined,
      difficulty: isQuiz ? difficulty : undefined,
      count: isQuiz || isCards || isXhs ? count : undefined,
    });
    onClose();
  };

  return (
    <Modal
      title={
        <div className="flex items-center gap-2.5">
          <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl", meta.tint)}>
            <meta.Icon width={19} height={19} className={meta.fg} />
          </span>
          <div className="min-w-0">
            <h2 className="text-[18px] font-semibold leading-tight text-ink">{meta.title}</h2>
            {meta.subtitle && <p className="mt-0.5 text-[12.5px] font-normal text-muted">{meta.subtitle}</p>}
          </div>
        </div>
      }
      onClose={isCad && cadSubmitting ? () => {} : onClose}
      noExpand
      narrow
      footer={
        <>
          <span className="mr-auto flex flex-col text-[13px] text-ink2">
            <span>
              {isCad && cadMode === "prompt_driven"
                ? "按描述生成 · 只使用本次描述，不使用来源"
                : isCad && cadMode === "fixed_template"
                  ? "标准模板 · 只使用页面参数，不使用来源"
                  : hasSources ? `已选择 ${selectedSourceIds.length} 个来源` : "请先在左栏勾选来源"}
            </span>
            <span className="mt-0.5 text-[11.5px] text-muted">
              {isCad ? "预检不扣积分 · " : ""}预计最多 {reservedCredits} 积分 · 完成后按实际 Token 结算，多退不补
            </span>
          </span>
          <button
            onClick={onClose}
            disabled={cadSubmitting}
            className="rounded-lg px-4 py-2 text-sm text-ink2 transition hover:bg-panel2"
          >
            取消
          </button>
          <button
            disabled={
              cadSubmitting
              || (isCad ? cadMode === "source_driven" && !hasSources : !hasSources)
              || (isCustom && !instruction.trim())
            }
            onClick={() => isCad ? void submitCad() : submitStandardConfig()}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-onAccent transition hover:brightness-110 disabled:opacity-50"
          >
            {isCad && cadSubmitting
              ? "正在预检…"
              : isCad && cadPlanPreview
                ? "确认并生成"
                : "免费预检"}
          </button>
        </>
      }
    >
      {isCad && (
        <div className="space-y-5">
          <div
            role="tablist"
            aria-label="建模方式"
            className="grid grid-cols-1 gap-2 sm:grid-cols-3"
          >
            {CAD_MODE_OPTIONS.map((mode) => {
              const selected = cadMode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  disabled={cadSubmitting}
                  onClick={() => switchCadMode(mode.id)}
                  className={cn(
                    "min-w-0 rounded-xl px-3 py-3 text-left transition",
                    selected
                      ? "bg-accentSoft/60 text-accent ring-2 ring-accent"
                      : "bg-panel2/45 text-ink2 ring-1 ring-edge hover:text-accent hover:ring-accent/40"
                  )}
                >
                  <span className={cn("block text-sm", selected && "font-semibold")}>{mode.label}</span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-muted">{mode.description}</span>
                </button>
              );
            })}
          </div>

          {cadMode === "source_driven" && (
            <div className="rounded-xl bg-panel2/55 px-4 py-3 text-[13px] leading-relaxed text-ink2">
              预检会从已选来源提取唯一具体对象、尺寸和约束。若来源含多个对象，请切换到“描述模型”明确本次目标；系统不会猜测或自动换成教学模型。
            </div>
          )}

          {cadMode === "prompt_driven" && (
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">建模目标 <span className="font-normal text-red-500">· 必填</span></span>
              <textarea
                name="instruction"
                autoComplete="off"
                value={instruction}
                onChange={(event) => { setInstruction(event.target.value); setCadIssues([]); setCadPlanPreview(null); }}
                placeholder={meta.placeholder}
                rows={6}
                aria-invalid={cadIssues.some((issue) => issue.field === "instruction") || undefined}
                className={cn(
                  "min-h-[154px] w-full resize-none rounded-xl border bg-panel2/35 px-4 py-3.5 text-sm leading-relaxed outline-none placeholder:whitespace-pre-line placeholder:text-muted focus:border-accent",
                  cadIssues.some((issue) => issue.field === "instruction") ? "border-red-400" : "border-edge"
                )}
              />
            </label>
          )}

          {cadMode === "fixed_template" && (
            <div className="space-y-4">
              <div>
                <p className={sectionLabel}>选择标准模板</p>
                <div className="flex gap-2 overflow-x-auto px-0.5 py-1.5 [&>*]:shrink-0" role="listbox" aria-label="CAD 标准模板">
                  {CAD_FIXED_MODELS.map((model) => {
                    const selected = fixedTemplateId === model.id && !cadTutorialExample;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        title={model.description}
                        disabled={cadSubmitting}
                        onClick={() => selectFixedCadTemplate(model.id)}
                        className={cn(
                          "w-[112px] rounded-xl p-2 text-center transition",
                          selected
                            ? "bg-accentSoft/55 text-accent ring-2 ring-accent"
                            : "bg-panel text-ink2 ring-1 ring-edge hover:text-accent hover:ring-accent/40"
                        )}
                      >
                        <span className="block rounded-lg bg-panel2/70 px-2 text-current"><CadModelThumb id={model.id} /></span>
                        <span className={cn("mt-1.5 block truncate text-xs", selected && "font-medium")}>{model.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {fixedParameterFields.length > 0 && (
                <div>
                  <p className={sectionLabel}>核心参数</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {fixedParameterFields.map((field) => {
                      const invalid = cadIssues.some((issue) => issue.field === `parameters.${field.key}`);
                      return (
                        <label key={field.key} className="min-w-0">
                          <span className="mb-1.5 block truncate text-xs text-ink2" title={field.label}>{field.label}</span>
                          <span className={cn("flex items-center rounded-lg border bg-panel2/35", invalid ? "border-red-400" : "border-edge focus-within:border-accent")}>
                            <input
                              name={`cad-parameter-${field.key}`}
                              type="number"
                              min={field.min}
                              max={field.max}
                              step={field.unit === "count" ? 1 : "any"}
                              value={cadParameters[field.key] ?? String(field.defaultValue)}
                              disabled={cadSubmitting}
                              onChange={(event) => {
                                setCadParameters((current) => ({ ...current, [field.key]: event.target.value }));
                                setCadIssues([]);
                                setCadPlanPreview(null);
                              }}
                              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-ink outline-none"
                            />
                            <span className="pr-2.5 text-[10px] text-muted">{field.unit === "mm" ? "mm" : "个"}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <button
                type="button"
                disabled={cadSubmitting}
                onClick={chooseCadTutorialExample}
                className={cn(
                  "w-full rounded-xl px-4 py-3 text-left transition ring-1",
                  cadTutorialExample
                    ? "bg-accentSoft/60 text-accent ring-accent"
                    : "bg-panel2/45 text-ink2 ring-edge hover:ring-accent/45"
                )}
              >
                <span className="block text-sm font-medium">使用四孔安装板教学示例</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-muted">仅在您明确点击时选中；使用页面列出的默认尺寸，不冒充来源约束。</span>
              </button>
            </div>
          )}

          <label className="flex items-start gap-2.5 rounded-xl bg-panel2/45 px-3.5 py-3 text-xs leading-relaxed text-ink2">
            <input
              name="cad-allow-assumptions"
              type="checkbox"
              checked={cadAllowAssumptions}
              disabled={cadSubmitting || cadTutorialExample}
              onChange={(event) => { setCadAllowAssumptions(event.target.checked); setCadIssues([]); setCadPlanPreview(null); }}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--c-accent))]"
            />
            <span>来源或描述缺少非关键尺寸时，允许使用预检明确列出的首版假设。假设必须在生成结果中可见，不得静默补齐。</span>
          </label>

          {cadPlanPreview && (
            <div className="rounded-xl bg-emerald-50/75 px-4 py-3 text-xs leading-relaxed text-emerald-950 dark:bg-emerald-950/25 dark:text-emerald-100">
              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold">预检通过：{cadPlanPreview.targetLabel}</p>
                <span className="shrink-0 text-[10px] text-emerald-700 dark:text-emerald-300">尚未扣积分</span>
              </div>
              {cadPlanPreview.constraints.length > 0 && (
                <div className="mt-2">
                  <p className="font-medium">已冻结约束</p>
                  <ul className="mt-1 space-y-0.5 text-emerald-900/85 dark:text-emerald-100/80">
                    {cadPlanPreview.constraints.map((constraint, index) => (
                      <li key={`constraint-${index}`}>· {constraint}</li>
                    ))}
                  </ul>
                </div>
              )}
              {cadPlanPreview.missingFields.length > 0 && (
                <p className="mt-2 text-amber-700 dark:text-amber-300">
                  将作为首版假设并在结果中披露：{cadPlanPreview.missingFields.join("、")}
                </p>
              )}
              {cadPlanPreview.limitations.length > 0 && (
                <p className="mt-2 text-emerald-900/70 dark:text-emerald-100/65">
                  能力边界：{cadPlanPreview.limitations.join("；")}
                </p>
              )}
              <p className="mt-2 font-medium">请核对后点击“确认并生成”。</p>
            </div>
          )}

          {cadIssues.length > 0 && (
            <div role="alert" aria-live="assertive" className="rounded-xl border border-red-200 bg-red-50/75 px-4 py-3 text-xs leading-relaxed text-red-700 dark:border-red-900/60 dark:bg-red-950/25 dark:text-red-300">
              <p className="font-semibold">本次未创建任务</p>
              <ul className="mt-1.5 space-y-1">
                {cadIssues.map((issue, index) => (
                  <li key={`${issue.code ?? issue.field ?? "issue"}-${index}`}>· {issue.message}</li>
                ))}
              </ul>
              {[...new Set(cadIssues.flatMap((issue) => issue.objectIds ?? []))].length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {[...new Set(cadIssues.flatMap((issue) => issue.objectIds ?? []))].map((objectId) => (
                    <button
                      key={objectId}
                      type="button"
                      disabled={cadSubmitting}
                      onClick={() => {
                        setCadTargetObjectId(objectId);
                        setCadIssues([]);
                        setCadPlanPreview(null);
                        setCadIdempotencyKey(null);
                      }}
                      className="rounded-full border border-red-300 bg-white/70 px-3 py-1.5 text-[11px] font-medium text-red-700 transition hover:border-accent hover:text-accent dark:bg-transparent"
                    >
                      本次生成{CAD_OBJECT_LABELS[objectId] ?? objectId}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 格式(音频 / 报告):2 列卡片,每张含标题 + 说明 + 选中勾(NotebookLM 风) */}
      {meta.formats && (
        <>
          <p className={sectionLabel}>格式</p>
          <div className="mb-4 grid grid-cols-2 gap-2">
            {meta.formats.map((o) => {
              const on = format === o.k;
              return (
                <button
                  key={o.k}
                  onClick={() => setFormat(o.k)}
                  className={cn(
                    "relative rounded-xl border-2 px-3 py-2.5 text-left transition",
                    on
                      ? "border-accent bg-accentSoft/70"
                      : "border-transparent bg-panel2 hover:border-accent/30"
                  )}
                >
                  <span className={cn("block text-[13.5px] font-medium", on ? "text-accent" : "text-ink")}>
                    {o.l}
                  </span>
                  <span className="mt-1 block text-[11.5px] leading-relaxed text-muted">{o.d}</span>
                  {on && (
                    <svg className="absolute right-2.5 top-2.5 text-accent" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* 模版(演示文稿 / 图片概述):手选 5 套主题之一(「自动」已下线) */}
      {(tile === "slides" || tile === "infographic") && (
        <>
          <p className={sectionLabel}>模版</p>
          {/* 单行左右横滑(不再换行罗列);约 4-5 个可见,其余横向滚动。
              px/py 留白:overflow-x-auto 会连带竖向裁剪,否则选中环(ring-2)上下/首尾会被切。 */}
          <div className="mb-4 flex gap-2 overflow-x-auto px-0.5 py-1.5 [&>*]:shrink-0">
            {availableSlideThemes.map((th) => {
              const on = theme === th.id;
              return (
                <button
                  key={th.id}
                  onClick={() => setTheme(th.id)}
                  title={th.name}
                  aria-label={`模版:${th.name}`}
                  className={cn(
                    "w-[124px] rounded-lg p-1 transition",
                    on ? "ring-2 ring-accent" : "ring-1 ring-edge hover:ring-accent/40"
                  )}
                >
                  {tile === "slides" ? <SlideThumb t={th} /> : <IgThumb t={th} />}
                  <span className={cn("mt-1 block text-center text-[11px]", on ? "font-medium text-accent" : "text-ink2")}>
                    {th.name}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* 模版(小红书卡组):默认 + 三套配色,手选或让「默认」按内容自动挑(对齐 PPT 的选模版) */}
      {isXhs && (
        <>
          <p className={sectionLabel}>模版</p>
          {/* 单行左右横滑(同 PPT):约 4-5 个可见,其余横向滚动,不换行罗列。
              px/py 留白:overflow-x-auto 会连带竖向裁剪,否则选中环(ring-2)首尾/上下会被切。 */}
          <div className="mb-4 flex gap-2.5 overflow-x-auto px-0.5 py-1.5 [&>*]:shrink-0">
            {XHS_THEME_META.map((th) => {
              const on = theme === th.id;
              return (
                <button
                  key={th.id}
                  onClick={() => setTheme(th.id)}
                  title={th.name}
                  aria-label={`模版:${th.name}`}
                  className={cn("rounded-lg p-1 transition", on ? "ring-2 ring-accent" : "ring-1 ring-edge hover:ring-accent/40")}
                >
                  <span className="block h-[76px] w-[58px] overflow-hidden rounded-md" style={{ background: th.bg }}>
                    {th.id === "auto" ? (
                      <span className="flex h-full w-full items-center justify-center" style={{ color: th.accent }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <circle cx="12" cy="12" r="3.4" />
                          <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
                        </svg>
                      </span>
                    ) : (
                      <span className="flex h-full flex-col gap-1 p-2">
                        <span className="h-1.5 w-8 rounded-full" style={{ background: th.accent }} />
                        <span className="mt-0.5 h-1 w-10 rounded-full" style={{ background: th.ink, opacity: 0.45 }} />
                        <span className="h-1 w-7 rounded-full" style={{ background: th.ink, opacity: 0.28 }} />
                        <span className="mt-auto h-4 w-full rounded" style={{ background: th.accent, opacity: 0.16 }} />
                      </span>
                    )}
                  </span>
                  <span className={cn("mt-1 block text-center text-[11px]", on ? "font-medium text-accent" : "text-ink2")}>{th.name}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* 题量 + 难度(测验):两列并排,胶囊 + 选中 ✓(对齐 NotebookLM 的两列布局) */}
      {/* 窄屏改单列上下排:半列 ~140px 塞不下胶囊组,会挤成一列竖条 */}
      {isQuiz && (
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-7">
          <div>
            <p className={sectionLabel}>题量</p>
            <div className="flex flex-wrap gap-2.5">
              {[6, 10, 15].map((n) => (
                <button key={n} onClick={() => setCount(n)} className={pillCls(count === n)}>
                  {count === n && check}
                  {n} 题
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className={sectionLabel}>难度</p>
            <div className="flex flex-wrap gap-2.5">
              {[
                { k: "easy", l: "简单" },
                { k: "medium", l: "中等" },
                { k: "hard", l: "困难" },
              ].map((o) => (
                <button key={o.k} onClick={() => setDifficulty(o.k)} className={pillCls(difficulty === o.k)}>
                  {difficulty === o.k && check}
                  {o.l}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 卡片数量(闪卡 / 小红书卡组):单组胶囊,风格同测验的题量 */}
      {(isCards || isXhs) && (
        <div className="mb-6">
          <p className={sectionLabel}>卡片数量</p>
          <div className="flex flex-wrap gap-2.5">
            {(isXhs ? [4, 6, 8] : [8, 12, 16]).map((n) => (
              <button key={n} onClick={() => setCount(n)} className={pillCls(count === n)}>
                {count === n && check}
                {n} 张
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 时间线保持原文日期与事件措辞，不展示无法执行的语言选项。 */}
      {!isTimeline && !isCad && <div className="mb-6">
        <p className={sectionLabel}>语言</p>
        <div className="flex flex-wrap gap-2.5">
          {LANGS.map((o) => (
            <button key={o.v} onClick={() => setLanguage(o.v)} className={pillCls(language === o.v)}>
              {language === o.v && check}
              {o.l}
            </button>
          ))}
        </div>
      </div>}
      {/* 时长:仅音频,放在语言下方整行(不再和语言并排挤半列) */}
      {isAudio && meta.lengths && (
        <div className="mb-6">
          <p className={sectionLabel}>时长</p>
          <div className="flex flex-wrap gap-2.5">
            {meta.lengths.map((o) => (
              <button key={o.k} onClick={() => setLength(o.k)} className={pillCls(length === o.k)}>
                {length === o.k && check}
                {o.l}
              </button>
            ))}
          </div>
        </div>
      )}

      {isTimeline ? (
        <div className="rounded-xl border border-edge bg-panel2/60 px-4 py-3 text-sm leading-relaxed text-ink2">
          时间线将直接读取来源正文中的明确日期与对应事件，并保留原文表述；不会执行改写、翻译或推测日期。
        </div>
      ) : !isCad ? (
        <>
          {/* 描述(NotebookLM 最后一项:目标 / 范围 / 重点 / 风格) */}
          <p className={sectionLabel}>
            {isCustom ? "请描述报告目标" : meta.promptLabel}{" "}
            <span className="text-[13px] font-normal text-muted">· {isCustom || isCad ? "必填" : "可选"}</span>
          </p>
          <textarea
            name="instruction"
            autoComplete="off"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={isCustom ? "例如：整理一份面向管理层的风险决策报告，按影响程度排序，并给出下一步行动。" : meta.placeholder}
            rows={5}
            className="min-h-[116px] w-full resize-none rounded-xl border border-edge bg-panel2/50 px-3.5 py-3 text-sm leading-relaxed outline-none placeholder:whitespace-pre-line placeholder:text-muted focus:border-accent"
          />
        </>
      ) : null}
    </Modal>
  );
}
