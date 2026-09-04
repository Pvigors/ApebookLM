import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("job_run_attempt");

test("数据库 run_attempt：旧跑不能写新跑的进度、产物、重排或终态", async () => {
  const user = await db.createUserByEmail("run-attempt@example.com", "任务栅栏");
  const notebook = await db.createNotebook(user.id, "任务栅栏本", "🧱");
  const job = await db.createJob(notebook.id, user.id, "briefing", "简报", {});

  const first = await db.claimNextQueued();
  assert.equal(first.id, job.id);
  assert.equal(first.run_attempt, 1);
  const firstOutput = await db.createStudioOutputForRun(
    job.id, first.run_attempt, notebook.id, "briefing", "旧跑产物", "old"
  );
  assert.ok(firstOutput);
  assert.equal((await db.listStudioOutputs(notebook.id)).length, 0, "processing 产物不得提前公开");
  assert.equal(await db.requeueJobForRetry(job.id, first.run_attempt), true);

  const second = await db.claimNextQueued();
  assert.equal(second.id, job.id);
  assert.equal(second.run_attempt, 2);
  assert.equal(await db.updateJobForRun(job.id, first.run_attempt, { progress: 88 }), false);
  assert.equal(await db.requeueJobForRetry(job.id, first.run_attempt), false);
  assert.equal(
    await db.createStudioOutputForRun(
      job.id, first.run_attempt, notebook.id, "briefing", "越权旧产物", "stale"
    ),
    undefined
  );
  assert.equal(await db.finalizeJobDone(job.id, firstOutput.id, undefined, first.run_attempt), false);

  const secondOutput = await db.createStudioOutputForRun(
    job.id, second.run_attempt, notebook.id, "briefing", "新跑产物", "fresh"
  );
  assert.ok(secondOutput);
  assert.equal((await db.listStudioOutputs(notebook.id)).length, 0);
  assert.equal(await db.finalizeJobDone(job.id, secondOutput.id, undefined, second.run_attempt), true);
  const done = await db.getJob(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.output_id, secondOutput.id);
  assert.equal(done.run_attempt, 2);
  assert.deepEqual((await db.listStudioOutputs(notebook.id)).map((out) => out.id), [secondOutput.id]);

  await db.deleteStudioOutput(firstOutput.id);
});

test("processing 产物被删后 finalize 必须失败，不能完成空任务", async () => {
  const user = await db.createUserByEmail("missing-output@example.com", "空产物守卫");
  const notebook = await db.createNotebook(user.id, "空产物守卫本", "🕳️");
  const job = await db.createJob(notebook.id, user.id, "briefing", "简报", {});
  const run = await db.claimNextQueued();
  const output = await db.createStudioOutputForRun(
    job.id, run.run_attempt, notebook.id, "briefing", "待删", "processing"
  );
  assert.ok(output);
  await db.deleteStudioOutput(output.id);
  assert.equal(await db.finalizeJobDone(job.id, output.id, undefined, run.run_attempt), false);
  assert.equal((await db.getJob(job.id)).status, "running", "失败后留给孤儿恢复重排，不能假 done");
});
