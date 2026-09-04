import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { freshPgDb } from "../helpers/pgdb.mjs";

process.env.EXPERIENCE_ACCESS_ENABLED = "1";
process.env.EXPERIENCE_SESSION_HOURS = "12";
process.env.PUBLIC_ORIGIN = "https://notes.example.test";

const access = await import("../../lib/experience-access.ts");
const passwords = ["Ape!Test-1-q8V$k2Lm9R", "Ape!Test-2-z7N@p4Wx6T", "Ape!Test-3-y5C#r8Hs2Q"];
const accounts = passwords.map((password, index) => ({
  accessKey: crypto.randomBytes(24).toString("base64url"),
  username: `apetest0${index + 1}`,
  userId: `experience-${crypto.randomUUID()}`,
  displayName: `测试账号 ${index + 1}`,
  passwordHash: access.hashExperiencePassword(password),
  expiresAt: Date.now() + 365 * 86400_000,
}));
const validConfig = Buffer.from(JSON.stringify({ v: 1, accounts }), "utf8").toString("base64url");
process.env.EXPERIENCE_ACCOUNTS_B64 = validConfig;

const db = await freshPgDb("experience_access");
const { getPool } = await import("../../lib/pg.ts");
const plans = await import("../../lib/plans.ts");
const membership = await import("../../lib/membership.ts");
const admin = await import("../../lib/admin.ts");
const loginRoute = await import("../../app/api/auth/experience/[accessKey]/route.ts");
const meRoute = await import("../../app/api/auth/me/route.ts");
const referralRoute = await import("../../app/api/referral/route.ts");
const usageRoute = await import("../../app/api/usage/route.ts");
const { NextRequest } = await import("next/server");

