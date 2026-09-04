import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("cad_failure_card");
const { getPool } = await import("../../lib/pg.ts");
const studioRoute = await import("../../app/api/notebooks/[id]/studio/route.ts");

test("CAD 失败阶段、错误码与退款状态仅保留为后台审计", async () => {
  const user = await db.createUserByEmail("cad-failure-card@example.com", "CAD 失败卡");
  const notebook = await db.createNotebook(user.id, "CAD 失败卡", "📐");
  const token = await db.createSession(user.id);
  const ready = await db.createStudioOutput(notebook.id, "cad", "已完成 CAD", "{}", "{}");
  const draft = await db.createJob(notebook.id, user.id, "cad", "CAD", {}, 0, null, "draft");
  const activated = await db.activateChargedJob(draft.id, user.id, "studio:cad", 12, notebook.title);
  assert.equal(activated.over, false);
  assert.ok(activated.ledgerId);
  const queued = activated.job;
  const running = await db.claimNextQueued("cad");
  assert.equal(running?.id, queued.id);
  assert.equal(await db.failJobAndQueueRefund(
    queued.id,
    running.run_attempt,
    "STEP 独立回读失败",
    undefined,
    { code: "cad_step_roundtrip_failed", stage: "validating_step" }
  ), true);
  assert.equal(await db.processCreditRefundOutbox(), 1);
  assert.equal(await db.processCreditRefundOutbox(), 0, "同一失败任务只能退款一次");

  const failures = await db.listFailedCadJobs(notebook.id);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].failure_code, "cad_step_roundtrip_failed");
  assert.equal(failures[0].failure_stage, "validating_step");
  assert.equal(failures[0].refund_state, "done");

  const active = await db.createJob(notebook.id, user.id, "cad", "CAD", {}, 0);
  const response = await studioRoute.GET(
    new NextRequest(`http://localhost/api/notebooks/${notebook.id}/studio`, {
      headers: { cookie: `nb_session=${token}` },
    }),
    { params: Promise.resolve({ id: notebook.id }) }
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.failedCadJobs, [], "用户记录必须同时隐藏历史与新增 CAD 失败项");
  assert.ok(payload.outputs.some((output) => output.id === ready.id), "成功制品必须保留");
  assert.ok(payload.jobs.some((job) => job.id === active.id), "排队或运行任务必须保留");
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(queued.id), "失败任务 ID 不得进入用户投影");
  assert.doesNotMatch(JSON.stringify(payload), /cad_step_roundtrip_failed|STEP 独立回读失败/);

  const persisted = await db.getJob(queued.id);
  assert.equal(persisted?.status, "error");
  const persistedParams = JSON.parse(persisted?.params || "{}");
  assert.equal(persistedParams.cadFailureCode, "cad_step_roundtrip_failed");
  assert.equal(persistedParams.cadFailureStage, "validating_step");
  const observability = await db.getCadJobObservabilitySummary(0);
  assert.equal(observability.byStatus.error, 1, "管理监控仍必须统计失败任务");
  assert.equal(observability.byFailureCode.cad_step_roundtrip_failed, 1);
  const ledger = await getPool().query(
    "SELECT op,credits,refunded FROM credit_ledger WHERE user_id=$1 AND op IN ('studio:cad','refund:studio:cad') ORDER BY id",
    [user.id]
  );
  assert.deepEqual(
    ledger.rows.map((row) => ({ op: row.op, credits: Number(row.credits), refunded: Number(row.refunded) })),
    [
      { op: "studio:cad", credits: 12, refunded: 1 },
      { op: "refund:studio:cad", credits: -12, refunded: 0 },
    ],
    "用户记录隐藏失败项不得破坏退款流水"
  );

  assert.equal(await db.dismissFailedJob(queued.id, user.id), true);
  assert.deepEqual(await db.listFailedCadJobs(notebook.id), []);
  assert.equal((await db.getJob(queued.id))?.status, "error", "审计任务不应物理删除");
});

test("CAD 失败项不进入用户记录，刷新恢复失败仍有一次性提示", () => {
  const studio = readFileSync(new URL("../../components/Studio.tsx", import.meta.url), "utf8");
  const home = readFileSync(new URL("../../components/HomeClient.tsx", import.meta.url), "utf8");
  const shared = readFileSync(new URL("../../components/studio-shared.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../../app/api/notebooks/[id]/studio/route.ts", import.meta.url), "utf8");
  for (const label of ["CAD 模型生成失败", "修改后重试", "复制错误编号", "删除记录", "退款处理中"]) {
    assert.doesNotMatch(studio, new RegExp(label));
  }
  assert.doesNotMatch(studio, /CadFailedJobState|onRetryCadFailure|onDismissCadFailure|failedCadJobs/);
  assert.doesNotMatch(home, /CadFailedJobState|failedCadJobs|setFailedCadJobs|dismissCadFailure|\?dismiss=1/);
  assert.doesNotMatch(shared, /CadFailedJobState/);
  assert.doesNotMatch(route, /listFailedCadJobs/);
  assert.match(route, /failedCadJobs: \[\]/, "用户态 API 保留空字段兼容旧前端，但不返回失败记录");
  assert.match(home, /job\.status === "error" && alive[\s\S]{0,120}toast\(/, "刷新后恢复的任务失败时不得静默消失");
});
