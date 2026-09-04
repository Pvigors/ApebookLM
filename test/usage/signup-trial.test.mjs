// 注册赠送 200 积分，并附 7 天试用权益；积分余额不再被会员墙冻结。
//
// 这条链路的每一环坏掉都是静默的:发放失败 → 新用户注册完发现一分钱功能都用不了;
// 闸门漏了 trial → 送了积分照样被当成「未开通会员」挡住;幂等失效 → 同一个人
// 反复领。全都不会报错,只会表现成「产品好像坏了」或者「成本莫名其妙涨了」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("trial");
const { MANAGED_ENTITLEMENT_TIERS, TRIAL_CREDITS, TRIAL_DAYS, getPlan, isEntitledTier, mergePlanOverrides } = await import("../../lib/plans.ts");
const { getPool } = await import("../../lib/pg.ts");
const { NextRequest } = await import("next/server");
const usageRoute = await import("../../app/api/usage/route.ts");

const DAY = 86400_000;

test("注册即发放:档位/额度/到期时间三者齐备", async () => {
  assert.equal(TRIAL_CREDITS, 200, "注册送额度的公开合同必须固定为 200 分");
  const u = await db.createUserByPhone("139" + "00000001");
  const row = await db.getUserById(u.id);
  assert.equal(row.plan_tier, "trial", "应落在试用档");
  assert.equal(Number(row.bonus_credits), TRIAL_CREDITS, `应发 ${TRIAL_CREDITS} 积分`);
  const left = Number(row.plan_expires_at) - Date.now();
  assert.ok(left > (TRIAL_DAYS - 1) * DAY && left <= TRIAL_DAYS * DAY, `到期应在 ${TRIAL_DAYS} 天内`);
  assert.equal(Number(row.trial_expires_at), Number(row.plan_expires_at), "原试用到期必须独立留存");
  assert.ok(Number(row.trial_granted_at) > 0, "发放时间戳要落库,它是判重依据");
  assert.equal(Number(row.signup_credits_granted), 200, "累计发行 marker 必须与真实发放一致");
});

test("发放记的是「发放」不是「消耗」——不能污染积分消耗指标", async () => {
  const u = await db.createUserByPhone("139" + "00000002");
  const rows = (await getPool().query(
    "SELECT op, credits, bonus FROM credit_ledger WHERE user_id = $1", [u.id]
  )).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].op, "bonus:trial");
  // 与邀请奖励同口径:credits 记负数表示发放。指标层按 op NOT LIKE 'bonus:%' 排除,
  // 两道保险都得在,少一道都会让「积分消耗」被发放量灌成负数或虚高。
  assert.equal(Number(rows[0].credits), -TRIAL_CREDITS);
  assert.equal(Number(rows[0].bonus), -TRIAL_CREDITS, "奖励入账的 bonus 必须与 credits 同为负数");
  assert.equal(Number(rows[0].credits), Number(rows[0].bonus), "纯奖励发放必须满足 credits = plan_credits + bonus");
});

test("usage 合同向新用户返回完整 200 分，不把一次性赠送误算成每日额度", async () => {
  const u = await db.createUserByPhone("139" + "00000012", "usage 新用户");
  const token = await db.createSession(u.id);
  const response = await usageRoute.GET(
    new NextRequest("https://notes.example.test/api/usage", {
      headers: { cookie: `nb_session=${token}` },
    })
  );
  assert.equal(response.status, 200);
  const usage = await response.json();
  assert.equal(usage.plan, "trial");
  assert.equal(usage.capabilityPlan, "trial");
  assert.equal(usage.daily.limit, 0);
  assert.equal(usage.bonus.balance, 200);
  assert.equal(usage.totalAvailable, 200);
});

test("试用用户真的能消费 —— 闸门必须放行,这是整个功能的成败点", async () => {
  const u = await db.createUserByPhone("139" + "00000003");
  const user = await db.getUserById(u.id);

  const pre = await db.checkDailyQuota(user);
  assert.equal(pre.over, false, "预检不能把试用用户判成超额");

  // 一次对话 3 分
  const r = await db.consumeDailyQuota(user, "chat", 3);
  assert.equal(r.over, false);
  assert.equal(Number(await db.getBonusCredits(u.id)), TRIAL_CREDITS - 3, "应从赠送额度里扣");
});

test("额度用尽后被挡,且不会扣成负数", async () => {
  const u = await db.createUserByPhone("139" + "00000004");
  const user = await db.getUserById(u.id);
  // 一集播客 20 分,按当前注册送总额恰好耗尽。
  const rounds = TRIAL_CREDITS / 20;
  assert.equal(Number.isInteger(rounds), true, "耗尽用例要求注册送额度能被 20 整除");
  for (let i = 0; i < rounds; i++) {
    const r = await db.consumeDailyQuota(user, "studio:audio", 20);
    assert.equal(r.over, false, `第 ${i + 1} 次应成功`);
  }
  assert.equal(Number(await db.getBonusCredits(u.id)), 0);
  const over = await db.consumeDailyQuota(user, "chat", 3);
  assert.equal(over.over, true, "余额为 0 时必须挡住");
  assert.equal(Number(await db.getBonusCredits(u.id)), 0, "挡住时不能把余额扣成负数");
});

