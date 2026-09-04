"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";

/** 后台共享 UI 原语 —— 直接复用主系统设计语言:Tailwind token(canvas/panel/ink/accent/edge)、
 *  rounded-[22px]+elev-soft 面板、rounded-xl 按钮、focus-neon 输入、rounded-full 标签。 */

const toneText: Record<string, string> = {
  ok: "text-emerald-600",
  warn: "text-amber-600",
  err: "text-red-500",
};

export function StatCard({
  label,
  value,
  sub,
  tone,
  icon,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "ok" | "warn" | "err";
  icon?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-edge bg-panel px-4 py-3.5 shadow-[0_10px_28px_-24px_rgba(28,30,60,.55)]">
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-xs text-muted">{label}</p>
        {icon && <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accentSoft text-accent">{icon}</span>}
      </div>
      <p className={"mt-1.5 text-[24px] font-medium leading-none tracking-[-0.01em] tabular-nums " + (tone ? toneText[tone] : "text-ink")}>
        {value}
      </p>
      {sub && <p className="mt-2 line-clamp-2 min-h-[16px] text-[11px] leading-4 text-muted">{sub}</p>}
    </div>
  );
}

/** 迷你折线(纯 SVG,薰衣草描边)—— 平滑曲线,用 min..max 满幅展示趋势。 */
export function Sparkline({ data, className = "h-5 w-16" }: { data: number[]; className?: string }) {
  if (!data || data.length < 2) return null;
  const W = 64,
    H = 20,
    pad = 2.5;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => ({
    x: (i / (data.length - 1)) * W,
    y: H - pad - ((v - min) / range) * (H - pad * 2),
  }));
  // 经中点的二次贝塞尔平滑,避免锯齿直角。
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const xc = ((pts[i - 1].x + pts[i].x) / 2).toFixed(1);
    const yc = ((pts[i - 1].y + pts[i].y) / 2).toFixed(1);
    d += ` Q${pts[i - 1].x.toFixed(1)},${pts[i - 1].y.toFixed(1)} ${xc},${yc}`;
  }
  d += ` L${pts[pts.length - 1].x.toFixed(1)},${pts[pts.length - 1].y.toFixed(1)}`;
  return (
    <svg viewBox="0 0 64 20" preserveAspectRatio="none" className={className} aria-hidden>
      <path d={d} fill="none" stroke="#6d5ae6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** KPI(极简留白):标签 → 大号值 → 环比 delta + sparkline 同行 → 周期注脚。可下钻。 */
export function KpiCard({
  label,
  value,
  delta,
  spark,
  href,
}: {
  label: string;
  value: string | number;
  delta?: { text: string; good: boolean | null; note?: string; up?: boolean };
  spark?: number[];
  href?: string;
}) {
  const body = (
    <>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1.5 text-[24px] font-medium leading-none tracking-[-0.01em] tabular-nums text-ink">{value}</p>
      {/* 整宽迷你曲线贴在数字下方,环比一行收尾。无 spark 留同高占位保持对齐。 */}
      {spark ? <Sparkline data={spark} className="mt-2.5 h-[18px] w-full" /> : <div className="mt-2.5 h-[18px]" aria-hidden />}
      {delta && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] tabular-nums">
          <span
            className={
              "flex items-center gap-0.5 " +
              (delta.good === null ? "text-muted" : delta.good ? "text-emerald-600" : "text-red-500")
            }
          >
            {delta.up !== undefined && <span aria-hidden>{delta.up ? "↑" : "↓"}</span>}
            {delta.text}
          </span>
          {delta.note && <span className="text-muted">· {delta.note}</span>}
        </div>
      )}
    </>
  );
  const cls = "block min-h-[118px] rounded-2xl border border-edge bg-panel px-4 py-3.5 shadow-[0_10px_28px_-24px_rgba(28,30,60,.55)] transition";
  return href ? (
    <Link href={href} className={cls + " hover:-translate-y-0.5 hover:border-accent/40"}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** 同形骨架占位(主系统同款 shimmer)。 */
export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return (
    <div className={"relative overflow-hidden rounded-lg bg-panel2 " + className}>
      <span className="pointer-events-none absolute inset-0 animate-[shimmerSweep_1.6s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/60 to-transparent" />
    </div>
  );
}

