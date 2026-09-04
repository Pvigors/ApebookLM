"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, EmptyState, Notice, PageHeader, Section, Skeleton, selectCls } from "@/components/AdminUI";

// ── 与 /api/admin/workbench 的返回一一对应 ────────────────────────────────
type Unit = "count" | "percent" | "cny" | "credits";
type CatalogMetric = {
  id: string;
  label: string;
  unit: Unit;
  desc: string;
  maxDays: number | null;
  caveat: string | null;
};
type CatalogGroup = { id: string; label: string; metrics: CatalogMetric[] };
type Series = {
  id: string;
  label: string;
  group: string;
  unit: Unit;
  desc: string;
  caveat?: string;
  values: (number | null)[];
  unavailable?: string;
};

const RANGES = [7, 14, 30, 90] as const;

// 与 analytics 页同一套系列色。主色只做图形填充与强调,不铺大色块 ——
// 见 docs/admin-redesign-requirements.md 第 3 条与「视觉方向」。
const C = { purple: "#6d5ae6", purpleLite: "#8b78ff", green: "#10b981", amber: "#f59e0b", axis: "#e6e7ee", tick: "#9094a0" };

/** 按单位格式化。金额与积分要千分位,比率带 %,空值明确写「无样本」而不是画成 0。 */
function fmt(v: number | null, unit: Unit): string {
  if (v === null) return "无样本";
  switch (unit) {
    case "percent": return `${v}%`;
    case "cny": return `¥${v.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
    case "credits": return `${v.toLocaleString("zh-CN")} 分`;
    default: return v.toLocaleString("zh-CN");
  }
}

/**
 * 单个指标的图形。柱状用于计数与金额,折线用于比率。
 *
 * 高度写死而不是让 viewBox 自己推:画布是网格布局,格子高度固定,若沿用
 * analytics 页那种「只给 w-full、高度由宽高比推出」的写法,双栏时整图会被压到
 * 一半高,9px 的刻度字实际渲染不到 5px。这里给定 H 并且**不加**
 * preserveAspectRatio="none" —— 那个属性配上固定高度会把图形横向抻变形。
 *
 * 比率型的 null(无样本)必须断线,不能连成一条穿过去的直线,否则等于凭空捏造数据。
 */
function Chart({ s, labels }: { s: Series; labels: string[] }) {
  const W = 640, H = 132, padB = 15, padT = 8;
  const nums = s.values.filter((v): v is number => v !== null);
  const max = Math.max(...nums, s.unit === "percent" ? 100 : 1);
  const min = Math.min(...nums, 0);
  const span = max - min || 1;
  const bw = W / Math.max(s.values.length, 1);
  const y = (v: number) => H - padB - ((v - min) / span) * (H - padB - padT);
  const zeroY = y(0);

  if (s.unit === "percent") {
    // 用 null 把序列切成若干连续段,逐段画 —— 断点处不连线。
    const segs: { i: number; v: number }[][] = [];
    let cur: { i: number; v: number }[] = [];
    s.values.forEach((v, i) => {
      if (v === null) { if (cur.length) segs.push(cur); cur = []; }
      else cur.push({ i, v });
    });
    if (cur.length) segs.push(cur);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img" aria-label={s.label}>
        <line x1={0} x2={W} y1={H - padB} y2={H - padB} stroke={C.axis} />
        {segs.map((seg, k) => (
          <polyline
            key={k}
            points={seg.map((p) => `${(p.i * bw + bw / 2).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}
            fill="none"
            stroke={C.purple}
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {segs.flat().map((p) => (
          <circle key={p.i} cx={p.i * bw + bw / 2} cy={y(p.v)} r={1.6} fill={C.purple} />
        ))}
        {labels.map((d, i) =>
          i % Math.ceil(labels.length / 6) === 0 ? (
            <text key={i} x={i * bw + bw / 2} y={H - 3} textAnchor="middle" fontSize={9} fill={C.tick}>{d}</text>
          ) : null
        )}
      </svg>
    );
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img" aria-label={s.label}>
      <defs>
        <linearGradient id={`wb-${s.id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.purpleLite} />
          <stop offset="100%" stopColor={C.purple} />
        </linearGradient>
      </defs>
      {/* 以零值为基线，兼容未来可能出现的有符号用量指标。 */}
      <line x1={0} x2={W} y1={zeroY} y2={zeroY} stroke={C.axis} />
      {s.values.map((v, i) => {
        if (v === null || v === 0) return null;
        const top = Math.min(y(v), zeroY);
        const h = Math.max(Math.abs(zeroY - y(v)), 2);
        return (
          <rect key={i} x={i * bw + 2} y={top} width={Math.max(bw - 4, 1)} height={h} rx={2}
            fill={v < 0 ? C.amber : `url(#wb-${s.id})`} opacity={0.9} />
        );
      })}
      {labels.map((d, i) =>
        i % Math.ceil(labels.length / 6) === 0 ? (
          <text key={i} x={i * bw + bw / 2} y={H - 3} textAnchor="middle" fontSize={9} fill={C.tick}>{d}</text>
        ) : null
      )}
    </svg>
  );
}

