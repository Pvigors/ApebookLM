import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("message_order_migration");
const { getPool } = await import("../../lib/pg.ts");

test("存量 messages 表没有 message_seq 时，幂等启动迁移能补列、回填并建稳定顺序索引", async () => {
  const pool = getPool();
  await pool.query("DROP INDEX IF EXISTS idx_messages_stable_order");
  await pool.query("ALTER TABLE messages DROP COLUMN message_seq");
  await db.initSchema();

  const column = (await pool.query(
    `SELECT is_nullable,column_default
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='messages' AND column_name='message_seq'`
  )).rows[0];
  assert.ok(column, "迁移必须补出 message_seq");
  assert.match(String(column.column_default), /nextval/);
  const index = (await pool.query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='idx_messages_stable_order'"
  )).rows[0];
  assert.match(String(index?.indexdef), /notebook_id, created_at, message_seq/);
});
