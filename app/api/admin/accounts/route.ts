import { NextRequest, NextResponse } from "next/server";
import { adminRoleOf, requireRole, type AdminRole } from "@/lib/admin";
import { listAdminAccounts, setUserAdminRoleGuarded, getUserById, getUserByPhone } from "@/lib/db";
import { recordEvent } from "@/lib/activity";
import { adminPasswordAccountByUserId, isAdminPasswordUserId } from "@/lib/admin-password-access";

const ROLES: AdminRole[] = ["super", "operator", "auditor"];
const maskPhone = (phone: string | null) =>
  phone ? `${phone.slice(0, 3)}****${phone.slice(-2)}` : null;
const maskEmail = (email: string | null) => {
  if (!email) return null;
  const at = email.indexOf("@");
  return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : "****";
};

/** 列出后台账户;?q=手机号/id 时附带查一个可授权的目标用户。 */
export async function GET(req: NextRequest) {
  const g = await requireRole(req, "accounts");
  if (g instanceof NextResponse) return g;
  const role = adminRoleOf(g);
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (q && role !== "super") {
    return NextResponse.json({ error: "只有系统管理员可以查找待授权用户" }, { status: 403 });
  }
  const rawAccounts = await listAdminAccounts();
  const accounts = role === "auditor"
    ? rawAccounts.map((account) => ({
        ...account,
        phone: maskPhone(account.phone),
        email: maskEmail(account.email),
      }))
    : rawAccounts;
  let found: { id: string; name: string; phone: string | null; admin_role: string | null; managed_password: number } | null = null;
  if (q) {
    const u = (await getUserByPhone(q)) ?? (await getUserById(q));
    if (u) found = {
      id: u.id,
      name: u.name,
      phone: u.phone ?? null,
      admin_role: u.admin_role ?? null,
      managed_password: adminPasswordAccountByUserId(u.id) ? 1 : 0,
    };
  }
  return NextResponse.json({ accounts, found });
}

/** 授予/变更/撤销三员角色(仅系统管理员)。带最后超管守卫 + 审计埋点。 */
export async function POST(req: NextRequest) {
  const g = await requireRole(req, "accounts", { write: true });
  if (g instanceof NextResponse) return g;
  const body = (await req.json().catch(() => ({}))) as { userId?: string; role?: string | null };
  const userId = typeof body.userId === "string" ? body.userId : "";
  const role = body.role === null ? null : String(body.role);
  if (!userId) return NextResponse.json({ error: "缺少用户" }, { status: 400 });
  if (role !== null && !ROLES.includes(role as AdminRole)) {
    return NextResponse.json({ error: "无效角色" }, { status: 400 });
  }
  const target = await getUserById(userId);
  if (!target) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  if (isAdminPasswordUserId(userId) && adminPasswordAccountByUserId(userId)) {
    return NextResponse.json(
      { error: "独立密码管理员由环境配置管理；可在用户管理中停用或撤销会话" },
      { status: 403 }
    );
  }

  const changed = await setUserAdminRoleGuarded(userId, role as AdminRole | null);
  if (changed === "not_found") return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  if (changed === "last_super") {
    return NextResponse.json({ error: "不能撤销最后一个系统管理员" }, { status: 400 });
  }
  if (changed === "ineligible") {
    return NextResponse.json(
      { error: "该账号没有可用的管理员登录方式，或属于测试账号，不能授予管理角色" },
      { status: 400 }
    );
  }
  await recordEvent({
    actorId: g.id,
    actorKind: "admin",
    action: "admin.role_change",
    targetType: "user",
    targetId: userId,
    meta: { role: role ?? "none", targetName: target.name },
  });
  return NextResponse.json({ ok: true });
}
