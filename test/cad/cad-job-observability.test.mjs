import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("cad_job_observability");
const { getPool } = await import("../../lib/pg.ts");

test("CAD 车道、真实阶段和终态时间可持久聚合，旧任务保持兼容", async () => {
  const pool = getPool();
  const user = await db.createUserByEmail("cad-observability@example.com", "CAD 可观测");
  const notebook = await db.createNotebook(user.id, "CAD 可观测", "📐");
  const base = Date.now() - 10_000;

  // 模拟迁移前的终态行：新列不在 INSERT 中，必须由默认值安全读取。
  const legacyId = `legacy-cad-observe-${Date.now()}`;
  await pool.query(
    `INSERT INTO jobs
       (id,notebook_id,user_id,kind,title,status,progress,params,output_id,error,
        created_at,updated_at,run_attempt,priority,credits_reserved,credits_final,tokens_in,tokens_out)
     VALUES ($1,$2,$3,'cad','旧 CAD','done',100,'{}',NULL,NULL,$4,$4,0,0,0,0,0,0)`,
    [legacyId, notebook.id, user.id, base]
  );
  const legacy = await db.getJob(legacyId);
  assert.equal(legacy?.lane, null);
  assert.equal(legacy?.started_at, 0);
  assert.equal(legacy?.finished_at, 0);
  assert.equal(legacy?.stage, null);
  assert.equal(legacy?.stage_started_at, 0);

  const doneDraft = await db.createJob(notebook.id, user.id, "cad", "CAD 成功", {}, 10);
  const doneRun = await db.claimNextQueued("cad");
  assert.equal(doneRun?.id, doneDraft.id);
  assert.equal(doneRun?.lane, "cad");
  assert.ok(Number(doneRun?.started_at) >= Number(doneRun?.created_at));
  assert.equal(doneRun?.finished_at, 0);
  assert.equal(doneRun?.stage, "starting");
  assert.equal(doneRun?.stage_started_at, doneRun?.started_at);

  const specAt = Date.now();
  assert.equal(await db.updateJobForRun(doneRun.id, doneRun.run_attempt, {
    progress: 50,
    stage: "validating_spec",
    stage_started_at: specAt,
  }), true);
  assert.equal((await db.getJob(doneRun.id))?.stage, "validating_spec");
  assert.equal(await db.finalizeJobDone(doneRun.id, null, undefined, doneRun.run_attempt), true);
  const completed = await db.getJob(doneRun.id);
  assert.equal(completed?.status, "done");
  assert.equal(completed?.stage, "completed");
  assert.ok(Number(completed?.finished_at) >= Number(completed?.started_at));

  const errorDraft = await db.createJob(notebook.id, user.id, "cad", "CAD 失败", {}, 5);
  const errorRun = await db.claimNextQueued("cad");
  assert.equal(errorRun?.id, errorDraft.id);
  const stepAt = Date.now();
  assert.equal(await db.updateJobForRun(errorRun.id, errorRun.run_attempt, {
    progress: 84,
    stage: "validating_step",
    stage_started_at: stepAt,
  }), true);
  assert.equal(await db.failJobAndQueueRefund(
    errorRun.id,
    errorRun.run_attempt,
    "STEP 回读失败",
    undefined,
    { code: "cad_step_roundtrip_failed", stage: "validating_step" }
  ), true);
  const failed = await db.getJob(errorRun.id);
  assert.equal(failed?.status, "error");
  assert.equal(failed?.stage, "validating_step");
  assert.ok(Number(failed?.finished_at) >= Number(failed?.started_at));

  const canceled = await db.createJob(notebook.id, user.id, "cad", "CAD 取消", {}, 0);
  assert.equal(await db.cancelJobAndQueueRefund(canceled.id), true);
  const canceledRow = await db.getJob(canceled.id);
  assert.equal(canceledRow?.status, "canceled");
  assert.equal(canceledRow?.started_at, 0);
  assert.ok(Number(canceledRow?.finished_at) > 0);

  const nonCad = await db.createJob(notebook.id, user.id, "quiz", "测验", {}, 0);
  const nonCadRun = await db.claimNextQueued("non_cad");
  assert.equal(nonCadRun?.id, nonCad.id);
  assert.equal(nonCadRun?.lane, "non_cad");
  assert.equal(nonCadRun?.stage, null);
  assert.equal(await db.cancelJobAndQueueRefund(nonCadRun.id), true);

  // 固定时间样本，证明聚合计算的是持久边界，不是墙上进度估算。
  await pool.query(
    "UPDATE jobs SET created_at=$1,started_at=$2,finished_at=$3,lane='cad' WHERE id=$4",
    [base + 1_000, base + 1_100, base + 1_500, doneRun.id]
  );
  await pool.query(
    "UPDATE jobs SET created_at=$1,started_at=$2,finished_at=$3,lane='cad' WHERE id=$4",
    [base + 2_000, base + 2_200, base + 3_000, errorRun.id]
  );
  await pool.query(
    "UPDATE jobs SET created_at=$1,started_at=0,finished_at=$2,lane=NULL WHERE id=$3",
    [base + 3_500, base + 3_600, canceled.id]
  );

  const summary = await db.getCadJobObservabilitySummary(base - 1);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.byStatus, { canceled: 1, done: 2, error: 1 });
  assert.deepEqual(summary.byFailureCode, { cad_step_roundtrip_failed: 1 });
  assert.deepEqual(summary.byLane, { cad: 2, unknown: 2 });
  assert.deepEqual(summary.queueWaitMs, { count: 2, avg: 150, p50: 150, p95: 195, max: 200 });
  assert.deepEqual(summary.runDurationMs, { count: 2, avg: 600, p50: 600, p95: 780, max: 800 });

  const jobsSource = readFileSync(new URL("../../lib/jobs.ts", import.meta.url), "utf8");
  assert.match(
    jobsSource,
    /advances[\s\S]{0,220}progress:\s*nextProgress,\s*stage,\s*stage_started_at:\s*Date\.now\(\)/,
    "CAD worker 必须在真实阶段前进时原子写 stage 和开始时间"
  );
});
