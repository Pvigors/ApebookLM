import { NextRequest, NextResponse } from "next/server";
import { getWeChatTicket, redeemWeChatTicket, setSessionCookie } from "@/lib/auth";
import { createSession, getUserById } from "@/lib/db";
import { recordEvent, reqMeta } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WX_NONCE_COOKIE = "nb_wx_nonce";

// Client polls this; once the ticket is confirmed we mint a session cookie.
export async function GET(req: NextRequest) {
  const ticket = req.nextUrl.searchParams.get("ticket") || "";
  const t = getWeChatTicket(ticket);
  if (!t) return NextResponse.json({ status: "expired" });
  if (t.status !== "confirmed" || !t.userId) {
    return NextResponse.json({ status: t.status });
  }
  // CSRF-1:仅当请求带回 start 时下发、与票据绑定的 nonce 才兑换会话。
  // 拦住「攻击者确认票据 → 诱导受害者 GET poll?ticket= 静默登入攻击者账户」的链路。
  const nonce = req.cookies.get(WX_NONCE_COOKIE)?.value || "";
  const userId = redeemWeChatTicket(ticket, nonce);
  if (!userId) return NextResponse.json({ status: "expired" });
  const user = await getUserById(userId);
  if (!user) return NextResponse.json({ status: "expired" });
  const token = await createSession(user.id);
  recordEvent({
    actorId: user.id,
    actorKind: "user",
    action: "auth.login",
    targetType: "user",
    targetId: user.id,
    meta: { method: "wechat" },
    ...reqMeta(req),
  });
  const res = NextResponse.json({ status: "confirmed", user });
  setSessionCookie(res, token);
  res.cookies.set(WX_NONCE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
