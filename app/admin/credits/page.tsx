"use client";

import { useCallback, useEffect, useState } from "react";
import { Section, KpiCard, Skeleton, EmptyState, Btn, PageHeader, InlineError, ReadOnlyNotice } from "@/components/AdminUI";
import { useAdminAccess } from "@/components/AdminAccess";
import { toast } from "@/components/Toast";

type OpRow = { op: string; label: string; credits: number; count: number; estCostCNY: number | null };
type ModelRow = { model: string; tokens_in: number; tokens_out: number; calls: number; costCNY: number };
type Data = {
  days: number;
  anchorCNY: number;
  breakEvenCNY: number;
  totalCredits: number;
  totalCostCNY: number;
  costPerCredit: number | null;
  costCalculable: boolean;
  costWindowDays: number;
  losing: boolean;
  aboveTarget: boolean;
  byOp: OpRow[];
  byDay: { day: number; credits: number }[];
  byModel: ModelRow[];
  topUsers: { user_id: string; name: string; credits: number }[];
  priceTable: { key: string; op: string; label: string; credits: number }[];
};

const fmt = (n: number) => n.toLocaleString("zh-CN");
const yuan = (n: number) => `¥${n.toFixed(n >= 100 ? 0 : n >= 1 ? 2 : 4)}`;