const apiRequest = (account, body, extraHeaders = {}) =>
  new NextRequest(`https://notes.example.test/api/auth/experience/${account.accessKey}`, {
    method: "POST",
    headers: {
      origin: "https://notes.example.test",
      "content-type": "application/json",
      "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 180) + 1}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });

const login = (account, username, password, extraHeaders) =>
  loginRoute.POST(
    apiRequest(account, { username, password }, extraHeaders),
    { params: Promise.resolve({ accessKey: account.accessKey }) }
  );

test("环境配置严格解析 3 个账号，访问密钥与 scrypt 凭据双重校验", async () => {
  const selected = access.experienceAccountByAccessKey(accounts[0].accessKey);
  assert.equal(selected?.userId, accounts[0].userId);
  assert.equal(access.experienceAccountByAccessKey("not-a-real-key"), null);
  assert.equal(await access.verifyExperienceCredentials(selected, accounts[0].username, passwords[0]), true);
  assert.equal(await access.verifyExperienceCredentials(selected, "wrong-user", passwords[0]), false);
  assert.equal(await access.verifyExperienceCredentials(selected, accounts[0].username, "wrong-password"), false);
  assert.equal(access.isConfiguredExperienceUser(accounts[0].userId), true);
  assert.equal(access.experienceSessionMaxAgeSeconds(), 12 * 3600);
});

test("畸形、少于 3 个或过期配置一律 fail closed", () => {
  const restore = process.env.EXPERIENCE_ACCOUNTS_B64;
  process.env.EXPERIENCE_ACCOUNTS_B64 = "not-base64url!";
  assert.equal(access.experienceAccountByAccessKey(accounts[0].accessKey), null);
  process.env.EXPERIENCE_ACCOUNTS_B64 = Buffer.from(
    JSON.stringify({ v: 1, accounts: accounts.slice(0, 2) })
  ).toString("base64url");
  assert.equal(access.experienceAccountByAccessKey(accounts[0].accessKey), null);
  process.env.EXPERIENCE_ACCOUNTS_B64 = Buffer.from(
    JSON.stringify({
      v: 1,
      accounts: accounts.map((item, index) =>
        index === 0 ? { ...item, expiresAt: Date.now() - 1 } : item
      ),
    })
  ).toString("base64url");
  assert.equal(access.experienceAccountByAccessKey(accounts[0].accessKey), null);
  assert.equal(
    access.experienceAccountByAccessKey(accounts[1].accessKey)?.userId,
    accounts[1].userId,
    "单账号到期不能连坐其余链接"
  );
  process.env.EXPERIENCE_ACCOUNTS_B64 = Buffer.from(
    JSON.stringify({ v: 1, accounts: accounts.map((item) => ({ ...item, expiresAt: Date.now() - 1 })) })
  ).toString("base64url");
  assert.equal(access.experienceAccountByAccessKey(accounts[0].accessKey), null);
  process.env.EXPERIENCE_ACCOUNTS_B64 = restore;
});

test("测试账号幂等 provision，不发试用、不接管普通 userId、停用不被登录复活", async () => {
  const first = await db.ensureExperienceAccount(accounts[0]);
  const again = await db.ensureExperienceAccount({ ...accounts[0], displayName: "测试账号一" });
  assert.equal(first.id, again.id);
  assert.equal(again.name, "测试账号一");
  assert.equal(again.plan_tier, "test");
  assert.equal(Number(again.is_admin), 0);
  assert.equal(again.admin_role, null);
  assert.equal(again.phone, null);
  assert.equal(again.email, null);
  assert.equal(again.wechat_openid, null);
  assert.equal(Number(again.trial_granted_at), 0);
  assert.equal(Number(again.bonus_credits), 0);

  const ordinary = await db.createUserByEmail("experience-collision@example.com", "普通用户");
  await assert.rejects(
    () => db.ensureExperienceAccount({ ...accounts[0], userId: ordinary.id }),
    /冲突/
  );

  const disabled = await db.ensureExperienceAccount(accounts[2]);
  await getPool().query("UPDATE users SET disabled=1 WHERE id=$1", [disabled.id]);
  const preserved = await db.ensureExperienceAccount(accounts[2]);
  assert.equal(Number(preserved.disabled), 1);
});

test("test 为内部测试权益，积分、笔记本和 OCR 不限量", async () => {
  const plan = plans.getPlan("test");
  assert.equal(plan.dailyLimit, -1);
  assert.equal(plan.maxNotebooks, -1);
  assert.equal(plan.watermark, false);
  assert.equal(plans.isEntitledTier("test"), true);
  assert.equal(membership.isActiveMember({ plan_tier: "test", plan_expires_at: Date.now() + 1000 }), true);
});

test("测试账号可消费百万积分，扣费快照精确，跨日退回不生成奖励积分", async () => {
  const user = await db.ensureExperienceAccount(accounts[0]);
  const charged = await db.consumeDailyQuota(user, "chat", 1_000_000, "不限量回归");
  assert.equal(charged.over, false);
  assert.equal(charged.limit, -1);
  assert.ok(charged.ledgerId);
  const chargeRow = (
    await getPool().query(
      "SELECT plan_credits, bonus, unlimited_at_charge FROM credit_ledger WHERE id=$1",
      [charged.ledgerId]
    )
  ).rows[0];
  assert.equal(Number(chargeRow.plan_credits), 1_000_000);
  assert.equal(Number(chargeRow.bonus), 0);
  assert.equal(Number(chargeRow.unlimited_at_charge), 1);

  const oldTs = Date.now() - 2 * 86400_000;
  const oldDay = Math.floor((oldTs + 8 * 3600_000) / 86400_000);
  await getPool().query("UPDATE credit_ledger SET ts=$1 WHERE id=$2", [oldTs, charged.ledgerId]);
  await getPool().query("UPDATE user_usage SET day=$1 WHERE user_id=$2", [oldDay, user.id]);
  assert.equal(await db.refundCredits(user.id, "chat", 1_000_000, charged.ledgerId), true);
  const after = await db.getUserById(user.id);
  assert.equal(Number(after.bonus_credits), 0, "不限量跨日退款不得变成永久奖励积分");
  const refund = (
    await getPool().query(
      "SELECT credits, bonus, plan_credits FROM credit_ledger WHERE user_id=$1 AND op='refund:chat' ORDER BY id DESC LIMIT 1",
      [user.id]
    )
  ).rows[0];
  assert.equal(Number(refund.credits), -1_000_000);
  assert.equal(Number(refund.bonus), 0);
  assert.equal(Number(refund.plan_credits), -1_000_000);
});

test("测试账号跨日 Token 差额结算不把无限积分转成 bonus", async () => {
  const user = await db.ensureExperienceAccount(accounts[1]);
  const notebook = await db.createNotebook(user.id, "测试结算本", "🧪");
  const charge = await db.consumeDailyQuota(user, "studio:slides", 8, notebook.title);
  const job = await db.createJob(notebook.id, user.id, "slides", "测试演示", {
    __creditLedgerId: charge.ledgerId,
  });
  await db.setJobReservedCredits(job.id, 8);
  const claimed = await db.claimNextQueued();
  assert.equal(claimed?.id, job.id);
  const output = await db.createStudioOutputForRun(
    job.id,
    claimed.run_attempt,
    notebook.id,
    "slides",
    "测试演示产物",
    "{}"
  );
  const oldTs = Date.now() - 2 * 86400_000;
  const oldDay = Math.floor((oldTs + 8 * 3600_000) / 86400_000);
  await getPool().query("UPDATE credit_ledger SET ts=$1 WHERE id=$2", [oldTs, charge.ledgerId]);
  await getPool().query("UPDATE user_usage SET day=$1 WHERE user_id=$2", [oldDay, user.id]);
  assert.equal(
    await db.finalizeJobDone(
      job.id,
      output.id,
      {
        userId: user.id,
        op: "studio:slides",
        reservedCredits: 8,
        finalCredits: 3,
        tokensIn: 1200,
        tokensOut: 300,
        notebookTitle: notebook.title,
        ledgerId: charge.ledgerId,
      },
      claimed.run_attempt
    ),
    true
  );
  assert.equal(Number((await db.getUserById(user.id)).bonus_credits), 0);
  const settled = (
    await getPool().query(
      "SELECT credits, bonus, plan_credits FROM credit_ledger WHERE user_id=$1 AND op='settle:studio:slides' ORDER BY id DESC LIMIT 1",
      [user.id]
    )
  ).rows[0];
  assert.equal(Number(settled.credits), -5);
  assert.equal(Number(settled.bonus), 0);
  assert.equal(Number(settled.plan_credits), -5);
});

test("PG 登录限流跨并发原子计数", async () => {
  const hash = crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex");
  const results = await Promise.all(
    Array.from({ length: 10 }, () => db.consumeAuthRateLimit(hash, 5, 60_000, 2_000_000_000_000))
  );
  assert.equal(results.filter((item) => item.ok).length, 5);
  assert.equal(results.filter((item) => !item.ok).length, 5);
  assert.ok(results.find((item) => !item.ok).retryAfter > 0);

  const staleHash = crypto.createHash("sha256").update("stale:" + crypto.randomUUID()).digest("hex");
  await getPool().query(
    "INSERT INTO auth_rate_limits(bucket_hash,window_started_at,attempts,updated_at) VALUES($1,$2,1,$2)",
    [staleHash, 2_000_000_000_000 - 2 * 86400_000]
  );
  const triggerHash = crypto.createHash("sha256").update("trigger:" + crypto.randomUUID()).digest("hex");
  await db.consumeAuthRateLimit(triggerHash, 5, 60_000, 2_000_000_060_001);
  assert.equal(
    Number((await getPool().query("SELECT COUNT(*) n FROM auth_rate_limits WHERE bucket_hash=$1", [staleHash])).rows[0].n),
    0,
    "24h 前的桶应被机会式清理"
  );
});

test("无 Content-Length 的流式超限请求在 8KB 处终止，不做完整缓冲", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8192));
      controller.enqueue(new Uint8Array([123]));
      controller.close();
    },
  });
  const request = new NextRequest(
    `https://notes.example.test/api/auth/experience/${accounts[0].accessKey}`,
    {
      method: "POST",
      headers: {
        origin: "https://notes.example.test",
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.242",
      },
      body: stream,
      duplex: "half",
    }
  );
  const response = await loginRoute.POST(request, {
    params: Promise.resolve({ accessKey: accounts[0].accessKey }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "请求体过大" });
});

