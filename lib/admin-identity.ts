import type { User } from "./types";
import {
  adminPasswordAccountByUserId,
  isAdminPasswordLoginEnforced,
  isAdminPasswordUserId,
} from "./admin-password-access";

export type AdminRole = "super" | "operator" | "auditor";

/** 是否存在可重新认证的后台主体；无登录方式的孤儿行不能充当系统管理员。 */
export function hasAdminLoginIdentity(user: User): boolean {
  if (user.plan_tier === "test") return false;
  if (isAdminPasswordUserId(user.id)) return adminPasswordAccountByUserId(user.id) !== null;
  return !!user.phone?.trim() || !!user.wechat_openid?.trim();
}

/** 三员身份的唯一纯解析入口；不依赖 auth/db，可被会员与积分层安全复用。 */
export function adminRoleOf(user: User | null | undefined): AdminRole | null {
  if (!user || user.disabled) return null;
  if (isAdminPasswordUserId(user.id)) {
    return adminPasswordAccountByUserId(user.id) && Number(user.is_admin) === 1 && user.admin_role === "super"
      ? "super"
      : null;
  }
  if (user.plan_tier === "test") return null;
  if (!hasAdminLoginIdentity(user)) return null;
  if (user.admin_role === "operator" || user.admin_role === "auditor") return user.admin_role;
  // 独立密码入口启用后，普通登录会话不能直接获得系统管理员能力。
  if (isAdminPasswordLoginEnforced()) return null;
  if (user.admin_role === "super") return "super";
  return Number(user.is_admin) === 1 ? "super" : null;
}

export function isAdmin(user: User | null | undefined): boolean {
  return adminRoleOf(user) !== null;
}

/** 只有系统管理员获得不限量资源权益；operator/auditor 明确不包含。 */
export function isSystemAdminUser(user: User | null | undefined): boolean {
  return adminRoleOf(user) === "super";
}
