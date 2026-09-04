"use client";

import { useCallback, useEffect, useState } from "react";
import { Section, StatCard, Btn, Skeleton, PageHeader } from "@/components/AdminUI";
// 复用唯一权威的 kind→中文名映射,别再自维护副本(旧副本长期漏 xhs/toc/blog,
// 新增 kind 也会漏 —— drawviso 就是这么被漏掉的)。
import { KIND_LABEL } from "@/components/studio-shared";

type GrowthRow = { day: string; newUsers: number; activeUsers: number };
type ContentRow = { day: string; sources: number; outputs: number; messages: number };
type Data = {
  growth: GrowthRow[];
  kpi: { dau: number; wau: number; d1: number | null; d7: number | null };
  content: ContentRow[];
  outputsByKind: { kind: string; n: number }[];
  discoverByDay: { day: string; n: number }[];
  credits: { day: string; credits: number }[];
  referral: {
    invited: number;
    milestones: number;
    totalCredits: number;
    topInviters: { name: string; invitees: number; credits: number }[];
  };
};

// 系列色:主柱沿用总览的薰衣草渐变,叠加序列用 emerald / amber(与后台语义色一致)。
const C = { purple: "#6d5ae6", green: "#10b981", amber: "#f59e0b", axis: "#e6e7ee", tick: "#9094a0" };

/** 图例圆点。 */
function Dot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink2">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

