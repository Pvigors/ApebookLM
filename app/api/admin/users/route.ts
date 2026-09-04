import { NextRequest, NextResponse } from "next/server";
import { adminRoleOf, requireRole } from "@/lib/admin";
import {
  deleteNotebook,
  deleteUser,
  getNotebook,
  guardUserAdminLifecycle,
  revokeUserSessions,
  retireFeaturedNotebook,
  setNotebookPublic,
  setUserDisabled,
  transferNotebookOwner,
} from "@/lib/db";
import { getPool } from "@/lib/pg";
import { recordEvent } from "@/lib/activity";
import { isConfiguredExperienceUser } from "@/lib/experience-access";
import { adminPasswordAccountByUserId, isAdminPasswordUserId } from "@/lib/admin-password-access";
import type { User } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maskPhone = (p: string | null) => (p ? `${p.slice(0, 3)}****${p.slice(-2)}` : p);
const maskEmail = (email: string | null) => {
  if (!email) return null;
  const at = email.indexOf("@");
  return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : "****";
};

export async function GET(req: NextRequest) {
  const g = await requireRole(req, "users");
  if (g instanceof NextResponse) return g;
  const pool = getPool();
  const role = adminRoleOf(g);
  const q = (req.nextUrl.searchParams.get("q") || "").trim().toLowerCase();
  // 默认在服务端脱敏手机号;仅当显式 reveal=1 时返回明文,并记一条审计(查看明文属敏感操作)。
  const reveal = req.nextUrl.searchParams.get("reveal") === "1";
  if (reveal && role === "auditor") {
    return NextResponse.json({ error: "安全审计员只能查看脱敏用户信息" }, { status: 403 });
  }
  const rawUsers = (
    await pool.query(
      `SELECT u.id, u.name, u.phone, u.email, u.wechat_nickname,
              (u.wechat_openid IS NOT NULL) AS wechat_bound,
              u.created_at, u.last_seen, u.last_login_at, u.login_count, u.disabled, u.is_admin,
              u.plan_tier, u.plan_expires_at, u.bonus_credits,
              (SELECT COUNT(*) FROM notebooks nb WHERE nb.user_id = u.id) AS notebooks,
              (SELECT COUNT(*) FROM sources s JOIN notebooks nb ON nb.id = s.notebook_id WHERE nb.user_id = u.id AND (s.origin IS NULL OR s.origin NOT LIKE 'note:%')) AS sources,
              (SELECT COUNT(*) FROM studio_outputs o JOIN notebooks nb ON nb.id = o.notebook_id WHERE nb.user_id = u.id) AS outputs
       FROM users u ORDER BY u.last_seen DESC`
    )
  ).rows as Array<{ phone: string | null; [k: string]: unknown }>;
  // 审计员可按名称/内部 ID 定位对象，但不能用手机号、邮箱或微信名做存在性枚举。
  const matchingUsers = q
    ? rawUsers.filter((user) =>
        (role === "auditor"
          ? [user.name, user.id]
          : [user.name, user.phone, user.email, user.wechat_nickname, user.id]
        ).some((value) =>
          String(value ?? "").toLowerCase().includes(q)
        )
      )
    : rawUsers;
  const users = reveal
    ? matchingUsers
    : matchingUsers.map((user) =>
        role === "auditor"
          ? {
              ...user,
              phone: maskPhone(user.phone),
              email: maskEmail(typeof user.email === "string" ? user.email : null),
              wechat_nickname: null,
            }
          : { ...user, phone: maskPhone(user.phone) }
      );
  if (reveal) {
    await recordEvent({ actorId: g.id, actorKind: "admin", action: "admin.users_reveal_phone", meta: { count: rawUsers.length } });
  }
  const notebooks = (
    await pool.query(
      `SELECT nb.id, nb.title, nb.emoji, nb.public, nb.featured, nb.featured_order, nb.created_at,
              nb.user_id AS owner_id, u.name AS owner,
              (SELECT COUNT(*) FROM sources s WHERE s.notebook_id = nb.id AND (s.origin IS NULL OR s.origin NOT LIKE 'note:%')) AS sources,
              (SELECT COUNT(*) FROM studio_outputs o WHERE o.notebook_id = nb.id) AS outputs
       FROM notebooks nb LEFT JOIN users u ON u.id = nb.user_id
       ORDER BY nb.featured DESC, nb.featured_order ASC, nb.created_at DESC LIMIT 500`
    )
  ).rows as Array<{ title: string; owner: string | null; public: number }>;
  const filtered = q
    ? notebooks.filter(
        (n) => n.title.toLowerCase().includes(q) || (n.owner ?? "").toLowerCase().includes(q)
      )
    : notebooks;
  return NextResponse.json({ users, notebooks: filtered });
}

