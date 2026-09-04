// 全局默认输出语言:回落 + 每本笔记覆盖;以及改昵称。
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("output_language");
const { getNotebookDirective } = await import("../../lib/settings.ts");

test("输出语言:笔记本为空时回落到所有者的全局默认,非空时覆盖", async () => {
  const u = await db.createUserByPhone("138" + "00000001", "阿满");
  const nb = await db.createNotebook(u.id, "测试本", "📘");

  // 双空 → 无语言指令(跟随来源)
  assert.ok(!(await getNotebookDirective(nb.id)).includes("OUTPUT LANGUAGE"), "双空应无语言指令");

  // 设全局默认 → 指令含该语言
  await db.updateUserProfile(u.id, { default_output_language: "English" });
  const d1 = await getNotebookDirective(nb.id);
  assert.ok(d1.includes("OUTPUT LANGUAGE") && d1.includes("English"), "应回落到全局默认 English");

  // 笔记本级语言 → 覆盖全局
  await db.setNotebookSettings(nb.id, { output_language: "简体中文" });
  const d2 = await getNotebookDirective(nb.id);
  assert.ok(d2.includes("简体中文") && !d2.includes("English"), "笔记本级应覆盖全局");

  // 清空笔记本级 → 再次回落全局
  await db.setNotebookSettings(nb.id, { output_language: "" });
  assert.ok((await getNotebookDirective(nb.id)).includes("English"), "清空后应再回落全局");

  // 全局设回跟随来源(空)→ 无指令
  await db.updateUserProfile(u.id, { default_output_language: "" });
  assert.ok(!(await getNotebookDirective(nb.id)).includes("OUTPUT LANGUAGE"), "全局跟随来源应无指令");
});

test("改昵称:updateUserProfile 持久化 name", async () => {
  const u = await db.createUserByPhone("138" + "00000002", "旧名");
  const upd = await db.updateUserProfile(u.id, { name: "新名" });
  assert.equal(upd?.name, "新名");
  assert.equal((await db.getUserById(u.id))?.name, "新名");
});
