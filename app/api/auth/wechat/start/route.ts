import { NextRequest, NextResponse } from "next/server";
import { createWeChatTicket } from "@/lib/auth";
import { buildQrUrl, isWeChatLoginEnabled } from "@/lib/wechat-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WX_NONCE_COOKIE = "nb_wx_nonce";

// 发起微信扫码登录。
// 配了开放平台密钥时,返回微信官方 qrconnect 页地址(票据 id 作为 state),前端用 iframe 内嵌,
// 用户扫码确认后由 /api/auth/wechat/callback 把票据置为 confirmed,前端轮询 poll 兑换会话。
// 未配置时 qrUrl 为 null,前端回退到开发环境的模拟扫码(生产则根本不显示微信入口)。
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const inviteCode = typeof body.invitecode === "string" ? body.invitecode : undefined;
  const { id, nonce } = createWeChatTicket(inviteCode);
  const origin = req.nextUrl.origin;

  const webAppLive = isWeChatLoginEnabled();
  const res = NextResponse.json({
    ticket: id,
    mode: "frame",
    qrUrl: webAppLive ? buildQrUrl({ state: id, origin, embedded: true }) : null,
    live: webAppLive,
  });
  // CSRF-1:把票据绑定到发起登录的这个浏览器。poll 兑换时必须带回同一 nonce,
  // 攻击者用自己确认过的票据无法在受害者浏览器里换取会话(受害者没有这枚 cookie)。
  res.cookies.set(WX_NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 300,
  });
  return res;
}