/** 30 天双序列:柱=新增(薰衣草渐变),折线=活跃(绿)。手写 SVG,零图表库。 */
function GrowthChart({ data }: { data: GrowthRow[] }) {
  const W = 720, H = 150, padB = 16, padT = 8;
  const max = Math.max(...data.map((d) => Math.max(d.newUsers, d.activeUsers)), 1);
  const bw = W / data.length;
  const y = (v: number) => H - padB - (v / max) * (H - padB - padT);
  const line = data.map((d, i) => `${(i * bw + bw / 2).toFixed(1)},${y(d.activeUsers).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="an-grow-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8b78ff" />
          <stop offset="100%" stopColor="#6d5ae6" />
        </linearGradient>
      </defs>
      <line x1={0} x2={W} y1={H - padB} y2={H - padB} stroke={C.axis} />
      {data.map((d, i) => (
        <g key={i}>
          {d.newUsers > 0 && (
            <rect
              x={i * bw + 3}
              y={y(d.newUsers)}
              width={bw - 6}
              height={Math.max(H - padB - y(d.newUsers), 3)}
              rx={3}
              fill="url(#an-grow-grad)"
              opacity={0.85}
            />
          )}
          {i % 5 === 0 && (
            <text x={i * bw + bw / 2} y={H - 3} textAnchor="middle" fontSize={9} fill={C.tick}>
              {d.day}
            </text>
          )}
        </g>
      ))}
      <polyline points={line} fill="none" stroke={C.green} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 30 天三序列分组柱:来源 / 制品 / 提问。 */
function ContentChart({ data }: { data: ContentRow[] }) {
  const W = 720, H = 150, padB = 16, padT = 8;
  const max = Math.max(...data.map((d) => Math.max(d.sources, d.outputs, d.messages)), 1);
  const bw = W / data.length;
  const sw = (bw - 6) / 3; // 每组 3 根子柱
  const y = (v: number) => H - padB - (v / max) * (H - padB - padT);
  const bar = (i: number, slot: number, v: number, fill: string) =>
    v > 0 ? (
      <rect
        x={i * bw + 3 + slot * sw}
        y={y(v)}
        width={Math.max(sw - 1, 1.5)}
        height={Math.max(H - padB - y(v), 2.5)}
        rx={1.5}
        fill={fill}
        opacity={0.85}
      />
    ) : null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" aria-hidden>
      <line x1={0} x2={W} y1={H - padB} y2={H - padB} stroke={C.axis} />
      {data.map((d, i) => (
        <g key={i}>
          {bar(i, 0, d.sources, C.purple)}
          {bar(i, 1, d.outputs, C.green)}
          {bar(i, 2, d.messages, C.amber)}
          {i % 5 === 0 && (
            <text x={i * bw + bw / 2} y={H - 3} textAnchor="middle" fontSize={9} fill={C.tick}>
              {d.day}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/** 30 天单序列小柱图(搜索量 / 积分消耗共用)。 */
function MiniBars({ data, height = 96 }: { data: { day: string; v: number }[]; height?: number }) {
  const H = height, W = 720, padB = 14;
  const max = Math.max(...data.map((d) => d.v), 1);
  const bw = W / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="an-mini-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8b78ff" />
          <stop offset="100%" stopColor="#6d5ae6" />
        </linearGradient>
      </defs>
      <line x1={0} x2={W} y1={H - padB} y2={H - padB} stroke={C.axis} />
      {data.map((d, i) => {
        const v = Math.max(0, d.v); // 积分退回可使净额为负，渲染钳到 0
        const h = (v / max) * (H - padB - 8);
        return (
          <g key={i}>
            <rect
              x={i * bw + 2}
              y={H - padB - h}
              width={bw - 4}
              height={Math.max(h, v > 0 ? 3 : 0)}
              rx={3}
              fill="url(#an-mini-grad)"
              opacity={0.85}
            />
            {i % 5 === 0 && (
              <text x={i * bw + bw / 2} y={H - 2} textAnchor="middle" fontSize={9} fill={C.tick}>
                {d.day}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default function AnalyticsPage() {
  const [d, setD] = useState<Data | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    () => fetch("/api/admin/analytics").then((r) => r.json()).then(setD).catch(() => {}),
    []
  );
  useEffect(() => {
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (!d)
    return (
      <div className="space-y-8">
        <Skeleton className="h-8 w-40" />
        <div className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[96px] w-full rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-56 w-full rounded-2xl" />
        <Skeleton className="h-56 w-full rounded-2xl" />
        <div className="grid grid-cols-1 gap-x-6 gap-y-6 md:grid-cols-2">
          <Skeleton className="h-48 w-full rounded-2xl" />
          <Skeleton className="h-48 w-full rounded-2xl" />
        </div>
      </div>
    );

  const pct = (v: number | null) => (v === null ? "样本不足" : `${v}%`);
  const maxKind = Math.max(...d.outputsByKind.map((k) => k.n), 1);
  const totalDiscover = d.discoverByDay.reduce((s, r) => s + r.n, 0);
  const totalCredits = d.credits.reduce((s, r) => s + r.credits, 0);
  const total30 = (key: "newUsers" | "activeUsers") => d.growth.reduce((s, r) => s + r[key], 0);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="经营洞察"
        title="数据分析"
        desc="查看近 30 天的用户增长、内容生产、留存和推广转化，按东八区自然日统计。"
        actions={<Btn onClick={refresh} disabled={refreshing}>{refreshing ? "刷新中…" : "刷新数据"}</Btn>}
      />

      {/* 核心 KPI:活跃 + 留存 */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-4">
        <StatCard label="今日活跃 DAU" value={d.kpi.dau.toLocaleString()} sub="今日有操作的去重用户数" />
        <StatCard label="周活跃 WAU" value={d.kpi.wau.toLocaleString()} sub="近 7 天有操作的去重用户数" />
        <StatCard label="次日留存" value={pct(d.kpi.d1)} sub="近 14 天新用户次日回访比例" tone={d.kpi.d1 === null ? undefined : d.kpi.d1 >= 30 ? "ok" : d.kpi.d1 >= 10 ? "warn" : "err"} />
        <StatCard label="7 日留存" value={pct(d.kpi.d7)} sub="近 4 周新用户第 7 日回访比例" tone={d.kpi.d7 === null ? undefined : d.kpi.d7 >= 15 ? "ok" : d.kpi.d7 >= 5 ? "warn" : "err"} />
      </div>

      <Section
        title="用户增长"
        desc={`近 30 天:新增 ${total30("newUsers").toLocaleString()} 人 · 活跃峰值 ${Math.max(...d.growth.map((g) => g.activeUsers), 0).toLocaleString()} 人/日`}
        actions={
          <div className="flex gap-3">
            <Dot color={C.purple} label="每日新增(柱)" />
            <Dot color={C.green} label="每日活跃(线)" />
          </div>
        }
      >
        <GrowthChart data={d.growth} />
      </Section>

      <Section
        title="内容生产"
        desc="近 30 天逐日:添加来源 / 生成制品 / 对话提问"
        actions={
          <div className="flex gap-3">
            <Dot color={C.purple} label="来源" />
            <Dot color={C.green} label="制品" />
            <Dot color={C.amber} label="提问" />
          </div>
        }
      >
        <ContentChart data={d.content} />
      </Section>

      <div className="grid grid-cols-1 gap-x-6 gap-y-6 md:grid-cols-2">
        <Section title="制品分布" desc="近 30 天各类型生成量">
          {d.outputsByKind.length === 0 ? (
            <p className="py-3 text-center text-sm text-muted">近 30 天暂无制品生成</p>
          ) : (
            <div className="space-y-2">
              {d.outputsByKind.slice(0, 8).map((k) => (
                <div key={k.kind} className="flex items-center gap-3">
                  <span className="w-16 shrink-0 text-right text-[11.5px] text-ink2">{KIND_LABEL[k.kind] ?? k.kind}</span>
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-panel2">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${(k.n / maxKind) * 100}%` }} />
                  </div>
                  <span className="w-9 shrink-0 text-right text-[11.5px] tabular-nums text-ink2">{k.n}</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="搜索使用量" desc={`近 30 天发现搜索(快速+深度)共 ${totalDiscover.toLocaleString()} 次`}>
          <MiniBars data={d.discoverByDay.map((r) => ({ day: r.day, v: r.n }))} />
        </Section>
      </div>

      <Section title="积分消耗" desc={`近 30 天净消耗 ${totalCredits.toLocaleString()} 积分（退回已冲抵）· 明细见「积分核对」`}>
        <MiniBars data={d.credits.map((r) => ({ day: r.day, v: r.credits }))} height={110} />
      </Section>

      <Section title="邀请推广" desc="推广链接转化(累计口径)· 奖励按里程碑双向返积分">
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-2xl bg-panel2 px-4 py-3">
            <p className="text-xs text-muted">被邀请注册</p>
            <p className="mt-1 text-[22px] font-medium tabular-nums text-ink">{d.referral.invited.toLocaleString()} <span className="text-xs font-normal text-muted">人</span></p>
          </div>
          <div className="rounded-2xl bg-panel2 px-4 py-3">
            <p className="text-xs text-muted">里程碑结算</p>
            <p className="mt-1 text-[22px] font-medium tabular-nums text-ink">{d.referral.milestones.toLocaleString()} <span className="text-xs font-normal text-muted">次</span></p>
          </div>
          <div className="rounded-2xl bg-panel2 px-4 py-3">
            <p className="text-xs text-muted">累计返奖励</p>
            <p className="mt-1 text-[22px] font-medium tabular-nums text-ink">{d.referral.totalCredits.toLocaleString()} <span className="text-xs font-normal text-muted">积分</span></p>
          </div>
        </div>
        <p className="mb-2 mt-4 text-xs font-medium text-ink2">Top 5 邀请人</p>
        {d.referral.topInviters.length === 0 ? (
          <p className="py-2 text-sm text-muted">暂无邀请记录。</p>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-muted">
                <th className="whitespace-nowrap pb-2 pr-6 font-medium">#</th>
                <th className="w-full pb-2 pr-6 font-medium">用户</th>
                <th className="whitespace-nowrap pb-2 pr-6 text-right font-medium">邀请人数</th>
                <th className="whitespace-nowrap pb-2 text-right font-medium">获得奖励</th>
              </tr>
            </thead>
            <tbody>
              {d.referral.topInviters.map((u, i) => (
                <tr key={i} className="border-t border-edge text-ink2 transition hover:bg-panel2/50">
                  <td className="py-2 pr-6 tabular-nums text-muted">{i + 1}</td>
                  <td className="w-full max-w-0 py-2 pr-6"><span className="block truncate font-medium text-ink">{u.name}</span></td>
                  <td className="whitespace-nowrap py-2 pr-6 text-right tabular-nums">{u.invitees}</td>
                  <td className="whitespace-nowrap py-2 text-right tabular-nums">{u.credits.toLocaleString()} 积分</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