/** 后台管理动作。所有破坏性 / 改鉴权动作均记录到 activity_log。 */
export async function POST(req: NextRequest) {
  const g = await requireRole(req, "users", { write: true });
  if (g instanceof NextResponse) return g;
  const b = (await req.json().catch(() => ({}))) as {
    action?: string;
    notebookId?: string;
    userId?: string;
    toUserId?: string;
    dir?: "up" | "down";
    cover?: string | null;
    publisher?: string | null;
    publisherAvatar?: string | null;
    amount?: number;
    plan?: string;
    expiresAt?: number;
    lifetime?: boolean; // 旧客户端参数；受管理权益必须有明确到期时间
    title?: string;
    body?: string;
  };
  const admin = { actorId: g.id, actorKind: "admin" as const };
  const ev = (action: string, extra: Record<string, unknown> = {}) =>
    recordEvent({ ...admin, action, ...extra });

  // 管理员角色只能在「管理账户」由 super 调整；用户管理页绝不能成为 operator 提权旁路。
  if (b.action === "user_set_admin" || b.action === "user_unset_admin") {
    return NextResponse.json({ error: "管理员角色请在「管理账户」中调整" }, { status: 403 });
  }

  // 环境托管账号可停用/启用/踢下线，但不能被删除后由环境配置悄悄重建，
  // 也不能通过普通运营动作改变其身份/权益。
  const protectedManagedActions = new Set([
    "user_set_admin",
    "user_unset_admin",
    "user_delete",
    "user_grant_credits",
    "user_set_plan",
  ]);
  let actionTarget: User | undefined;
  if (b.userId && b.action) {
    actionTarget = (
      await getPool().query("SELECT * FROM users WHERE id = $1", [b.userId])
    ).rows[0] as User | undefined;
    if (
      protectedManagedActions.has(b.action) &&
      actionTarget?.plan_tier === "test" &&
      isConfiguredExperienceUser(b.userId)
    ) {
      return NextResponse.json(
        { error: "测试账号由生产环境配置管理；可停用或撤销会话，不能执行此操作" },
        { status: 403 }
      );
    }
    if (
      protectedManagedActions.has(b.action) &&
      isAdminPasswordUserId(b.userId) &&
      adminPasswordAccountByUserId(b.userId)
    ) {
      return NextResponse.json(
        { error: "独立密码管理员由环境配置管理；可停用或撤销会话，不能执行此操作" },
        { status: 403 }
      );
    }
    const lifecycle = new Set(["user_disable", "user_enable", "user_revoke", "user_delete"]);
    const targetIsAdmin =
      !!actionTarget &&
      (isAdminPasswordUserId(actionTarget.id) ||
        Number(actionTarget.is_admin) === 1 ||
        !!actionTarget.admin_role ||
        adminRoleOf(actionTarget) !== null);
    if (lifecycle.has(b.action) && targetIsAdmin && adminRoleOf(g) !== "super") {
      return NextResponse.json({ error: "只有系统管理员可以管理后台账户" }, { status: 403 });
    }
  }

  switch (b.action) {
    // ---- 笔记本 ----
    case "feature": {
      return NextResponse.json(
        { error: "精选新增请使用专用精选管理接口", code: "use_featured_api" },
        { status: 409 }
      );
    }
    case "unfeature": {
      if (!b.notebookId) return NextResponse.json({ error: "缺少 notebookId" }, { status: 400 });
      const stopped = await retireFeaturedNotebook(b.notebookId);
      if (!stopped) return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });
      await ev("admin.notebook_unfeature", {
        targetType: "notebook",
        targetId: b.notebookId,
        notebookId: b.notebookId,
        meta: { title: (await getNotebook(b.notebookId))?.title, via: "users-legacy", stopped },
      });
      return NextResponse.json({ ok: true });
    }
    case "set_private": {
      if (!b.notebookId) return NextResponse.json({ error: "缺少 notebookId" }, { status: 400 });
      const stopped = await retireFeaturedNotebook(b.notebookId, { makePrivate: true });
      if (!stopped) return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });
      await ev("admin.notebook_private", {
        targetType: "notebook",
        targetId: b.notebookId,
        notebookId: b.notebookId,
        meta: { title: (await getNotebook(b.notebookId))?.title, stopped },
      });
      return NextResponse.json({ ok: true });
    }
    case "set_public": {
      // 独立「设为公开」(不连带进精选画廊),与「精选」解耦。
      if (!b.notebookId) return NextResponse.json({ error: "缺少 notebookId" }, { status: 400 });
      await setNotebookPublic(b.notebookId, true);
      await ev("admin.notebook_public", {
        targetType: "notebook",
        targetId: b.notebookId,
        notebookId: b.notebookId,
        meta: { title: (await getNotebook(b.notebookId))?.title },
      });
      return NextResponse.json({ ok: true });
    }
    case "delete_notebook": {
      if (!b.notebookId) return NextResponse.json({ error: "缺少 notebookId" }, { status: 400 });
      const title = (await getNotebook(b.notebookId))?.title;
      await deleteNotebook(b.notebookId);
      await ev("admin.notebook_delete", { targetType: "notebook", targetId: b.notebookId, meta: { title } });
      return NextResponse.json({ ok: true });
    }
    case "transfer_owner": {
      if (!b.notebookId || !b.toUserId)
        return NextResponse.json({ error: "缺少参数" }, { status: 400 });
      const target = (
        await getPool().query("SELECT id, disabled FROM users WHERE id = $1", [b.toUserId])
      ).rows[0] as { id: string; disabled: number } | undefined;
      if (!target) return NextResponse.json({ error: "目标用户不存在" }, { status: 400 });
      if (target.disabled) return NextResponse.json({ error: "不能转移给已停用账号" }, { status: 400 });
      await transferNotebookOwner(b.notebookId, b.toUserId);
      await ev("admin.notebook_transfer", {
        targetType: "notebook",
        targetId: b.notebookId,
        notebookId: b.notebookId,
        meta: { to: b.toUserId },
      });
      return NextResponse.json({ ok: true });
    }
    case "featured_meta": {
      return NextResponse.json(
        { error: "精选门面请使用专用精选管理接口", code: "use_featured_api" },
        { status: 409 }
      );
    }
    case "featured_move": {
      return NextResponse.json(
        { error: "精选排序请使用专用精选管理接口", code: "use_featured_api" },
        { status: 409 }
      );
    }

    // ---- 用户 ----
    case "user_disable":
    case "user_enable": {
      if (!b.userId) return NextResponse.json({ error: "缺少 userId" }, { status: 400 });
      if (b.userId === g.id)
        return NextResponse.json({ error: "不能停用自己" }, { status: 400 });
      const disable = b.action === "user_disable";
      if (disable) {
        const guarded = await guardUserAdminLifecycle(b.userId, "disable");
        if (guarded === "not_found")
          return NextResponse.json({ error: "目标用户不存在" }, { status: 404 });
        if (guarded === "last_super")
          return NextResponse.json({ error: "不能停用最后一名管理员" }, { status: 400 });
      } else {
        await setUserDisabled(b.userId, false);
      }
      await ev(disable ? "admin.user_disable" : "admin.user_enable", {
        targetType: "user",
        targetId: b.userId,
      });
      return NextResponse.json({ ok: true });
    }
    case "user_revoke": {
      if (!b.userId) return NextResponse.json({ error: "缺少 userId" }, { status: 400 });
      if (b.userId === g.id)
        return NextResponse.json({ error: "不能撤销自己的登录" }, { status: 400 });
      const n = await revokeUserSessions(b.userId);
      await ev("admin.user_revoke", { targetType: "user", targetId: b.userId, meta: { sessions: n } });
      return NextResponse.json({ ok: true, revoked: n });
    }
    case "user_delete": {
      if (!b.userId) return NextResponse.json({ error: "缺少 userId" }, { status: 400 });
      if (b.userId === g.id)
        return NextResponse.json({ error: "不能删除自己" }, { status: 400 });
      const guarded = await guardUserAdminLifecycle(b.userId, "delete");
      if (guarded === "not_found")
        return NextResponse.json({ error: "目标用户不存在" }, { status: 404 });
      if (guarded === "last_super")
        return NextResponse.json({ error: "不能删除最后一名管理员" }, { status: 400 });
      await deleteUser(b.userId);
      await ev("admin.user_delete", { targetType: "user", targetId: b.userId });
      return NextResponse.json({ ok: true });
    }

    // ---- 运营操作 ----
    case "user_grant_credits": {
      if (!b.userId) return NextResponse.json({ error: "缺少 userId" }, { status: 400 });
      const amount = b.amount;
      if (!Number.isInteger(amount) || (amount as number) < 1 || (amount as number) > 10000)
        return NextResponse.json({ error: "赠送数量须为 1~10000 的整数" }, { status: 400 });
      const target = (
        await getPool().query("SELECT id, name FROM users WHERE id = $1", [b.userId])
      ).rows[0] as { id: string; name: string } | undefined;
      if (!target) return NextResponse.json({ error: "目标用户不存在" }, { status: 400 });
      {
        const client = await getPool().connect();
        try {
          await client.query("BEGIN");
          // 与消费共用 users 行锁，余额与 acquisition 流水不可部分成功。
          await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [b.userId]);
          await client.query("UPDATE users SET bonus_credits = bonus_credits + $1 WHERE id = $2", [amount, b.userId]);
          // 号约定:credit_ledger 里「消耗为正」(consumeDailyQuota 记 +credits)、
          // 「入账为负」(refundCredits 记 -credits)。管理员赠送是入账,记 -amount,
          // 保证 SUM(credits) 仍等于净消耗,后台对账页口径不被赠送灌水。
          await client.query(
            `INSERT INTO credit_ledger (user_id, op, credits, bonus, plan_credits, ts)
               VALUES ($1, $2, $3, $3, 0, $4)`,
            [b.userId, "admin:grant", -(amount as number), Date.now()]
          );
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      }
      await ev("admin.user.grant_credits", {
        targetType: "user",
        targetId: b.userId,
        meta: { amount, name: target.name },
      });
      return NextResponse.json({ ok: true });
    }
    case "user_set_plan": {
      if (!b.userId) return NextResponse.json({ error: "缺少 userId" }, { status: 400 });
      const plan = b.plan;
      if (plan !== "free" && plan !== "starter" && plan !== "pro" && plan !== "max")
        return NextResponse.json({ error: "无效权益档位" }, { status: 400 });
      let planExpiresAt = 0;
      if (plan !== "free") {
        const hasExpiry = Number.isSafeInteger(b.expiresAt) && Number(b.expiresAt) > Date.now();
        if (!hasExpiry || b.lifetime === true) {
          return NextResponse.json(
            { error: "受管理权益必须指定明确的未来 expiresAt，不支持永久权益" },
            { status: 400 }
          );
        }
        planExpiresAt = Number(b.expiresAt);
      } else if (b.lifetime === true || (b.expiresAt != null && Number(b.expiresAt) !== 0)) {
        return NextResponse.json({ error: "基础权益不能设置到期时间" }, { status: 400 });
      }
      const target = (
        await getPool().query("SELECT id, name, plan_tier, plan_expires_at FROM users WHERE id = $1", [b.userId])
      ).rows[0] as { id: string; name: string; plan_tier: string; plan_expires_at: number } | undefined;
      if (!target) return NextResponse.json({ error: "目标用户不存在" }, { status: 400 });
      const updated = (
        await getPool().query(
          "UPDATE users SET plan_tier = $1, plan_expires_at = $2 WHERE id = $3 RETURNING plan_tier, plan_expires_at",
          [plan, planExpiresAt, b.userId]
        )
      ).rows[0] as { plan_tier: string; plan_expires_at: number };
      await ev("admin.user.set_plan", {
        targetType: "user",
        targetId: b.userId,
        meta: {
          plan,
          from: target.plan_tier,
          expiresAt: Number(updated.plan_expires_at),
          previousExpiresAt: Number(target.plan_expires_at ?? 0),
          name: target.name,
        },
      });
      return NextResponse.json({
        ok: true,
        planTier: updated.plan_tier,
        planExpiresAt: Number(updated.plan_expires_at),
      });
    }
    case "notify": {
      const title = (b.title ?? "").trim();
      const body = (b.body ?? "").trim();
      if (!title || title.length > 60)
        return NextResponse.json({ error: "标题必填且不超过 60 字" }, { status: 400 });
      if (!body || body.length > 300)
        return NextResponse.json({ error: "内容必填且不超过 300 字" }, { status: 400 });
      let targets: { id: string }[];
      if (b.userId) {
        const t = (await getPool().query("SELECT id FROM users WHERE id = $1", [b.userId])).rows[0] as
          | { id: string }
          | undefined;
        if (!t) return NextResponse.json({ error: "目标用户不存在" }, { status: 400 });
        targets = [t];
      } else {
        // 群发 = 全部未停用用户
        targets = (await getPool().query("SELECT id FROM users WHERE disabled = 0")).rows as { id: string }[];
      }
      const now = Date.now();
      {
        const client = await getPool().connect();
        try {
          await client.query("BEGIN");
          for (const t of targets)
            await client.query(
              "INSERT INTO notifications (id, user_id, type, title, summary, link, read, created_at) VALUES ($1, $2, 'admin', $3, $4, NULL, 0, $5)",
              [crypto.randomUUID(), t.id, title, body, now]
            );
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      }
      await ev("admin.notify", {
        meta: { title, delivered: targets.length, scope: b.userId ? "single" : "all", to: b.userId ?? undefined },
      });
      return NextResponse.json({ ok: true, delivered: targets.length });
    }

    default:
      return NextResponse.json({ error: "未知动作" }, { status: 400 });
  }
}
