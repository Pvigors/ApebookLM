"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Section, Pill, Btn, Modal, Field, inputCls, ago, fmtTime, PageHeader, Notice, ReadOnlyNotice } from "@/components/AdminUI";
import { useAdminAccess } from "@/components/AdminAccess";
import { DotsIcon } from "@/components/Icons";
import { MANAGED_ENTITLEMENT_TIERS, PLANS } from "@/lib/plans";

// 后台只能手工设为基础权益或受管理权益；trial 由注册流程发放，不能人工续发。
const ADMIN_ASSIGNABLE_PLANS = PLANS.filter(
  (plan) => plan.id === "free" || (MANAGED_ENTITLEMENT_TIERS as readonly string[]).includes(plan.id)
);

type U = {
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
  disabled: number;
  is_admin: number;
  plan_tier: string;
  plan_expires_at: number;
  bonus_credits: number;
  notebooks: number;
  sources: number;
  outputs: number;
};
type NB = {
  id: string;
  title: string;
  emoji: string;
  public: number;
  featured: number;
  featured_order: number;
  created_at: number;
  owner: string | null;
  owner_id: string | null;
  sources: number;
  outputs: number;
};

type Confirm = { title: string; body: string; danger?: boolean; run: () => void };

const shortDate = (ms: number) =>
  ms ? new Date(ms).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }) : "—";
const planName = (tier: string) => PLANS.find((plan) => plan.id === tier)?.name ?? tier;
const membershipExpiry = (u: Pick<U, "plan_tier" | "plan_expires_at">) => {
  if (!u.plan_expires_at) return u.plan_tier === "free" ? "未开通" : "—";
  return `${shortDate(u.plan_expires_at)}${u.plan_expires_at <= Date.now() ? " · 已到期" : ""}`;
};

