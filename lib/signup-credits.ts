import type { PoolClient } from "pg";
import { isSystemAdminUser } from "./admin-identity";
import { TRIAL_CREDITS } from "./plans";
import type { User } from "./types";

/** 200 分升级前的历史注册送额度，只用于缺失旧流水时的保守恢复。 */
export const LEGACY_SIGNUP_CREDITS = 100;
/** 版本化操作名同时承担账本审计与唯一索引幂等键。 */
export const SIGNUP_CREDIT_UPGRADE_OP = `bonus:signup:upgrade:${TRIAL_CREDITS}:v1`;
export const SIGNUP_CREDIT_MIGRATION_KEY = `migration.signup_credits_${TRIAL_CREDITS}.v1`;
const SYNTHETIC_USER_IDS = new Set([
  "system-0000-0000-0000-000000000000",
]);

export type SignupCreditIssueState = {
  issued: number;
  marker: number;
  ledgerIssued: number;
  initialCount: number;
  upgradeCount: number;
  recoveredLegacyWithoutLedger: boolean;
  anomalies: string[];
};

/**
 * 注册赠送面向真实注册用户；测试专用账号和系统管理员不参与赠送。
 * disabled 仍属于注册用户，operator/auditor 也没有特殊豁免，二者均正常补发。
 */
export function isSyntheticSignupCreditUser(user: User | null | undefined): boolean {
  return !!user && SYNTHETIC_USER_IDS.has(user.id);
}

export function hasSignupRegistrationEvidence(user: User | null | undefined): boolean {
  return !!user && Boolean(
    user.phone?.trim() ||
    user.email?.trim() ||
    user.wechat_openid?.trim() ||
    Number(user.trial_granted_at ?? 0) > 0 ||
    Number(user.signup_credits_granted ?? 0) > 0
  );
}

/** 用户行已创建但首次赠送事务尚未完成；显式存量迁移必须等待该状态收敛。 */
export function isSignupInitialGrantPending(user: User | null | undefined): boolean {
  return !!user &&
    Number(user.trial_granted_at ?? 0) === 0 &&
    Number(user.trial_expires_at ?? 0) > 0;
}

export function isSignupCreditSystemAdmin(user: User | null | undefined): boolean {
  if (!user) return false;
  // disabled 会让 adminRoleOf 返回 null，因此额外按持久 DB 角色排除已停用的 super。
  const persistentSuper =
    Number(user.is_admin ?? 0) === 1 &&
    (user.admin_role == null || user.admin_role === "super");
  return persistentSuper || isSystemAdminUser(user);
}

export function isSignupCreditEligible(user: User | null | undefined): user is User {
  return !!user &&
    user.plan_tier !== "test" &&
    !isSyntheticSignupCreditUser(user) &&
    !isSignupCreditSystemAdmin(user) &&
    hasSignupRegistrationEvidence(user);
}

/**
 * 从单调 marker 与注册送专属流水重建累计发行额；绝不读取 bonus_credits 当前余额。
 * 调用方必须先锁定 users 行，保证补发与消费遵循同一 users → ledger 锁序。
 */
export async function readSignupCreditIssueState(
  client: PoolClient,
  user: User
): Promise<SignupCreditIssueState> {
  const row = (
    await client.query<{
      initial_count: number;
      upgrade_count: number;
      ledger_issued: number;
      invalid_count: number;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE op = 'bonus:trial')::BIGINT AS initial_count,
         COUNT(*) FILTER (WHERE op = $2)::BIGINT AS upgrade_count,
         COALESCE(SUM(CASE WHEN bonus < 0 THEN -bonus ELSE 0 END), 0)::BIGINT AS ledger_issued,
         COUNT(*) FILTER (
           WHERE bonus >= 0
              OR credits <> bonus
              OR plan_credits IS DISTINCT FROM 0
              OR (op = 'bonus:trial' AND -bonus NOT IN ($3, $4))
         )::BIGINT AS invalid_count
       FROM credit_ledger
      WHERE user_id = $1 AND op IN ('bonus:trial', $2)`,
      [user.id, SIGNUP_CREDIT_UPGRADE_OP, LEGACY_SIGNUP_CREDITS, TRIAL_CREDITS]
    )
  ).rows[0];

  const marker = Math.max(0, Number(user.signup_credits_granted ?? 0));
  const initialCount = Number(row?.initial_count ?? 0);
  const upgradeCount = Number(row?.upgrade_count ?? 0);
  const ledgerIssued = Math.max(0, Number(row?.ledger_issued ?? 0));
  // trial_granted_at 与旧 bonus:trial 在同一事务落库；旧流水被人工清理时，时间戳仍是
  // “历史确实发过 100”的持久证据。该推断在补发后也必须持续参与重建，否则 verify
  // 只看到 upgrade -100，会误判为一笔不完整升级。
  const inferredLegacyCredits =
    initialCount === 0 &&
    Number(user.trial_granted_at ?? 0) > 0 &&
    ledgerIssued < TRIAL_CREDITS
      ? LEGACY_SIGNUP_CREDITS
      : 0;
  const recoveredLegacyWithoutLedger = inferredLegacyCredits > 0;
  const reconstructedLedgerIssued = ledgerIssued + inferredLegacyCredits;
  const issued = Math.max(marker, reconstructedLedgerIssued);
  const anomalies: string[] = [];
  if (Number(row?.invalid_count ?? 0) > 0) anomalies.push("invalid-ledger-shape");
  if (initialCount > 1) anomalies.push("duplicate-initial-grant");
  if (upgradeCount > 1) anomalies.push("duplicate-upgrade-grant");
  if (upgradeCount > 0 && reconstructedLedgerIssued !== TRIAL_CREDITS) {
    anomalies.push("incomplete-upgrade-ledger");
  }
  if (marker > reconstructedLedgerIssued) anomalies.push("marker-ahead-of-ledger");
  return {
    issued,
    marker,
    ledgerIssued,
    initialCount,
    upgradeCount,
    recoveredLegacyWithoutLedger,
    anomalies,
  };
}