/** 空状态:图标 + 一句话 + 可选 CTA。 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      {icon && (
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accentSoft text-accent">{icon}</div>
      )}
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="max-w-xs text-xs leading-relaxed text-muted">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function Section({
  title,
  desc,
  children,
  actions,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-2xl border border-edge bg-panel p-4 shadow-[0_12px_34px_-28px_rgba(28,30,60,.5)] sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
            <span className="h-3.5 w-[3px] rounded-full bg-accent" aria-hidden />
            {title}
          </h2>
          {desc && <p className="mt-1 max-w-3xl pl-[11px] text-xs leading-5 text-muted">{desc}</p>}
        </div>
        {actions && <div className="w-full min-w-0 sm:w-auto sm:shrink-0">{actions}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  desc,
  eyebrow,
  actions,
}: {
  title: string;
  desc?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-[11px] font-semibold tracking-[0.12em] text-accent">{eyebrow}</p>}
        <h1 className="text-[22px] font-semibold tracking-tight text-ink sm:text-[26px]">{title}</h1>
        {desc && <p className="mt-1.5 max-w-3xl text-[13px] leading-5 text-muted">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function FilterBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-edge bg-panel p-2.5 shadow-[0_10px_28px_-25px_rgba(28,30,60,.45)]">
      {children}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
  onClose,
}: {
  tone?: "info" | "ok" | "warn" | "err";
  children: React.ReactNode;
  onClose?: () => void;
}) {
  const cls =
    tone === "ok"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : tone === "warn"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : tone === "err"
      ? "border-red-200 bg-red-50 text-red-600"
      : "border-accent/20 bg-accentSoft/55 text-ink2";
  return (
    <div role={tone === "err" ? "alert" : "status"} className={`flex items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-[13px] leading-5 ${cls}`}>
      <div className="min-w-0">{children}</div>
      {onClose && <button type="button" onClick={onClose} className="shrink-0 opacity-60 transition hover:opacity-100" aria-label="关闭提示">✕</button>}
    </div>
  );
}

/** 三员后台统一只读说明。写入口由权限上下文隐藏，说明保留当前页面仍可监督的范围。 */
export function ReadOnlyNotice({
  children = "当前角色处于只读模式，可以查看数据，但不能执行修改操作。",
}: {
  children?: React.ReactNode;
}) {
  return (
    <Notice tone="info">
      <span className="font-medium text-ink">只读模式</span>
      <span className="ml-1">{children}</span>
    </Notice>
  );
}

/** 页面或区块加载失败的统一形态；保留原页面上下文并提供明确重试入口。 */
export function InlineError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Notice tone="err">
      <div className="flex flex-wrap items-center gap-3">
        <span>{message}</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg border border-current/25 px-2.5 py-1 text-xs font-medium transition hover:bg-current/5"
          >
            重新加载
          </button>
        )}
      </div>
    </Notice>
  );
}

export function TableWrap({ children, minWidth }: { children: React.ReactNode; minWidth?: number }) {
  return (
    <div className="admin-table-scroll -mx-1 overflow-x-auto px-1 pb-1" style={minWidth ? { minWidth: 0 } : undefined}>
      <div style={minWidth ? { minWidth } : undefined}>{children}</div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink2">{label}</span>
      {children}
    </label>
  );
}

export const inputCls =
  "w-full rounded-xl border border-edge bg-panel2/60 px-3 py-2 text-sm text-ink outline-none transition placeholder:text-muted focus:border-accent focus-neon";

export const selectCls =
  "rounded-xl border border-edge bg-panel2/60 px-3 py-2 text-xs text-ink outline-none transition focus:border-accent focus-neon";

export function Btn({
  children,
  onClick,
  kind = "ghost",
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost" | "danger";
  disabled?: boolean;
}) {
  const cls =
    kind === "primary"
      ? "bg-accent text-onAccent shadow-[0_6px_16px_-8px_rgba(109,90,230,0.55)] hover:brightness-110"
      : kind === "danger"
      ? "border border-edge text-red-500 hover:border-red-300 hover:bg-red-50"
      : "border border-edge bg-panel text-ink2 hover:border-accent/50 hover:text-accent";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3.5 py-2 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
    >
      {children}
    </button>
  );
}

