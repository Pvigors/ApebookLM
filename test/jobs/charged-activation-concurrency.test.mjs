import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("charged_activation_concurrency");
const { getPool } = await import("../../lib/pg.ts");

test("不同请求并发入队时，事务门禁最多只激活 3 个任务并扣 3 次积分", async () => {
  const user = await db.createUserByEmail(`m9-${Date.now()}@example.com`, "M9 并发验收");
  const notebook = await db.createNotebook(user.id, "M9 并发验收", "📐");
  const drafts = await Promise.all(Array.from({ length: 8 }, (_, index) => (
    db.createJob(
      notebook.id,
      user.id,
      "cad",
      `CAD 并发 ${index + 1}`,
      { cadIdempotencyKey: `0000000${index + 1}-0000-4000-8000-00000000000${index + 1}` },
      0,
      null,
      "draft"
    )
  )));

  const results = await Promise.all(drafts.map((draft) => (
    db.activateChargedJob(draft.id, user.id, "studio:cad", 5, notebook.title, 3)
  )));

  assert.equal(results.filter((result) => !!result.job).length, 3);
  assert.equal(results.filter((result) => result.activeLimitExceeded === true).length, 5);
  const state = await getPool().query(
    `SELECT
       (SELECT COUNT(*) FROM jobs WHERE user_id=$1 AND status IN ('queued','running'))::int AS active,
       (SELECT COUNT(*) FROM jobs WHERE user_id=$1 AND status='draft')::int AS drafts,
       (SELECT COUNT(*) FROM credit_ledger WHERE user_id=$1 AND op='studio:cad')::int AS charges`,
    [user.id]
  );
  assert.deepEqual(state.rows[0], { active: 3, drafts: 0, charges: 3 });
});
