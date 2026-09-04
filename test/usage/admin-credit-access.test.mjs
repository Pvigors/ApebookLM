import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { freshPgDb } from "../helpers/pgdb.mjs";

process.env.ADMIN_PASSWORD_LOGIN_ENABLED = "1";

const access = await import("../../lib/admin-password-access.ts");
const account = {
  username: "system.root",
  userId: "password-admin-fedcba98-7654-3210-fedc-ba9876543210",
  displayName: "系统管理员",
  passwordHash: access.hashAdminPassword("Ape!Admin-q8V$k2Lm9R", Buffer.alloc(18, 31)),
  credentialVersion: 1,
  expiresAt: Date.now() + 365 * 86400_000,
};
process.env.ADMIN_PASSWORD_ACCOUNT_B64 = Buffer.from(
  JSON.stringify({ v: 1, ...account }),
  "utf8"
).toString("base64url");

const db = await freshPgDb("admin_credit_access");
const membership = await import("../../lib/membership.ts");
const plans = await import("../../lib/plans-config.ts");
const { getPool } = await import("../../lib/pg.ts");
const { NextRequest } = await import("next/server");
const referralRoute = await import("../../app/api/referral/route.ts");
const usageRoute = await import("../../app/api/usage/route.ts");
const auth = await import("../../lib/auth.ts");

test("独立系统管理员虚拟获得不限量权益，但数据库档位保持 free", async () => {
  const admin = await db.ensureAdminPasswordAccount(account);
  assert.equal(admin.plan_tier, "free");
  assert.equal(membership.effectivePlanTierForUser(admin), "test");
  assert.equal(membership.hasUsageAccess(admin), true);
  const snapshot = membership.membershipSnapshot(admin);
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.systemAdmin, true);
  assert.equal(snapshot.test, false);
  assert.equal(snapshot.tier, "test");
  const plan = await plans.getEffectivePlanConfigForUser(admin);
  assert.equal(plan.dailyLimit, -1);
  assert.equal(plan.maxNotebooks, -1);
  assert.equal(plan.watermark, false);
});

test("系统管理员任意大额操作可计量但不扣奖励，异步 draft 仍能凭 ledger 激活", async () => {
  await getPool().query(
    "UPDATE users SET plan_tier='starter',plan_expires_at=$1,is_admin=0,admin_role=NULL WHERE id=$2",
    [Date.now() + 30 * 86400_000, account.userId]
  );
  const ordinary = await db.getUserById(account.userId);
  assert.equal((await db.consumeDailyQuota(ordinary, "setup", 10)).over, false);
  await getPool().query("UPDATE users SET is_admin=1,admin_role='super' WHERE id=$1", [account.userId]);
  const admin = await db.getUserById(account.userId);
  const charge = await db.consumeDailyQuota(admin, "chat", 1_000_000, "系统管理员不限量回归");
  assert.equal(charge.over, false);
  assert.equal(charge.limit, -1);
  assert.ok(charge.ledgerId);
  assert.equal(Number(await db.getBonusCredits(admin.id)), 0);
  const ledger = (
    await getPool().query("SELECT credits,unlimited_at_charge FROM credit_ledger WHERE id=$1", [charge.ledgerId])
  ).rows[0];
  assert.equal(Number(ledger.credits), 1_000_000);
  assert.equal(Number(ledger.unlimited_at_charge), 1);
  assert.equal(Number((await db.getUserUsage(admin.id)).today), 10, "管理员用量不得进入套餐日桶");
  assert.equal(await db.refundCredits(admin.id, "chat", 1_000_000, charge.ledgerId), true);
  assert.equal(Number((await db.getUserUsage(admin.id)).today), 10, "管理员退款不得回冲底层套餐日桶");

  const notebook = await db.createNotebook(admin.id, "管理员制品", "🛡️");
  const draft = await db.createJob(notebook.id, admin.id, "briefing", "管理员制品", {}, 0, null, "draft");
  const activated = await db.activateChargedJob(draft.id, admin.id, "studio:briefing", 5, notebook.title);
  assert.equal(activated.over, false);
  assert.equal(activated.job?.status, "queued");
  assert.ok(activated.ledgerId);
  const running = await db.claimNextQueued();
  assert.equal(running?.id, draft.id);
  assert.equal(await db.finalizeJobDone(
    running.id,
    null,
    {
      userId: admin.id,
      op: "studio:briefing",
      reservedCredits: 5,
      finalCredits: 2,
      tokensIn: 100,
      tokensOut: 50,
      ledgerId: activated.ledgerId,
    },
    running.run_attempt
  ), true);
  assert.equal(Number((await db.getUserUsage(admin.id)).today), 10, "管理员 Token 差额结算不得回冲套餐日桶");
});

