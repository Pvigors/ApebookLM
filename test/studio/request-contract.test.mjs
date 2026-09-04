import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStudioRequestOptions,
  QUIZ_COUNT_OPTIONS,
  FLASHCARD_COUNT_OPTIONS,
  XHS_COUNT_OPTIONS,
} from "../../lib/studio-request-contract.ts";

test("测验题量与难度只接受 UI 合同，缺省值和页面一致", () => {
  assert.deepEqual(normalizeStudioRequestOptions("quiz", {}), {
    ok: true,
    count: 10,
    difficulty: "medium",
  });
  for (const count of QUIZ_COUNT_OPTIONS) {
    assert.deepEqual(normalizeStudioRequestOptions("quiz", { count, difficulty: "hard" }), {
      ok: true,
      count,
      difficulty: "hard",
    });
  }
  for (const count of [4, 8, 20, 10.5, "10", -1]) {
    assert.equal(normalizeStudioRequestOptions("quiz", { count, difficulty: "medium" }).ok, false);
  }
  for (const difficulty of ["nightmare", "HARD", 1, ""]) {
    assert.equal(normalizeStudioRequestOptions("quiz", { count: 10, difficulty }).ok, false);
  }
});

test("闪卡与小红书卡量 fail closed，不再静默四舍五入或钳制", () => {
  for (const count of FLASHCARD_COUNT_OPTIONS) {
    assert.deepEqual(normalizeStudioRequestOptions("flashcards", { count }), { ok: true, count });
  }
  for (const count of XHS_COUNT_OPTIONS) {
    assert.deepEqual(normalizeStudioRequestOptions("xhs", { count }), { ok: true, count });
  }
  assert.equal(normalizeStudioRequestOptions("flashcards", { count: 9 }).ok, false);
  assert.equal(normalizeStudioRequestOptions("xhs", { count: 5 }).ok, false);
  assert.deepEqual(normalizeStudioRequestOptions("briefing", { count: 999 }), { ok: true });
});