export function Pill({ text, tone }: { text: string; tone: "ok" | "warn" | "err" | "muted" | "info" }) {
  const cls =
    tone === "ok"
      ? "bg-emerald-50 text-emerald-700"
      : tone === "warn"
      ? "bg-amber-50 text-amber-700"
      : tone === "err"
      ? "bg-red-50 text-red-600"
      : tone === "info"
      ? "bg-accentSoft text-accent"
      : "bg-panel2 text-ink2";
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium ${cls}`}>
      {text}
    </span>
  );
}

/** 24h 柱状迷你图:薰衣草渐变柱 + 失败红柱叠加。 */
export function HourBars({
  series,
  height = 120,
}: {
  series: { hour: number; total: number; errors: number }[];
  height?: number;
}) {
  const max = Math.max(...series.map((s) => s.total), 1);
  const W = 720;
  const bw = W / series.length;
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="ad-bar-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8b78ff" />
          <stop offset="100%" stopColor="#6d5ae6" />
        </linearGradient>
      </defs>
      <line x1={0} x2={W} y1={height - 14} y2={height - 14} stroke="#e6e7ee" />
      {series.map((s, i) => {
        const h = (s.total / max) * (height - 22);
        const he = (s.errors / max) * (height - 22);
        return (
          <g key={i}>
            <rect
              x={i * bw + 2}
              y={height - 14 - h}
              width={bw - 4}
              height={Math.max(h, s.total > 0 ? 3 : 0)}
              rx={3}
              fill="url(#ad-bar-grad)"
              opacity={0.85}
            />
            {s.errors > 0 && (
              <rect x={i * bw + 2} y={height - 14 - he} width={bw - 4} height={Math.max(he, 3)} rx={3} fill="#ef4444" opacity={0.9} />
            )}
            {i % 4 === 0 && (
              <text x={i * bw + bw / 2} y={height - 2} textAnchor="middle" fontSize={9} fill="#9094a0">
                {new Date(s.hour * 3600_000).getHours()}时
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** 分页器:上一页/下一页 + 计数。offset/limit 由调用方管控。 */
export function Pagination({
  offset,
  limit,
  total,
  onPage,
}: {
  offset: number;
  limit: number;
  total: number;
  onPage: (offset: number) => void;
}) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-edge/70 pt-3 text-xs text-muted">
      <span className="tabular-nums">
        共 {total} 条 · 第 {page}/{pages} 页
      </span>
      <div className="flex gap-2">
        <Btn disabled={offset <= 0} onClick={() => onPage(Math.max(0, offset - limit))}>
          上一页
        </Btn>
        <Btn disabled={page >= pages} onClick={() => onPage(offset + limit)}>
          下一页
        </Btn>
      </div>
    </div>
  );
}

/** 居中弹窗(确认 / 编辑)。点遮罩或传入的 onClose 关闭。 */
export function Modal({
  title,
  children,
  onClose,
  footer,
  width = 440,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[90] grid place-items-center overflow-y-auto bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="relative my-auto max-h-[calc(100dvh-2rem)] w-full animate-popin overflow-y-auto rounded-[22px] border border-edge bg-panel p-5 elev-soft"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
          <button type="button" onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-panel2 hover:text-ink" aria-label="关闭弹窗">✕</button>
        </div>
        <div className="mt-3 text-sm leading-relaxed text-ink2">{children}</div>
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel = "确认执行",
  busy = false,
  danger = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={busy ? () => {} : onCancel}
      footer={
        <>
          <Btn disabled={busy} onClick={onCancel}>取消</Btn>
          <Btn kind={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>
            {busy ? "正在执行…" : confirmLabel}
          </Btn>
        </>
      }
    >
      <div className={`rounded-xl border px-3.5 py-3 ${danger ? "border-red-200 bg-red-50 text-red-600" : "border-edge bg-panel2 text-ink2"}`}>
        {children}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// iOS 风分组列表原语(对齐前台设置弹窗:白卡分组 + 发丝线行 + 圆角开关)
// ---------------------------------------------------------------------------

/** 分组容器:小标题 + 白卡 + 行间发丝线 + 可选脚注。 */
export function IGroup({
  label,
  desc,
  children,
}: {
  label?: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5 first:mt-0">
      {label && <p className="mb-1.5 px-1 text-[12px] font-medium text-muted">{label}</p>}
      <div className="overflow-hidden rounded-2xl border border-edge bg-panel [&>*+*]:border-t [&>*+*]:border-edge/55">
        {children}
      </div>
      {desc && <p className="mt-1.5 px-1 text-[11px] leading-relaxed text-muted">{desc}</p>}
    </div>
  );
}

/** 列表行:左标题(+副说明)、右值/控件。可点(button)或纯展示。 */
export function IRow({
  label,
  sub,
  value,
  right,
  onClick,
  tone,
}: {
  label: React.ReactNode;
  sub?: React.ReactNode;
  value?: React.ReactNode;
  right?: React.ReactNode;
  onClick?: () => void;
  tone?: "danger";
}) {
  const inner = (
    <>
      <span className="min-w-0 flex-1">
        <span className={"block text-[14px] " + (tone === "danger" ? "text-red-500" : "text-ink")}>{label}</span>
        {sub && <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{sub}</span>}
      </span>
      {value !== undefined && <span className="shrink-0 text-[13px] text-muted">{value}</span>}
      {right}
      {onClick && !right && (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted" aria-hidden>
          <path d="M9 6l6 6-6 6" />
        </svg>
      )}
    </>
  );
  const cls = "flex w-full items-center gap-3 px-4 py-3 text-left";
  return onClick ? (
    <button onClick={onClick} className={cls + " transition hover:bg-panel2/50"}>{inner}</button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

/** iOS 风开关。 */
export function IToggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      aria-pressed={on}
      className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition ${on ? "bg-accent" : "bg-edge"}`}
    >
      <span className={`h-5 w-5 rounded-full bg-white shadow transition ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
    </button>
  );
}

export function fmtBytes(n: number): string {
  if (n > 1 << 30) return (n / (1 << 30)).toFixed(2) + " GB";
  if (n > 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  return Math.round(n / 1024) + " KB";
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

export function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