test("系统管理员不参与邀请，同时不能绕过私人笔记本权限", async () => {
  const admin = await db.getUserById(account.userId);
  const invited = await db.createUserByPhone("139" + "00000993", "被邀请人");
  await db.attributeReferral(invited.id, admin.id);
  assert.equal((await db.getUserById(invited.id)).referred_by, null, "系统管理员不能作为邀请人归因");
  await getPool().query("UPDATE users SET referred_by=$1 WHERE id=$2", [admin.id, invited.id]);
  await db.awardReferralMilestone(invited.id, "first_chat");
  assert.equal(Number(await db.getBonusCredits(admin.id)), 0, "存量归因也不能给系统管理员发奖励");
  await db.attributeReferral(admin.id, invited.id);
  assert.equal((await db.getUserById(admin.id)).referred_by, null, "系统管理员不能作为被邀请人归因");
  const token = await db.createSession(admin.id);
  const headers = new Headers({
    cookie: `nb_session=${token}`,
    "content-type": "application/json",
    "x-forwarded-for": "198.51.100.91",
  });
  const stranger = await db.createUserByPhone("139" + "00000995", "普通所有者");
  const privateNotebook = await db.createNotebook(stranger.id, "私有笔记本", "🔒");
  const acl = await auth.requireAccess(
    new NextRequest(`https://notes.example.test/api/notebooks/${privateNotebook.id}`, { headers }),
    privateNotebook.id,
    true
  );
  assert.equal(acl instanceof Response, true);
  assert.equal(acl.status, 403, "系统管理员不限量权益不能绕过私人笔记本 ACL");
  const usageRes = await usageRoute.GET(new NextRequest("https://notes.example.test/api/usage", { headers }));
  assert.equal(usageRes.status, 200);
  const usage = await usageRes.json();
  assert.equal(usage.membership.name, "系统管理员");
  assert.equal(usage.membership.systemAdmin, true);
  assert.equal(usage.totalAvailable, -1);
  assert.equal(usage.dailyLimit, -1);
  assert.equal(usage.maxNotebooks, -1);

  const referralRes = await referralRoute.GET(new NextRequest("https://notes.example.test/api/referral", { headers }));
  assert.equal(referralRes.status, 403);
  assert.match((await referralRes.json()).error, /系统管理员不参与邀请返利/);
});

