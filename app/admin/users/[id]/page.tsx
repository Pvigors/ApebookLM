"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Section, KpiCard, Skeleton, EmptyState, PageHeader } from "@/components/AdminUI";

type Detail = {
  user: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    wechat_nickname: string | null;
    wechat_bound: boolean;
    created_at: number;
    last_seen: number;
    last_login_at: number;
    login_count: number;
    disabled: boolean;
    is_admin: boolean;
    plan_tier: string;
    plan_expires_at: number;
    invite_code: string | null;
  };
  plan: { id: string; name: string; dailyLimit: number; maxNotebooks: number; expiresAt: number };
  usage: { today: number; month: number };
  bonus: number;
  notebooks: { id: string; title: string; emoji: string; public: boolean; created_at: number }[];
  ledger: { id: number; op: string; label: string; credits: number; refunded: number; ts: number; kind: string }[];
  referral: { invitedThisMonth: number; totalInvited: number; earnedThisMonth: number; totalEarned: number };
};

const fmt = (n: number) => n.toLocaleString("zh-CN");
const date = (ms: number) => (ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "—");
const day = (ms: number) => (ms ? new Date(ms).toLocaleDateString("zh-CN") : "—");
const lim = (n: number) => (n < 0 ? "不限" : fmt(n));

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/admin/users/${id}`)
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(j.error || "加载失败"))))
      .then(setD)
      .catch((e) => setErr(String(e)));
  }, [id]);

  if (err)
    return (
      <div className="space-y-4">
        <Link href="/admin/users" className="text-[13px] text-accent hover:underline">← 返回用户列表</Link>
        <EmptyState title="无法加载" hint={err} />
      </div>
    );
  if (!d)
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );

  const u = d.user;
  return (
    <div className="space-y-5">
      <Link href="/admin/users" className="inline-block text-[13px] text-accent hover:underline">← 返回用户列表</Link>

      <PageHeader
        eyebrow="用户详情"
        title={u.name}
        desc={`注册于 ${date(u.created_at)} · 最近活跃 ${date(u.last_seen)}`}
        actions={<>
        <span className="rounded-full bg-panel2 px-2 py-0.5 text-[11px] text-ink2">{d.plan.name}</span>
        {u.is_admin && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-accent">管理员</span>}
        {u.disabled && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] text-red-600">已停用</span>}
        </>}
      />
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12.5px] text-ink2">
        <span>微信名:{u.wechat_nickname || "—"}</span>
        <span>微信:{u.wechat_bound ? "已绑定" : "未绑定"}</span>
        <span>手机:{u.phone || "—"}</span>
        <span>邮箱:{u.email || "—"}</span>
        <span>邀请码:{u.invite_code || "—"}</span>
        <span>注册时间:{date(u.created_at)}</span>
        <span>最近活跃:{date(u.last_seen)}</span>
        <span>最近登录:{date(u.last_login_at)}</span>
        <span title="存量账号按尚存会话保守回填；升级后每次成功登录精确累计">可追溯登录:{fmt(u.login_count)} 次</span>
        <span>权益到期:{d.plan.id === "free" ? "基础权益" : date(d.plan.expiresAt)}</span>
        <span className="select-all text-muted">id:{u.id}</span>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="今日积分消耗" value={`${fmt(d.usage.today)}${d.plan.dailyLimit < 0 ? "" : ` / ${fmt(d.plan.dailyLimit)}`}`} />
        <KpiCard label="本月积分消耗" value={fmt(d.usage.month)} />
        <KpiCard label="奖励余额(返利)" value={fmt(d.bonus)} />
        <KpiCard label="笔记本数" value={`${fmt(d.notebooks.length)}${d.plan.maxNotebooks < 0 ? "" : ` / ${lim(d.plan.maxNotebooks)}`}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 名下笔记本 */}
        <Section title={`名下笔记本(${d.notebooks.length})`}>
          {d.notebooks.length === 0 ? (
            <EmptyState title="暂无笔记本" hint="" />
          ) : (
            <div className="max-h-[360px] space-y-0.5 overflow-auto text-[12.5px]">
              {d.notebooks.map((n) => (
                <Link
                  key={n.id}
                  href={`/admin/notebooks/${n.id}`}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-panel2"
                >
                  <span>{n.emoji}</span>
                  <span className="min-w-0 flex-1 truncate">{n.title}</span>
                  {n.public && <span className="rounded bg-panel2 px-1.5 py-0.5 text-[10.5px] text-ink2">公开</span>}
                  <span className="text-muted">{day(n.created_at)}</span>
                </Link>
              ))}
            </div>
          )}
        </Section>

        {/* 返利 */}
        <Section title="邀请返利">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12.5px]">
            <div className="flex justify-between border-b border-edge/50 py-1"><span className="text-ink2">本月邀请</span><span className="tabular-nums font-medium">{fmt(d.referral.invitedThisMonth)}</span></div>
            <div className="flex justify-between border-b border-edge/50 py-1"><span className="text-ink2">累计邀请</span><span className="tabular-nums font-medium">{fmt(d.referral.totalInvited)}</span></div>
            <div className="flex justify-between border-b border-edge/50 py-1"><span className="text-ink2">本月返奖励</span><span className="tabular-nums font-medium">{fmt(d.referral.earnedThisMonth)}</span></div>
            <div className="flex justify-between border-b border-edge/50 py-1"><span className="text-ink2">累计返奖励</span><span className="tabular-nums font-medium">{fmt(d.referral.totalEarned)}</span></div>
          </div>
        </Section>
      </div>

      {/* 积分流水 */}
      <Section title="积分流水（最近 50 笔；正=消耗 / 负=入账赠送或退回）">
        {d.ledger.length === 0 ? (
          <EmptyState title="暂无流水" hint="credit_ledger 尚无该用户记录" />
        ) : (
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1.5 font-medium">时间</th>
                <th className="py-1.5 font-medium">操作</th>
                <th className="py-1.5 text-right font-medium">积分</th>
                <th className="py-1.5 text-right font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {d.ledger.map((r) => (
                <tr key={r.id} className="border-t border-edge/70">
                  <td className="py-1.5 text-ink2">{date(r.ts)}</td>
                  <td className="py-1.5">{r.label}</td>
                  <td className={`py-1.5 text-right tabular-nums font-medium ${r.kind === "in" ? "text-emerald-600" : "text-ink"}`}>
                    {r.credits > 0 ? "-" : "+"}
                    {fmt(Math.abs(r.credits))}
                  </td>
                  <td className="py-1.5 text-right text-muted">{r.refunded ? "已退回" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
