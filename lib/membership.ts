import type { User } from "./types";
import { isEntitledTier } from "./plans";
import { isSystemAdminUser } from "./admin-identity";

/**
 * 有没有在有效期内的可用权益。trial 与受管理权益使用同一有效期合同。
 *
 * 判据用 isEntitledTier 而不是本文件的 isPaidPlanId:后者只有 starter/pro/max,
 * 曾经让试用用户在三个地方被当成非会员 —— 编辑笔记本被 403、新建/搜索被 403、
 * 下载一律打水印,而扣费层其实已经放行了。这种「后端放行、门口拦住」的断裂
 * 不会报错,只会让人以为产品坏了。
 *
 * 会话层会惰性降级到期会员；这里仍复核到期，堵住长请求与脏数据窗口。
 */
export function isActiveMember(
  user: Pick<User, "plan_tier" | "plan_expires_at"> | null | undefined,
  now = Date.now()
): boolean {
  if (!user || !isEntitledTier(user.plan_tier)) return false;
  const expiresAt = Number(user.plan_expires_at ?? 0);
  // 权益档必须有明确未来到期时间；0 不代表永久权益。
  return expiresAt > now;
}

type EntitlementUser = Pick<
  User,
  | "id"
  | "phone"
  | "wechat_openid"
  | "plan_tier"
  | "plan_expires_at"
  | "bonus_credits"
  | "disabled"
  | "is_admin"
  | "admin_role"
>;

/** 有效权益、可用奖励积分或系统管理员，任一成立即可进入功能；模型调用仍原子扣分。 */
export function hasUsageAccess(
  user: EntitlementUser | null | undefined,
  now = Date.now()
): boolean {
  if (!user || user.disabled) return false;
  return isSystemAdminUser(user as User) || isActiveMember(user, now) || Number(user.bonus_credits ?? 0) > 0;
}

/**
 * 权益能力映射不改 DB 档位：系统管理员复用 test 的不限量能力；有积分的非会员
 * 复用 trial 的基础工作区能力；撤权或积分耗尽后下一请求立即回真实档位。
 */
export function effectivePlanTierForUser(
  user: EntitlementUser | null | undefined,
  now = Date.now()
): string {
  if (!user || user.disabled) return "free";
  if (isSystemAdminUser(user as User)) return "test";
  if (isActiveMember(user, now)) return user.plan_tier ?? "free";
  return Number(user.bonus_credits ?? 0) > 0 ? "trial" : "free";
}

export function membershipSnapshot(
  user: EntitlementUser | null | undefined,
  now = Date.now()
) {
  const systemAdmin = isSystemAdminUser(user as User | null | undefined);
  const active = systemAdmin || isActiveMember(user, now);
  const tier = systemAdmin ? "test" : active ? user?.plan_tier ?? null : null;
  return {
    status: active ? ("active" as const) : ("none" as const),
    active,
    // 必须回真实档位(含 trial)。此前这里过 isPaidPlanId,试用用户拿到的是 null,
    // 于是 /api/usage 的 effectiveTier 回落成 free —— 前端看到的是零权益配置
    // (0 个笔记本、要打水印),和后端的实际放行对不上。
    tier,
    /** 是否处于注册试用期。前端据此把文案写成「试用中」而不是「会员」。 */
    trial: !systemAdmin && tier === "trial",
    /** 环境配置发放的内部测试权益；不参与邀请奖励。 */
    test: !systemAdmin && tier === "test",
    /** 系统管理员拥有虚拟不限量能力，但数据库会员档位保持不变。 */
    systemAdmin,
    expiresAt: active && !systemAdmin ? Math.max(0, Number(user?.plan_expires_at ?? 0)) : 0,
  };
}

/** 兼容 usage API 的语义化命名。 */
export const resolveMembership = membershipSnapshot;

/** 当前时刻之后最近一次东八区 00:00 的 Unix 毫秒。 */
export function nextBeijingResetAt(now = Date.now()): number {
  const shifted = new Date(now + 8 * 60 * 60 * 1000);
  return (
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate() + 1
    ) -
    8 * 60 * 60 * 1000
  );
}