/** 汇总值:比率取有样本天的均值,其余取合计 —— 把 30 天的百分比加起来没有意义。 */
function summarize(s: Series): string {
  const nums = s.values.filter((v): v is number => v !== null);
  if (!nums.length) return "无样本";
  if (s.unit === "percent") {
    return fmt(Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10, s.unit);
  }
  return fmt(Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100, s.unit);
}

/**
 * 画布里的一块。
 *
 * 口径说明**直接印在图下面**,不做成 hover 才出现的提示 —— 这一层的每个数字都带
 * 前提(排除了什么、算不算复制品、只回看几天),把前提藏进浮层等于默认没人会看。
 */
function ChartBox({ s, labels, onRemove }: { s: Series; labels: string[]; onRemove: () => void }) {
  return (
    <div className="rounded-2xl border border-edge bg-panel p-3.5">
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-ink">{s.label}</span>
            <span className="tabular-nums text-[15px] font-semibold text-ink">{summarize(s)}</span>
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{s.desc}</p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`移除 ${s.label}`}
          className="shrink-0 rounded-lg px-1.5 py-0.5 text-[15px] leading-none text-muted transition hover:bg-panel2 hover:text-ink2"
        >
          ×
        </button>
      </div>

      {s.unavailable ? (
        <div className="flex h-[132px] items-center justify-center rounded-xl bg-panel2/50 px-4 text-center text-[12px] text-muted">
          {s.unavailable}
        </div>
      ) : (
        <Chart s={s} labels={labels} />
      )}

      {s.caveat && (
        // 口径局限用 3px 左强调边,不用整块底色 —— 视觉规范只允许主色做强调边与软背景。
        <p className="mt-2 border-l-[3px] border-amber-400/70 pl-2 text-[11px] leading-relaxed text-muted">
          {s.caveat}
        </p>
      )}
    </div>
  );
}

