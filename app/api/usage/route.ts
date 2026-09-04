import { NextRequest, NextResponse } from "next/server";
import { userFromRequest } from "@/lib/auth";
import { getUserUsage, checkNotebookQuota, getBonusCredits } from "@/lib/db";
import { getPlanConfig } from "@/lib/plans-config";
import { getCreditConfig } from "@/lib/credits-config";
import {
  effectivePlanTierForUser,
  hasUsageAccess,
  membershipSnapshot,
  nextBeijingResetAt,
} from "@/lib/membership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 当前用户的本月/今日 AI 生成用量 + 所在套餐的每日额度。 */
export async function GET(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const now = Date.now();
  const membershipState = membershipSnapshot(user, now);
  const effectiveTier = effectivePlanTierForUser(user, now);
  const [usage, plan, credits, nb, rawBonusCredits] = await Promise.all([
    getUserUsage(user.id),
    getPlanConfig(effectiveTier),
    getCreditConfig(),
    checkNotebookQuota({ id: user.id, plan_tier: effectiveTier }),
    getBonusCredits(user.id),
  ]);
  const membership = {
    ...membershipState,
    name: membershipState.systemAdmin ? "系统管理员" : membershipState.active ? plan.name : "基础权益",
  };
  const bonusCredits = Math.max(0, Number(rawBonusCredits) || 0);
  const dailyRemaining = plan.dailyLimit < 0
    ? -1
    : Math.max(0, plan.dailyLimit - usage.today);
  const accessActive = hasUsageAccess(user, now);
  const totalAvailable = !accessActive
    ? 0
    : dailyRemaining < 0
      ? -1
      : dailyRemaining + bonusCredits;
  return NextResponse.json({
    today: usage.today,
    month: usage.month,
    dailyLimit: plan.dailyLimit, // -1 = 不限量
    notebooks: nb.used, // 本人拥有的笔记本数
    maxNotebooks: plan.maxNotebooks, // -1 = 不限量
    bonusCredits, // 邀请返利奖励额度余额
    // 护城河 1:单文件上传字节上限,前端 HomeClient 预检读它做「已跳过」toast + 提前放弃上传。
    // 与 sources/route.ts 的 MAX_FILE_BYTES 同源(同一 getPlan().maxFileBytes)。
    maxFileBytes: plan.maxFileBytes,
    // 生成弹窗展示当前后台生效价；成功后只会按真实 Token 多退、不暗中多扣。
    studioCreditCosts: credits.studio,
    creditCosts: credits.costs,
    downloadWatermark: plan.watermark,
    plan: user.plan_tier ?? "free",
    capabilityPlan: plan.id,
    membership,
    access: {
      active: accessActive,
      systemAdmin: membershipState.systemAdmin,
      reason: membershipState.systemAdmin ? "system_admin" : membershipState.active ? "membership" : bonusCredits > 0 ? "credits" : "none",
    },
    daily: {
      limit: plan.dailyLimit,
      spent: usage.today,
      remaining: dailyRemaining,
      resetAt: nextBeijingResetAt(now),
    },
    bonus: { balance: bonusCredits },
    totalAvailable,
  });
}
