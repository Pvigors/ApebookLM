"use client";

import { useCallback, useEffect, useState } from "react";
import { Section, HourBars, Pill, Btn, Skeleton, StatCard, TableWrap, fmtTime, ago, PageHeader, InlineError, ReadOnlyNotice } from "@/components/AdminUI";
import { useAdminAccess } from "@/components/AdminAccess";
import { toast } from "@/components/Toast";
import { KIND_LABEL } from "@/components/studio-shared";

type Call = { id: number; ts: number; provider: string; model: string; ms: number; ok: number; status: number | null; error: string | null };
type JobRow = {
  id: string; kind: string; status: string; progress: number; error: string | null;
  created_at: number; updated_at: number; notebook: string | null; user_name: string | null;
  lane: "general" | "cad"; priority: number; run_attempt: number;
  credits_reserved: number; credits_final: number; tokens_in: number; tokens_out: number;
  stage?: string | null; started_at?: number; finished_at?: number; stage_started_at?: number;
};
type DurationStats = { count: number; avg: number | null; p50: number | null; p95: number | null; max: number | null };
type CadSummary = { total: number; byStatus: Record<string, number>; byFailureCode: Record<string, number>; byLane: Record<string, number>; queueWaitMs: DurationStats; runDurationMs: DurationStats };
type QueueCounts = Record<string, number>;
type Data = {
  calls: Call[];
  jobs: JobRow[];
  series: { hour: number; total: number; errors: number }[];
  queue: { general: QueueCounts; cad: QueueCounts };
  workers: { general: boolean; cad: boolean };
  refunds: { pending: number; processing: number };
  cad?: CadSummary;
};
type HealthCheck = { name: string; ok: boolean; ms: number; detail: string };

const SYSTEM_KIND_LABEL: Record<string, string> = {
  feed_enum: "订阅源枚举",
  feed_ingest: "订阅源导入",
};

const providerPill = (provider: string): { text: string; tone: "info" | "muted" | "warn" } => {
  if (provider === "gateway") return { text: "网关", tone: "info" };
  if (provider === "primary") return { text: "主", tone: "muted" };
  return { text: provider === "fallback" ? "备" : provider, tone: "warn" };
};

