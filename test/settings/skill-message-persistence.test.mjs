import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("skill_message_persistence");

test("messages.skill_id 在 PG 落库/重载往返，assistant 不得伪装技能轮", async () => {
  const user = await db.createUserByPhone("139" + "80000002", "技能持久化");
  const notebook = await db.createNotebook(user.id, "技能本", "📘");
  const first = await db.addMessage(notebook.id, "user", "学术摘要", [], "abstract");
  await db.addMessage(notebook.id, "assistant", "摘要正文", [], "abstract");
  await db.addMessage(notebook.id, "user", "普通问题");
  assert.equal(first.skill_id, "abstract");
  const rows = await db.listMessages(notebook.id);
  assert.equal(rows[0].skill_id, "abstract");
  assert.equal(rows[1].skill_id, null);
  assert.equal(rows[2].skill_id, null);
});

test("skill_id 同时写入 schema 真源与存量 addCol 迁移", () => {
  const schema = fs.readFileSync(new URL("../../db/schema.pg.sql", import.meta.url), "utf8");
  const source = fs.readFileSync(new URL("../../lib/db.ts", import.meta.url), "utf8");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS messages[\s\S]*skill_id TEXT/);
  assert.match(source, /addCol\("messages", "skill_id", "TEXT"\)/);
  assert.match(schema, /message_seq BIGSERIAL/);
  assert.match(source, /addCol\("messages", "message_seq", "BIGSERIAL"\)/);
  assert.match(source, /ORDER BY created_at DESC, message_seq DESC/);
});

test("重生成服务端以最后 user.skill_id 为真源，不信客户端跨本 id", () => {
  const route = fs.readFileSync(new URL("../../app/api/notebooks/[id]/chat/route.ts", import.meta.url), "utf8");
  assert.match(route, /lastUser\.skill_id\?\.trim\(\)/);
  assert.match(route, /requestedSkillId !== persistedSkillId/);
  assert.match(route, /lastUser\.content !== rawMessage/);
  assert.match(route, /addMessage\(notebookId, "user", rawMessage, \[\], skillId \|\| null, clientUserMessageId\)/);
  assert.match(route, /lastUser\.id !== targetUserMessageId/);
});