/** 积分对账:积分消费净额 vs 模型成本快照；经营目标与现金盈亏线分开。 */
export default function CreditsPage() {
  const { canWrite } = useAdminAccess("credits");
  const [d, setD] = useState<Data | null>(null);
  const [days, setDays] = useState(7);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/credits?days=${days}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "积分对账加载失败");
      setD(payload as Data);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "积分对账加载失败");
    }
  }, [days]);
  useEffect(() => {
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [load]);

  const savePrices = async () => {
    if (!canWrite || !Object.keys(edits).length) return;
    try {
      const response = await fetch("/api/admin/credits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ set: edits }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        applied?: string[];
      };
      const applied = new Set(payload.applied ?? []);
      const expected = Object.entries(edits).map(([key, value]) => value.trim() ? key : `-${key}`);
      if (!response.ok || payload.ok !== true || expected.some((key) => !applied.has(key))) {
        throw new Error(payload.error || "积分权重未完整保存，请检查输入");
      }
      setEdits({});
      toast("已保存，下一次调用即按新权重计量");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "积分权重保存失败", "error");
    }
  };

  if (!d && loadError) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="成本与用量" title="积分核对" desc="用量数据未能加载。" />
        <InlineError message={loadError} onRetry={() => void load()} />
      </div>
    );
  }
  if (!d) return <div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;

  const maxDay = Math.max(1, ...d.byDay.map((x) => x.credits));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="成本与用量"
        title="积分核对"
        desc="对照积分账本与模型成本快照，识别成本优化空间与严重超预算风险。搜索、TTS、存储等成本需另行计入。"
        actions={<div className="flex items-center gap-1.5 rounded-xl bg-panel2 p-1 text-[12.5px]">
          {[7, 14, 30].map((n) => (
            <button
              key={n}
              onClick={() => setDays(n)}
              className={`rounded-lg px-2.5 py-1 transition ${days === n ? "bg-accent text-onAccent" : "bg-panel2 text-ink2 hover:text-ink"}`}
            >
              近 {n} 天
            </button>
          ))}
        </div>}
      />

      {!canWrite && (
        <ReadOnlyNotice>当前角色可查看积分与成本，用量权重调整仅限系统管理员。</ReadOnlyNotice>
      )}
      {loadError && <InlineError message={loadError} onRetry={() => void load()} />}

      {/* 双阈值：目标成本用于日常优化，硬上限用于严重超预算预警。 */}
      {!d.costCalculable ? (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px] font-medium text-amber-700">
          △ 暂无法判断成本达标：近 {d.costWindowDays} 天有效净消费积分小于或等于 0
          {d.totalCostCNY > 0 ? `，但已发生模型成本 ${yuan(d.totalCostCNY)}` : ""}。请检查积分退回与 Token 结算窗口，不得按 ¥0 视为达标。
        </div>
      ) : d.losing ? (
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-600">
          ⚠ 严重超预算：每积分模型成本 {yuan(d.costPerCredit!)} 已超过硬成本上限 {yuan(d.breakEvenCNY)}。
          请在下方「用量权重」提高高成本操作的积分权重（保存即生效），或下调模型档位。
        </div>
      ) : d.aboveTarget ? (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px] font-medium text-amber-700">
          △ 成本高于目标：每积分模型成本 {yuan(d.costPerCredit!)} 高于目标 {yuan(d.anchorCNY)}，但尚未超过硬上限 {yuan(d.breakEvenCNY)}。
        </div>
      ) : (
        <div className="rounded-2xl border border-green-600/30 bg-green-500/10 px-4 py-3 text-[13px] font-medium text-green-700">
          ✓ 达标：每积分模型成本 {yuan(d.costPerCredit!)} ≤ 目标 {yuan(d.anchorCNY)}（近 {d.costWindowDays} 天窗口）。
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={`积分消耗(${d.days}天)`} value={fmt(d.totalCredits)} />
        <KpiCard label="模型成本快照(7天)" value={yuan(d.totalCostCNY)} />
        <KpiCard label="每积分成本" value={d.costPerCredit == null ? "无法计算" : yuan(d.costPerCredit)} />
        <KpiCard label="目标 / 硬成本上限" value={`${yuan(d.anchorCNY)} / ${yuan(d.breakEvenCNY)}`} />
      </div>

      {/* 近 14 天积分曲线 */}
      <Section title="每日积分消耗(东八区日切)">
        {d.byDay.length === 0 ? (
          <EmptyState title="暂无数据" hint="产生生成消耗后这里会出现曲线" />
        ) : (
          <div className="flex h-28 items-end gap-1.5 px-1">
            {d.byDay.map((x) => (
              <div key={x.day} className="group relative flex-1">
                <div
                  className="rounded-t-md bg-accent/70 transition group-hover:bg-accent"
                  style={{ height: `${Math.max(3, (x.credits / maxDay) * 100)}px` }}
                />
                <div className="absolute -top-6 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-solid px-1.5 py-0.5 text-[10.5px] text-onSolid group-hover:block">
                  {fmt(x.credits)} 分
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 按操作 */}
        <Section title={`按操作(${d.days}天净积分 / 成本按近${d.costWindowDays}天净消费分摊估算)`}>
          {d.byOp.length === 0 ? (
            <EmptyState title="暂无消耗" hint="credit_ledger 尚无记录" />
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1.5 font-medium">操作</th>
                  <th className="py-1.5 text-right font-medium">次数</th>
                  <th className="py-1.5 text-right font-medium">积分</th>
                  <th className="py-1.5 text-right font-medium">est.成本</th>
                </tr>
              </thead>
              <tbody>
                {d.byOp.map((r) => (
                  <tr key={r.op} className="border-t border-edge/70">
                    <td className="py-1.5">{r.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(r.count)}</td>
                    <td className="py-1.5 text-right tabular-nums font-medium">{fmt(r.credits)}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink2">{r.estCostCNY == null ? "—" : yuan(r.estCostCNY)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        {/* 按模型真实成本 */}
        <Section title="按模型成本快照(7天,单次请求阶梯价)">
          {d.byModel.length === 0 ? (
            <EmptyState title="暂无调用" hint="ai_calls 近 7 天无成功调用" />
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1.5 font-medium">模型</th>
                  <th className="py-1.5 text-right font-medium">调用</th>
                  <th className="py-1.5 text-right font-medium">in/out tokens</th>
                  <th className="py-1.5 text-right font-medium">成本</th>
                </tr>
              </thead>
              <tbody>
                {d.byModel.map((m) => (
                  <tr key={m.model} className="border-t border-edge/70">
                    <td className="max-w-[140px] truncate py-1.5" title={m.model}>{m.model}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(m.calls)}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink2">{fmt(m.tokens_in)} / {fmt(m.tokens_out)}</td>
                    <td className="py-1.5 text-right tabular-nums font-medium">{yuan(m.costCNY)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        {/* Top 用户 */}
        <Section title={`积分消耗 Top 用户(${d.days}天,防滥用排查)`}>
          {d.topUsers.length === 0 ? (
            <EmptyState title="暂无数据" hint="" />
          ) : (
            <table className="w-full text-[12.5px]">
              <tbody>
                {d.topUsers.map((u, i) => (
                  <tr key={u.user_id} className={i ? "border-t border-edge/70" : ""}>
                    <td className="w-7 py-1.5 text-muted">{i + 1}</td>
                    <td className="py-1.5">{u.name}</td>
                    <td className="py-1.5 text-right tabular-nums font-medium">{fmt(u.credits)} 分</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        {/* 用量权重：系统管理员可编辑，其余后台角色只读。 */}
        <Section title={canWrite ? "积分权重（保存即生效，无需发版）" : "当前积分权重（只读）"}>
          {canWrite ? (
          <>
          <div className="mb-3 flex items-center justify-between gap-2 border-b border-edge/60 pb-2.5">
            <span className="text-[12.5px] text-ink2">单积分目标模型成本(¥，超过后提示成本优化)</span>
            <input
              className="w-24 rounded-lg border border-edge bg-panel2/60 px-2 py-1 text-right text-[12.5px] tabular-nums outline-none focus:border-accent"
              name="credit-anchor"
              autoComplete="off"
              inputMode="decimal"
              value={edits["credit.anchor"] ?? String(d.anchorCNY)}
              onChange={(e) => setEdits({ ...edits, "credit.anchor": e.target.value.replace(/[^0-9.]/g, "") })}
            />
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px]">
            {d.priceTable.map((p) => (
              <label key={p.key} className="flex items-center justify-between gap-2 border-b border-edge/50 py-1">
                <span className="min-w-0 truncate text-ink2">{p.label}</span>
                <span className="flex items-center gap-1">
                  <input
                    className="w-14 rounded-md border border-edge bg-panel2/60 px-1.5 py-0.5 text-right tabular-nums outline-none focus:border-accent"
                    name={p.key}
                    autoComplete="off"
                    inputMode="numeric"
                    value={edits[p.key] ?? String(p.credits)}
                    onChange={(e) => setEdits({ ...edits, [p.key]: e.target.value.replace(/[^0-9]/g, "") })}
                  />
                  <span className="text-muted">分</span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Btn kind="primary" onClick={savePrices} disabled={!Object.keys(edits).length}>
              保存权重
            </Btn>
            <span className="text-[11px] text-muted">清空某格 = 撤销覆盖,回落代码默认</span>
          </div>
          </>
          ) : (
            <div className="grid grid-cols-1 gap-x-6 text-[12.5px] sm:grid-cols-2">
              <div className="flex items-center justify-between gap-3 border-b border-edge/50 py-2">
                <span className="text-ink2">单积分目标模型成本</span>
                <span className="tabular-nums text-ink">{yuan(d.anchorCNY)}</span>
              </div>
              {d.priceTable.map((p) => (
                <div key={p.key} className="flex items-center justify-between gap-3 border-b border-edge/50 py-2">
                  <span className="min-w-0 truncate text-ink2">{p.label}</span>
                  <span className="shrink-0 tabular-nums text-ink">{p.credits} 分</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
