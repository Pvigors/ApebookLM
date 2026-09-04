import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lexicalJsonToMarkdown,
  lexicalJsonToText,
  outputToMarkdown,
} from "../../lib/output-text.ts";

// A realistic Lexical editor-state: a bold heading + a body paragraph. Note the
// metadata tokens ("normal", "ltr") that a naive deep-walk would leak.
const LEXICAL = JSON.stringify({
  root: {
    type: "root",
    direction: "ltr",
    format: "",
    indent: 0,
    version: 1,
    children: [
      {
        type: "heading",
        tag: "h1",
        direction: "ltr",
        format: "",
        indent: 0,
        version: 1,
        children: [
          { type: "text", text: "Big Title", format: 0, mode: "normal", style: "", detail: 0, version: 1 },
        ],
      },
      {
        type: "paragraph",
        direction: "ltr",
        format: "",
        indent: 0,
        version: 1,
        children: [
          { type: "text", text: "Hello body.", format: 0, mode: "normal", style: "", detail: 0, version: 1 },
        ],
      },
    ],
  },
});

test("lexicalJsonToText extracts text without editor metadata", () => {
  const out = lexicalJsonToText(LEXICAL);
  assert.ok(out.includes("Big Title"));
  assert.ok(out.includes("Hello body."));
  // The bug we guard against: deep-walking a Lexical tree leaks node metadata.
  assert.ok(!out.includes("normal"), "must not leak mode:normal");
  assert.ok(!out.includes("ltr"), "must not leak direction:ltr");
});

test("lexicalJsonToText passes plain text / markdown through unchanged", () => {
  assert.equal(lexicalJsonToText("just plain text"), "just plain text");
  assert.equal(lexicalJsonToText("# A heading\n\nbody"), "# A heading\n\nbody");
});

test("lexicalJsonToMarkdown renders headings", () => {
  const md = lexicalJsonToMarkdown(LEXICAL);
  assert.ok(md.startsWith("# "), "heading becomes # …");
  assert.ok(md.includes("Big Title"));
  assert.ok(md.includes("Hello body."));
});

test("outputToMarkdown: edited report (Lexical JSON) → clean markdown, no metadata", () => {
  const out = outputToMarkdown("study_guide", LEXICAL);
  assert.ok(out.includes("Big Title"));
  assert.ok(!out.includes("normal"), "BUG B guard: no editor metadata in source text");
  assert.ok(!out.includes("ltr"));
});

test("outputToMarkdown: slides JSON → markdown bullets, not JSON", () => {
  const slides = JSON.stringify({
    title: "Deck",
    slides: [{ title: "Intro", bullets: ["point a", "point b"] }],
  });
  const out = outputToMarkdown("slides", slides);
  assert.ok(out.includes("# Deck"));
  assert.ok(out.includes("## Intro"));
  assert.ok(out.includes("- point a"));
  assert.ok(!out.includes("{"), "must not contain raw JSON");
});

test("outputToMarkdown: flashcards JSON → Q/A text, not JSON (download/source fix)", () => {
  const cards = JSON.stringify({ cards: [{ front: "Q one?", back: "A one" }] });
  const out = outputToMarkdown("flashcards", cards);
  assert.ok(out.includes("Q one?"));
  assert.ok(out.includes("A one"));
  assert.ok(!out.includes('"cards"'), "must not contain raw JSON");
});

test("outputToMarkdown: quiz JSON → questions with correct option marked", () => {
  const quiz = JSON.stringify({
    questions: [{
      q: "2+2?",
      type: "application",
      options: ["3", "4", "5", "6"],
      answer: 1,
      explanations: ["three is too small", "four is correct", "five is too large", "six is too large"],
      hint: "think about pairs",
      sources: ["math source", "formula source"],
    }, {
      q: "legacy?",
      options: ["yes", "no", "maybe", "unknown"],
      answer: 0,
      explanation: "legacy explanation",
      source: "legacy source",
    }],
  });
  const out = outputToMarkdown("quiz", quiz);
  assert.ok(out.includes("2+2?"));
  assert.ok(out.includes("- 4 ✓"), "correct option flagged");
  for (const text of ["题型:应用", "three is too small", "four is correct", "five is too large", "six is too large", "think about pairs", "math source", "formula source", "legacy source"])
    assert.ok(out.includes(text), `quiz export must preserve ${text}`);
});

test("outputToMarkdown: infographic JSON (blocks) → markdown, not raw JSON", () => {
  // 真实信息图内容存在 `blocks`(不是 sections);此前测试用错字段,把 bug 固化了。
  const info = JSON.stringify({
    title: "Stats",
    subtitle: "overview",
    blocks: [
      { type: "stats", title: "Growth", items: [{ value: "35%", label: "增长" }] },
      { type: "steps", title: "流程", items: [{ label: "第一步", text: "做A" }] },
      { type: "compare", title: "对比", left: { label: "A", points: ["快"] }, right: { label: "B", points: ["慢"] } },
    ],
    takeaway: "关键要点",
  });
  const out = outputToMarkdown("infographic", info);
  assert.ok(out.includes("# Stats"));
  assert.ok(out.includes("## Growth") && out.includes("35%"));
  assert.ok(out.includes("## 流程") && out.includes("第一步"));
  assert.ok(out.includes("## 对比") && out.includes("快"));
  assert.ok(out.includes("关键要点"));
  // 回归防护:绝不能把原始 JSON 当正文吐出(会污染 RAG / 变成乱码笔记)。
  assert.ok(!out.includes('"blocks"') && !out.includes('"type"'));
});

test("outputToMarkdown: plain markdown (reports, mind maps, tables) passes through", () => {
  assert.equal(outputToMarkdown("study_guide", "# Guide\n\n- a"), "# Guide\n\n- a");
  assert.equal(outputToMarkdown("mindmap", "# Map\n## Branch"), "# Map\n## Branch");
});

test("outputToMarkdown: empty content → empty string", () => {
  assert.equal(outputToMarkdown("audio", ""), "");
  assert.equal(outputToMarkdown("audio", "   "), "");
});