test("幂等:重复发放拿不到第二份", async () => {
  const u = await db.createUserByPhone("139" + "00000005");
  const again = await db.grantSignupTrial(u.id);
  assert.equal(again, false, "第二次调用应拒绝");
  assert.equal(Number(await db.getBonusCredits(u.id)), TRIAL_CREDITS, "额度不能翻倍");
});

test("幂等:额度花光后也不能再领(判重看发放时间戳,不看余额)", async () => {
  const u = await db.createUserByPhone("139" + "00000006");
  const user = await db.getUserById(u.id);
  await db.consumeDailyQuota(user, "studio:audio", 20);
  await db.consumeDailyQuota(user, "studio:audio", 20);
  const again = await db.grantSignupTrial(u.id);
  assert.equal(again, false, "花掉一部分后仍不能再领");
  assert.equal(Number(await db.getBonusCredits(u.id)), TRIAL_CREDITS - 40);
});

test("不会把已付费用户降成试用档", async () => {
  const u = await db.createUserByPhone("139" + "00000007");
  const exp = Date.now() + 30 * DAY;
  await getPool().query("UPDATE users SET plan_tier='pro', plan_expires_at=$1, trial_granted_at=0 WHERE id=$2", [exp, u.id]);
  const granted = await db.grantSignupTrial(u.id);
  assert.equal(granted, false, "非 free 档一律不发");
  const row = await db.getUserById(u.id);
  assert.equal(row.plan_tier, "pro", "档位不能被改写");
  assert.equal(Number(row.plan_expires_at), exp, "到期时间不能被改写");
});

test("试用到期后自动降回未开通，但剩余赠送积分仍可继续使用", async () => {
  const u = await db.createUserByPhone("139" + "00000008");
  // 把到期时间拨到过去
  await getPool().query("UPDATE users SET plan_expires_at=$1 WHERE id=$2", [Date.now() - DAY, u.id]);
  const user = await db.getUserById(u.id);
  const r = await db.consumeDailyQuota(user, "chat", 3);
  assert.equal(r.over, false, "有剩余赠送积分时不应弹会员墙");
  const row = await db.getUserById(u.id);
  assert.equal(row.plan_tier, "free", "过期档位应被自动收回");
  assert.equal(Number(row.bonus_credits), TRIAL_CREDITS - 3, "应从剩余赠送积分扣减");
});

test("试用档被认定为有额度档,但不可购买", async () => {
  assert.equal(isEntitledTier("trial"), true);
  assert.equal(isEntitledTier("free"), false);
  for (const t of ["starter", "pro", "max"]) assert.equal(isEntitledTier(t), true);
});

test("微信注册同样发放 —— 发放挂在创建函数内部,不依赖各登录路由自觉", async () => {
  const u = await db.createUserByWechat("openid_trial_test", "微信用户");
  const row = await db.getUserById(u.id);
  assert.equal(row.plan_tier, "trial");
  assert.equal(Number(row.bonus_credits), TRIAL_CREDITS);
});

test("邮箱注册同样发放 200 分并写累计发行 marker", async () => {
  const u = await db.createUserByEmail("trial-email@example.test", "邮箱用户");
  const row = await db.getUserById(u.id);
  assert.equal(row.plan_tier, "trial");
  assert.equal(Number(row.bonus_credits), 200);
  assert.equal(Number(row.signup_credits_granted), 200);
});

// ── 会员判定必须认试用档 ────────────────────────────────────────────────
// 这一组对应一次真实的断裂:扣费层放行了 trial,但 lib/membership.ts 另有一套
// 只认 starter/pro/max 的判定,于是试用用户编辑笔记本被 403、新建/搜索被 403、
// 下载一律打水印。后端放行、门口拦住,不报错,只表现为「产品坏了」。
const { isActiveMember, membershipSnapshot } = await import("../../lib/membership.ts");
const { getPlanConfig } = await import("../../lib/plans-config.ts");

test("会员判定:试用档算「有可用权益」", () => {
  const future = Date.now() + 3 * DAY;
  assert.equal(isActiveMember({ plan_tier: "trial", plan_expires_at: future }), true);
  assert.equal(isActiveMember({ plan_tier: "free", plan_expires_at: future }), false);
  assert.equal(isActiveMember({ plan_tier: "pro", plan_expires_at: future }), true);
});

test("会员判定:试用到期即失去权益", () => {
  assert.equal(isActiveMember({ plan_tier: "trial", plan_expires_at: Date.now() - 1 }), false);
});

test("会员快照:回真实档位而不是回落成 free —— 否则前端拿到零权益配置", () => {
  const snap = membershipSnapshot({ plan_tier: "trial", plan_expires_at: Date.now() + 3 * DAY });
  assert.equal(snap.active, true);
  assert.equal(snap.tier, "trial", "tier 必须是 trial;回 null 会让 usage 接口回落到 free 配置");
  assert.equal(snap.trial, true, "前端据此把文案写成「试用中」而非「会员」");
  assert.ok(snap.expiresAt > Date.now());
});

