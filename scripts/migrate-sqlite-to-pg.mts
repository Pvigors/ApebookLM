// SQLite → PostgreSQL 数据迁移(PG 迁移 阶段5)。已是历史脚本 —— 生产早已迁完。
//
// ⚠️ better-sqlite3 已从依赖里移除:它在应用代码里没有任何真实引用(只剩历史注释),
// 却每次构建都要编译原生模块,而 node-gyp 取 node 头文件、prebuild-install 取预编译包
// 走的都是境外源 —— 国内构建曾因此长时间挂死。真要再跑这个脚本,临时装一次即可:
//   npm i -D better-sqlite3 && npx tsx scripts/migrate-sqlite-to-pg.mts && npm un better-sqlite3
// 用法:DATABASE_URL=postgres://... SQLITE_PATH=.data/notebooklm.db npx tsx scripts/migrate-sqlite-to-pg.mts
// 幂等:每表 INSERT ... ON CONFLICT DO NOTHING(重跑不重复;演示账号 seed 冲突也被跳过)。
// embedding:SQLite 返回 Buffer,pg 的 bytea 直接收 Buffer,逐字节保真。
import Database from "better-sqlite3";
import { getPool } from "../lib/pg.ts";
import { initSchema } from "../lib/db.ts";

// FK 依赖顺序:被引用的表先迁。
const TABLES = [
  "users", "notebooks", "sources", "chunks", "messages", "notes",
  "studio_outputs", "sessions", "notebook_collaborators", "jobs",
  "notifications", "app_settings", "ai_calls", "usage_daily",
  "activity_log", "feedback", "user_usage", "credit_ledger", "referrals",
];
// BIGSERIAL 表:id 由 PG 生成,迁移时【显式带上原 id】保持引用一致,迁完重置序列。
const SERIAL_TABLES = new Set(["ai_calls", "activity_log", "credit_ledger"]);

const SQLITE = process.env.SQLITE_PATH || ".data/notebooklm.db";

async function main() {
  const sq = new Database(SQLITE, { readonly: true });
  const pool = getPool();
  await initSchema(); // 确保 PostgreSQL schema 就位。

  const sqTables = new Set(
    sq.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name)
  );

  let grand = 0;
  for (const t of TABLES) {
    if (!sqTables.has(t)) { console.log(`- ${t}: SQLite 无此表,跳过`); continue; }
    const rows = sq.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
    if (rows.length === 0) { console.log(`- ${t}: 0 行`); continue; }
    // 只迁移【两边都有】的列。SQLite 里可能残留已废弃功能的死列(如 users.memory_enabled,
    // 记忆功能已删但旧库还留着列),PG schema 已不含,按交集迁移并记录丢弃项。
    const pgColsRes = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
      [t]
    );
    const pgCols = new Set(pgColsRes.rows.map((r) => r.column_name as string));
    const allCols = Object.keys(rows[0]);
    const cols = allCols.filter((c) => pgCols.has(c));
    const dropped = allCols.filter((c) => !pgCols.has(c));
    if (dropped.length) console.log(`  · ${t} 丢弃 PG 无此列的遗留列: ${dropped.join(", ")}`);
    const client = await pool.connect();
    let inserted = 0;
    try {
      await client.query("BEGIN");
      for (const row of rows) {
        const vals = cols.map((c) => row[c]); // embedding 是 Buffer → bytea 直接收
        const ph = cols.map((_, i) => `$${i + 1}`).join(",");
        const r = await client.query(
          `INSERT INTO ${t} (${cols.join(",")}) VALUES (${ph}) ON CONFLICT DO NOTHING`,
          vals
        );
        inserted += r.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`✗ ${t} 迁移失败:`, (e as Error).message);
      throw e;
    } finally {
      client.release();
    }
    // BIGSERIAL 序列重置到当前 max(id),避免后续自增撞已迁入的 id。
    if (SERIAL_TABLES.has(t)) {
      await pool.query(
        `SELECT setval(pg_get_serial_sequence('${t}','id'), COALESCE((SELECT MAX(id) FROM ${t}),1))`
      );
    }
    console.log(`✓ ${t}: ${rows.length} 行读入 → ${inserted} 行写入(冲突跳过 ${rows.length - inserted})`);
    grand += inserted;
  }
  sq.close();
  console.log(`\n迁移完成:共写入 ${grand} 行。`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
