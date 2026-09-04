import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("cad_worker_heartbeat");
const { CAD_LIBRARY_VERSION } = await import("../../lib/cad-spec.ts");
const { cadWorkerHeartbeatReady } = await import("../../lib/cad-worker-heartbeat.ts");

test("扣分前必须有当前 owner、同库版本和 FreeCAD 验证器的新鲜心跳", async () => {
  await db.setSetting("jobs.worker_owner", "green", "test");
  assert.equal((await cadWorkerHeartbeatReady(true)).ok, false);

  await db.setSetting("jobs.cad_worker_heartbeat", JSON.stringify({
    ts: Date.now(), workerId: "blue", validator: "freecad-native", libraryVersion: CAD_LIBRARY_VERSION,
  }), "test");
  assert.equal((await cadWorkerHeartbeatReady(true)).ok, false);

  await db.setSetting("jobs.cad_worker_heartbeat", JSON.stringify({
    ts: Date.now(), workerId: "green", validator: "freecad-native", libraryVersion: CAD_LIBRARY_VERSION + 1,
  }), "test");
  assert.equal((await cadWorkerHeartbeatReady(true)).ok, false);

  await db.setSetting("jobs.cad_worker_heartbeat", JSON.stringify({
    ts: Date.now(), workerId: "green", validator: "freecad-native", libraryVersion: CAD_LIBRARY_VERSION,
  }), "test");
  assert.equal((await cadWorkerHeartbeatReady(true)).ok, true);

  await db.setSetting("jobs.cad_worker_heartbeat", JSON.stringify({
    ts: Date.now() - 31_000, workerId: "green", validator: "freecad-native", libraryVersion: CAD_LIBRARY_VERSION,
  }), "test");
  assert.equal((await cadWorkerHeartbeatReady(true)).ok, false);
});
