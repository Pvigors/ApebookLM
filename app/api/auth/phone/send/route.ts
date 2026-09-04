import { NextRequest, NextResponse } from "next/server";
import { genCode, isValidPhone, setPhoneCode } from "@/lib/auth";
import { reqMeta } from "@/lib/activity";
import { rateLimit, tooMany } from "@/lib/ratelimit";
import { isSmsLoginEnabled, sendSms } from "@/lib/sms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IS_PROD = process.env.NODE_ENV === "production";

export async function POST(req: NextRequest) {
  if (IS_PROD && !isSmsLoginEnabled()) {
    return NextResponse.json({ error: "此实例尚未配置手机号登录" }, { status: 503 });
  }
  const { phone } = await req.json().catch(() => ({}));
  if (typeof phone !== "string" || !isValidPhone(phone)) {
    return NextResponse.json({ error: "请输入有效的手机号" }, { status: 400 });
  }
  // H5/RATE-1:发送限流。单号 60s 冷却 + 单 IP 滑窗,防短信轰炸 / 费用耗尽 / 内存刷量。
  const ip = reqMeta(req).ip || "unknown";
  const perPhone = rateLimit(`otp-send:phone:${phone}`, 1, 60_000);
  if (!perPhone.ok) return tooMany(perPhone.retryAfter, "验证码发送过于频繁,请稍后再试");
  const perIp = rateLimit(`otp-send:ip:${ip}`, 10, 60 * 60_000);
  if (!perIp.ok) return tooMany(perIp.retryAfter, "操作过于频繁,请稍后再试");

  const code = genCode();
  setPhoneCode(phone, code);
  // 生产走阿里云短信;dev 保留 console 便于本地看码(sendSms 在 dev 直接 return 不发)。
  if (IS_PROD) {
    try {
      await sendSms(phone, code);
    } catch {
      return NextResponse.json({ error: "短信发送失败,请稍后重试" }, { status: 502 });
    }
  } else {
    console.log(`[DEV SMS] ${phone} → 验证码 ${code}`);
  }
  // C1:验证码绝不回包到生产。开发环境无短信网关时才回传以便在屏幕上显示。
  return NextResponse.json(IS_PROD ? { ok: true } : { ok: true, devCode: code });
}
