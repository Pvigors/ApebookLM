import { NextRequest, NextResponse } from "next/server";
import { confirmWeChatTicket, getWeChatTicket } from "@/lib/auth";
import { attributeReferral, createUserByWechat, ensureSignupTrial, getUserByInviteCode, getUserByWechat, setWechatUnionid, updateUserProfile } from "@/lib/db";
import { exchangeCodeForIdentity, isWeChatLoginEnabled } from "@/lib/wechat-login";
import { recordEvent, reqMeta } from "@/lib/activity";
import { getAppConfig } from "@/lib/app-config";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 微信扫码确认后回跳到这里(qrconnect 带 self_redirect=true 时,是在登录页的 iframe 内部跳转)。
// 这里只负责把票据置为 confirmed;真正下发会话 cookie 的是 poll 路由 —— 会话必须发在
// 发起登录的那个浏览器上下文里,而这个回调可能发生在 iframe/新标签中,拿不到那边的 nonce。
//
// state 即票据 id:它同时充当 OAuth 的 CSRF 参数,伪造的 state 找不到对应票据,直接拒。

function page(title: string, hint: string, ok: boolean): NextResponse {
  const color = ok ? "#07994d" : "#dc2626";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#fff;
font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;text-align:center;padding:16px}
h1{font-size:16px;font-weight:600;color:${color};margin:0 0 8px}p{font-size:13px;color:#6b7280;margin:0;line-height:1.7}</style>
</head><body><div><h1>${title}</h1><p>${hint}</p></div></body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  if (!isWeChatLoginEnabled()) return page("微信登录未开启", "请联系管理员配置微信开放平台密钥。", false);

  // 回调端点是匿名可达的,按 IP 限流,防有人拿它刷微信接口配额或试探 state。
  const ip = reqMeta(req).ip || "unknown";
  const lim = rateLimit(`wx-callback:${ip}`, 20, 5 * 60_000);
  if (!lim.ok) return page("操作过于频繁", "请稍后再试。", false);

  const code = req.nextUrl.searchParams.get("code") || "";
  const state = req.nextUrl.searchParams.get("state") || "";
  if (!code || !state) return page("授权已取消", "你可以回到登录页重新扫码。", false);

  // state 必须对应一个仍在等待中的票据,否则视为伪造/过期。
  const ticket = getWeChatTicket(state);
  if (!ticket || ticket.status !== "pending") {
    return page("二维码已失效", "请回到登录页重新获取二维码。", false);
  }

  const identity = await exchangeCodeForIdentity(code);
  if (!identity) return page("微信授权失败", "请回到登录页重新扫码。", false);

  const existing = await getUserByWechat(identity.openid);
  // 后台「应用设置」可关停新用户注册,与手机号通道保持同一道闸。
  if (!existing && !(await getAppConfig()).signup_enabled) {
    return page("新用户注册已暂停", "请稍后再试,或改用手机号登录。", false);
  }

  let user = existing
    ? await ensureSignupTrial(existing)
    : await createUserByWechat(identity.openid, identity.nickname || "", identity.avatar);
  if (!existing && ticket.inviteCode) {
    const referrer = await getUserByInviteCode(ticket.inviteCode);
    if (referrer) await attributeReferral(user.id, referrer.id);
  }
  // 老用户回填:头像/昵称原来只在建号那一刻写,之后再登录不会更新 —— 早于「头像取不到」
  // 那个修复建的号,不删号就永远补不上。产品昵称 name 只在原值为空/占位时补,
  // 而 wechat_nickname 始终跟进微信本次返回的真实昵称，绝不覆盖用户自改 name。
  if (existing) {
    const needName = identity.nickname && (!existing.name || existing.name === "微信用户");
    const needAvatar = identity.avatar && !existing.avatar;
    const needWechatNickname = identity.nickname && identity.nickname !== existing.wechat_nickname;
    if (needName || needAvatar || needWechatNickname) {
      user =
        (await updateUserProfile(existing.id, {
          ...(needName ? { name: identity.nickname } : {}),
          ...(needWechatNickname ? { wechat_nickname: identity.nickname } : {}),
          ...(needAvatar ? { avatar: identity.avatar } : {}),
        })) ?? existing;
    }
  }
  // 开放平台返回联合标识时一并记录，便于部署者实现明确授权的账号合并策略。
  if (identity.unionid) await setWechatUnionid(user.id, identity.unionid);
  confirmWeChatTicket(state, user.id);

  recordEvent({
    actorId: user.id,
    actorKind: "user",
    action: existing ? "auth.login" : "auth.signup",
    targetType: "user",
    targetId: user.id,
    meta: { method: "wechat" },
    ...reqMeta(req),
  });

  return page("扫码成功", "正在为你登录，请回到原页面…", true);
}
