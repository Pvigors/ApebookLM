"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog, Notice, PageHeader } from "@/components/AdminUI";
import { useAdminAccess } from "@/components/AdminAccess";

type Account = {
  id: string; name: string; phone: string | null; email: string | null;
  admin_role: string | null; is_admin: number; disabled: number; created_at: number; managed_password: number;
};
type Found = { id: string; name: string; phone: string | null; admin_role: string | null; managed_password: number };

const ROLE_LABEL: Record<string, string> = { super: "系统管理员", operator: "运营员", auditor: "安全审计员" };
const ROLE_STYLE: Record<string, string> = {
  super: "bg-[#efecfd] text-[#5a49c9] border-[#d7cffa]",
  operator: "bg-[#e1f5ee] text-[#0f6e56] border-[#b3e6d5]",
  auditor: "bg-[#faefda] text-[#8a5709] border-[#f0dcae]",
};

/** 有效角色:admin_role 优先;为空但 is_admin=1 = 旧管理员(视为 super)。 */
function effRole(a: Account | Found): string {
  if ("admin_role" in a && a.admin_role) return a.admin_role;
  if ("is_admin" in a && (a as Account).is_admin) return "super";
  return "";
}

export default function AccountsPage() {
  const { role: myRole, canWrite } = useAdminAccess("accounts");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ t: "ok" | "err"; s: string } | null>(null);
  const [pendingRole, setPendingRole] = useState<{ userId: string; name: string; role: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/accounts");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "管理账户加载失败");
      setAccounts(payload.accounts ?? []);
    } catch (error) {
      setMsg({ t: "err", s: error instanceof Error ? error.message : "管理账户加载失败" });
      setAccounts([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const readOnly = !canWrite;

  const setRole = async (userId: string, role: string | null) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/accounts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ t: "err", s: d.error ?? "操作失败" }); return; }
      setMsg({ t: "ok", s: role ? `已设为${ROLE_LABEL[role]}` : "已撤销后台权限" });
      setFound(null); setQ("");
      setPendingRole(null);
      await load();
    } finally { setBusy(false); }
  };

  const search = async () => {
    const term = q.trim();
    if (!term) return;
    try {
      const response = await fetch(`/api/admin/accounts?q=${encodeURIComponent(term)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "查找用户失败");
      setFound(payload.found ?? null);
      if (!payload.found) setMsg({ t: "err", s: "未找到该用户" });
    } catch (error) {
      setFound(null);
      setMsg({ t: "err", s: error instanceof Error ? error.message : "查找用户失败" });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="权限治理"
        title="管理账户"
        desc={`按职责划分系统管理员、运营员与安全审计员。${readOnly ? "当前角色只有查看权限。" : "角色变更会立即生效并写入活动审计。"}`}
        actions={myRole ? <span className={`rounded-full border px-3 py-1.5 text-xs font-medium ${ROLE_STYLE[myRole] ?? ""}`}>{ROLE_LABEL[myRole]}</span> : null}
      />

      {msg && (
        <Notice tone={msg.t}>{msg.s}</Notice>
      )}

      {/* 授权:超管专属 */}
      {!readOnly && (
        <div className="rounded-2xl border border-edge bg-panel p-4">
          <p className="mb-2 text-sm font-medium text-ink">授予角色</p>
          <div className="flex flex-wrap gap-2">
            <input
              value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder="输入手机号 / 用户 ID 查找"
              className="min-w-[220px] flex-1 rounded-lg border border-edge bg-panel2 px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            />
            <button onClick={search} className="rounded-lg border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-accent hover:text-accent">查找</button>
          </div>
          {found && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-edge bg-panel2 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{found.name}</p>
                <p className="text-xs text-muted">{found.phone ?? found.id}{effRole(found) && ` · 当前:${ROLE_LABEL[effRole(found)]}`}</p>
              </div>
              <div className="flex gap-1.5">
                {found.managed_password ? (
                  <span className="rounded-lg border border-accent/25 bg-accentSoft px-2.5 py-1.5 text-xs text-accent">独立密码管理员</span>
                ) : (
                  <>
                    {(["super", "operator", "auditor"] as const).map((r) => (
                      <button key={r} disabled={busy} onClick={() => setPendingRole({ userId: found.id, name: found.name, role: r })}
                        className="rounded-lg border border-edge px-2.5 py-1.5 text-xs text-ink2 transition hover:border-accent hover:text-accent disabled:opacity-40">
                        设为{ROLE_LABEL[r]}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 后台账户列表 */}
      <div className="overflow-x-auto rounded-2xl border border-edge bg-panel">
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr className="border-b border-edge text-left text-xs text-muted">
              <th className="px-4 py-3 font-medium">账户</th>
              <th className="px-4 py-3 font-medium">当前角色</th>
              <th className="px-4 py-3 text-right font-medium">{readOnly ? "" : "变更"}</th>
            </tr>
          </thead>
          <tbody>
            {accounts === null ? (
              <tr><td colSpan={3} className="px-4 py-8 text-center text-muted">加载中…</td></tr>
            ) : accounts.length === 0 ? (
              <tr><td colSpan={3} className="px-4 py-8 text-center text-muted">暂无后台账户</td></tr>
            ) : accounts.map((a) => {
              const role = effRole(a);
              return (
                <tr key={a.id} className="border-b border-edge last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium text-ink">
                      {a.name}{a.disabled ? " (已停用)" : ""}
                      {a.managed_password ? <span className="ml-2 rounded-full bg-accentSoft px-2 py-0.5 text-[10.5px] text-accent">独立密码管理员</span> : null}
                    </p>
                    <p className="text-xs text-muted">{a.phone ?? a.email ?? a.id}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${ROLE_STYLE[role] ?? "bg-panel2 text-ink2 border-edge"}`}>{ROLE_LABEL[role] ?? "—"}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!readOnly && !a.managed_password && (
                      <div className="inline-flex flex-wrap justify-end gap-1.5">
                        {(["super", "operator", "auditor"] as const).filter((r) => r !== role).map((r) => (
                          <button key={r} disabled={busy} onClick={() => setPendingRole({ userId: a.id, name: a.name, role: r })}
                            className="rounded-md border border-edge px-2 py-1 text-[11.5px] text-ink2 transition hover:border-accent hover:text-accent disabled:opacity-40">
                            {ROLE_LABEL[r]}
                          </button>
                        ))}
                        <button disabled={busy} onClick={() => setPendingRole({ userId: a.id, name: a.name, role: null })}
                          className="rounded-md border border-red-200 px-2 py-1 text-[11.5px] text-red-500 transition hover:bg-red-50 disabled:opacity-40">
                          撤销
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pendingRole && (
        <ConfirmDialog
          title={pendingRole.role ? "变更管理角色" : "撤销后台权限"}
          danger={!pendingRole.role || pendingRole.role === "super"}
          busy={busy}
          confirmLabel={pendingRole.role ? `设为${ROLE_LABEL[pendingRole.role]}` : "确认撤销"}
          onCancel={() => setPendingRole(null)}
          onConfirm={() => void setRole(pendingRole.userId, pendingRole.role)}
        >
          {pendingRole.role
            ? `“${pendingRole.name}”将获得${ROLE_LABEL[pendingRole.role]}权限，变更会立即生效。`
            : `“${pendingRole.name}”将无法继续进入管理中心，当前管理会话也会失效。`}
        </ConfirmDialog>
      )}
    </div>
  );
}
