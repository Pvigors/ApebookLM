import { NextRequest, NextResponse } from "next/server";
import { confirmWeChatTicket, getWeChatTicket } from "@/lib/auth";
import { attributeReferral, createUserByWechat, getUserByInviteCode } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NAMES = ["小鹿", "阿强", "Luna", "老王", "Mia", "阿杰", "Nova", "小满", "Kai", "团子"];
const AVATARS = ["🦊", "🐼", "🐯", "🐧", "🦉", "🐙", "🦄", "🐳", "🐱", "🐶"];
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

// DEV ONLY: simulate a user scanning + confirming in WeChat. Real WeChat would
// hit your callback with a code, you'd exchange it for an openid + userinfo.
export async function POST(req: NextRequest) {
  // L1/ENUM-5:生产环境禁用模拟端点(否则 = 任意人凭票据建号的开放注册后门)。
  // 上线请接真实微信 OAuth 回调取 openid。
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "未开启该功能" }, { status: 404 });
  }
  const { ticket } = await req.json().catch(() => ({}));
  const t = getWeChatTicket(ticket);
  if (!t || t.status !== "pending") {
    return NextResponse.json({ error: "二维码已失效,请刷新" }, { status: 400 });
  }
  const openid = "sim_" + crypto.randomUUID().slice(0, 12);
  const user = await createUserByWechat(openid, pick(NAMES), pick(AVATARS));
  if (t.inviteCode) {
    const referrer = await getUserByInviteCode(t.inviteCode);
    if (referrer) await attributeReferral(user.id, referrer.id);
  }
  confirmWeChatTicket(ticket, user.id);
  return NextResponse.json({ ok: true });
}
