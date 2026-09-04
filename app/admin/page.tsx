"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { KpiCard, Section, HourBars, Pill, Skeleton, TableWrap, PageHeader, InlineError, fmtBytes, fmtTime, ago } from "@/components/AdminUI";
import { useAdminAccess } from "@/components/AdminAccess";
import { KIND_LABEL } from "@/components/studio-shared";
import { actionLabel, KIND_CN as ACTOR_KIND_CN, KIND_TONE } from "@/lib/activity-labels";
import type { ActivityEvent } from "@/lib/types";

type Overview = {
  counts: { users: number; notebooks: number; sources: number; notes: number; outputs: number; activeUsers7d: number };
  calls24h: { total: number; errors: number; fallback: number; p50: number; p95: number };
  jobs: { status: string; n: number }[];
  outputsByKind: { kind: string; n: number }[];
  recentErrors: { ts: number; provider: string; model: string; status: number | null; error: string | null }[];
  feedback: { up: number; down: number };
  recentDown: { notebook_id: string; content?: string; created_at: number; title: string | null }[];
  recentActivity: ActivityEvent[];
  deltas: { users: number; notebooks: number; sources: number; outputs: number; calls: number; successPp: number; p95Ms: number };
  spark: { users: number[]; notebooks: number[]; sources: number[]; outputs: number[]; calls: number[] };
  series: { hour: number; total: number; errors: number }[];
  usage: { days: number; providers: { provider: string; used: number; calls: number; budget: number; ratio: number; level: "none" | "ok" | "warn" | "over" }[] };
  dbSize: number;
  provider: {
    primaryBase: string;
    primaryModel: string;
    fallbackBase: string | null;
    gatewayBase: string | null;
    gatewayModel: string;
  };
  uptimeSec: number;
};

// 环比 delta:正数=good(成功率/计数);p95 反向(降=good)。
const pctDelta = (v: number, invert = false) => {
  const good = v === 0 ? null : invert ? v < 0 : v > 0;
  return { text: `${Math.abs(v).toFixed(1)}%`, note: "较昨日", good, up: v === 0 ? undefined : v > 0 };
};

const providerLabel = (provider: string, compact = false) => {
  if (provider === "gateway") return compact ? "网关" : "内网网关";
  if (provider === "primary") return compact ? "主" : "主接口";
  if (provider === "fallback") return compact ? "备" : "备用接口";
  return provider;
};

