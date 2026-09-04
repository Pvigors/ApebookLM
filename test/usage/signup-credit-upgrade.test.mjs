// 注册赠送从 100 升级到 200 的存量补差：以累计发行额为准，不覆盖混合奖励余额。
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

process.env.RELEASE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const db = await freshPgDb("signup_credit_upgrade");
const { getPool } = await import("../../lib/pg.ts");
const { runSignupCreditMigration } = await import("../../lib/signup-credits-migration.ts");
const { SIGNUP_CREDIT_MIGRATION_KEY, SIGNUP_CREDIT_UPGRADE_OP } = await import("../../lib/signup-credits.ts");
const pool = getPool();

async function insertUser({
  id,
  bonus = 0,
  plan = "free",
  trialGranted = 0,
  trialExpires = 0,
  marker = 0,
  disabled = 0,
  isAdmin = 0,
  adminRole = null,
  email,
}) {
  const now = Date.now();
  const resolvedEmail = email === undefined ? `${id}@example.test` : email;
  await pool.query(
    `INSERT INTO users(
       id,name,email,created_at,last_seen,bonus_credits,plan_tier,plan_expires_at,
       trial_granted_at,signup_credits_granted,trial_expires_at,disabled,is_admin,admin_role
     ) VALUES($1,$1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      resolvedEmail,
      now,
      bonus,
      plan,
      plan === "pro" ? now + 30 * 86400_000 : 0,
      trialGranted,
      marker,
      trialExpires,
      disabled,
      isAdmin,
      adminRole,
    ]
  );
}

async function insertGrant(userId, amount) {
  await pool.query(
    `INSERT INTO credit_ledger(user_id,op,credits,bonus,plan_credits,ts,note)
     VALUES($1,'bonus:trial',$2,$2,0,$3,'历史注册送积分')`,
    [userId, -amount, Date.now()]
  );
}

test("全量补发按累计发行差额入账，不覆盖已消费、邀请奖励或套餐状态", async () => {
  await insertUser({ id: "old-spent", bonus: 40, trialGranted: 1 });
  await insertGrant("old-spent", 100);
  await insertUser({ id: "managed-referral", bonus: 600, plan: "pro", trialGranted: 2 });
  await insertGrant("managed-referral", 100);
  await pool.query(
    `INSERT INTO credit_ledger(user_id,op,credits,bonus,plan_credits,ts)
     VALUES('managed-referral','referral:first_chat',-500,-500,0,$1)`,
    [Date.now()]
  );
  await insertUser({ id: "legacy-never-granted" });
  await insertUser({ id: "legacy-missing-ledger", bonus: 60, trialGranted: 7 });
  await insertUser({ id: "already-200", bonus: 200, trialGranted: 3, marker: 200 });
  await insertGrant("already-200", 200);
  await insertUser({ id: "test-account", plan: "test" });
  await insertUser({ id: "system-admin", isAdmin: 1, adminRole: "super" });
  await insertUser({ id: "operator", isAdmin: 1, adminRole: "operator" });
  await insertUser({ id: "disabled-user", disabled: 1 });
  await insertUser({ id: "orphan-row", email: null });

  const dry = await runSignupCreditMigration(pool, { mode: "dry-run" });
  assert.equal(dry.pendingUsers, 6);
  assert.equal(dry.pendingCredits, 900);
  assert.equal(dry.excludedTestUsers, 1);
  assert.equal(dry.excludedSystemAdmins, 1);
  assert.equal(dry.excludedSyntheticUsers, 0, "社区版不会自动播种演示账号");
  assert.equal(dry.excludedUnregisteredUsers, 1, "无登录身份/注册证据的孤儿行不得获赠");
  assert.equal(dry.anomalyUsers, 0);
  assert.equal(dry.appliedUsers, 0, "dry-run 绝不能改数据");

  const applied = await runSignupCreditMigration(pool, {
    mode: "apply",
    expectedUsers: dry.pendingUsers,
    expectedCredits: dry.pendingCredits,
  });
  assert.equal(applied.appliedUsers, 6);
  assert.equal(applied.appliedCredits, 900);
  assert.equal(applied.afterBonusSum - applied.beforeBonusSum, 900);

  const balances = Object.fromEntries(
    (
      await pool.query(
        `SELECT id,bonus_credits,signup_credits_granted,plan_tier,plan_expires_at
           FROM users ORDER BY id`
      )
    ).rows.map((row) => [row.id, row])
  );
  assert.equal(Number(balances["old-spent"].bonus_credits), 140, "已花 60 只补 100，不把余额设成 200");
  assert.equal(Number(balances["managed-referral"].bonus_credits), 700, "邀请奖励不参与注册差额计算");
  assert.equal(balances["managed-referral"].plan_tier, "pro", "补分不能改权益档位");
  assert.ok(Number(balances["managed-referral"].plan_expires_at) > Date.now(), "补分不能改权益到期时间");
  assert.equal(Number(balances["legacy-never-granted"].bonus_credits), 200, "从未获赠的历史用户补完整 200");
  assert.equal(Number(balances["legacy-missing-ledger"].bonus_credits), 160, "旧流水缺失时以发放时间保守恢复 100，再补差 100");
  assert.equal(Number(balances["already-200"].bonus_credits), 200, "已发满不得重复补");
  assert.equal(Number(balances.operator.bonus_credits), 200, "operator 没有额度豁免，仍属于注册用户");
  assert.equal(Number(balances["disabled-user"].bonus_credits), 200, "停用只限制访问，不吞注册赠送");
  assert.equal(Number(balances["test-account"].bonus_credits), 0);
  assert.equal(Number(balances["system-admin"].bonus_credits), 0);
  assert.equal(Number(balances["orphan-row"].bonus_credits), 0);

  const upgrades = (
    await pool.query(
      `SELECT user_id,-bonus AS granted,credits,bonus,plan_credits
         FROM credit_ledger WHERE op=$1 ORDER BY user_id`,
      [SIGNUP_CREDIT_UPGRADE_OP]
    )
  ).rows;
  assert.deepEqual(
    upgrades.map((row) => [row.user_id, Number(row.granted)]),
    [
      ["disabled-user", 200],
      ["legacy-missing-ledger", 100],
      ["legacy-never-granted", 200],
      ["managed-referral", 100],
      ["old-spent", 100],
      ["operator", 200],
    ]
  );
  for (const row of upgrades) {
    assert.equal(Number(row.credits), Number(row.bonus));
    assert.equal(Number(row.plan_credits), 0);
  }

  const verify = await runSignupCreditMigration(pool, { mode: "verify" });
  assert.equal(verify.remainingPendingUsers, 0);
  assert.equal(verify.anomalyUsers, 0);
  assert.equal(verify.duplicateUpgradeUsers, 0);
  assert.equal(verify.markerBehindUsers, 0);
  assert.equal(verify.migrationMarkerValid, true);
  const firstMarker = (
    await pool.query("SELECT value FROM app_settings WHERE key=$1", [SIGNUP_CREDIT_MIGRATION_KEY])
  ).rows[0].value;
  const repeated = await runSignupCreditMigration(pool, {
    mode: "apply",
    expectedUsers: 0,
    expectedCredits: 0,
  });
  assert.equal(repeated.appliedUsers, 0, "重复部署必须是 no-op");
  assert.equal(repeated.appliedCredits, 0);
  assert.equal(
    (await pool.query("SELECT value FROM app_settings WHERE key=$1", [SIGNUP_CREDIT_MIGRATION_KEY])).rows[0].value,
    firstMarker,
    "第二次 0/0 apply 不得覆盖首次发放统计"
  );
});

test("迁移 marker 必须与实际升级流水累计精确对账", async () => {
  const valid = (
    await pool.query("SELECT value FROM app_settings WHERE key=$1", [SIGNUP_CREDIT_MIGRATION_KEY])
  ).rows[0].value;
  await pool.query(
    "UPDATE app_settings SET value=$1 WHERE key=$2",
    [
      JSON.stringify({
        target: 200,
        users: 0,
        credits: 0,
        release: process.env.RELEASE_SHA,
        appliedAt: Date.now(),
      }),
      SIGNUP_CREDIT_MIGRATION_KEY,
    ]
  );
  const verify = await runSignupCreditMigration(pool, { mode: "verify" });
  assert.equal(verify.migrationMarkerValid, false, "格式合法但统计错误的 marker 不能假绿");
  await assert.rejects(
    runSignupCreditMigration(pool, { mode: "apply", expectedUsers: 0, expectedCredits: 0 }),
    /marker 与实际升级流水不一致/
  );
  await pool.query("UPDATE app_settings SET value=$1 WHERE key=$2", [valid, SIGNUP_CREDIT_MIGRATION_KEY]);
});

test("注册发放中的用户阻断存量迁移，注册完成后 verify 恢复全绿", async () => {
  await insertUser({
    id: "pending-signup",
    trialExpires: Date.now() + 7 * 86400_000,
  });
  const dry = await runSignupCreditMigration(pool, { mode: "dry-run" });
  assert.equal(dry.pendingInitialGrantUsers, 1);
  assert.equal(dry.pendingUsers, 0);
  await assert.rejects(
    runSignupCreditMigration(pool, { mode: "apply", expectedUsers: 0, expectedCredits: 0 }),
    /注册发放中的账号/
  );
  assert.equal(await db.grantSignupTrial("pending-signup"), true);
  const user = await db.getUserById("pending-signup");
  assert.equal(Number(user.bonus_credits), 200);
  assert.equal(Number(user.signup_credits_granted), 200);
  const verify = await runSignupCreditMigration(pool, { mode: "verify" });
  assert.equal(verify.pendingInitialGrantUsers, 0);
  assert.equal(verify.remainingPendingUsers, 0);
  assert.equal(verify.anomalyUsers, 0);
  assert.equal(verify.markerBehindUsers, 0);
  assert.equal(verify.migrationMarkerValid, true);
});

test("注册发放与迁移真并发最终仍严格为 200 且无升级歧义", async () => {
  await insertUser({
    id: "pending-signup-race",
    trialExpires: Date.now() + 7 * 86400_000,
  });
  const [migration, grant] = await Promise.allSettled([
    runSignupCreditMigration(pool, { mode: "apply", expectedUsers: 0, expectedCredits: 0 }),
    db.grantSignupTrial("pending-signup-race"),
  ]);
  assert.equal(grant.status, "fulfilled");
  assert.equal(grant.value, true);
  if (migration.status === "rejected") {
    assert.match(String(migration.reason?.message ?? migration.reason), /注册发放中的账号/);
  } else {
    assert.equal(migration.value.appliedUsers, 0);
  }
  const user = await db.getUserById("pending-signup-race");
  assert.equal(Number(user.bonus_credits), 200);
  assert.equal(Number(user.signup_credits_granted), 200);
  assert.equal(
    Number((await pool.query(
      "SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id='pending-signup-race' AND op='bonus:trial'"
    )).rows[0].n),
    1
  );
  assert.equal(
    Number((await pool.query(
      "SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id='pending-signup-race' AND op=$1",
      [SIGNUP_CREDIT_UPGRADE_OP]
    )).rows[0].n),
    0
  );
  const verify = await runSignupCreditMigration(pool, { mode: "verify" });
  assert.equal(verify.pendingInitialGrantUsers, 0);
  assert.equal(verify.anomalyUsers, 0);
  assert.equal(verify.migrationMarkerValid, true);
});

test("存量补发不允许由普通会话绕过 dry-run 与显式迁移", async () => {
  await insertUser({ id: "controlled-upgrade", bonus: 0, trialGranted: 4 });
  await insertGrant("controlled-upgrade", 100);
  const token = await db.createSession("controlled-upgrade");
  const user = await db.getSessionUser(token);
  assert.equal(Number(user.bonus_credits), 0, "登录不能在财务迁移前偷偷发放");
  assert.equal(Number(user.signup_credits_granted), 0);
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id='controlled-upgrade' AND op=$1",
          [SIGNUP_CREDIT_UPGRADE_OP]
        )
      ).rows[0].n
    ),
    0
  );
  const dry = await runSignupCreditMigration(pool, { mode: "dry-run" });
  assert.equal(dry.pendingUsers, 1);
  assert.equal(dry.pendingCredits, 100);
  await assert.rejects(
    runSignupCreditMigration(pool, { mode: "apply", expectedUsers: 1, expectedCredits: 100 }),
    /marker 已存在但仍有待补账号/
  );
  await pool.query("DELETE FROM credit_ledger WHERE user_id='controlled-upgrade'");
  await pool.query("DELETE FROM sessions WHERE user_id='controlled-upgrade'");
  await pool.query("DELETE FROM users WHERE id='controlled-upgrade'");
});

test("marker 领先可信账本时 verify 必须 fail-closed", async () => {
  await insertUser({ id: "marker-ahead", bonus: 100, trialGranted: 8, marker: 200 });
  await insertGrant("marker-ahead", 100);
  const verify = await runSignupCreditMigration(pool, { mode: "verify" });
  assert.equal(verify.anomalyUsers, 1);
  await assert.rejects(
    runSignupCreditMigration(pool, { mode: "apply" }),
    /账本异常/
  );
  await pool.query("DELETE FROM credit_ledger WHERE user_id='marker-ahead'");
  await pool.query("DELETE FROM users WHERE id='marker-ahead'");
});

test("两个补发进程并发时只有一笔余额和流水生效", async () => {
  await pool.query("DELETE FROM app_settings WHERE key=$1", [SIGNUP_CREDIT_MIGRATION_KEY]);
  await insertUser({ id: "concurrent-upgrade", bonus: 25, trialGranted: 5 });
  await insertGrant("concurrent-upgrade", 100);
  const results = await Promise.all([
    runSignupCreditMigration(pool, { mode: "apply" }),
    runSignupCreditMigration(pool, { mode: "apply" }),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.appliedUsers, 0), 1);
  const user = await db.getUserById("concurrent-upgrade");
  assert.equal(Number(user.bonus_credits), 125);
  assert.equal(Number(user.signup_credits_granted), 200);
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id='concurrent-upgrade' AND op=$1",
          [SIGNUP_CREDIT_UPGRADE_OP]
        )
      ).rows[0].n
    ),
    1
  );
});

test("补发流水写入故障时余额与 marker 整笔回滚", async () => {
  await pool.query("DELETE FROM app_settings WHERE key=$1", [SIGNUP_CREDIT_MIGRATION_KEY]);
  await insertUser({ id: "rollback-upgrade", bonus: 10, trialGranted: 6 });
  await insertGrant("rollback-upgrade", 100);
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_signup_upgrade() RETURNS trigger AS $$
    BEGIN
      IF NEW.op = '${SIGNUP_CREDIT_UPGRADE_OP}' THEN
        RAISE EXCEPTION 'injected signup upgrade failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_signup_upgrade_trigger
      BEFORE INSERT ON credit_ledger
      FOR EACH ROW EXECUTE FUNCTION fail_signup_upgrade();
  `);
  try {
    await assert.rejects(
      runSignupCreditMigration(pool, { mode: "apply" }),
      /injected signup upgrade failure/
    );
  } finally {
    await pool.query("DROP TRIGGER fail_signup_upgrade_trigger ON credit_ledger");
    await pool.query("DROP FUNCTION fail_signup_upgrade() ");
  }
  const user = await db.getUserById("rollback-upgrade");
  assert.equal(Number(user.bonus_credits), 10);
  assert.equal(Number(user.signup_credits_granted), 0);
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id='rollback-upgrade' AND op=$1",
          [SIGNUP_CREDIT_UPGRADE_OP]
        )
      ).rows[0].n
    ),
    0
  );
});
