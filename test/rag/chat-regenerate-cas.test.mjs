import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("chat_regenerate_cas");

test("首发 user 气泡的客户端 UUID 与 DB 真源使用同一 id", async () => {
  const user = await db.createUserByPhone("139" + "80000040", "消息ID对齐");
  const notebook = await db.createNotebook(user.id, "ID对齐本", "🪪");
  const clientId = crypto.randomUUID();
  const saved = await db.addMessage(notebook.id, "user", "首发问题", [], null, clientId);
  assert.equal(saved.id, clientId);
  assert.equal((await db.listMessages(notebook.id))[0].id, clientId);
});

test("清空对话后，旧的 fire-and-forget 摘要不能复活已删私密内容", async () => {
  const user = await db.createUserByPhone("139" + "80000043", "摘要epoch");
  const notebook = await db.createNotebook(user.id, "摘要epoch本", "🧹");
  await db.addMessage(notebook.id, "user", "私密旧对话");
  const before = await db.getChatSummary(notebook.id);
  await db.clearMessages(notebook.id);
  assert.equal(await db.setChatSummary(notebook.id, "不得复活的私密摘要", 1, before.epoch), false);
  const after = await db.getChatSummary(notebook.id);
  assert.equal(after.summary, null);
  assert.equal(after.upto, 0);
  assert.equal(after.epoch, before.epoch + 1);
});

async function charge(user, notebook, requestId) {
  const result = await db.consumeDailyQuota(user, "chat", 2, notebook.title, {
    refundAfterMs: 60_000,
    requestId,
  });
  assert.ok(result.ledgerId);
  return result.ledgerId;
}

test("同一旧答案的两个并发重生成只能有一个 CAS 赢家，输家不删新答案", async () => {
  const user = await db.createUserByPhone("139" + "80000041", "重生成CAS");
  const notebook = await db.createNotebook(user.id, "CAS本", "📘");
  const u1 = await db.addMessage(notebook.id, "user", "继续");
  const a1 = await db.addMessage(notebook.id, "assistant", "旧答案");
  const [ledgerA, ledgerB] = await Promise.all([
    charge(user, notebook, "regen:a"),
    charge(user, notebook, "regen:b"),
  ]);
  const expected = { userMessageId: u1.id, assistantIds: [a1.id] };
  const results = await Promise.allSettled([
    db.replaceTrailingAssistant(notebook.id, "新答案A", [], ledgerA, expected),
    db.replaceTrailingAssistant(notebook.id, "新答案B", [], ledgerB, expected),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const loserIndex = results.findIndex((result) => result.status === "rejected");
  assert.match(String(results[loserIndex].reason), /对话已在其它页面更新/);
  await db.refundGuardedCreditsWithRetry(user.id, "chat", 2, loserIndex === 0 ? ledgerA : ledgerB);
  const rows = await db.listMessages(notebook.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, u1.id);
  assert.match(rows[1].content, /^新答案[AB]$/);
});

test("旧轮生成期间新轮已完成，迟到重生成不得删掉新轮答案；相同文本也不得冒充身份", async () => {
  const user = await db.createUserByPhone("139" + "80000042", "跨轮CAS");
  const notebook = await db.createNotebook(user.id, "跨轮本", "📙");
  const u1 = await db.addMessage(notebook.id, "user", "继续");
  const a1 = await db.addMessage(notebook.id, "assistant", "U1答案");
  const ledger = await charge(user, notebook, "regen:stale-u1");
  const u2 = await db.addMessage(notebook.id, "user", "继续");
  const a2 = await db.addMessage(notebook.id, "assistant", "U2答案");

  await assert.rejects(
    db.replaceTrailingAssistant(
      notebook.id,
      "U1迟到重生成",
      [],
      ledger,
      { userMessageId: u1.id, assistantIds: [a1.id] }
    ),
    /对话已在其它页面更新/
  );
  await db.refundGuardedCreditsWithRetry(user.id, "chat", 2, ledger);
  const rows = await db.listMessages(notebook.id);
  assert.deepEqual(rows.map((row) => [row.id, row.content]), [
    [u1.id, "继续"],
    [a1.id, "U1答案"],
    [u2.id, "继续"],
    [a2.id, "U2答案"],
  ]);
});

test("历史无来源 append bug 留下超过20条尾部 assistant 时，刷新后仍可一次原子收敛", async () => {
  const user = await db.createUserByPhone("139" + "80000044", "历史尾部");
  const notebook = await db.createNotebook(user.id, "历史尾部本", "🧵");
  const prompt = await db.addMessage(notebook.id, "user", "历史问题");
  const oldAnswers = [];
  for (let index = 0; index < 21; index++) oldAnswers.push(await db.addMessage(notebook.id, "assistant", `旧答案${index + 1}`));
  const ledger = await charge(user, notebook, "regen:legacy-21");
  await db.replaceTrailingAssistant(
    notebook.id,
    "收敛后新答案",
    [],
    ledger,
    { userMessageId: prompt.id, assistantIds: oldAnswers.map((answer) => answer.id) }
  );
  assert.deepEqual((await db.listMessages(notebook.id)).map((message) => message.content), ["历史问题", "收敛后新答案"]);
});

test("前端与路由必须传/校验目标 user id 和预期 assistant ids，无来源重生成也走 replace", async () => {
  const fs = await import("node:fs");
  const home = fs.readFileSync(new URL("../../components/HomeClient.tsx", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../../app/api/notebooks/[id]/chat/route.ts", import.meta.url), "utf8");
  assert.match(home, /targetUserMessageId:\s*regenerateTarget\.userMessageId/);
  assert.match(home, /expectedAssistantIds:\s*regenerateTarget\.assistantIds/);
  assert.match(home, /clientUserMessageId \? \{ clientUserMessageId \}/);
  assert.match(home, /code === "regenerate_conflict"[\s\S]*if \(onRegenerateConflict\) onRegenerateConflict\(\)/);
  assert.match(home, /code === "regenerate_conflict"[\s\S]*filter\(\(message\) => message\.id !== STREAM_ID\)/);
  assert.match(home, /code === "regenerate_conflict"[\s\S]*reloadMessagesFromServer\(\)/);
  assert.match(home, /onRegenerateConflict[\s\S]*setMessages\(msgs\)/);
  assert.match(route, /lastUser\.id !== targetUserMessageId/);
  assert.match(route, /actualAssistantIds\.length !== expectedSorted\.length/);
  assert.doesNotMatch(route, /expectedAssistantIds[\s\S]{0,300}\.slice\(0,\s*20\)/);
  assert.match(route, /if \(readyCount === 0\)[\s\S]*isRegenerate[\s\S]*replaceTrailingAssistant/);
  const dbSource = fs.readFileSync(new URL("../../lib/db.ts", import.meta.url), "utf8");
  const clearBody = dbSource.match(/export async function clearMessages[\s\S]*?\n}\n\n\/\*\* 滚动对话摘要/)?.[0] || "";
  assert.match(clearBody, /pg_advisory_xact_lock/);
  assert.match(clearBody, /BEGIN[\s\S]*DELETE FROM messages[\s\S]*chat_summary=NULL[\s\S]*COMMIT/);
});