test("基础权益用户有奖励积分即可使用；积分耗尽后只返回 quota", async () => {
  const created = await db.createUserByPhone("139" + "00000991", "积分用户");
  await getPool().query(
    "UPDATE users SET plan_tier='free',plan_expires_at=0,bonus_credits=5 WHERE id=$1",
    [created.id]
  );
  const user = await db.getUserById(created.id);
  assert.equal(membership.membershipSnapshot(user).active, false, "积分可用不冒充限时权益");
  assert.equal(membership.hasUsageAccess(user), true);
  assert.equal(membership.effectivePlanTierForUser(user), "trial");
  const token = await db.createSession(user.id);
  const usageRes = await usageRoute.GET(new NextRequest("https://notes.example.test/api/usage", {
    headers: { cookie: `nb_session=${token}` },
  }));
  const usage = await usageRes.json();
  assert.equal(usage.plan, "free");
  assert.equal(usage.capabilityPlan, "trial");
  assert.equal(usage.membership.active, false);
  assert.equal(usage.membership.name, "基础权益");
  assert.equal(usage.access.reason, "credits");
  assert.equal(usage.totalAvailable, 5);
  assert.equal(usage.maxFileBytes, 0);
  const first = await db.consumeDailyQuota(user, "chat", 3);
  assert.equal(first.over, false);
  assert.equal(Number(await db.getBonusCredits(user.id)), 2);
  const second = await db.consumeDailyQuota(user, "chat", 3);
  assert.equal(second.over, true);
  assert.equal(Number(await db.getBonusCredits(user.id)), 2, "不足时不能扣成负数");
});

test("operator/auditor 不继承系统管理员的不限量权益，撤销 super 后立即失效", async () => {
  const operator = await db.createUserByPhone("139" + "00000992", "运营员");
  await getPool().query(
    "UPDATE users SET plan_tier='free',plan_expires_at=0,bonus_credits=0,admin_role='operator',is_admin=0 WHERE id=$1",
    [operator.id]
  );
  const op = await db.getUserById(operator.id);
  assert.equal(membership.hasUsageAccess(op), false);
  assert.equal((await db.consumeDailyQuota(op, "chat", 1)).over, true);
  const auditor = await db.createUserByPhone("139" + "00000994", "审计员");
  await getPool().query(
    "UPDATE users SET plan_tier='free',plan_expires_at=0,bonus_credits=0,admin_role='auditor',is_admin=0 WHERE id=$1",
    [auditor.id]
  );
  const auditUser = await db.getUserById(auditor.id);
  assert.equal(membership.hasUsageAccess(auditUser), false);
  assert.equal((await db.consumeDailyQuota(auditUser, "chat", 1)).over, true);

  await getPool().query("UPDATE users SET is_admin=0,admin_role=NULL WHERE id=$1", [account.userId]);
  const revoked = await db.getUserById(account.userId);
  assert.equal(membership.membershipSnapshot(revoked).systemAdmin, false);
  assert.equal(membership.effectivePlanTierForUser(revoked), "starter", "撤权后恢复底层权益档");
  const before = await db.checkDailyQuota(revoked);
  assert.equal(before.over, false);
  assert.equal(before.used, 10, "管理员期间的不限量使用不得污染原权益日桶");
  const normal = await db.consumeDailyQuota(revoked, "chat", 1);
  assert.equal(normal.over, false);
  assert.equal(normal.used, 11);
});

test("社区版邀请仍识别系统管理员，设置入口使用模型 API 配置", () => {
  const referral = fs.readFileSync(new URL("../../app/api/referral/route.ts", import.meta.url), "utf8");
  const settings = fs.readFileSync(new URL("../../components/SettingsMenu.tsx", import.meta.url), "utf8");
  const home = fs.readFileSync(new URL("../../components/HomeClient.tsx", import.meta.url), "utf8");
  assert.match(referral, /isSystemAdminUser\(user\)/);
  assert.match(settings, /模型 API 配置/);
  assert.match(settings, /<ModelApiSettings \/>/);
  assert.doesNotMatch(settings, /PayModal|购买成功|续费/);
  assert.match(home, /addEventListener\("nb:usage-updated"/);
  assert.match(home, /systemAdmin=\{user\?\.adminRole === "super"\}/);
  assert.doesNotMatch(home, /data\?\.code === "membership_required"/);
  assert.doesNotMatch(home, /quotaMsg\?\.includes\("开通会员"\)/);
  assert.equal((home.match(/user\?\.adminRole !== "super"/g) ?? []).length, 2, "首页和笔记本页都隐藏管理员邀请入口");
});
