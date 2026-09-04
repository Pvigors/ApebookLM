import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdminSessionUser, getNotebook, getNotebookAccess, getSessionUser } from "./db";
import type { User } from "./types";
import { hasUsageAccess } from "./membership";

export const SESSION_COOKIE = "nb_session";
export const SESSION_MAX_AGE = 30 * 86400; // seconds
export const ADMIN_SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-nb_admin_session" : "nb_admin_session";

// 统一会话 cookie 属性。`secure` 在生产强制(M3:此前 verify/wechat 漏了 secure,
// 中间人可在一次明文 HTTP 请求里嗅探到 30 天有效令牌)。
const SESSION_COOKIE_BASE = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};
const ADMIN_SESSION_COOKIE_BASE = {
  httpOnly: true,
  sameSite: "strict" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};

/** 下发会话 cookie(登录成功时调用),保证全站属性一致。 */
export function setSessionCookie(
  res: NextResponse,
  token: string,
  maxAgeSeconds = SESSION_MAX_AGE
): void {
  const maxAge = Number.isSafeInteger(maxAgeSeconds) && maxAgeSeconds > 0
    ? Math.min(maxAgeSeconds, SESSION_MAX_AGE)
    : SESSION_MAX_AGE;
  res.cookies.set(SESSION_COOKIE, token, { ...SESSION_COOKIE_BASE, maxAge });
}

/** 清除会话 cookie(登出 / 注销时调用)。 */
export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", { ...SESSION_COOKIE_BASE, maxAge: 0 });
}

export function setAdminSessionCookie(
  res: NextResponse,
  token: string,
  maxAgeSeconds: number
): void {
  const maxAge = Number.isSafeInteger(maxAgeSeconds) && maxAgeSeconds > 0
    ? Math.min(maxAgeSeconds, 8 * 3600)
    : 2 * 3600;
  res.cookies.set(ADMIN_SESSION_COOKIE, token, { ...ADMIN_SESSION_COOKIE_BASE, maxAge });
}

export function clearAdminSessionCookie(res: NextResponse): void {
  res.cookies.set(ADMIN_SESSION_COOKIE, "", { ...ADMIN_SESSION_COOKIE_BASE, maxAge: 0 });
}

/** Resolve the logged-in user inside a route handler (has NextRequest). */
export async function userFromRequest(req: NextRequest): Promise<User | null> {
  return (await getSessionUser(req.cookies.get(SESSION_COOKIE)?.value)) ?? null;
}

export async function adminUserFromRequest(req: NextRequest): Promise<User | null> {
  return (await getAdminSessionUser(req.cookies.get(ADMIN_SESSION_COOKIE)?.value)) ?? null;
}

/** Resolve the logged-in user inside a server component / page. */
export async function userFromCookies(): Promise<User | null> {
  const store = await cookies();
  return (await getSessionUser(store.get(SESSION_COOKIE)?.value)) ?? null;
}

/** Server Component 使用的独立管理员会话；必须再与普通会话 userId 对齐。 */
export async function adminUserFromCookies(): Promise<User | null> {
  const store = await cookies();
  // 仅用于前台 SSR 判断可见性，不应把“浏览首页”算作后台活动而续期 30 分钟 idle。
  return (await getAdminSessionUser(store.get(ADMIN_SESSION_COOKIE)?.value, { touch: false })) ?? null;
}

/**
 * Gate a notebook-scoped route. Returns the user on success, or a NextResponse
 * (401/403) to return directly. Pass `edit: true` to forbid viewers.
 *   const g = requireAccess(req, id); if (g instanceof NextResponse) return g;
 */
export async function requireAccess(
  req: NextRequest,
  notebookId: string,
  edit = false
): Promise<User | NextResponse> {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (edit && !hasUsageAccess(user)) {
    return NextResponse.json(
      { error: "积分不足，可通过邀请活动获取积分或联系管理员补充", code: "quota" },
      { status: 429 }
    );
  }
  const role = await getNotebookAccess(notebookId, user.id);
  if (!role) return NextResponse.json({ error: "无权访问此笔记本" }, { status: 403 });
  if (edit && role === "viewer") {
    return NextResponse.json({ error: "你是只读协作者,无法修改" }, { status: 403 });
  }
  return user;
}

/**
 * 只校验笔记本编辑角色，不校验会员/积分。
 * 仅用于不创建任务、不调用模型、不扣费的免费预检；真正入队仍必须走
 * requireAccess(..., true) + 原子扣费事务。
 */
export async function requireNotebookEditAccess(
  req: NextRequest,
  notebookId: string
): Promise<User | NextResponse> {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const role = await getNotebookAccess(notebookId, user.id);
  if (!role) return NextResponse.json({ error: "无权访问此笔记本" }, { status: 403 });
  if (role === "viewer") {
    return NextResponse.json({ error: "你是只读协作者,无法修改" }, { status: 403 });
  }
  return user;
}

/** 登录且有套餐积分/奖励积分或系统管理员权益的非笔记本路由闸门。 */
export async function requireMember(req: NextRequest): Promise<User | NextResponse> {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!hasUsageAccess(user)) {
    return NextResponse.json(
      { error: "积分不足，可通过邀请活动获取积分或联系管理员补充", code: "quota" },
      { status: 429 }
    );
  }
  return user;
}

/**
 * 只读闸门(供制品 / 媒体下载等路由用,H1/F1/F2):
 * 公开笔记本对任何人放行;否则要求登录且对该笔记本有访问角色。
 * 返回 true(放行)或可直接返回的 NextResponse(404/401/403)。
 *   const g = requireNotebookRead(req, out.notebook_id); if (g !== true) return g;
 */
export async function requireNotebookRead(
  req: NextRequest,
  notebookId: string
): Promise<true | NextResponse> {
  const nb = await getNotebook(notebookId);
  if (!nb) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (nb.public) return true;
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!(await getNotebookAccess(notebookId, user.id))) {
    return NextResponse.json({ error: "无权访问此笔记本" }, { status: 403 });
  }
  return true;
}

// ---------------------------------------------------------------------------
// OTP / WeChat-ticket logic lives in ./auth-otp (no next/db imports, so it can
// be unit-tested in plain Node). Re-exported here so existing
// `@/lib/auth` import sites keep working unchanged.
// ---------------------------------------------------------------------------

export {
  genCode,
  isValidPhone,
  setPhoneCode,
  checkPhoneCode,
  createWeChatTicket,
  getWeChatTicket,
  redeemWeChatTicket,
  confirmWeChatTicket,
  type WeChatTicket,
} from "./auth-otp";