test("专用登录路由：来源/错误统一、12 小时 Cookie、登录统计与配置撤销闭环", async () => {
  const account = accounts[1];
  let response = await login(account, account.username, "wrong-password");
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "用户名或密码错误" });
  assert.equal(response.headers.get("set-cookie"), null);

  response = await login(account, "wrong-user", passwords[1]);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "用户名或密码错误" });

  const missingOrigin = apiRequest(account, { username: account.username, password: passwords[1] });
  missingOrigin.headers.delete("origin");
  response = await loginRoute.POST(missingOrigin, {
    params: Promise.resolve({ accessKey: account.accessKey }),
  });
  assert.equal(response.status, 403);

  response = await login(account, account.username, passwords[1]);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const setCookie = response.headers.get("set-cookie") || "";
  assert.match(setCookie, /^nb_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=lax/i);
  assert.match(setCookie, /Path=\//i);
  assert.match(setCookie, /Max-Age=43200/i);
  const token = /nb_session=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(token);
  const stored = await db.getSessionUser(token);
  assert.equal(stored?.id, account.userId);
  assert.equal(Number(stored?.login_count), 1);
  assert.ok(Number(stored?.last_login_at) > 0);

  // 运维在旧 DB 到期点前后延长 env 有效期时，现有会话应先同步新到期时间，
  // test 档不能被通用 downgrade 永久楔成 free。
  await getPool().query("UPDATE users SET plan_expires_at=$1 WHERE id=$2", [Date.now() - 1, account.userId]);
  const extendedExpiry = account.expiresAt + 365 * 86400_000;
  process.env.EXPERIENCE_ACCOUNTS_B64 = Buffer.from(
    JSON.stringify({
      v: 1,
      accounts: accounts.map((item) =>
        item.userId === account.userId ? { ...item, expiresAt: extendedExpiry } : item
      ),
    })
  ).toString("base64url");
  const renewed = await db.getSessionUser(token);
  assert.equal(renewed?.plan_tier, "test");
  assert.equal(Number(renewed?.plan_expires_at), extendedExpiry);
  assert.equal((await db.downgradeIfExpired(renewed)).plan_tier, "test");

  process.env.EXPERIENCE_ACCESS_ENABLED = "0";
  assert.equal(await db.getSessionUser(token), undefined, "关闭环境配置后现有测试会话应立即失效");
  process.env.EXPERIENCE_ACCESS_ENABLED = "1";
  process.env.EXPERIENCE_ACCOUNTS_B64 = validConfig;
});

