import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("request_refund_guard");
const { getPool } = await import("../../lib/pg.ts");

test("聊天扣分与持久退分 guard 同一事务，产物落库时原子结算", async () => {
  const user = await db.createUserByPhone("139" + "80000031", "guard成功");
  const notebook = await db.createNotebook(user.id, "guard笔记本", "📘");
  const charge = await db.consumeDailyQuota(user, "chat", 3, notebook.title, {
    refundAfterMs: 60_000,
    requestId: "test:success",
  });
  assert.equal(charge.over, false);
  assert.ok(charge.ledgerId);
  let outbox = (await getPool().query(
    "SELECT state,next_at FROM credit_refund_outbox WHERE ledger_id=$1",
    [charge.ledgerId]
  )).rows[0];
  assert.equal(outbox.state, "pending");
  assert.ok(Number(outbox.next_at) > Date.now());

  const saved = await db.addAssistantMessageAndSettleCharge(
    notebook.id,
    "已核验答案",
    [],
    charge.ledgerId
  );
  assert.equal(saved.content, "已核验答案");
  outbox = (await getPool().query(
    "SELECT state,done_at FROM credit_refund_outbox WHERE ledger_id=$1",
    [charge.ledgerId]
  )).rows[0];
  assert.equal(outbox.state, "done");
  assert.ok(Number(outbox.done_at) > 0);
  assert.equal((await db.listMessages(notebook.id)).length, 1);
});

test("模拟扣分后 SIGKILL：超时 outbox 可在新进程扫描时退分，且禁止迟到产物落库", async () => {
  const user = await db.createUserByPhone("139" + "80000032", "guard崩溃");
  const notebook = await db.createNotebook(user.id, "崩溃补偿本", "📕");
  const charge = await db.consumeDailyQuota(user, "chat", 4, notebook.title, {
    refundAfterMs: 60_000,
    requestId: "test:crash",
  });
  assert.ok(charge.ledgerId);
  await getPool().query(
    "UPDATE credit_refund_outbox SET next_at=0 WHERE ledger_id=$1",
    [charge.ledgerId]
  );
  assert.equal(await db.processCreditRefundOutbox(10), 1);
  const ledger = (await getPool().query(
    "SELECT refunded FROM credit_ledger WHERE id=$1",
    [charge.ledgerId]
  )).rows[0];
  assert.equal(Number(ledger.refunded), 1);
  await assert.rejects(
    db.addAssistantMessageAndSettleCharge(notebook.id, "迟到答案", [], charge.ledgerId),
    /已超时退回/
  );
  assert.equal((await db.listMessages(notebook.id)).length, 0);
});

test("重新生成在新答案+扣费结算成功后才原子替换旧答案", async () => {
  const user = await db.createUserByPhone("139" + "80000033", "guard重生成");
  const notebook = await db.createNotebook(user.id, "重生成本", "📗");
  const userMessage = await db.addMessage(notebook.id, "user", "原问题", [], "abstract");
  const oldAssistant = await db.addMessage(notebook.id, "assistant", "旧答案");
  const charge = await db.consumeDailyQuota(user, "chat", 2, notebook.title, {
    refundAfterMs: 60_000,
    requestId: "test:regenerate",
  });
  await db.replaceTrailingAssistant(notebook.id, "新答案", [], charge.ledgerId, {
    userMessageId: userMessage.id,
    assistantIds: [oldAssistant.id],
  });
  const rows = await db.listMessages(notebook.id);
  assert.deepEqual(rows.map((row) => [row.role, row.content]), [
    ["user", "原问题"],
    ["assistant", "新答案"],
  ]);
  assert.equal((await getPool().query(
    "SELECT state FROM credit_refund_outbox WHERE ledger_id=$1",
    [charge.ledgerId]
  )).rows[0].state, "done");
});