/** 轻量行内下拉菜单(⋯)。 */
function RowMenu({ items }: { items: { label: string; danger?: boolean; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-panel2 hover:text-ink"
        aria-label="更多操作"
      >
        <DotsIcon width={16} height={16} />
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <span className="absolute right-0 top-7 z-30 block w-32 overflow-hidden rounded-xl border border-edge bg-panel py-1 shadow-xl">
            {items.map((it) => (
              <button
                key={it.label}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
                className={`block w-full px-3 py-1.5 text-left text-[13px] transition hover:bg-panel2 ${it.danger ? "text-red-500" : "text-ink2"}`}
              >
                {it.label}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

export default function UsersPage() {
  const { canWrite } = useAdminAccess("users");
  const [users, setUsers] = useState<U[]>([]);
  const [notebooks, setNotebooks] = useState<NB[]>([]);
  const [q, setQ] = useState("");
  const [reveal, setReveal] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [transfer, setTransfer] = useState<NB | null>(null);
  const [transferTo, setTransferTo] = useState("");
  // 运营操作:赠积分 / 调权益 / 发通知
  const [grant, setGrant] = useState<U | null>(null);
  const [grantAmount, setGrantAmount] = useState("100");
  const [planFor, setPlanFor] = useState<U | null>(null);
  const [planVal, setPlanVal] = useState("free");
  const [planExpiresLocal, setPlanExpiresLocal] = useState("");
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [nTitle, setNTitle] = useState("");
  const [nBody, setNBody] = useState("");
  const [nTo, setNTo] = useState(""); // '' = 全员群发
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  // 手机号脱敏在服务端做;reveal=明文需重新请求(并被服务端记审计),不再前端本地切换。
  const load = useCallback(async (query = "", rev = false) => {
    try {
      const response = await fetch(`/api/admin/users?q=${encodeURIComponent(query)}${rev ? "&reveal=1" : ""}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "加载失败,请重试");
      setUsers(data.users ?? []);
      setNotebooks(data.notebooks ?? []);
    } catch (reason) {
      setMsg({ text: reason instanceof Error ? reason.message : "加载失败,请重试", tone: "err" });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load("", false);
  }, [load]);

  const act = async (body: Record<string, unknown>, okText?: string) => {
    if (!canWrite) return false;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ text: d.error || "操作失败", tone: "err" });
        return;
      }
      if (typeof d.revoked === "number")
        setMsg({ text: `已撤销 ${d.revoked} 个登录会话`, tone: "ok" });
      else if (typeof d.delivered === "number")
        setMsg({ text: `通知已发送,送达 ${d.delivered} 人`, tone: "ok" });
      else if (okText) setMsg({ text: okText, tone: "ok" });
      await load(q, reveal);
    } finally {
      setBusy(false);
      setConfirm(null);
      setTransfer(null);
      setGrant(null);
      setPlanFor(null);
      setNotifyOpen(false);
    }
  };

  const grantNum = Number(grantAmount);
  const grantValid = Number.isInteger(grantNum) && grantNum >= 1 && grantNum <= 10000;
  const activeUsers = users.filter((u) => !u.disabled);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="用户运营"
        title="用户与内容"
        desc="管理账号生命周期、笔记本与公开内容；敏感和破坏性操作都会写入活动审计。"
        actions={canWrite ? <Btn
          kind="primary"
          onClick={() => {
            setNTitle("");
            setNBody("");
            setNTo("");
            setNotifyOpen(true);
          }}
        >发站内通知</Btn> : undefined}
      />

      {!canWrite && (
        <ReadOnlyNotice>当前角色可监督用户、权益与内容状态，账号和内容变更操作已隐藏。</ReadOnlyNotice>
      )}

      {msg && (
        <Notice tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Notice>
      )}

      {loading ? (
        <div className="space-y-3">
          <div className="h-28 animate-pulse rounded-2xl bg-panel2" />
          <div className="h-64 animate-pulse rounded-2xl bg-panel2" />
        </div>
      ) : (
      <>
      {/* ---- 用户 ---- */}
      <Section
        title={`用户(${users.length})`}
        desc="按最近活跃排序；存量账号的登录次数为现有会话可追溯下限，升级后持续精确累计"
        actions={canWrite ? (
          <label className="flex items-center gap-1.5 text-xs text-ink2">
            <input
              type="checkbox"
              name="reveal-phone"
              checked={reveal}
              onChange={(e) => {
                setReveal(e.target.checked);
                load(q, e.target.checked);
              }}
            />
            显示完整手机号
          </label>
        ) : undefined}
      >
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full min-w-[1328px] table-fixed text-left text-[13px]">
            <colgroup>
              <col className="w-[190px]" />
              <col className="w-[140px]" />
              <col className="w-[120px]" />
              <col className="w-[90px]" />
              <col className="w-[140px]" />
              <col className="w-[70px]" />
              <col className="w-[70px]" />
              <col className="w-[70px]" />
              <col className="w-[110px]" />
              <col className="w-[90px]" />
              <col className="w-[90px]" />
              <col className="w-[90px]" />
              <col className="w-[48px]" />
            </colgroup>
            <thead className="sticky top-0 bg-panel">
              <tr className="text-muted">
                <th className="pb-2 pr-3 font-medium">用户</th>
                <th className="whitespace-nowrap pb-2 pr-3 font-medium">微信名</th>
                <th className="whitespace-nowrap pb-2 pr-3 font-medium">手机</th>
                <th className="whitespace-nowrap pb-2 pr-3 font-medium">状态</th>
                <th className="whitespace-nowrap pb-2 pr-3 font-medium">权益 / 到期</th>
                <th className="whitespace-nowrap pb-2 pr-3 text-right font-medium">笔记本</th>
                <th className="whitespace-nowrap pb-2 pr-3 text-right font-medium">来源</th>
                <th className="whitespace-nowrap pb-2 pr-3 text-right font-medium">制品</th>
                <th className="whitespace-nowrap pb-2 pr-3 font-medium">注册时间</th>
                <th className="whitespace-nowrap pb-2 pr-3 font-medium">最近活跃</th>
                <th className="whitespace-nowrap pb-2 pr-3 font-medium">最近登录</th>
                <th className="whitespace-nowrap pb-2 pr-3 text-right font-medium">可追溯登录</th>
                <th className="sticky right-0 bg-panel pb-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="group border-t border-edge text-ink2 transition hover:bg-panel2/50">
                  <td className="overflow-hidden py-2.5 pr-3">
                    <Link href={`/admin/users/${u.id}`} className="flex min-w-0 items-center gap-2.5 hover:opacity-80">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accentSoft text-[11px] font-medium text-accent">
                        {u.name.slice(0, 1)}
                      </span>
                      <span className="truncate font-medium text-ink hover:text-accent hover:underline">{u.name}</span>
                    </Link>
                  </td>
                  <td className="max-w-[150px] truncate whitespace-nowrap py-2.5 pr-3" title={u.wechat_nickname || undefined}>
                    {u.wechat_nickname || "—"}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums">
                    {u.phone || "—"}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-3">
                    <span className="flex flex-nowrap gap-1.5">
                      {u.is_admin ? <Pill text="管理员" tone="info" /> : null}
                      {u.disabled ? <Pill text="已停用" tone="err" /> : <Pill text="正常" tone="muted" />}
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3">
                    <span className="block text-ink">{planName(u.plan_tier)}</span>
                    <span className="block text-[11px] text-muted" title={u.plan_expires_at ? fmtTime(u.plan_expires_at) : undefined}>
                      {membershipExpiry(u)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{u.notebooks}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{u.sources}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{u.outputs}</td>
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums" title={u.created_at ? fmtTime(u.created_at) : undefined}>{shortDate(u.created_at)}</td>
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums" title={u.last_seen ? fmtTime(u.last_seen) : undefined}>{u.last_seen ? ago(u.last_seen) : "—"}</td>
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums" title={u.last_login_at ? fmtTime(u.last_login_at) : undefined}>{u.last_login_at ? ago(u.last_login_at) : "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{Number(u.login_count ?? 0).toLocaleString("zh-CN")}</td>
                  <td className="sticky right-0 border-l border-edge/60 bg-panel py-2 text-right transition group-hover:bg-panel2">
                    {canWrite && <RowMenu
                      items={[
                        u.disabled
                          ? { label: "启用账号", onClick: () => act({ action: "user_enable", userId: u.id }) }
                          : {
                              label: "停用账号",
                              danger: true,
                              onClick: () =>
                                setConfirm({
                                  title: "停用账号",
                                  body: `停用「${u.name}」后,其登录态立即失效、无法访问。可随时重新启用。`,
                                  danger: true,
                                  run: () => act({ action: "user_disable", userId: u.id }),
                                }),
                            },
                        {
                          label: "撤销登录",
                          onClick: () => act({ action: "user_revoke", userId: u.id }),
                        },
                        {
                          label: "赠送积分",
                          onClick: () => {
                            setGrantAmount("100");
                            setGrant(u);
                          },
                        },
                        {
                          label: "调整权益",
                          onClick: () => {
                            setPlanVal(
                              ADMIN_ASSIGNABLE_PLANS.some((plan) => plan.id === u.plan_tier)
                                ? u.plan_tier
                                : "free"
                            );
                            const exp = Number(u.plan_expires_at ?? 0);
                            const fallback = Date.now() + 31 * 86400_000;
                            const d = new Date(exp > Date.now() ? exp : fallback);
                            d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
                            setPlanExpiresLocal(d.toISOString().slice(0, 16));
                            setPlanFor(u);
                          },
                        },
                        {
                          label: "删除用户",
                          danger: true,
                          onClick: () =>
                            setConfirm({
                              title: "删除用户",
                              body: `将永久删除「${u.name}」及其拥有的全部笔记本(含来源、制品、媒体文件)。此操作不可恢复。`,
                              danger: true,
                              run: () => act({ action: "user_delete", userId: u.id }),
                            }),
                        },
                      ]}
                    />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ---- 笔记本 ---- */}
      <Section
        title={`笔记本(${notebooks.length})`}
        desc="点标题查看明细;撤销公开会同时撤精选"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <input
              name="search"
              autoComplete="off"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                load(e.target.value, reveal);
              }}
              placeholder="按标题 / 所有者搜索…"
              className={`${inputCls} w-60 py-1.5 text-xs`}
            />
            <Link
              href="/admin/featured"
              className="inline-flex min-h-9 items-center rounded-xl border border-edge bg-panel px-3.5 py-2 text-[13px] font-medium text-ink2 transition hover:border-accent/50 hover:text-accent"
            >
              前往精选管理
            </Link>
          </div>
        }
      >
        <div className="max-h-[460px] overflow-y-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 bg-panel">
              <tr className="text-muted">
                <th className="w-full pb-2 pr-3 font-medium">笔记本</th>
                <th className="whitespace-nowrap pb-2 pr-3 font-medium">所有者</th>
                <th className="whitespace-nowrap pb-2 pr-3 text-right font-medium">来源</th>
                <th className="whitespace-nowrap pb-2 pr-3 text-right font-medium">制品</th>
                <th className="whitespace-nowrap pb-2 pr-3 font-medium">状态</th>
                <th className="whitespace-nowrap pb-2 pr-3 font-medium">创建</th>
                <th className="pb-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {notebooks.map((n) => (
                <tr key={n.id} className="border-t border-edge text-ink2 transition hover:bg-panel2/50">
                  <td className="max-w-[460px] truncate py-2 pr-3 font-medium text-ink">
                    <Link href={`/admin/notebooks/${n.id}`} className="transition hover:text-accent hover:underline">
                      {n.emoji} {n.title}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3">{n.owner ?? "-"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{n.sources}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{n.outputs}</td>
                  <td className="py-2 pr-3">
                    <span className="flex gap-1.5">
                      {!!n.featured && <Pill text="精选" tone="ok" />}
                      {!!n.public && <Pill text="公开" tone="muted" />}
                      {!n.public && !n.featured && <Pill text="私有" tone="muted" />}
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{ago(n.created_at)}</td>
                  <td className="whitespace-nowrap py-2 text-right">
                    {canWrite && <span className="inline-flex items-center gap-1">
                      <RowMenu
                        items={[
                          n.public
                            ? { label: "设为私有", onClick: () => act({ action: "set_private", notebookId: n.id }) }
                            : { label: "设为公开", onClick: () => act({ action: "set_public", notebookId: n.id }) },
                          { label: "转移所有者", onClick: () => { setTransfer(n); setTransferTo(""); } },
                          {
                            label: "删除笔记本",
                            danger: true,
                            onClick: () =>
                              setConfirm({
                                title: "删除笔记本",
                                body: `将永久删除「${n.title}」及其全部来源、制品与媒体文件。此操作不可恢复。`,
                                danger: true,
                                run: () => act({ action: "delete_notebook", notebookId: n.id }),
                              }),
                          },
                        ]}
                      />
                    </span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      </>
      )}

      {canWrite && confirm && (
        <Modal
          title={confirm.title}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Btn onClick={() => setConfirm(null)}>取消</Btn>
              <Btn kind={confirm.danger ? "danger" : "primary"} disabled={busy} onClick={confirm.run}>
                确认
              </Btn>
            </>
          }
        >
          {confirm.body}
        </Modal>
      )}

      {canWrite && transfer && (
        <Modal
          title="转移所有者"
          onClose={() => setTransfer(null)}
          footer={
            <>
              <Btn onClick={() => setTransfer(null)}>取消</Btn>
              <Btn
                kind="primary"
                disabled={!transferTo || busy}
                onClick={() => act({ action: "transfer_owner", notebookId: transfer.id, toUserId: transferTo })}
              >
                转移
              </Btn>
            </>
          }
        >
          <p className="mb-2">
            把「{transfer.title}」转给:
          </p>
          <select
            name="transfer-to"
            value={transferTo}
            onChange={(e) => setTransferTo(e.target.value)}
            className="w-full rounded-xl border border-edge bg-panel2 px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          >
            <option value="">选择用户…</option>
            {users
              .filter((u) => u.id !== transfer.owner_id)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.phone ? ` · ${u.phone}` : ""}
                </option>
              ))}
          </select>
        </Modal>
      )}

      {canWrite && grant && (
        <Modal
          title="赠送积分"
          onClose={() => setGrant(null)}
          footer={
            <>
              <Btn onClick={() => setGrant(null)}>取消</Btn>
              <Btn
                kind="primary"
                disabled={!grantValid || busy}
                onClick={() =>
                  act(
                    { action: "user_grant_credits", userId: grant.id, amount: grantNum },
                    `已给「${grant.name}」赠送 ${grantNum} 积分`
                  )
                }
              >
                赠送
              </Btn>
            </>
          }
        >
          <p className="mb-3">
            给「{grant.name}」的奖励余额加积分,当前余额{" "}
            <b className="tabular-nums text-ink">{grant.bonus_credits}</b> 积分。
          </p>
          <Field label="赠送数量(1~10000 的整数)">
            <input
              type="number"
              name="grant-amount"
              autoComplete="off"
              min={1}
              max={10000}
              step={1}
              value={grantAmount}
              onChange={(e) => setGrantAmount(e.target.value)}
              className={inputCls}
            />
          </Field>
          <p className="mt-2 text-xs text-muted">
            计入奖励额度：在日权益积分用尽后自动抵扣，不随日切清零；操作记入活动审计。
          </p>
        </Modal>
      )}

      {canWrite && planFor && (
        <Modal
          title="调整权益"
          onClose={() => setPlanFor(null)}
          footer={
            <>
              <Btn onClick={() => setPlanFor(null)}>取消</Btn>
              <Btn
                kind="primary"
                disabled={
                  busy ||
                  (planVal !== "free" && !(new Date(planExpiresLocal).getTime() > Date.now()))
                }
                onClick={() =>
                  act(
                    {
                      action: "user_set_plan",
                      userId: planFor.id,
                      plan: planVal,
                      ...(planVal === "free" ? {} : { expiresAt: new Date(planExpiresLocal).getTime() }),
                    },
                    `已把「${planFor.name}」的权益调整为 ${PLANS.find((p) => p.id === planVal)?.name ?? planVal}`
                  )
                }
              >
                保存
              </Btn>
            </>
          }
        >
          <p className="mb-3">
            调整「{planFor.name}」的权益档位,当前:
            <b className="text-ink">{PLANS.find((p) => p.id === (planFor.plan_tier || "free"))?.name ?? planFor.plan_tier}</b>
          </p>
          <div className="space-y-2">
            {ADMIN_ASSIGNABLE_PLANS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPlanVal(p.id)}
                className={`flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition ${
                  planVal === p.id
                    ? "border-accent bg-accentSoft/60"
                    : "border-edge bg-panel2/40 hover:border-accent/40"
                }`}
              >
                <span>
                  <span className={`block text-[13px] font-medium ${planVal === p.id ? "text-accent" : "text-ink"}`}>{p.name}</span>
                  <span className="mt-0.5 block text-[11px] text-muted">{p.quota}</span>
                </span>
                <span
                  className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                    planVal === p.id ? "border-accent bg-accent" : "border-edge"
                  }`}
                  aria-hidden
                >
                  {planVal === p.id && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                </span>
              </button>
            ))}
          </div>
          {planVal !== "free" && (
            <div className="mt-4 space-y-3 rounded-xl border border-edge bg-panel2/40 p-3">
              <Field label="权益到期时间（必填）">
                <input
                  type="datetime-local"
                  name="plan-expires-at"
                  value={planExpiresLocal}
                  onChange={(e) => setPlanExpiresLocal(e.target.value)}
                  className={inputCls}
                />
              </Field>
            </div>
          )}
          <p className="mt-2 text-xs text-muted">立即生效；受管理权益必须明确未来到期时间，不支持隐式永久权益，操作会写入审计。</p>
        </Modal>
      )}

      {canWrite && notifyOpen && (
        <Modal
          title="发通知"
          onClose={() => setNotifyOpen(false)}
          footer={
            <>
              <Btn onClick={() => setNotifyOpen(false)}>取消</Btn>
              <Btn
                kind="primary"
                disabled={busy || !nTitle.trim() || !nBody.trim()}
                onClick={() =>
                  act({
                    action: "notify",
                    title: nTitle.trim(),
                    body: nBody.trim(),
                    ...(nTo ? { userId: nTo } : {}),
                  })
                }
              >
                发送
              </Btn>
            </>
          }
        >
          <div className="space-y-3">
            <Field label={`标题(${nTitle.trim().length}/60)`}>
              <input
                name="notify-title"
                autoComplete="off"
                maxLength={60}
                value={nTitle}
                onChange={(e) => setNTitle(e.target.value)}
                placeholder="例如:系统维护公告"
                className={inputCls}
              />
            </Field>
            <Field label={`内容(${nBody.trim().length}/300)`}>
              <textarea
                name="notify-body"
                autoComplete="off"
                maxLength={300}
                rows={4}
                value={nBody}
                onChange={(e) => setNBody(e.target.value)}
                placeholder="通知正文,显示在用户消息中心"
                className={`${inputCls} resize-none leading-relaxed`}
              />
            </Field>
            <Field label="发送范围">
              <select
                name="notify-to"
                value={nTo}
                onChange={(e) => setNTo(e.target.value)}
                className="w-full rounded-xl border border-edge bg-panel2 px-3 py-2 text-sm text-ink outline-none focus:border-accent"
              >
                <option value="">全部未停用用户({activeUsers.length} 人)</option>
                {activeUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    仅 {u.name}
                    {u.phone ? ` · ${u.phone}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