test("测试账号 usage 返回 -1，禁止返利和自助注销且永不拥有后台权限", async () => {
  const user = await db.ensureExperienceAccount(accounts[0]);
  const token = await db.createSession(user.id, 0.5);
  const cookie = `nb_session=${token}`;
  const usageResponse = await usageRoute.GET(
    new NextRequest("https://notes.example.test/api/usage", { headers: { cookie } })
  );
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json();
  assert.equal(usage.dailyLimit, -1);
  assert.equal(usage.daily.limit, -1);
  assert.equal(usage.daily.remaining, -1);
  assert.equal(usage.totalAvailable, -1);
  assert.equal(usage.membership.name, "测试配置");
  const referralResponse = await referralRoute.GET(
    new NextRequest("https://notes.example.test/api/referral", { headers: { cookie } })
  );
  assert.equal(referralResponse.status, 403);
  const deleteResponse = await meRoute.DELETE(
    new NextRequest("https://notes.example.test/api/auth/me", { method: "DELETE", headers: { cookie } })
  );
  assert.equal(deleteResponse.status, 403);
  assert.equal(admin.adminRoleOf({ ...user, is_admin: 1, admin_role: "super" }), null);
});

test("专用入口 noindex/no-store，头像菜单改为个人模型配置入口", () => {
  const page = fs.readFileSync(new URL("../../app/experience/[accessKey]/page.tsx", import.meta.url), "utf8");
  const menu = fs.readFileSync(new URL("../../components/AccountMenu.tsx", import.meta.url), "utf8");
  const config = fs.readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
  assert.match(page, /index:\s*false/);
  assert.match(page, /noarchive:\s*true/);
  assert.match(config, /private, no-store/);
  assert.match(menu, /模型 API 配置/);
  assert.match(menu, /openSettings\("model"\)/);
  assert.doesNotMatch(menu, /查看积分|总可用积分/);
});
