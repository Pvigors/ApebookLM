import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { freshPgDb } from "../helpers/pgdb.mjs";

process.env.PUBLIC_ORIGIN = "https://notes.example.test";
process.env.ADMIN_PASSWORD_LOGIN_ENABLED = "0";
process.env.NBLM_WORKER_ENABLED = "1";
process.env.NBLM_CAD_WORKER_ENABLED = "0";
delete process.env.ADMIN_PASSWORD_ACCOUNT_B64;

const db = await freshPgDb("admin_monitor_runtime");
const { getPool } = await import("../../lib/pg.ts");
const auth = await import("../../lib/auth.ts");
const logsRoute = await import("../../app/api/admin/logs/route.ts");
const { NextRequest } = await import("next/server");

const pool = getPool();
const operator = await db.createUserByPhone("139" + "00009621", "监控运营员");
await db.setUserAdminRole(operator.id, "operator");
const token = await db.createSession(operator.id);

const request = () => new NextRequest("https://notes.example.test/api/admin/logs", {
  headers: { cookie: `${auth.SESSION_COOKIE}=${token}` },
});

test("服务监控区分通用/CAD队列、worker闸与退款补偿且不泄露params", async () => {
  const notebook = await db.createNotebook(operator.id, "运行监控合同", "📡");
  const general = await db.createJob(
    notebook.id,
    operator.id,
    "briefing",
    "通用简报",
    { instruction: "PRIVATE-PROMPT-SENTINEL", __sponsored: true },
    5
  );
  const cad = await db.createJob(
    notebook.id,
    operator.id,
    "cad",
    "CAD任务",
    { cadTemplate: "plate", __sponsored: true },
    10
  );
  await pool.query(
    `UPDATE jobs SET status='running',progress=62,run_attempt=2,
       credits_reserved=12,tokens_in=120,tokens_out=30 WHERE id=$1`,
    [cad.id]
  );
  const ledger = await pool.query(
    `INSERT INTO credit_ledger(user_id,op,credits,bonus,plan_credits,ts)
     VALUES($1,'studio:briefing',5,0,5,$2) RETURNING id`,
    [operator.id, Date.now()]
  );
  await pool.query(
    `INSERT INTO credit_refund_outbox
       (ledger_id,job_id,user_id,op,credits,state,attempts,next_at,claimed_at,created_at)
     VALUES($1,$2,$3,'studio:briefing',5,'pending',0,0,0,$4)`,
    [ledger.rows[0].id, general.id, operator.id, Date.now()]
  );

  const response = await logsRoute.GET(request());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.queue.general.queued, 1);
  assert.equal(data.queue.cad.running, 1);
  assert.deepEqual(data.workers, { general: true, cad: false });
  assert.deepEqual(data.refunds, { pending: 1, processing: 0 });

  const cadRow = data.jobs.find((job) => job.id === cad.id);
  assert.equal(cadRow.lane, "cad");
  assert.equal(cadRow.run_attempt, 2);
  assert.equal(cadRow.priority, 10);
  assert.equal(cadRow.credits_reserved, 12);
  assert.equal(cadRow.tokens_in + cadRow.tokens_out, 150);
  assert.equal(cadRow.params, undefined);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE-PROMPT-SENTINEL/);
});

test("依赖体检覆盖 Text2CAD，且不包含资金交易探测", () => {
  const source = fs.readFileSync(
    new URL("../../app/api/admin/health/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /text2cadRuntimeHealth/);
  assert.doesNotMatch(source, /resolvePaymentConfig|历史订单/);
  assert.match(source, /cadWorkerHeartbeatReady\(true\)/);
  assert.match(source, /probe\("CAD 独立 worker"/);
  assert.match(source, /SET LOCAL statement_timeout = 5000/);
  assert.doesNotMatch(source, /SET statement_timeout = 5000/);
  assert.match(source, /status='running'/);
  assert.match(source, /kind<>'cad' AND status='running'/);
  assert.match(source, /kind='cad' AND status='running'/);
  assert.doesNotMatch(source, /status IN \('queued','running'\)[^\n]*updated_at/);
});
