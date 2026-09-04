import type { Pool, PoolClient } from "pg";
import { TRIAL_CREDITS } from "./plans";
import {
  isSignupCreditEligible,
  isSignupCreditSystemAdmin,
  isSyntheticSignupCreditUser,
  hasSignupRegistrationEvidence,
  isSignupInitialGrantPending,
  readSignupCreditIssueState,
  SIGNUP_CREDIT_MIGRATION_KEY,
  SIGNUP_CREDIT_UPGRADE_OP,
} from "./signup-credits";
import type { User } from "./types";

const MIGRATION_LOCK = 904_202_610;

export type SignupCreditMigrationSummary = {
  mode: "dry-run" | "apply" | "verify";
  targetCredits: number;
  totalUsers: number;
  eligibleUsers: number;
  excludedTestUsers: number;
  excludedSystemAdmins: number;
  excludedSyntheticUsers: number;
  excludedUnregisteredUsers: number;
  pendingInitialGrantUsers: number;
  pendingUsers: number;
  pendingCredits: number;
  atTargetUsers: number;
  overTargetUsers: number;
  markerBehindUsers: number;
  recoveredLegacyWithoutLedger: number;
  anomalyUsers: number;
  appliedUsers: number;
  appliedCredits: number;
  markerSyncedUsers: number;
  beforeBonusSum: number;
  afterBonusSum: number;
  remainingPendingUsers: number;
  duplicateUpgradeUsers: number;
  migrationMarkerValid: boolean;
};

type BackfillOptions = {
  mode?: SignupCreditMigrationSummary["mode"];
  expectedUsers?: number;
  expectedCredits?: number;
};

type Candidate = {
  user: User;
  issued: number;
  delta: number;
  marker: number;
};

type UpgradeTotals = { users: number; credits: number; invalidRows: number };

function validMigrationMarker(raw: string | undefined, totals: UpgradeTotals): boolean {
  if (!raw) return false;
  try {
    const value = JSON.parse(raw) as {
      target?: unknown;
      users?: unknown;
      credits?: unknown;
      release?: unknown;
      appliedAt?: unknown;
    };
    return totals.invalidRows === 0 &&
      value.target === TRIAL_CREDITS &&
      Number.isSafeInteger(value.users) && Number(value.users) === totals.users &&
      Number.isSafeInteger(value.credits) && Number(value.credits) === totals.credits &&
      typeof value.release === "string" && /^[a-f0-9]{7,40}$/i.test(value.release) &&
      Number.isSafeInteger(value.appliedAt) && Number(value.appliedAt) > 0;
  } catch {
    return false;
  }
}

async function readUpgradeTotals(client: PoolClient): Promise<UpgradeTotals> {
  const row = (
    await client.query<{ users: number; credits: number; invalid_rows: number }>(
      `SELECT COUNT(*)::BIGINT AS users,
              COALESCE(SUM(CASE WHEN bonus<0 THEN -bonus ELSE 0 END),0)::BIGINT AS credits,
              COUNT(*) FILTER (
                WHERE bonus>=0 OR credits<>bonus OR plan_credits IS DISTINCT FROM 0
              )::BIGINT AS invalid_rows
         FROM credit_ledger WHERE op=$1`,
      [SIGNUP_CREDIT_UPGRADE_OP]
    )
  ).rows[0];
  return {
    users: Number(row?.users ?? 0),
    credits: Number(row?.credits ?? 0),
    invalidRows: Number(row?.invalid_rows ?? 0),
  };
}

/**
 * 显式存量补发：只在新版本完成切流、旧实例不再发 100 分之后运行。
 * apply 使用事务 advisory lock + 固定顺序 users 行锁；重跑只会得到 0 笔。
 */
