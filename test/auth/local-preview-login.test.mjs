import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { freshPgDb } from "../helpers/pgdb.mjs";

process.env.LOCAL_PREVIEW_AUTO_LOGIN_ENABLED = "1";
process.env.ADMIN_PASSWORD_LOGIN_ENABLED = "1";
process.env.ADMIN_PASSWORD_SESSION_HOURS = "2";
process.env.PUBLIC_ORIGIN = "http://localhost:3100";

const access = await import("../../lib/admin-password-access.ts");
const account = {
  username: "local.owner",
  userId: "password-admin-11111111-2222-3333-4444-555555555555",
  displayName: "本地管理员",
  passwordHash: access.hashAdminPassword("Local-preview-password-2026!", Buffer.alloc(18, 29)),
  credentialVersion: 1,
  expiresAt: Date.now() + 365 * 86400_000,
};
process.env.ADMIN_PASSWORD_ACCOUNT_B64 = Buffer.from(
  JSON.stringify({ v: 1, ...account }),
  "utf8"
).toString("base64url");

const db = await freshPgDb("local_preview_login");
const { getPool } = await import("../../lib/pg.ts");
const auth = await import("../../lib/auth.ts");
const preview = await import("../../lib/local-preview-auth.ts");
const route = await import("../../app/api/auth/local-preview/route.ts");
const { NextRequest } = await import("next/server");

test("首页已有账号入口在本机预览模式下一次点击完成登录", () => {
  const content = fs.readFileSync(
    new URL("../../components/landing/landing-content.ts", import.meta.url),
    "utf8"
  );
  const client = fs.readFileSync(
    new URL("../../components/LandingClient.tsx", import.meta.url),
    "utf8"
  );
  assert.match(content, /data-preview-direct[^>]*>已有账号？登录</);
  assert.match(client, /previewLive && hit\.hasAttribute\("data-preview-direct"\)/);
  assert.match(client, /fetch\("\/api\/auth\/local-preview", \{ method: "POST" \}\)/);
  assert.match(client, /window\.location\.replace\("\/"\)/);
});

function request(origin = "http://localhost:3100", host = "localhost:3100", fetchSite = "same-origin") {
  return new NextRequest("http://localhost:3100/api/auth/local-preview", {
    method: "POST",
    headers: {
      origin,
      host,
      "sec-fetch-site": fetchSite,
    },
  });
}

test("本机免密入口只在精确回环配置下启用", () => {
  assert.equal(preview.isLocalPreviewAutoLoginEnabled(), true);
  assert.match(preview.localPreviewAccount()?.userId ?? "", /^local-preview-[a-f0-9]{32}$/);

  process.env.LOCAL_PREVIEW_AUTO_LOGIN_ENABLED = "true";
  assert.equal(preview.isLocalPreviewAutoLoginEnabled(), false);
  process.env.LOCAL_PREVIEW_AUTO_LOGIN_ENABLED = "1";

  process.env.PUBLIC_ORIGIN = "http://localhost.evil:3100";
  assert.equal(preview.isLocalPreviewAutoLoginEnabled(), false);
  process.env.PUBLIC_ORIGIN = "http://localhost:3100";
});

test("免密登录严格校验 Origin、Host 与浏览器同源标记", async () => {
  assert.equal((await route.POST(request("https://evil.example"))).status, 403);
  assert.equal((await route.POST(request(undefined, "127.0.0.1:3100"))).status, 403);
  assert.equal((await route.POST(request(undefined, undefined, "cross-site"))).status, 403);

  // Docker 端口映射后 NextRequest 的内部 URL 仍可能是容器端口；可信边界是
  // 与部署配置逐字匹配的 Origin + Host + Sec-Fetch-Site 三元组。
  const remapped = new NextRequest("http://127.0.0.1:3000/api/auth/local-preview", {
    method: "POST",
    headers: {
      origin: "http://localhost:3100",
      host: "localhost:3100",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal((await route.POST(remapped)).status, 200);
});

test("免密入口只创建普通预览账号会话并清除后台 Cookie", async () => {
  const response = await route.POST(request());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);

  const session = response.cookies.get(auth.SESSION_COOKIE)?.value;
  assert.ok(session);
  const user = await db.getSessionUser(session);
  assert.ok(user);
  assert.match(user.id, /^local-preview-/);
  assert.equal(user.name, "本地试用账号");
  assert.equal(Number(user.is_admin), 0);
  assert.equal(user.admin_role, null);
  assert.equal(user.phone, null);
  assert.equal(user.wechat_openid, null);
  assert.notEqual(user.id, account.userId);

  const adminCookie = response.cookies.get(auth.ADMIN_SESSION_COOKIE);
  assert.equal(adminCookie?.value ?? "", "");
  const adminSessions = Number((await getPool().query("SELECT COUNT(*) n FROM admin_sessions")).rows[0].n);
  assert.equal(adminSessions, 0);
});

test("关闭免密开关会立即让预览会话失效且路由隐藏", async () => {
  const first = await route.POST(request());
  const token = first.cookies.get(auth.SESSION_COOKIE)?.value;
  assert.ok(token);

  process.env.LOCAL_PREVIEW_AUTO_LOGIN_ENABLED = "0";
  assert.equal((await route.POST(request())).status, 404);
  assert.equal(await db.getSessionUser(token), undefined);
  process.env.LOCAL_PREVIEW_AUTO_LOGIN_ENABLED = "1";
});
