"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Section, Pill, Pagination, EmptyState, Skeleton, selectCls, fmtTime, ago, PageHeader } from "@/components/AdminUI";
import { ACTION_CN, TARGET_CN, KIND_CN, KIND_TONE } from "@/lib/activity-labels";
import type { ActivityEvent } from "@/lib/types";

type Tab = "all" | "admin" | "user";
type Range = "1d" | "7d" | "all";
const RANGE_MS: Record<Range, number> = { "1d": 86400_000, "7d": 7 * 86400_000, all: 0 };
const LIMIT = 50;

function metaSummary(ev: ActivityEvent): string {
  if (!ev.meta) return "";
  try {
    const m = JSON.parse(ev.meta) as Record<string, unknown>;
    const parts: string[] = [];
    if (m.title) parts.push(String(m.title));
    if (m.kind) parts.push(`类型 ${m.kind}`);
    if (m.type) parts.push(String(m.type));
    if (m.method) parts.push(String(m.method) === "phone" ? "短信" : "微信");
    if (m.role) parts.push(`角色 ${m.role}`);
    if (m.status && m.status !== "ready") parts.push(`状态 ${m.status}`);
    if (typeof m.cleared === "number") parts.push(`清理 ${m.cleared}`);
    if (typeof m.deleted === "number") parts.push(`删除 ${m.deleted}`);
    if (Array.isArray(m.applied)) parts.push(m.applied.join(", "));
    if (m.to !== undefined) parts.push(`→ ${m.to}`);
    return parts.join(" · ") || JSON.stringify(m);
  } catch {
    return ev.meta;
  }
}

export default function ActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [actions, setActions] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [action, setAction] = useState("");
  const [range, setRange] = useState<Range>("7d");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    const p = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
    if (tab === "admin") p.set("prefix", "admin.");
    if (tab === "user") p.set("kind", "user");
    if (action) p.set("action", action);
    if (RANGE_MS[range]) p.set("since", String(Date.now() - RANGE_MS[range]));
    setLoading(true);
    fetch(`/api/admin/activity?${p}`)
      .then((r) => r.json())
      .then((d) => {
        setEvents(d.events ?? []);
        setTotal(d.total ?? 0);
        if (d.actions) setActions(d.actions);
      })
      .finally(() => setLoading(false));
  }, [tab, action, range, offset]);

  useEffect(() => {
    load();
  }, [load]);

  // 切换筛选时回到第一页。
  const setFilter = (fn: () => void) => {
    fn();
    setOffset(0);
  };

  const tabs: { key: Tab; label: string }[] = useMemo(
    () => [
      { key: "all", label: "全部" },
      { key: "admin", label: "管理操作" },
      { key: "user", label: "用户活动" },
    ],
    []
  );

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="系统与安全" title="活动审计" desc="统一追踪登录、内容变更、生成、分享和后台管理操作，回答谁在何时做了什么。" />

      <Section
        title={`活动记录(${total})`}
        desc="按时间倒序;管理操作长期保留,用户活动默认保留 90 天"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-full bg-panel2 p-0.5 text-xs">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setFilter(() => setTab(t.key))}
                  className={
                    "rounded-full px-3 py-1 font-medium transition " +
                    (tab === t.key ? "bg-panel text-accent shadow-sm" : "text-ink2 hover:text-ink")
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
            <select
              name="action"
              value={action}
              onChange={(e) => setFilter(() => setAction(e.target.value))}
              className={selectCls}
            >
              <option value="">全部动作</option>
              {actions.map((a) => (
                <option key={a} value={a}>
                  {ACTION_CN[a] ?? a}
                </option>
              ))}
            </select>
            <select
              name="time-range"
              value={range}
              onChange={(e) => setFilter(() => setRange(e.target.value as Range))}
              className={selectCls}
            >
              <option value="1d">近 24 小时</option>
              <option value="7d">近 7 天</option>
              <option value="all">全部时间</option>
            </select>
          </div>
        }
      >
        {loading && events.length === 0 ? (
          <div className="space-y-2.5 py-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : events.length === 0 ? (
          <EmptyState title="该筛选下暂无记录" hint="换个时间范围或动作再试" />
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-muted">
                <th className="whitespace-nowrap pb-2 pr-6 font-medium">时间</th>
                <th className="whitespace-nowrap pb-2 pr-6 font-medium">操作者</th>
                <th className="whitespace-nowrap pb-2 pr-6 font-medium">动作</th>
                <th className="whitespace-nowrap pb-2 pr-6 font-medium">对象</th>
                <th className="w-full pb-2 font-medium">详情</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id} className="border-t border-edge text-ink2 transition hover:bg-panel2/50">
                  <td className="whitespace-nowrap py-2 pr-6 tabular-nums" title={fmtTime(ev.ts)}>
                    {ago(ev.ts)}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-6">
                    <span className="flex items-center gap-1.5">
                      <Pill text={KIND_CN[ev.actor_kind] ?? ev.actor_kind} tone={KIND_TONE[ev.actor_kind] ?? "muted"} />
                      <span className="text-ink">{ev.actor_name ?? "—"}</span>
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-6 font-medium text-ink">
                    {ACTION_CN[ev.action] ?? ev.action}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-6">
                    {ev.target_type ? TARGET_CN[ev.target_type] ?? ev.target_type : "—"}
                  </td>
                  <td className="w-full max-w-0 py-2" title={metaSummary(ev)}>
                    <span className="block truncate">{metaSummary(ev)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination offset={offset} limit={LIMIT} total={total} onPage={setOffset} />
      </Section>
    </div>
  );
}
