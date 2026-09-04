// 置顶单一性测试:同一用户至多一个置顶,跨用户互不影响。
// PG 迁移后:用 freshPgDb 起独立 PG 测试库,db 全 async(需 await)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("pin");

test("置顶:同用户单一置顶,置顶一个自动取消其它;跨用户互不影响", async () => {
  const a = await db.createNotebook("u1", "A", "📘");
  const b = await db.createNotebook("u1", "B", "📗");
  const c = await db.createNotebook("u2", "C", "📙");

  assert.equal((await db.getNotebook(a.id)).pinned, false, "初始无置顶");

  await db.setNotebookPinned(a.id, true);
  assert.equal((await db.getNotebook(a.id)).pinned, true);

  // 置顶 B → 同用户的 A 自动取消
  await db.setNotebookPinned(b.id, true);
  assert.equal((await db.getNotebook(b.id)).pinned, true);
  assert.equal((await db.getNotebook(a.id)).pinned, false, "同用户单一置顶");

  // 另一用户置顶 C,不影响 u1 的置顶
  await db.setNotebookPinned(c.id, true);
  assert.equal((await db.getNotebook(c.id)).pinned, true);
  assert.equal((await db.getNotebook(b.id)).pinned, true, "u2 置顶不影响 u1");

  // 取消置顶
  await db.setNotebookPinned(b.id, false);
  assert.equal((await db.getNotebook(b.id)).pinned, false);
});
