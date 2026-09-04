import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { getArticleNav } from "../../lib/help-content.ts";

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("智能制品与查看器存笔记统一落 report，不伪装手写 manual 进 RAG", () => {
  const home = read("components/HomeClient.tsx");
  assert.match(home, /addNote\(title, content, "report"\)/);
  assert.match(home, /onQuizSaveNote=\{async \(t, c\) => !!\(await addNote\(t, c, "report"\)\)\}/);
  assert.doesNotMatch(home, /onSaveNote=\{[^\n]*addNote\(t, c, "manual"\)/);
  const noteRag = read("lib/note-rag.ts");
  assert.match(noteRag, /const eligible = note\.kind === "manual"/);
});

test("帮助中心明确手写笔记可检索，生成笔记需转来源", () => {
  for (const slug of ["create-and-edit-notes", "how-notes-join-the-chat", "save-as-note-and-convert-to-source"]) {
    const item = getArticleNav("notes", slug)?.article.body ?? "";
    assert.match(item, /手写笔记/);
    assert.match(item, /生成笔记|生成内容/);
    assert.match(item, /转为来源/);
  }
});
