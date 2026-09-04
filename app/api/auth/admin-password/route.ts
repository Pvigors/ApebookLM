import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, setAdminSessionCookie, setSessionCookie } from "@/lib/auth";
import {
  consumeAuthRateLimit,
  createAdminLoginSessions,
  deleteAdminSession,
  ensureAdminPasswordAccount,
} from "@/lib/db";
import {
  adminPasswordAccount,
  adminPasswordSessionMaxAgeSeconds,
  isAdminPasswordStateError,
  verifyAdminPasswordCredentials,
} from "@/lib/admin-password-access";
import { recordEvent, reqMeta } from "@/lib/activity";
import { rateLimitGlobal } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8192;
const BODY_READ_TIMEOUT_MS = 5_000;
const GENERIC_ERROR = "用户名或密码错误";
const MAX_CONCURRENT_KDF = 3;
let activeKdf = 0;

class BodyReadTimeoutError extends Error {}

function acquireKdfSlot(): boolean {
  if (activeKdf >= MAX_CONCURRENT_KDF) return false;
  activeKdf += 1;
  return true;
}

function releaseKdfSlot(): void {
  activeKdf = Math.max(0, activeKdf - 1);
}

function json(body: Record<string, unknown>, status: number, headers?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function bucket(kind: string, value: string): string {
  return crypto.createHash("sha256").update(`${kind}:${value}`, "utf8").digest("hex");
}

function sameOrigin(req: NextRequest): boolean {
  const sent = (req.headers.get("origin") ?? "").replace(/\/+$/, "");
  const expected = (process.env.PUBLIC_ORIGIN || req.nextUrl.origin).replace(/\/+$/, "");
  return !!sent && sent === expected;
}

async function readLimitedBody(req: NextRequest): Promise<string | null> {
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      void reader.cancel("admin login body timeout").catch(() => {});
      reject(new BodyReadTimeoutError("请求体读取超时"));
    }, BODY_READ_TIMEOUT_MS);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel("body too large").catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout!);
    reader.releaseLock();
  }
  if (total === 0) return "";
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function POST(req: NextRequest) {
  const account = adminPasswordAccount();
  if (!account) return json({ error: "Not found" }, 404);
  if (!sameOrigin(req)) return json({ error: "请求来源无效" }, 403);

  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return json({ error: "请求格式无效" }, 415);
  const declaredHeader = req.headers.get("content-length");
  if (declaredHeader && !/^\d+$/.test(declaredHeader)) return json({ error: "请求格式无效" }, 400);
  if (Number(declaredHeader ?? 0) > MAX_BODY_BYTES) return json({ error: "请求体过大" }, 413);

  // 读取 chunked body 前先做进程内 + PG 共享三层限流，避免用超大请求放大内存/scrypt。
  const fast = rateLimitGlobal("admin-password-login", 90, 60_000);
  if (!fast.ok) {
    return json({ error: "尝试次数过多，请稍后再试" }, 429, {
      "Retry-After": String(fast.retryAfter),
    });
  }
  if (!acquireKdfSlot()) {
    return json({ error: "登录请求繁忙，请稍后重试" }, 429, { "Retry-After": "1" });
  }
  let credentialsValid = false;
  try {
    // 把 PG 限流与请求体解析也纳入同一小并发槽。否则 8 个同时到达的请求会因
    // PG 往返耗时被摊成多波 KDF：任一时刻虽不超过 3 个，总工作集仍会连续放大。
    const ip = reqMeta(req).ip || "unknown";
    const limits = await Promise.all([
      consumeAuthRateLimit(bucket("admin-password-global", "all"), 60, 60_000),
      consumeAuthRateLimit(bucket("admin-password-ip", ip), 7, 15 * 60_000),
      consumeAuthRateLimit(bucket("admin-password-account", account.userId), 30, 15 * 60_000),
    ]);
    const denied = limits.filter((limit) => !limit.ok);
    if (denied.length) {
      return json({ error: "尝试次数过多，请稍后再试" }, 429, {
        "Retry-After": String(Math.max(...denied.map((limit) => limit.retryAfter))),
      });
    }

    let raw: string | null;
    try {
      raw = await readLimitedBody(req);
    } catch (error) {
      if (error instanceof BodyReadTimeoutError) {
        return json({ error: "请求体读取超时，请重试" }, 408);
      }
      return json({ error: "请求格式无效" }, 400);
    }
    if (raw === null) return json({ error: "请求体过大" }, 413);
    if (!raw) return json({ error: "请求格式无效" }, 400);
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return json({ error: "请求格式无效" }, 400);
    }
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (username.length > 64 || password.length > 256) return json({ error: GENERIC_ERROR }, 401);
    credentialsValid = await verifyAdminPasswordCredentials(account, username, password);
  } finally {
    releaseKdfSlot();
  }
  if (!credentialsValid) {
    return json({ error: GENERIC_ERROR }, 401);
  }

  try {
    const user = await ensureAdminPasswordAccount(account);
    if (user.disabled || Number(user.is_admin) !== 1 || user.admin_role !== "super") {
      return json({ error: GENERIC_ERROR }, 401);
    }
    const maxAge = adminPasswordSessionMaxAgeSeconds();
    await deleteAdminSession(req.cookies.get(ADMIN_SESSION_COOKIE)?.value);
    const tokens = await createAdminLoginSessions(
      user.id,
      account.credentialVersion,
      maxAge
    );
    await recordEvent({
      actorId: user.id,
      actorKind: "admin",
      action: "auth.admin_login",
      targetType: "user",
      targetId: user.id,
      meta: { method: "username_password", role: "super" },
      ...reqMeta(req),
    });
    const response = json({ ok: true }, 200);
    setSessionCookie(response, tokens.userToken, maxAge);
    setAdminSessionCookie(response, tokens.adminToken, maxAge);
    return response;
  } catch (error) {
    if (isAdminPasswordStateError(error)) {
      return json({ error: GENERIC_ERROR }, 401);
    }
    console.error("[admin-password-login] provision 或会话创建失败", error);
    return json({ error: "登录服务暂不可用，请稍后再试" }, 503);
  }
}
