import { NextRequest, NextResponse } from "next/server";
import { adminUserFromRequest, userFromRequest } from "./auth";
import type { User } from "./types";
import { isAdminPasswordLoginEnforced } from "./admin-password-access";
import { adminRoleOf, type AdminRole } from "./admin-identity";
export {
  adminRoleOf,
  hasAdminLoginIdentity,
  isAdmin,
  isSystemAdminUser,
  type AdminRole,
} from "./admin-identity";

// ---------------------------------------------------------------------------
// 三员账户体系(等保 2.0 三权分立):
//   super    系统管理员 —— 配置系统 + 管理账户 + 授予角色(操作全进审计)
//   operator 运营员     —— 业务运营(数据/内容/反馈/开关),不碰密钥/运维/审计/权益配置
//   auditor  安全审计员 —— 只读审计/活动/监控,监督前两者,零配置权
// 普通用户无 admin_role；is_admin=1 兼容为 super。
// ---------------------------------------------------------------------------

/** 后台模块(与 app/admin 各页 + API 路由一一对应)。 */
export type AdminModule =
  | "overview" | "analytics" | "users" | "featured" | "credits" | "plans" | "settings"
  | "feedback" | "monitor" | "audit" | "accounts" | "providers" | "ops" | "legal";

/** 每模块:哪些【非 super】角色可写(write)、哪些可只读(read)。super 恒可写,不列。
 *  权益方案(plans)与积分配置仅 super;审计(audit)仅 super+auditor;密钥/运维/法律仅 super。 */
const MODULE_ACCESS: Record<AdminModule, { write: AdminRole[]; read: AdminRole[] }> = {
  overview:  { write: ["operator"], read: ["auditor"] },
  analytics: { write: ["operator"], read: ["auditor"] },
  users:     { write: ["operator"], read: ["auditor"] },
  featured:  { write: ["operator"], read: ["auditor"] },   // 精选策展 = 内容运营;审计只读监督
  credits:   { write: [], read: ["operator", "auditor"] }, // 用量流水可看,配置仅 super
  plans:     { write: [], read: [] },                       // 权益方案仅 super
  settings:  { write: ["operator"], read: [] },             // 功能开关/输出语言
  feedback:  { write: ["operator"], read: [] },
  monitor:   { write: ["operator"], read: ["auditor"] },
  audit:     { write: [], read: ["auditor"] },              // super + auditor;operator 无
  accounts:  { write: [], read: ["auditor"] },              // 授权仅 super;auditor 只读
  providers: { write: [], read: [] },                       // API 密钥仅 super
  ops:       { write: [], read: [] },                       // 运维仅 super
  legal:     { write: [], read: [] },                       // 法律文档仅 super
};

/** 该角色能否访问模块(读或写皆可)。super 恒 true。 */
export function canAccess(role: AdminRole, module: AdminModule): boolean {
  if (role === "super") return true;
  const a = MODULE_ACCESS[module];
  return a.write.includes(role) || a.read.includes(role);
}

/** 该角色能否对模块执行【写操作】。super 恒 true。 */
export function canWrite(role: AdminRole, module: AdminModule): boolean {
  if (role === "super") return true;
  return MODULE_ACCESS[module].write.includes(role);
}

/** 该角色可进入的模块清单(后台侧栏过滤用)。 */
export function accessibleModules(role: AdminRole): AdminModule[] {
  return (Object.keys(MODULE_ACCESS) as AdminModule[]).filter((m) => canAccess(role, m));
}

/** 该角色可执行写操作的模块清单。前端只消费服务端返回的这份结果，
 *  不在浏览器里复制三员权限矩阵，避免页面按钮与 API 守卫漂移。 */
export function writableModules(role: AdminRole): AdminModule[] {
  return (Object.keys(MODULE_ACCESS) as AdminModule[]).filter((m) => canWrite(role, m));
}

function adminOriginError(req: NextRequest): NextResponse | null {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) return null;
  const sent = (req.headers.get("origin") ?? "").replace(/\/+$/, "");
  const expected = (process.env.PUBLIC_ORIGIN || req.nextUrl.origin).replace(/\/+$/, "");
  if (!sent || sent !== expected) {
    return NextResponse.json({ error: "管理请求来源无效" }, { status: 403 });
  }
  return null;
}

/** 旧守卫:任一后台角色即放行(兼容尚未细分模块的路由)。 */
export async function requireAdmin(req: NextRequest): Promise<User | NextResponse> {
  const originError = adminOriginError(req);
  if (originError) return originError;
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const role = adminRoleOf(user);
  if (!role) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });
  if (role === "super" && isAdminPasswordLoginEnforced()) {
    const adminUser = await adminUserFromRequest(req);
    if (!adminUser || adminUser.id !== user.id) {
      return NextResponse.json(
        { error: "系统管理员会话已过期，请使用独立管理员入口重新登录", code: "admin_session_required" },
        { status: 401 }
      );
    }
  }
  return user;
}

/** 按模块 + 读/写把关。opts.write=true 要求写权限,否则只需可访问(读)。 */
export async function requireRole(
  req: NextRequest,
  module: AdminModule,
  opts?: { write?: boolean }
): Promise<User | NextResponse> {
  const originError = adminOriginError(req);
  if (originError) return originError;
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const role = adminRoleOf(user);
  if (!role) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });
  if (role === "super" && isAdminPasswordLoginEnforced()) {
    const adminUser = await adminUserFromRequest(req);
    if (!adminUser || adminUser.id !== user.id) {
      return NextResponse.json(
        { error: "系统管理员会话已过期，请使用独立管理员入口重新登录", code: "admin_session_required" },
        { status: 401 }
      );
    }
  }
  const ok = opts?.write ? canWrite(role, module) : canAccess(role, module);
  if (!ok) {
    return NextResponse.json(
      { error: opts?.write ? "当前角色无此操作权限" : "当前角色无权访问该模块" },
      { status: 403 }
    );
  }
  return user;
}
