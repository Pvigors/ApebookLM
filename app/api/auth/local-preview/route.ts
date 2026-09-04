import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  SESSION_COOKIE,
  clearAdminSessionCookie,
  setSessionCookie,
} from "@/lib/auth";
import {
  createSession,
  deleteAdminSession,
  deleteSession,
  ensureLocalPreviewAccount,
  revokeUserSessions,
} from "@/lib/db";
import { localPreviewAccount, localPreviewOrigin } from "@/lib/local-preview-auth";
import { rateLimitGlobal } from "@/lib/ratelimit";
import { recordEvent, reqMeta } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_SECONDS = 12 * 3600;

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

export async function POST(req: NextRequest) {
  const account = localPreviewAccount();
  const expected = localPreviewOrigin();
  if (!account || !expected) return json({ error: "Not found" }, 404);

  const expectedUrl = new URL(expected);
  const origin = (req.headers.get("origin") ?? "").replace(/\/+$/, "");
  const host = (req.headers.get("host") ?? "").toLowerCase();
  const fetchSite = (req.headers.get("sec-fetch-site") ?? "").toLowerCase();
  if (
    origin !== expected ||
    host !== expectedUrl.host.toLowerCase() ||
    fetchSite !== "same-origin"
  ) {
    return json({ error: "请求来源无效" }, 403);
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength && contentLength !== "0") return json({ error: "请求格式无效" }, 400);
  const limited = rateLimitGlobal("local-preview-auto-login", 12, 60_000);
  if (!limited.ok) {
    const response = json({ error: "操作过于频繁，请稍后再试" }, 429);
    response.headers.set("Retry-After", String(limited.retryAfter));
    return response;
  }

  try {
    const user = await ensureLocalPreviewAccount(account);
    if (user.disabled || Number(user.is_admin) !== 0 || user.admin_role !== null) {
      return json({ error: "本地账号暂不可用" }, 503);
    }

    const oldSession = req.cookies.get(SESSION_COOKIE)?.value;
    const oldAdminSession = req.cookies.get(ADMIN_SESSION_COOKIE)?.value;
    await Promise.all([
      oldSession ? deleteSession(oldSession) : Promise.resolve(),
      deleteAdminSession(oldAdminSession),
      revokeUserSessions(user.id),
    ]);
    const token = await createSession(user.id, SESSION_SECONDS / 86400);
    await recordEvent({
      actorId: user.id,
      actorKind: "user",
      action: "auth.local_preview_login",
      targetType: "user",
      targetId: user.id,
      meta: { method: "local_preview" },
      ...reqMeta(req),
    });

    const response = json({ ok: true }, 200);
    setSessionCookie(response, token, SESSION_SECONDS);
    clearAdminSessionCookie(response);
    return response;
  } catch (error) {
    console.error("[local-preview-login] 登录失败", error);
    return json({ error: "本地登录暂不可用，请稍后再试" }, 503);
  }
}
