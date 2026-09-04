import { NextRequest, NextResponse } from "next/server";
import { adminRoleOf, requireRole } from "@/lib/admin";
import {
  getUserById,
  getUserUsage,
  getBonusCredits,
  listNotebooks,
  listUserLedger,
  getReferralStats,
} from "@/lib/db";
import { getPlanConfig } from "@/lib/plans-config";
import { creditOpLabel } from "@/lib/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maskPhone = (phone: string | null | undefined) =>
  phone ? `${phone.slice(0, 3)}****${phone.slice(-2)}` : null;
const maskEmail = (email: string | null | undefined) => {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return "****";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
};

/** 单用户明细:基本信息 + 权益/额度 + 今日/本月用量 + 奖励余额 + 名下笔记本 + 积分流水 + 返利。 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireRole(req, "users");
  if (g instanceof NextResponse) return g;
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  const auditor = adminRoleOf(g) === "auditor";

  const [plan, usage, bonus, notebooks, ledgerRaw, referral] = await Promise.all([
    getPlanConfig(user.plan_tier),
    getUserUsage(id),
    getBonusCredits(id),
    listNotebooks(id),
    listUserLedger(id, 50),
    getReferralStats(id),
  ]);

  const ledger = ledgerRaw.map((r) => ({
    ...r,
    label: creditOpLabel(r.op),
    // credits 正=消耗、负=入账（管理员赠送/积分退回）；前端据此染色。
    kind: r.credits < 0 ? "in" : "out",
  }));

  return NextResponse.json({
    user: {
      id: user.id,
      name: user.name,
      phone: auditor ? maskPhone(user.phone) : user.phone,
      email: auditor ? maskEmail(user.email) : user.email,
      wechat_nickname: user.wechat_nickname ?? null,
      // 后台只需要绑定状态，不向页面下发可识别用户的 openid。
      wechat_bound: !!user.wechat_openid,
      avatar: user.avatar,
      created_at: user.created_at,
      last_seen: user.last_seen,
      last_login_at: Number(user.last_login_at ?? 0),
      login_count: Number(user.login_count ?? 0),
      disabled: !!user.disabled,
      is_admin: !!user.is_admin,
      plan_tier: user.plan_tier,
      plan_expires_at: Number(user.plan_expires_at ?? 0),
      invite_code: auditor ? null : user.invite_code,
    },
    plan: {
      id: plan.id,
      name: plan.name,
      dailyLimit: plan.dailyLimit,
      maxNotebooks: plan.maxNotebooks,
      expiresAt: Number(user.plan_expires_at ?? 0),
    },
    usage,
    bonus,
    notebooks: notebooks.map((n) => ({
      id: n.id,
      title: n.title,
      emoji: n.emoji,
      public: n.public,
      created_at: n.created_at,
    })),
    ledger,
    referral,
  });
}