export default function MonitorPage() {
  const { canWrite } = useAdminAccess("monitor");
  const [d, setD] = useState<Data | null>(null);
  const [provider, setProvider] = useState("");
  const [ok, setOk] = useState("");
  const [loadError, setLoadError] = useState("");
  // 接口健康:仅手动触发(探测有真实调用成本,不自动轮询)。
  const [health, setHealth] = useState<HealthCheck[] | null>(null);
  const [checking, setChecking] = useState(false);

  const runHealth = async () => {
    if (!canWrite) return;
    setChecking(true);
    try {
      const r = await fetch("/api/admin/health", { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as { checks?: HealthCheck[]; error?: string };
      if (!r.ok) throw new Error(j.error || "依赖体检失败");
      setHealth(Array.isArray(j.checks) ? j.checks : [{ name: "体检", ok: false, ms: 0, detail: "响应格式异常" }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "依赖体检失败";
      setHealth([{ name: "体检", ok: false, ms: 0, detail: message }]);
      toast(message, "error");
    } finally {
      setChecking(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      if (provider) q.set("provider", provider);
      if (ok) q.set("ok", ok);
      const response = await fetch(`/api/admin/logs?${q}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "监控数据加载失败");
      setD(payload as Data);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "监控数据加载失败");
    }
  }, [provider, ok]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 10000);
    return () => clearInterval(iv);
  }, [load]);

  const retry = async (jobId: string) => {
    if (!canWrite) return;
    try {
      const response = await fetch("/api/admin/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry_job", jobId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || "任务重试失败");
      toast("已重新入队");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "任务重试失败", "error");
    }
  };

  if (!d && loadError) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="运行状态" title="服务监控" desc="监控数据未能加载。" />
        <InlineError message={loadError} onRetry={() => void load()} />
      </div>
    );
  }
  if (!d)
    return (
      <div className="space-y-8">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-[120px] w-full rounded-[22px]" />
        <Skeleton className="h-[330px] w-full rounded-[22px]" />
      </div>
    );

  const seg = (cur: string, set: (v: string) => void, items: [string, string][]) => (
    <div className="flex rounded-full border border-edge bg-panel2 p-0.5">
      {items.map(([v, label]) => (
        <button
          key={v}
          onClick={() => set(v)}
          className={`rounded-full px-3 py-1 text-xs transition ${cur === v ? "bg-accent text-onAccent" : "text-ink2 hover:text-ink"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="运行状态"
        title="服务监控"
        desc="查看模型调用、生成任务和依赖服务状态，页面每 10 秒自动刷新。"
        actions={<div className="flex flex-wrap gap-2">
          {seg(provider, setProvider, [["", "全部通道"], ["gateway", "网关"], ["primary", "主"], ["fallback", "备"]])}
          {seg(ok, setOk, [["", "全部"], ["ok", "成功"], ["err", "失败"]])}
        </div>}
      />

      {!canWrite && (
        <ReadOnlyNotice>当前角色可查看调用、任务和依赖状态，体检与任务重试仅限有监控写权限的角色。</ReadOnlyNotice>
      )}
      {loadError && <InlineError message={loadError} onRetry={() => void load()} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="通用任务队列"
          value={(Number(d.queue?.general?.queued ?? 0) + Number(d.queue?.general?.running ?? 0)).toLocaleString()}
          tone={d.workers?.general ? "ok" : "warn"}
          sub={`${d.workers?.general ? "worker 已开启" : "worker 已关闭"} · 运行 ${Number(d.queue?.general?.running ?? 0)} / 排队 ${Number(d.queue?.general?.queued ?? 0)}`}
        />
        <StatCard
          label="CAD 任务队列"
          value={(Number(d.queue?.cad?.queued ?? 0) + Number(d.queue?.cad?.running ?? 0)).toLocaleString()}
          tone={d.workers?.cad ? "ok" : "warn"}
          sub={`${d.workers?.cad ? "独立 worker 已就绪" : "CAD 领取已暂停"} · 运行 ${Number(d.queue?.cad?.running ?? 0)} / 排队 ${Number(d.queue?.cad?.queued ?? 0)}`}
        />
        <StatCard
          label="积分退回队列"
          value={(Number(d.refunds?.pending ?? 0) + Number(d.refunds?.processing ?? 0)).toLocaleString()}
          tone={Number(d.refunds?.pending ?? 0) > 0 ? "warn" : "ok"}
          sub={`待处理 ${Number(d.refunds?.pending ?? 0)} / 处理中 ${Number(d.refunds?.processing ?? 0)}`}
        />
        <StatCard
          label="失败任务"
          value={(Number(d.queue?.general?.error ?? 0) + Number(d.queue?.cad?.error ?? 0)).toLocaleString()}
          tone={(Number(d.queue?.general?.error ?? 0) + Number(d.queue?.cad?.error ?? 0)) > 0 ? "err" : "ok"}
          sub="当前保留的失败任务，可在下方查看错误"
        />
      </div>

      <Section
        title="接口健康"
        desc="内网网关 · 主/备接口 · Docling · Crawl4AI · 搜索 · TTS · 数据库 · 任务 worker · CAD 基础内核 · Text2CAD 参数化链 · 磁盘；部分探测有真实调用成本，仅手动触发"
        actions={canWrite ? (
          <Btn kind="primary" disabled={checking} onClick={runHealth}>
            {checking ? "体检中…" : "全部体检"}
          </Btn>
        ) : undefined}
      >
        {checking && !health ? (
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-7 w-32 rounded-full" />)}
          </div>
        ) : health ? (
          <div className="flex flex-wrap gap-2">
            {health.map((c) => {
              const skipped = c.detail.includes("跳过");
              return (
                <span
                  key={c.name}
                  title={c.detail}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-edge bg-panel2/60 px-3 py-1 text-xs"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${skipped ? "bg-edge" : c.ok ? "bg-emerald-500" : "bg-red-500"}`}
                    aria-hidden
                  />
                  <span className={"font-medium " + (skipped ? "text-muted" : "text-ink")}>{c.name}</span>
                  {!skipped && <span className="tabular-nums text-muted">{c.ms}ms</span>}
                  <span className="max-w-[200px] truncate text-muted">{c.detail}</span>
                </span>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted">尚未体检 —— 点右上「全部体检」并行探测所有依赖(每项 8 秒超时,单项故障不影响其余)。</p>
        )}
      </Section>

      <Section title="24 小时调用趋势" desc="紫色=调用量,红色=失败">
        <HourBars series={d.series} height={100} />
      </Section>

      <Section title="CAD 发布门禁（24 小时）" desc="数据来自真实车道、阶段与终态时间；旧任务不伪造 0ms 样本">
        {d.cad ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl bg-panel2/60 p-3"><p className="text-xs text-muted">总任务</p><p className="mt-1 text-xl font-semibold text-ink">{d.cad.total}</p></div>
            <div className="rounded-xl bg-panel2/60 p-3"><p className="text-xs text-muted">排队 P95</p><p className="mt-1 text-xl font-semibold text-ink">{d.cad.queueWaitMs.p95 == null ? "-" : `${(d.cad.queueWaitMs.p95 / 1000).toFixed(1)}s`}</p></div>
            <div className="rounded-xl bg-panel2/60 p-3"><p className="text-xs text-muted">运行 P95</p><p className="mt-1 text-xl font-semibold text-ink">{d.cad.runDurationMs.p95 == null ? "-" : `${(d.cad.runDurationMs.p95 / 1000).toFixed(1)}s`}</p></div>
            <div className="rounded-xl bg-panel2/60 p-3"><p className="text-xs text-muted">终态</p><p className="mt-1 text-sm font-medium text-ink">{Object.entries(d.cad.byStatus).map(([key, value]) => `${key} ${value}`).join(" · ") || "-"}</p></div>
            <div className="rounded-xl bg-panel2/60 p-3 sm:col-span-2 lg:col-span-4"><p className="text-xs text-muted">失败码</p><p className="mt-1 break-words text-sm text-ink2">{Object.entries(d.cad.byFailureCode).map(([key, value]) => `${key} ${value}`).join(" · ") || "无"}</p></div>
          </div>
        ) : <p className="text-xs text-muted">暂无 CAD 观测数据。</p>}
      </Section>

      <Section title={`模型调用日志(${d.calls.length})`} desc="逐条请求：通道 / 模型 / 耗时 / 结果（错误已脱敏）">
        <div className="max-h-[330px] overflow-y-auto">
          <TableWrap minWidth={760}><table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 bg-panel">
              <tr className="text-muted">
                <th className="whitespace-nowrap pb-2 pr-6 font-medium">时间</th>
                <th className="whitespace-nowrap pb-2 pr-6 font-medium">通道</th>
                <th className="whitespace-nowrap pb-2 pr-6 font-medium">模型</th>
                <th className="whitespace-nowrap pb-2 pr-6 text-right font-medium">耗时</th>
                <th className="whitespace-nowrap pb-2 pr-6 font-medium">结果</th>
                <th className="w-full pb-2 font-medium">错误</th>
              </tr>
            </thead>
            <tbody>
              {d.calls.map((c) => {
                const channel = providerPill(c.provider);
                return (
                <tr key={c.id} className="border-t border-edge text-ink2 transition hover:bg-panel2/50">
                  <td className="whitespace-nowrap py-1.5 pr-6 tabular-nums">{fmtTime(c.ts)}</td>
                  <td className="whitespace-nowrap py-1.5 pr-6">
                    <Pill text={channel.text} tone={channel.tone} />
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-6">{c.model}</td>
                  <td className="whitespace-nowrap py-1.5 pr-6 text-right tabular-nums">{(c.ms / 1000).toFixed(1)}s</td>
                  <td className="whitespace-nowrap py-1.5 pr-6">
                    <Pill text={c.ok ? "成功" : `失败${c.status ? " " + c.status : ""}`} tone={c.ok ? "ok" : "err"} />
                  </td>
                  <td className="w-full max-w-0 py-1.5" title={c.error ?? ""}><span className="block truncate">{c.error ?? "-"}</span></td>
                </tr>
                );
              })}
              {d.calls.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-muted">暂无记录</td></tr>
              )}
            </tbody>
          </table></TableWrap>
        </div>
      </Section>

      <Section
        title="任务队列(最近 40)"
        desc={canWrite ? "失败任务可一键重试" : "只读查看任务状态与错误信息"}
      >
        <TableWrap minWidth={1080}><table className="w-full text-left text-[13px]">
          <thead>
            <tr className="text-muted">
              <th className="whitespace-nowrap pb-2 pr-5 font-medium">队列</th>
              <th className="whitespace-nowrap pb-2 pr-6 font-medium">类型</th>
              <th className="whitespace-nowrap pb-2 pr-6 font-medium">笔记本</th>
              <th className="whitespace-nowrap pb-2 pr-6 font-medium">状态</th>
              <th className="whitespace-nowrap pb-2 pr-6 font-medium">代次 / 优先级</th>
              <th className="whitespace-nowrap pb-2 pr-6 font-medium">积分 / Token</th>
              <th className="whitespace-nowrap pb-2 pr-6 font-medium">心跳</th>
              <th className="w-full pb-2 pr-6 font-medium">错误</th>
              <th className="pb-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {d.jobs.map((j) => (
              <tr key={j.id} className="border-t border-edge text-ink2 transition hover:bg-panel2/50">
                <td className="whitespace-nowrap py-1.5 pr-5"><Pill text={j.lane === "cad" ? "CAD" : "通用"} tone={j.lane === "cad" ? "info" : "muted"} /></td>
                <td className="whitespace-nowrap py-1.5 pr-6 font-medium text-ink">{KIND_LABEL[j.kind] ?? SYSTEM_KIND_LABEL[j.kind] ?? j.kind}</td>
                <td className="max-w-[200px] py-1.5 pr-6"><span className="block truncate">{j.notebook ?? "-"}</span><span className="block truncate text-[11px] text-muted">{j.user_name ?? "系统任务"}</span></td>
                <td className="whitespace-nowrap py-1.5 pr-6">
                  <Pill
                    text={j.status === "done" ? "完成" : j.status === "running" ? `运行 ${j.progress}%` : j.status === "queued" ? "排队" : j.status === "draft" ? "待扣费" : j.status === "canceled" ? "已取消" : "失败"}
                    tone={j.status === "done" ? "ok" : j.status === "error" ? "err" : j.status === "canceled" ? "muted" : "warn"}
                  />
                </td>
                <td className="whitespace-nowrap py-1.5 pr-6 tabular-nums">#{Number(j.run_attempt ?? 0)} / {Number(j.priority ?? 0)}</td>
                <td className="whitespace-nowrap py-1.5 pr-6 tabular-nums">{(j.status === "done" ? Number(j.credits_final ?? 0) : Number(j.credits_reserved ?? 0))} 分 / {(Number(j.tokens_in ?? 0) + Number(j.tokens_out ?? 0)).toLocaleString()}</td>
                <td className="whitespace-nowrap py-1.5 pr-6 tabular-nums" title={`创建 ${fmtTime(j.created_at)}`}>{ago(j.updated_at)}</td>
                <td className="w-full max-w-0 py-1.5 pr-6" title={j.error ?? ""}><span className="block truncate">{j.error ?? "-"}</span></td>
                <td className="py-1.5 text-right">
                  {canWrite && j.status === "error" && <Btn onClick={() => retry(j.id)}>重试</Btn>}
                </td>
              </tr>
            ))}
            {d.jobs.length === 0 && (
              <tr><td colSpan={9} className="py-6 text-center text-muted">暂无任务</td></tr>
            )}
          </tbody>
        </table></TableWrap>
      </Section>
    </div>
  );
}
