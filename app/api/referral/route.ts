import { NextRequest, NextResponse } from "next/server";
import { userFromRequest } from "@/lib/auth";
import {
  getOrCreateInviteCode,
  getReferralStats,
  REFERRAL_REWARD,
  REFERRAL_MONTHLY_CAP,
  REFERRAL_MONTHLY_INVITES,
} from "@/lib/db";
import { isSystemAdminUser } from "@/lib/admin-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 当前用户的推广邀请码 + 本月/累计返利统计。 */
export async function GET(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (user.plan_tier === "test" || isSystemAdminUser(user)) {
    return NextResponse.json(
      { error: isSystemAdminUser(user) ? "系统管理员不参与邀请返利" : "测试账号不参与邀请返利" },
      { status: 403 }
    );
  }
  const code = await getOrCreateInviteCode(user.id);
  const stats = await getReferralStats(user.id);
  return NextResponse.json({
    code,
    rewardPerMilestone: REFERRAL_REWARD, // 每个里程碑返利额度(次)
    inviteCap: REFERRAL_MONTHLY_INVITES, // 每月可返利邀请数
    earnCap: REFERRAL_MONTHLY_CAP, // 每月最多赚取额度
    ...stats, // invitedThisMonth / totalInvited / earnedThisMonth / totalEarned / bonusCredits
  });
}
