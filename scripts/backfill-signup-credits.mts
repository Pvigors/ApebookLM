/**
 * 注册赠送积分存量补发。生产必须先 dry-run，再把精确人数/积分作为 apply 门禁传回。
 *
 * npx tsx scripts/backfill-signup-credits.mts --dry-run
 * RELEASE_SHA=<commit> npx tsx scripts/backfill-signup-credits.mts --apply \
 *   --confirm-database <db> --confirm-target <host:port/db> \
 *   --expected-users N --expected-credits M
 * npx tsx scripts/backfill-signup-credits.mts --verify
 */
import { getPool } from "../lib/pg.ts";
import { runSignupCreditMigration } from "../lib/signup-credits-migration.ts";

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const stringValueOf = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = String(args[index + 1] ?? "").trim();
  if (!value) throw new Error(`${flag} 缺少值`);
  return value;
};
const valueOf = (flag: string): number | undefined => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = Number(args[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${flag} 必须是非负整数`);
  return value;
};

let requestedMode = "dry-run";

async function main(): Promise<void> {
  const selected = [has("--dry-run"), has("--apply"), has("--verify")].filter(Boolean).length;
  if (selected > 1) throw new Error("--dry-run、--apply、--verify 只能选择一个");
  const mode = has("--apply") ? "apply" : has("--verify") ? "verify" : "dry-run";
  requestedMode = mode;
  const expectedUsers = valueOf("--expected-users");
  const expectedCredits = valueOf("--expected-credits");
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) throw new Error("必须显式设置 DATABASE_URL，禁止回落到本地默认库");
  let databaseName = "";
  let targetIdentity = "";
  try {
    const parsed = new URL(databaseUrl);
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    targetIdentity = `${parsed.hostname}:${parsed.port || "5432"}/${databaseName}`;
  } catch {
    throw new Error("DATABASE_URL 格式无效");
  }
  if (!databaseName) throw new Error("DATABASE_URL 必须包含明确数据库名");
  if (mode === "apply" && (expectedUsers == null || expectedCredits == null)) {
    throw new Error("--apply 必须同时提供 dry-run 得到的 --expected-users 与 --expected-credits");
  }
  if (mode === "apply" && stringValueOf("--confirm-database") !== databaseName) {
    throw new Error(`--apply 必须使用 --confirm-database ${databaseName} 明确确认目标库`);
  }
  if (mode === "apply" && stringValueOf("--confirm-target") !== targetIdentity) {
    throw new Error(`--apply 必须使用 --confirm-target ${targetIdentity} 确认主机、端口与数据库`);
  }
  if (mode === "apply" && !/^[a-f0-9]{7,40}$/i.test((process.env.RELEASE_SHA ?? "").trim())) {
    throw new Error("--apply 必须显式设置当前候选的 RELEASE_SHA");
  }

  const pool = getPool();
  try {
    const summary = await runSignupCreditMigration(pool, { mode, expectedUsers, expectedCredits });
    console.log(JSON.stringify({ ok: true, database: databaseName, target: targetIdentity, ...summary }));
    if (
      mode === "verify" &&
      (
        summary.remainingPendingUsers > 0 ||
        summary.anomalyUsers > 0 ||
        summary.duplicateUpgradeUsers > 0 ||
        summary.overTargetUsers > 0 ||
        summary.markerBehindUsers > 0 ||
        summary.pendingInitialGrantUsers > 0 ||
        !summary.migrationMarkerValid
      )
    ) {
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      mode: requestedMode,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exitCode = 1;
});