export default function WorkbenchPage() {
  const [groups, setGroups] = useState<CatalogGroup[] | null>(null);
  const [picked, setPicked] = useState<string[]>(["dau", "new", "src", "crd"]);
  const [days, setDays] = useState<number>(30);
  const [labels, setLabels] = useState<string[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const byId = useMemo(() => {
    const m = new Map<string, CatalogMetric>();
    groups?.forEach((g) => g.metrics.forEach((x) => m.set(x.id, x)));
    return m;
  }, [groups]);

  useEffect(() => {
    fetch("/api/admin/workbench?catalog=1")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("指标目录加载失败"))))
      .then((d: { groups: CatalogGroup[] }) => setGroups(d.groups))
      .catch((e: Error) => setErr(e.message));
  }, []);

  const load = useCallback(async () => {
    if (!picked.length) { setSeries([]); setLabels([]); setLoading(false); return; }
    setLoading(true);
    setErr("");
    try {
      const r = await fetch(`/api/admin/workbench?metrics=${picked.join(",")}&days=${days}`);
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error || "取数失败");
      const d = (await r.json()) as { labels: string[]; series: Series[] };
      setLabels(d.labels);
      setSeries(d.series);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "取数失败");
    } finally {
      setLoading(false);
    }
  }, [picked, days]);

  useEffect(() => { void load(); }, [load]);

  const add = (id: string) => setPicked((p) => (p.includes(id) || p.length >= 8 ? p : [...p, id]));
  const remove = (id: string) => setPicked((p) => p.filter((x) => x !== id));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="经营洞察"
        title="数据工作台"
        desc="从左侧指标库挑选指标组合成画布，自选时间范围。每个数字都标注了口径与局限。"
        actions={<Btn onClick={() => void load()} disabled={loading}>{loading ? "取数中…" : "刷新"}</Btn>}
      />

      {err && (
        <Notice tone="err">
          {err}
          <button type="button" onClick={() => void load()} className="ml-2 underline underline-offset-2">重试</button>
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[190px_1fr_180px]">
        {/* ── 左:指标库 ────────────────────────────────── */}
        <aside className="space-y-3">
          <div className="text-[12px] font-semibold text-ink">指标库</div>
          {!groups ? (
            <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div>
          ) : (
            groups.map((g) => (
              <div key={g.id}>
                <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-muted">{g.label}</div>
                <div className="space-y-1">
                  {g.metrics.map((m) => {
                    const on = picked.includes(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        draggable={!on}
                        onDragStart={(e) => { e.dataTransfer.setData("text/plain", m.id); e.dataTransfer.effectAllowed = "copy"; }}
                        onClick={() => (on ? remove(m.id) : add(m.id))}
                        title={m.desc}
                        className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] transition ${
                          on
                            ? "border-l-[3px] border-accent bg-accent/[0.07] pl-[5px] font-medium text-accent"
                            : "text-ink2 hover:bg-panel2"
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">{m.label}</span>
                        {m.maxDays && <span className="shrink-0 text-[9.5px] text-muted">{m.maxDays}天</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
          <p className="pt-1 text-[10.5px] leading-relaxed text-muted">拖到右侧画布，或直接点击添加／移除。最多 8 个。</p>
        </aside>

        {/* ── 中:画布 ──────────────────────────────────── */}
        <div
          // 两处 preventDefault 都不能少,但失败形态不同:dragover 漏了 drop 根本不触发;
          // drop 漏了自己的 handler 照跑,坏的是浏览器会另外执行默认动作(把拖入的东西当文件打开)。
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDragOver(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); const id = e.dataTransfer.getData("text/plain"); if (byId.has(id)) add(id); }}
          className={`min-h-[420px] rounded-2xl border border-dashed p-3 transition ${
            dragOver ? "border-accent bg-accent/[0.04]" : "border-edge"
          }`}
        >
          {loading && !series.length ? (
            <div className="grid gap-3 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-52 w-full rounded-2xl" />)}</div>
          ) : !picked.length ? (
            <EmptyState title="画布是空的" hint="从左侧指标库挑一个指标开始，拖过来或直接点它。" />
          ) : (
            <div className={`grid gap-3 ${series.length > 1 ? "md:grid-cols-2" : ""}`}>
              {series.map((s) => <ChartBox key={s.id} s={s} labels={labels} onRemove={() => remove(s.id)} />)}
            </div>
          )}
        </div>

        {/* ── 右:配置 ──────────────────────────────────── */}
        <aside className="space-y-3">
          <div className="text-[12px] font-semibold text-ink">时间范围</div>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${selectCls} w-full`}>
            {RANGES.map((d) => <option key={d} value={d}>近 {d} 天</option>)}
          </select>
          <p className="text-[10.5px] leading-relaxed text-muted">
            按东八区自然日统计。部分指标有各自的回看上限（标在指标名后），超出时不出数并说明原因。
          </p>
          <div className="border-t border-edge pt-3">
            <div className="mb-1 text-[12px] font-semibold text-ink">已选 {picked.length}/8</div>
            <div className="space-y-1">
              {picked.map((id) => (
                <div key={id} className="flex items-center gap-1 text-[11.5px] text-ink2">
                  <span className="min-w-0 flex-1 truncate">{byId.get(id)?.label ?? id}</span>
                  <button type="button" onClick={() => remove(id)} aria-label="移除" className="text-muted hover:text-ink2">×</button>
                </div>
              ))}
              {!picked.length && <span className="text-[11px] text-muted">尚未选择</span>}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
