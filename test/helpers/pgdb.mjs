// PG 测试库助手(PG 迁移 阶段4)。
// 旧范式:每个测试设 NBLM_DB_PATH 指向 tmp sqlite 文件。lib/db 迁 PG 后 sqlite 已废,
// 改为:每个测试文件独占一个【新建的 PG 库】nblm_test_<tag>,initSchema 建表后返回 db 模块。
// 隔离原理:node --test 每个文件跑在独立进程,进程内设 DATABASE_URL 再 import lib/db 即生效,
// 各文件 tag 唯一 → 并行安全、互不污染。after() 里断连+drop 库,自我清理(DROP IF EXISTS 幂等重跑)。
// CI 里配 PG_ADMIN_URL 指向有 CREATEDB 权限的维护库(默认本地 postgres)。
import { after } from "node:test";
import pg from "pg";

const ADMIN_URL = process.env.PG_ADMIN_URL || "postgres://localhost:5432/postgres";
const hostFor = (name) => {
  // 从 ADMIN_URL 派生同主机的目标库 URL(替换末段 dbname),保证 CI/本地一致。
  const u = new URL(ADMIN_URL);
  u.pathname = "/" + name;
  return u.toString();
};

async function admin() {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  return c;
}
async function dropDb(name) {
  const c = await admin();
  try {
    // 先踢掉残留连接(否则 DROP 报 "being accessed by other users")。
    await c.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
      [name]
    );
    await c.query(`DROP DATABASE IF EXISTS ${name}`);
  } finally {
    await c.end();
  }
}

/**
 * 为当前测试文件建一个全新 PG 库并初始化 schema,返回 lib/db 模块(全 async)。
 * @param {string} tag 该测试文件的唯一短名(如 "pin"、"usage"),用作库名后缀。
 */
export async function freshPgDb(tag) {
  const name = `nblm_test_${tag}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  await dropDb(name); // 清掉上次残留
  const c = await admin();
  try {
    await c.query(`CREATE DATABASE ${name}`);
  } finally {
    await c.end();
  }

  process.env.DATABASE_URL = hostFor(name);
  // 清掉可能被复用的旧池(同进程再次调用时),确保新池连到本测试库。
  const g = /** @type {{ __nblm_pg?: { end: () => Promise<void> } }} */ (globalThis);
  if (g.__nblm_pg) { try { await g.__nblm_pg.end(); } catch {} delete g.__nblm_pg; }

  const db = await import("../../lib/db.ts");
  await db.initSchema();

  after(async () => {
    if (g.__nblm_pg) { try { await g.__nblm_pg.end(); } catch {} delete g.__nblm_pg; }
    await dropDb(name);
  });

  return db;
}

/**
 * 把用户退回「未获发注册试用」的状态:free 档、零余额、零到期。
 *
 * 背景:注册赠送试用(lib/db.ts 的 grantSignupTrial)是后加的产品行为,新用户从此
 * 自带 trial 档 + 200 赠送积分。大量既有测试建完用户就直接断言余额、档位或积分增量,
 * 它们要验的是别的东西(邀请返利、扣费原子性、退款补偿),不该被这 200 分干扰。
 * 需要验试用本身的用例在 test/usage/signup-trial.test.mjs。
 */
export async function withoutTrial(userId) {
  const { getPool } = await import("../../lib/pg.ts");
  const pool = getPool();
  await pool.query(
    "UPDATE users SET plan_tier='free', plan_expires_at=0, bonus_credits=0, trial_granted_at=0, signup_credits_granted=0, trial_expires_at=0 WHERE id=$1",
    [userId]
  );
  // 发放同时会往 credit_ledger 写一条 bonus:trial。只清余额不清这条,
  // 台账类断言(条数、筛选、倒序)照样会被它顶偏一位。
  await pool.query(
    "DELETE FROM credit_ledger WHERE user_id=$1 AND op IN ('bonus:trial','bonus:signup:upgrade:200:v1')",
    [userId]
  );
}
