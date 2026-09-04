import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("citation_persistence");

test("精确引用字段写入消息后可完整重载，历史引用仍兼容", async () => {
  const user = await db.createUserByEmail("citation-persistence@example.com", "引用持久化");
  const notebook = await db.createNotebook(user.id, "引用持久化验收", "🔖");
  const precise = {
    number: 1,
    source_id: "source-1",
    source_title: "来源一",
    chunk_index: 3,
    chunk_id: "chunk-3",
    snippet: "精确证据句。",
    quote: "精确证据句。",
    source_start: 128,
    source_end: 135,
    source_content_hash: "abc123",
    source_kind: "web",
    source_url: "https://example.com/source",
    evidence_kind: "search_snippet",
    verification_context: "立场标题。精确证据句。限定条件。",
    verification_start: 120,
    verification_end: 144,
  };
  const legacy = {
    number: 2,
    source_id: "source-2",
    source_title: "来源二",
    chunk_index: 0,
    snippet: "历史摘录。",
  };
  await db.addMessage(notebook.id, "assistant", "结论。[1] 历史。[2]", [precise, legacy]);
  const [saved] = await db.listMessages(notebook.id);
  assert.deepEqual(saved.citations[0], precise);
  assert.deepEqual(saved.citations[1], legacy);
});