test("会员快照:付费档不被误标为试用", () => {
  const snap = membershipSnapshot({ plan_tier: "pro", plan_expires_at: Date.now() + 30 * DAY });
  assert.equal(snap.tier, "pro");
  assert.equal(snap.trial, false);
});

test("试用档权益:不打水印(分享传播要靠它),但文件上传仍关闭(成本大头)", async () => {
  const trial = await getPlanConfig("trial");
  assert.equal(trial.watermark, false, "打水印会掐掉图片制品的分享获客链路");
  assert.equal(trial.maxFileBytes, 0, "文件上传是成本大头,试用期不放开");
  assert.equal(trial.dailyLimit, 0, "试用给的是一次性总额,不是每日配额");
  assert.equal(trial.maxNotebooks, 3);
});

test("试用档是固定合同:遗留后台覆盖不能开无限积分或文件上传", async () => {
  assert.deepEqual([...MANAGED_ENTITLEMENT_TIERS], ["starter", "pro", "max"], "后台只能调整受管理权益档");
  const merged = mergePlanOverrides(getPlan("trial"), {
    "plan.trial.dailyLimit": "-1",
    "plan.trial.maxNotebooks": "-1",
    "plan.trial.maxFileMB": "2048",
    "plan.trial.collaboratorLimit": "-1",
  });
  assert.equal(merged.dailyLimit, 0);
  assert.equal(merged.maxNotebooks, 3);
  assert.equal(merged.maxFileBytes, 0);
  assert.equal(merged.collaboratorLimit, 0);

  await db.setSetting("plan.trial.dailyLimit", "-1", "test");
  try {
    assert.equal((await getPlanConfig("trial")).dailyLimit, 0, "DB 遗留覆盖也必须失效");
  } finally {
    await db.deleteSetting("plan.trial.dailyLimit");
  }
});

test("并发补发仅一次:余额、时间戳和流水一起仲裁", async () => {
  const id = "trial-race-user";
  const now = Date.now();
  await getPool().query(
    "INSERT INTO users(id,name,phone,created_at,last_seen,trial_expires_at) VALUES($1,$2,$3,$4,0,$5)",
    [id, "并发补发", "139" + "00000011", now, now + TRIAL_DAYS * DAY]
  );
  const results = await Promise.all(Array.from({ length: 20 }, () => db.grantSignupTrial(id)));
  assert.equal(results.filter(Boolean).length, 1);
  const row = await db.getUserById(id);
  assert.equal(row.plan_tier, "trial");
  assert.equal(Number(row.bonus_credits), TRIAL_CREDITS);
  assert.equal(
    Number((await getPool().query("SELECT COUNT(*) n FROM credit_ledger WHERE user_id=$1 AND op='bonus:trial'", [id])).rows[0].n),
    1
  );
});

test("发放故障不虚报,会话层会按持久资格幂等补发", async () => {
  const pool = getPool();
  await pool.query("ALTER TABLE credit_ledger RENAME TO credit_ledger_fault");
  let returned;
  try {
    returned = await db.createUserByPhone("139" + "00000009", "故障补发");
  } finally {
    await pool.query("ALTER TABLE credit_ledger_fault RENAME TO credit_ledger");
  }
  const storedBefore = await db.getUserById(returned.id);
  assert.equal(returned.plan_tier, "free", "返回对象必须与失败后 DB 一致");
  assert.equal(storedBefore.plan_tier, "free");
  assert.equal(Number(storedBefore.bonus_credits), 0);
  assert.ok(Number(storedBefore.trial_expires_at) > Date.now(), "补发资格必须持久留存");

  const token = await db.createSession(returned.id);
  const repaired = await db.getSessionUser(token);
  assert.equal(repaired.plan_tier, "trial");
  assert.equal(Number(repaired.bonus_credits), TRIAL_CREDITS);
  assert.equal(Number(repaired.plan_expires_at), Number(storedBefore.trial_expires_at));
  assert.equal(
    Number((await pool.query("SELECT COUNT(*) n FROM credit_ledger WHERE user_id=$1 AND op='bonus:trial'", [returned.id])).rows[0].n),
    1
  );
});

test("db8ea00 存量试用回填原到期快照且迁移幂等", async () => {
  const u = await db.createUserByPhone("139" + "00000010", "迁移回填");
  const before = await db.getUserById(u.id);
  const expected = Number(before.trial_granted_at) + TRIAL_DAYS * DAY;
  // 模拟已升级付费的 db8ea00 用户:plan_expires_at 已不再是试用到期,新列尚不存在事实。
  await getPool().query(
    "UPDATE users SET plan_tier='pro', plan_expires_at=$1 WHERE id=$2",
    [Date.now() + 31 * DAY, u.id]
  );
  await getPool().query("ALTER TABLE users DROP COLUMN trial_expires_at");
  await db.initSchema();
  await db.initSchema();
  const migrated = await db.getUserById(u.id);
  assert.equal(Number(migrated.trial_expires_at), expected);
});
