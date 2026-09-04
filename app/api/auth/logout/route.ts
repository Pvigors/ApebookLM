import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  SESSION_COOKIE,
  clearAdminSessionCookie,
  clearSessionCookie,
  userFromRequest,
} from "@/lib/auth";
import { deleteAdminSession, deleteSession } from "@/lib/db";
import { recordEvent, reqMeta } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // 登出会同时撤销高权管理员 Cookie；严格同源可防同站子域发起 logout CSRF。
  const sent = (req.headers.get("origin") ?? "").replace(/\/+$/, "");
  const expected = (process.env.PUBLIC_ORIGIN || req.nextUrl.origin).replace(/\/+$/, "");
  if (!sent || sent !== expected) {
    return NextResponse.json(
      { error: "请求来源无效" },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const adminToken = req.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  const user = await userFromRequest(req);
  await Promise.all([token ? deleteSession(token) : Promise.resolve(), deleteAdminSession(adminToken)]);
  if (user) {
    recordEvent({
      actorId: user.id,
      actorKind: "user",
      action: "auth.logout",
      targetType: "user",
      targetId: user.id,
      ...reqMeta(req),
    });
  }
  const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  clearSessionCookie(res);
  clearAdminSessionCookie(res);
  return res;
}