export default function AdminDashboard() {
  const [d, setD] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { modules } = useAdminAccess();
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/overview");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "运营数据加载失败");
      setD(data as Overview);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "运营数据加载失败");
    }
  }, []);
  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 15000);
    return () => clearInterval(iv);
  }, [load]);
  if (!d && error) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="运营工作台" title="运营总览" desc="暂时无法读取后台数据。" />
        <InlineError message={error} onRetry={() => void load()} />
      </div>
    );
  }
  if (!d)
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="运营工作台" title="运营总览" desc="正在汇总用户、内容、收入与服务运行数据…" />
        <Skeleton className="h-11 w-full rounded-2xl" />
        <div className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[120px] w-full rounded-2xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-6 md:grid-cols-2">
          <Skeleton className="h-56 w-full rounded-2xl" />
          <Skeleton className="h-56 w-full rounded-2xl" />
        </div>
      </div>
    );

  const okRate = d.calls24h.total
    ? Math.round(((d.calls24h.total - d.calls24h.errors) / d.calls24h.total) * 100)
    : 100;
  const failRate = d.calls24h.total ? (d.calls24h.errors / d.calls24h.total) * 100 : 0;
  const jobMap = Object.fromEntries(d.jobs.map((j) => [j.status, j.n]));
  const maxKind = Math.max(...d.outputsByKind.map((k) => k.n), 1);
  const upH = Math.floor(d.uptimeSec / 3600);
  const upM = Math.floor((d.uptimeSec % 3600) / 60);
  // 主接口健康由近 24h 真实失败率推断(无调用=待命),不再写死「正常」。
  const primaryHealth =
    d.calls24h.total === 0
      ? { dot: "bg-muted", val: "待命", ping: false }
      : failRate > 20
      ? { dot: "bg-red-500", val: "异常", ping: false }
      : failRate > 5
      ? { dot: "bg-amber-500", val: "降级", ping: false }
      : { dot: "bg-emerald-500", val: "正常", ping: true };
  const quickItems = [
    { href: "/admin/users", module: "users", icon: "👥", title: "管理用户", desc: "账户、笔记本与通知" },
    { href: "/admin/monitor", module: "monitor", icon: "↗", title: "服务监控", desc: "调用、任务与错误" },
    { href: "/admin/providers", module: "providers", icon: "⚙", title: "外部服务", desc: "模型、搜索、语音与解析" },
  ].filter((item) => modules.includes(item.module));

  return (
    <div className="space-y-6 sm:space-y-8">
      <PageHeader
        eyebrow="运营工作台"
        title="运营数据总览"
        desc={`当前进程已运行 ${upH} 小时 ${upM} 分钟；调用、队列与经营数据每 15 秒自动刷新，依赖健康以「服务监控」体检结果为准。`}
        actions={
          <div className="flex items-center gap-2 rounded-full border border-edge bg-panel px-3 py-2 text-xs text-ink2">
          <span className="relative flex h-2 w-2">
            {primaryHealth.ping && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            )}
            <span className={"relative inline-flex h-2 w-2 rounded-full " + primaryHealth.dot} />
          </span>
          {d.provider.gatewayBase ? "网关服务" : "主服务"}{" "}
          <b className="max-w-[180px] truncate font-medium text-ink">
            {d.provider.gatewayBase ? d.provider.gatewayModel : d.provider.primaryModel}
          </b>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {quickItems.map((item) => (
          <Link key={item.href} href={item.href} className="group flex items-center gap-3 rounded-2xl border border-edge bg-panel px-4 py-3 transition hover:-translate-y-0.5 hover:border-accent/35 hover:shadow-sm">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accentSoft text-sm font-semibold text-accent">{item.icon}</span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink">{item.title}</span>
              <span className="block truncate text-[11px] text-muted">{item.desc}</span>
            </span>
            <span className="ml-auto text-muted transition group-hover:translate-x-0.5 group-hover:text-accent">›</span>
          </Link>
        ))}
      </div>

      {/* API 额度预警:任一通道近 N 天 token 用量达预算 80%/100% 时置顶提醒 */}
      {d.usage?.providers.some((p) => p.level === "over" || p.level === "warn") && (
        <div
          className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border px-4 py-3 text-sm ${
            d.usage.providers.some((p) => p.level === "over")
              ? "border-red-300 bg-red-50 text-red-600"
              : "border-amber-300 bg-amber-50 text-amber-700"
          }`}
        >
          <b>模型服务额度预警：</b>
          <span>
            {d.usage.providers
              .filter((p) => p.level === "over" || p.level === "warn")
              .map((p) => `${providerLabel(p.provider)}近 ${d.usage.days} 天已用 ${Math.round(p.ratio * 100)}%`)
              .join(" · ")}
            ，请及时充值或调高预算，以免额度用尽中断服务。
          </span>
          {modules.includes("providers") ? (
            <Link href="/admin/providers" className="font-medium underline">去配置 →</Link>
          ) : (
            <span className="font-medium">请联系系统管理员调整预算</span>
          )}
        </div>
      )}

      {/* 健康总览条 */}
      <div className="flex flex-wrap items-center gap-x-7 gap-y-2 rounded-2xl border border-edge/70 bg-panel2/75 px-4 py-3">
        {[
          d.provider.gatewayBase
            ? { dot: "bg-accent", label: "内网网关", val: "已启用" }
            : { dot: "bg-muted", label: "内网网关", val: "未启用" },
          { dot: primaryHealth.dot, label: "主接口", val: primaryHealth.val },
          d.provider.fallbackBase
            ? { dot: "bg-emerald-500", label: "备用接口", val: "待命" }
            : { dot: "bg-muted", label: "备用接口", val: "未配置" },
          { dot: failRate > 1 ? "bg-amber-500" : "bg-emerald-500", label: "失败率", val: failRate.toFixed(1) + "%" },
          { dot: (jobMap.error ?? 0) > 0 ? "bg-red-500" : "bg-emerald-500", label: "失败任务", val: String(jobMap.error ?? 0) },
        ].map((h, i) => (
          <span key={i} className="inline-flex items-center gap-2 text-xs text-ink2">
            <span className={"h-1.5 w-1.5 rounded-full " + h.dot} />
            {h.label} <span className="tabular-nums text-ink">{h.val}</span>
          </span>
        ))}
      </div>

      {/* 核心指标 —— 大号 + sparkline + 环比,整卡可下钻 */}
      <div>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">核心指标</h2>
            <p className="mt-0.5 text-xs text-muted">用户规模、内容沉淀与服务表现</p>
          </div>
          <Link href="/admin/analytics" className="text-xs font-medium text-accent hover:underline">查看完整分析 →</Link>
        </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="用户" value={d.counts.users.toLocaleString()} delta={pctDelta(d.deltas.users)} spark={d.spark.users} href="/admin/users" />
        <KpiCard label="笔记本" value={d.counts.notebooks.toLocaleString()} delta={pctDelta(d.deltas.notebooks)} spark={d.spark.notebooks} href="/admin/users" />
        <KpiCard label="来源" value={d.counts.sources.toLocaleString()} delta={pctDelta(d.deltas.sources)} spark={d.spark.sources} href="/admin/users" />
        <KpiCard label="制品" value={d.counts.outputs.toLocaleString()} delta={pctDelta(d.deltas.outputs)} spark={d.spark.outputs} href="/admin/users" />
        <KpiCard label="笔记" value={d.counts.notes.toLocaleString()} href="/admin/users" />
        <KpiCard
          label="24h 调用"
          value={d.calls24h.total.toLocaleString()}
          delta={{ text: `${Math.abs(d.deltas.calls).toFixed(1)}%`, note: "较前24h", good: d.deltas.calls === 0 ? null : d.deltas.calls > 0, up: d.deltas.calls === 0 ? undefined : d.deltas.calls > 0 }}
          spark={d.spark.calls}
          href="/admin/monitor"
        />
        <KpiCard
          label="成功率"
          value={okRate + "%"}
          delta={{ text: `${Math.abs(d.deltas.successPp).toFixed(1)}pp`, note: "较前24h", good: d.deltas.successPp === 0 ? null : d.deltas.successPp > 0, up: d.deltas.successPp === 0 ? undefined : d.deltas.successPp > 0 }}
          href="/admin/monitor"
        />
        <KpiCard
          label="延迟 p95"
          value={(d.calls24h.p95 / 1000).toFixed(1) + "s"}
          delta={{ text: `${Math.abs(d.deltas.p95Ms / 1000).toFixed(1)}s`, note: "较前24h", good: d.deltas.p95Ms === 0 ? null : d.deltas.p95Ms < 0, up: d.deltas.p95Ms === 0 ? undefined : d.deltas.p95Ms > 0 }}
          href="/admin/monitor"
        />
        <KpiCard label="PostgreSQL" value={fmtBytes(d.dbSize)} delta={{ text: `${d.counts.activeUsers7d} 人`, note: "7 日活跃", good: null }} />
      </div>
      </div>

      {/* API Key 用量 / 近30天滚动预算 */}
      {d.usage?.providers.some((p) => p.budget > 0 || p.used > 0) && (
        <Section title="模型服务用量" desc={`近 ${d.usage.days} 天 token 用量与滚动预算（在「模型与外部服务」页设置，0 表示不限额）`}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {d.usage.providers
              .filter((p) => p.budget > 0 || p.used > 0)
              .map((p) => {
                const pctNum = p.budget > 0 ? Math.min(100, Math.round(p.ratio * 100)) : 0;
                const bar = p.level === "over" ? "bg-red-500" : p.level === "warn" ? "bg-amber-500" : "bg-emerald-500";
                return (
                  <div key={p.provider} className="rounded-2xl border border-edge bg-panel p-4">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-medium text-ink">{providerLabel(p.provider)}</span>
                      <span className="text-xs text-muted">{p.calls.toLocaleString()} 次调用</span>
                    </div>
                    <div className="mt-1.5 text-lg font-semibold tabular-nums text-ink">
                      {p.used.toLocaleString()}
                      <span className="text-sm font-normal text-muted"> {p.budget > 0 ? `/ ${p.budget.toLocaleString()} tokens` : "tokens · 未设预算"}</span>
                    </div>
                    {p.budget > 0 && (
                      <>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-panel2">
                          <div className={`h-full rounded-full ${bar}`} style={{ width: `${pctNum}%` }} />
                        </div>
                        <p className={`mt-1.5 text-xs ${p.level === "over" ? "text-red-500" : p.level === "warn" ? "text-amber-600" : "text-muted"}`}>
                          已用 {pctNum}%{p.level === "over" ? " · 已超滚动预算" : p.level === "warn" ? " · 接近上限" : ""}
                        </p>
                      </>
                    )}
                  </div>
                );
              })}
          </div>
        </Section>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Section title="24 小时模型调用" desc="紫色为调用量，红色为失败量">
          <HourBars series={d.series} />
        </Section>
        <Section title="生成任务（24 小时）" desc="后台任务队列状态分布">
          <div className="flex flex-wrap gap-2.5 pb-2">
            <Pill text={`完成 ${jobMap.done ?? 0}`} tone="ok" />
            <Pill text={`运行中 ${jobMap.running ?? 0}`} tone="warn" />
            <Pill text={`排队 ${jobMap.queued ?? 0}`} tone="muted" />
            <Pill text={`失败 ${jobMap.error ?? 0}`} tone={(jobMap.error ?? 0) > 0 ? "err" : "muted"} />
          </div>
          <p className="mb-2 mt-3 text-xs font-medium text-ink2">制品分布(累计)</p>
          <div className="max-w-[460px] space-y-2">
            {d.outputsByKind.slice(0, 6).map((k) => (
              <div key={k.kind} className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-right text-[11.5px] text-ink2">{KIND_LABEL[k.kind] ?? k.kind}</span>
                <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-panel2">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${(k.n / maxKind) * 100}%` }} />
                </div>
                <span className="w-7 shrink-0 text-right text-[11.5px] tabular-nums text-ink2">{k.n}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <Section title="最近失败" desc="最近 5 条模型调用错误，敏感信息已脱敏">
        {d.recentErrors.length === 0 ? (
          <p className="py-2 text-sm text-muted">暂无失败记录,服务运行平稳。</p>
        ) : (
          <TableWrap minWidth={720}><table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-muted">
                <th className="whitespace-nowrap pb-2 pr-6 font-medium">时间</th>
                <th className="whitespace-nowrap pb-2 pr-6 font-medium">通道</th>
                <th className="whitespace-nowrap pb-2 pr-6 font-medium">模型</th>
                <th className="whitespace-nowrap pb-2 pr-6 font-medium">状态</th>
                <th className="w-full pb-2 font-medium">错误</th>
              </tr>
            </thead>
            <tbody>
              {d.recentErrors.map((e, i) => (
                <tr key={i} className="border-t border-edge text-ink2 transition hover:bg-panel2/50">
                  <td className="whitespace-nowrap py-2 pr-6 tabular-nums">{fmtTime(e.ts)}</td>
                  <td className="py-2 pr-6">{providerLabel(e.provider, true)}</td>
                  <td className="whitespace-nowrap py-2 pr-6">{e.model}</td>
                  <td className="py-2 pr-6">{e.status ?? "-"}</td>
                  <td className="w-full max-w-0 py-2" title={e.error ?? ""}><span className="block truncate">{e.error}</span></td>
                </tr>
              ))}
            </tbody>
          </table></TableWrap>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {modules.includes("audit") && (
          <Section
            title="最近活动"
            desc="登录 / 内容 / 管理操作"
            actions={
              <Link href="/admin/activity" className="text-xs font-medium text-accent hover:underline">
                查看全部 →
              </Link>
            }
          >
            {(d.recentActivity ?? []).length === 0 ? (
              <p className="py-3 text-center text-sm text-muted">暂无活动记录</p>
            ) : (
              <ul className="space-y-1.5">
                {d.recentActivity.map((ev) => (
                  <li key={ev.id} className="flex items-center gap-2 text-[13px]">
                    <Pill text={ACTOR_KIND_CN[ev.actor_kind] ?? ev.actor_kind} tone={KIND_TONE[ev.actor_kind] ?? "muted"} />
                    <span className="text-ink">{ev.actor_name ?? "—"}</span>
                    <span className="text-ink2">{actionLabel(ev.action)}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-muted" title={fmtTime(ev.ts)}>
                      {ago(ev.ts)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        <Section title="答案反馈" desc={`赞 ${d.feedback?.up ?? 0} · 踩 ${d.feedback?.down ?? 0} —— 最近被点踩的回答`}>
          {(d.recentDown ?? []).length === 0 ? (
            <p className="py-2 text-sm text-muted">暂无点踩,回答质量良好。</p>
          ) : (
            <ul className="space-y-2">
              {d.recentDown.map((m, i) => (
                <li key={i} className="text-[13px]">
                  <Link
                    href={`/admin/notebooks/${m.notebook_id}`}
                    className="font-medium text-ink transition hover:text-accent hover:underline"
                  >
                    {m.title ?? "(未命名笔记本)"}
                  </Link>
                  <p className="mt-0.5 line-clamp-2 text-ink2">
                    {m.content ?? "回答正文已按审计权限隐藏"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
