import { NextRequest, NextResponse } from "next/server";
import { checkPhoneCode, isValidPhone, setSessionCookie } from "@/lib/auth";
import { attributeReferral, createSession, createUserByPhone, ensureSignupTrial, getUserByInviteCode, getUserByPhone } from "@/lib/db";
import { recordEvent, reqMeta } from "@/lib/activity";
import { adminRoleOf } from "@/lib/admin";
import { getAppConfig } from "@/lib/app-config";
import { rateLimit, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { phone, code, name, invitecode } = await req.json().catch(() => ({}));
  if (typeof phone !== "string" || !isValidPhone(phone)) {
    return NextResponse.json({ error: "手机号无效" }, { status: 400 });
  }
  // M4:校验尝试限流(手机号 + IP),与验证码失败锁定形成双层防爆破。
  const ip = reqMeta(req).ip || "unknown";
  const lim = rateLimit(`otp-verify:${phone}:${ip}`, 10, 5 * 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter, "尝试次数过多,请稍后再试");
  if (typeof code !== "string" || !checkPhoneCode(phone, code)) {
    return NextResponse.json({ error: "验证码错误或已过期" }, { status: 400 });
  }
  const existing = await getUserByPhone(phone);
  // 后台「应用设置」可关闭新用户注册:未注册手机号在关闭时拒绝建号。
  if (!existing && !(await getAppConfig()).signup_enabled) {
    return NextResponse.json({ error: "新用户注册已暂停,请稍后再试" }, { status: 403 });
  }
  const user = existing
    ? await ensureSignupTrial(existing)
    : await createUserByPhone(phone, typeof name === "string" ? name : undefined);
  // 推广归因:仅对「新注册」用户,且带了有效邀请码时写入(一次性)。
  if (!existing && typeof invitecode === "string" && invitecode.trim()) {
    const referrer = await getUserByInviteCode(invitecode.trim());
    if (referrer && referrer.id !== user.id) await attributeReferral(user.id, referrer.id);
  }
  const token = await createSession(user.id);
  // 管理员登录单独留痕(action=auth.admin_login + 角色),便于后台审计筛选/告警异常登录。
  const role = adminRoleOf(user);
  recordEvent({
    actorId: user.id,
    actorKind: role ? "admin" : "user",
    action: role ? "auth.admin_login" : existing ? "auth.login" : "auth.signup",
    targetType: "user",
    targetId: user.id,
    meta: role ? { method: "phone", role } : { method: "phone" },
    ...reqMeta(req),
  });
  const res = NextResponse.json({ user });
  setSessionCookie(res, token);
  return res;
}
