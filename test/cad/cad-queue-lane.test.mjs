import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("cad_queue_lane");

test("CAD 与非 CAD 任务由独立 claim 车道认领", async () => {
  const user = await db.createUserByEmail("cad-lane@example.com", "CAD 车道");
  const notebook = await db.createNotebook(user.id, "CAD 车道", "📐");
  const cad = await db.createJob(notebook.id, user.id, "cad", "CAD", { sourceIds: ["s"] }, 100);
  const quiz = await db.createJob(notebook.id, user.id, "quiz", "测验", { sourceIds: ["s"] }, 0);

  const nonCadClaim = await db.claimNextQueued("non_cad");
  assert.equal(nonCadClaim?.id, quiz.id, "CAD 即使优先级更高也不得阻塞非 CAD 车道");
  assert.equal(nonCadClaim?.run_attempt, 1);

  const cadClaim = await db.claimNextQueued("cad");
  assert.equal(cadClaim?.id, cad.id);
  assert.equal(cadClaim?.run_attempt, 1);
  assert.equal(await db.claimNextQueued("cad"), undefined);
  assert.equal(await db.claimNextQueued("non_cad"), undefined);
});

test("any 保留旧调用方的全局认领语义", async () => {
  const user = await db.createUserByEmail("cad-lane-any@example.com", "CAD 兼容车道");
  const notebook = await db.createNotebook(user.id, "CAD any", "📐");
  const job = await db.createJob(notebook.id, user.id, "briefing", "简报", {}, 0);
  assert.equal((await db.claimNextQueued())?.id, job.id);
});
