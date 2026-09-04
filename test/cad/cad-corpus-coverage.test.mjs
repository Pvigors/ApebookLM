import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("cad_corpus_coverage");
const corpusModule = await import("../../lib/corpus.ts");
const corpus = corpusModule.buildCorpus ? corpusModule : corpusModule.default;

test("CAD fallback 在 48K 预算内覆盖 24 个来源，等长同前言正文不被伪哈希误删", async () => {
  const user = await db.createUserByEmail("cad-corpus-coverage@example.com", "CAD 语料覆盖");
  const notebook = await db.createNotebook(user.id, "CAD 语料覆盖", "📐");
  const sourceIds = [];
  for (let index = 1; index <= 24; index++) {
    const marker = `末来源对象-${String(index).padStart(2, "0")}`;
    const prefix = "相同模板前言用于验证完整内容哈希与公平来源预算。".repeat(8);
    const body = `${prefix}${"参数化设计正文。".repeat(360)}${marker}`.slice(0, 2_990) + marker;
    const source = await db.createSource(notebook.id, `规格来源 ${String(index).padStart(2, "0")}`, "pdf");
    await db.finalizeSource(source.id, {
      status: "ready",
      content: body,
      char_count: body.length,
      chunk_count: 0,
    });
    sourceIds.push(source.id);
  }
  const text = await corpus.buildCorpus(notebook.id, sourceIds, { maxTotal: 48_000 });
  for (let index = 1; index <= 24; index++) {
    assert.match(text, new RegExp(`末来源对象-${String(index).padStart(2, "0")}`));
  }
});
