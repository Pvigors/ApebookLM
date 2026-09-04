import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { setSessionCookie } from "@/lib/auth";
import {
  consumeAuthRateLimit,
  createSession,
  ensureExperienceAccount,
} from "@/lib/db";
import {
  experienceAccountByAccessKey,
  experienceSessionMaxAgeSeconds,
  verifyExperienceCredentials,
} from "@/lib/experience-access";
import { recordEvent, reqMeta } from "@/lib/activity";
import { rateLimitGlobal } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8192;
const GENERIC_ERROR = "用户名或密码错误";

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
  try {
    while (true) {
      const { done, value } = await reader.read();
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
    reader.releaseLock();
  }
  if (total === 0) return "";
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ accessKey: string }> }
) {
  const { accessKey } = await context.params;
  const account = experienceAccountByAccessKey(accessKey);
  if (!account) return json({ error: "Not found" }, 404);
  if (!sameOrigin(req)) return json({ error: "请求来源无效" }, 403);

  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return json({ error: "请求格式无效" }, 415);
  const declaredHeader = req.headers.get("content-length");
  if (declaredHeader && !/^\d+$/.test(declaredHeader)) return json({ error: "请求格式无效" }, 400);
  const declared = Number(declaredHeader ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return json({ error: "请求体过大" }, 413);
  }

  // 必须在读取 chunked body 前限流；否则攻击者可省略 Content-Length，让 req.text()
  // 先完整缓冲数百 MB，再被 8KB 后验门禁拒绝，形成认证入口内存 DoS。
  const fast = rateLimitGlobal("experience-login", 180, 60_000);
  if (!fast.ok) {
    return json({ error: "尝试次数过多，请稍后再试" }, 429, {
      "Retry-After": String(fast.retryAfter),
    });
  }
  const ip = reqMeta(req).ip || "unknown";
  const accountScope = crypto.createHash("sha256").update(accessKey).digest("hex");
  const limits = await Promise.all([
    consumeAuthRateLimit(bucket("experience-global", "all"), 120, 60_000),
    consumeAuthRateLimit(bucket("experience-ip", ip), 10, 15 * 60_000),
    // 每条隐藏链接固定映射一个账号；按链接而非用户输入限流，错误用户名不能换值绕过。
    consumeAuthRateLimit(bucket("experience-account", accountScope), 20, 15 * 60_000),
  ]);
  const denied = limits.filter((limit) => !limit.ok);
  if (denied.length) {
    return json({ error: "尝试次数过多，请稍后再试" }, 429, {
      "Retry-After": String(Math.max(...denied.map((limit) => limit.retryAfter))),
    });
  }

  const raw = await readLimitedBody(req).catch(() => null);
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

  if (!(await verifyExperienceCredentials(account, username, password))) {
    return json({ error: GENERIC_ERROR }, 401);
  }

  try {
    const user = await ensureExperienceAccount(account);
    // provision 刻意保留 disabled；停用、配置过期与错误凭据统一不泄露具体原因。
    if (user.disabled || Number(user.plan_expires_at ?? 0) <= Date.now()) {
      return json({ error: GENERIC_ERROR }, 401);
    }
    const maxAge = experienceSessionMaxAgeSeconds();
    const token = await createSession(user.id, maxAge / 86400);
    await recordEvent({
      actorId: user.id,
      actorKind: "user",
      action: "auth.experience_login",
      targetType: "user",
      targetId: user.id,
      meta: { method: "username_password" },
      ...reqMeta(req),
    });
    const response = json({ ok: true }, 200);
    setSessionCookie(response, token, maxAge);
    return response;
  } catch (error) {
    console.error("[experience-login] 账号 provision 或会话创建失败", error);
    return json({ error: "登录服务暂不可用，请稍后再试" }, 503);
  }
}