export async function runSignupCreditMigration(
  pool: Pool,
  options: BackfillOptions = {}
): Promise<SignupCreditMigrationSummary> {
  const mode = options.mode ?? "dry-run";
  const apply = mode === "apply";
  const client = await pool.connect();
  try {
    if (apply) {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='10s'");
      await client.query("SET LOCAL statement_timeout='120s'");
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    }

    const users = (
      await client.query<User>(
        `SELECT * FROM users ORDER BY id${apply ? " FOR UPDATE" : ""}`
      )
    ).rows;
    const candidates: Candidate[] = [];
    let excludedTestUsers = 0;
    let excludedSystemAdmins = 0;
    let excludedSyntheticUsers = 0;
    let excludedUnregisteredUsers = 0;
    let pendingInitialGrantUsers = 0;
    let atTargetUsers = 0;
    let overTargetUsers = 0;
    let markerBehindUsers = 0;
    let recoveredLegacyWithoutLedger = 0;
    let anomalyUsers = 0;

    for (const user of users) {
      if (user.plan_tier === "test") {
        excludedTestUsers++;
        continue;
      }
      if (isSyntheticSignupCreditUser(user)) {
        excludedSyntheticUsers++;
        continue;
      }
      if (isSignupCreditSystemAdmin(user)) {
        excludedSystemAdmins++;
        continue;
      }
      if (!hasSignupRegistrationEvidence(user)) {
        excludedUnregisteredUsers++;
        continue;
      }
      if (isSignupInitialGrantPending(user)) {
        pendingInitialGrantUsers++;
        continue;
      }
      const state = await readSignupCreditIssueState(client, user);
      if (state.marker < state.issued) markerBehindUsers++;
      if (state.recoveredLegacyWithoutLedger) recoveredLegacyWithoutLedger++;
      if (state.anomalies.length > 0) {
        anomalyUsers++;
        continue;
      }
      if (state.issued > TRIAL_CREDITS) {
        overTargetUsers++;
        continue;
      }
      if (state.issued === TRIAL_CREDITS) {
        atTargetUsers++;
        candidates.push({ user, issued: state.issued, delta: 0, marker: state.marker });
        continue;
      }
      candidates.push({
        user,
        issued: state.issued,
        delta: TRIAL_CREDITS - state.issued,
        marker: state.marker,
      });
    }
    const pending = candidates.filter((item) => item.delta > 0);
    const pendingCredits = pending.reduce((sum, item) => sum + item.delta, 0);
    const eligibleUsers =
      users.length - excludedTestUsers - excludedSystemAdmins -
      excludedSyntheticUsers - excludedUnregisteredUsers - pendingInitialGrantUsers;
    const eligibleIds = users.filter(isSignupCreditEligible).map((user) => user.id);
    const beforeBonusSum = users.reduce(
      (sum, user) => sum + (isSignupCreditEligible(user) ? Number(user.bonus_credits ?? 0) : 0),
      0
    );
    const markerRow = (
      await client.query<{ value: string }>("SELECT value FROM app_settings WHERE key=$1", [
        SIGNUP_CREDIT_MIGRATION_KEY,
      ])
    ).rows[0];
    const upgradeTotalsBefore = await readUpgradeTotals(client);
    const markerValid = validMigrationMarker(markerRow?.value, upgradeTotalsBefore);

    if (mode === "verify") {
      const duplicateUpgradeUsers = Number(
        (
          await client.query(
            `SELECT COUNT(*)::BIGINT AS n FROM (
               SELECT user_id FROM credit_ledger
                WHERE op=$1 GROUP BY user_id HAVING COUNT(*)>1
             ) duplicated`,
            [SIGNUP_CREDIT_UPGRADE_OP]
          )
        ).rows[0]?.n ?? 0
      );
      return {
        mode,
        targetCredits: TRIAL_CREDITS,
        totalUsers: users.length,
        eligibleUsers,
        excludedTestUsers,
        excludedSystemAdmins,
        excludedSyntheticUsers,
        excludedUnregisteredUsers,
        pendingInitialGrantUsers,
        pendingUsers: pending.length,
        pendingCredits,
        atTargetUsers,
        overTargetUsers,
        markerBehindUsers,
        recoveredLegacyWithoutLedger,
        anomalyUsers,
        appliedUsers: 0,
        appliedCredits: 0,
        markerSyncedUsers: 0,
        beforeBonusSum,
        afterBonusSum: beforeBonusSum,
        remainingPendingUsers: pending.length,
        duplicateUpgradeUsers,
        migrationMarkerValid: markerValid,
      };
    }

    if (!apply) {
      return {
        mode,
        targetCredits: TRIAL_CREDITS,
        totalUsers: users.length,
        eligibleUsers,
        excludedTestUsers,
        excludedSystemAdmins,
        excludedSyntheticUsers,
        excludedUnregisteredUsers,
        pendingInitialGrantUsers,
        pendingUsers: pending.length,
        pendingCredits,
        atTargetUsers,
        overTargetUsers,
        markerBehindUsers,
        recoveredLegacyWithoutLedger,
        anomalyUsers,
        appliedUsers: 0,
        appliedCredits: 0,
        markerSyncedUsers: 0,
        beforeBonusSum,
        afterBonusSum: beforeBonusSum,
        remainingPendingUsers: pending.length,
        duplicateUpgradeUsers: 0,
        migrationMarkerValid: markerValid,
      };
    }

    if (anomalyUsers > 0) {
      throw new Error(`检测到 ${anomalyUsers} 个注册送积分账本异常账号，已拒绝自动补发`);
    }
    if (pendingInitialGrantUsers > 0) {
      throw new Error(`检测到 ${pendingInitialGrantUsers} 个注册发放中的账号，请稍后重新 dry-run`);
    }
    if (markerRow && pending.length > 0) {
      throw new Error("迁移审计 marker 已存在但仍有待补账号，已拒绝继续发放");
    }
    if (markerRow && !markerValid) {
      throw new Error("迁移审计 marker 与实际升级流水不一致，已拒绝继续发放");
    }
    const releaseSha = (process.env.RELEASE_SHA ?? "").trim();
    if (!/^[a-f0-9]{7,40}$/i.test(releaseSha)) {
      throw new Error("apply 必须提供当前候选的 RELEASE_SHA");
    }
    if (options.expectedUsers != null && options.expectedUsers !== pending.length) {
      throw new Error(`待补人数已变化：预期 ${options.expectedUsers}，实际 ${pending.length}`);
    }
    if (options.expectedCredits != null && options.expectedCredits !== pendingCredits) {
      throw new Error(`待补积分已变化：预期 ${options.expectedCredits}，实际 ${pendingCredits}`);
    }

    let markerSyncedUsers = 0;
    for (const candidate of candidates) {
      if (candidate.delta === 0) {
        if (candidate.marker < candidate.issued) {
          const synced = await client.query(
            `UPDATE users SET signup_credits_granted=$1
              WHERE id=$2 AND signup_credits_granted<$1`,
            [candidate.issued, candidate.user.id]
          );
          markerSyncedUsers += synced.rowCount ?? 0;
        }
        continue;
      }
      const now = Date.now();
      const inserted = await client.query(
        `INSERT INTO credit_ledger (user_id,op,credits,bonus,plan_credits,ts,note)
         VALUES($1,$2,$3,$3,0,$4,$5)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          candidate.user.id,
          SIGNUP_CREDIT_UPGRADE_OP,
          -candidate.delta,
          now,
          `注册送积分升级补发 ${candidate.delta} 积分，累计 ${TRIAL_CREDITS} 积分`,
        ]
      );
      if (inserted.rowCount !== 1) {
        throw new Error("补发流水幂等冲突，事务已回滚");
      }
      await client.query(
        `UPDATE users
            SET bonus_credits=bonus_credits+$1,
                signup_credits_granted=$2
          WHERE id=$3`,
        [candidate.delta, TRIAL_CREDITS, candidate.user.id]
      );
    }

    const afterBonusSum = Number(
      (
        await client.query(
          `SELECT COALESCE(SUM(bonus_credits),0)::BIGINT AS n
             FROM users WHERE id=ANY($1::text[])`,
          [eligibleIds]
        )
      ).rows[0]?.n ?? 0
    );
    if (afterBonusSum - beforeBonusSum !== pendingCredits) {
      throw new Error("补发前后余额增量与预期不一致，事务已回滚");
    }
    const upgradeTotalsAfter = await readUpgradeTotals(client);
    if (upgradeTotalsAfter.invalidRows > 0) {
      throw new Error("升级补发流水形态异常，事务已回滚");
    }
    await client.query(
      `INSERT INTO app_settings(key,value,updated_at)
       VALUES($1,$2,$3)
       ON CONFLICT(key) DO NOTHING`,
      [
        SIGNUP_CREDIT_MIGRATION_KEY,
        JSON.stringify({
          users: upgradeTotalsAfter.users,
          credits: upgradeTotalsAfter.credits,
          target: TRIAL_CREDITS,
          eligibleUsers,
          excludedTestUsers,
          excludedSystemAdmins,
          excludedSyntheticUsers,
          excludedUnregisteredUsers,
          recoveredLegacyWithoutLedger,
          beforeBonusSum,
          afterBonusSum,
          appliedAt: Date.now(),
          release: releaseSha,
        }),
        Date.now(),
      ]
    );
    const persistedMarker = (
      await client.query<{ value: string }>("SELECT value FROM app_settings WHERE key=$1", [
        SIGNUP_CREDIT_MIGRATION_KEY,
      ])
    ).rows[0];
    const persistedMarkerValid = validMigrationMarker(
      persistedMarker?.value,
      upgradeTotalsAfter
    );
    if (!persistedMarkerValid) throw new Error("迁移审计 marker 缺失或格式无效，事务已回滚");
    await client.query("COMMIT");

    return {
      mode,
      targetCredits: TRIAL_CREDITS,
      totalUsers: users.length,
      eligibleUsers,
      excludedTestUsers,
      excludedSystemAdmins,
      excludedSyntheticUsers,
      excludedUnregisteredUsers,
      pendingInitialGrantUsers,
      pendingUsers: pending.length,
      pendingCredits,
      atTargetUsers,
      overTargetUsers,
      markerBehindUsers: 0,
      recoveredLegacyWithoutLedger,
      anomalyUsers,
      appliedUsers: pending.length,
      appliedCredits: pendingCredits,
      markerSyncedUsers,
      beforeBonusSum,
      afterBonusSum,
      remainingPendingUsers: 0,
      duplicateUpgradeUsers: 0,
      migrationMarkerValid: true,
    };
  } catch (error) {
    if (apply) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
