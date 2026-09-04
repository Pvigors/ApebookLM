import test from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("worker_lane_gate");
const { resolveWorkerGates } = await import("../../lib/worker-gates.ts");

test("worker 闸门把蓝绿 owner、通用开关与 CAD 开关收口为同一真源", () => {
  assert.deepEqual(
    resolveWorkerGates({}, { NBLM_WORKER_ID: "blue" }),
    { general: true, cad: true, ownerMatched: true }
  );
  assert.deepEqual(
    resolveWorkerGates({ "jobs.worker_owner": "green" }, { NBLM_WORKER_ID: "blue" }),
    { general: false, cad: false, ownerMatched: false }
  );
  assert.equal(
    resolveWorkerGates({}, { NBLM_WORKER_ID: "blue", NBLM_CAD_WORKER_ENABLED: "0" }).cad,
    false
  );
  assert.deepEqual(
    resolveWorkerGates({}, { NBLM_WORKER_ID: "blue", NBLM_NON_CAD_WORKER_ENABLED: "0" }),
    { general: false, cad: true, ownerMatched: true }
  );
  assert.equal(
    resolveWorkerGates({ "jobs.cad_worker_enabled": "0" }, { NBLM_WORKER_ID: "blue" }).cad,
    false
  );
  assert.deepEqual(
    resolveWorkerGates({ "jobs.worker_v2_enabled": "0" }, { NBLM_WORKER_ID: "blue" }),
    { general: false, cad: false, ownerMatched: true }
  );
});

test("CAD 领取暂停时跳过高优先级 CAD，通用任务仍可运行", async () => {
  const user = await db.createUserByPhone("139" + "00009641", "队列闸门测试");
  const notebook = await db.createNotebook(user.id, "任务 lane", "⚙️");
  const cad = await db.createJob(notebook.id, user.id, "cad", "CAD", { __sponsored: true }, 100);
  const general = await db.createJob(notebook.id, user.id, "briefing", "简报", { __sponsored: true }, 1);

  const first = await db.claimNextQueued("non_cad");
  assert.equal(first.id, general.id);
  assert.equal((await db.getJob(cad.id)).status, "queued");

  const second = await db.claimNextQueued("cad");
  assert.equal(second.id, cad.id);
});
