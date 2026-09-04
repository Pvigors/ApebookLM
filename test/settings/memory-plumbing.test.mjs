// 调用点不变式:把「记忆跟谁走」的策略锁在源码层面,防止回归。
// 这条审查教训 —— 生成路径(jobs.ts)丢了发起人 user_id、退回所有者记忆 —— 没有
// 任何测试拦得住,因为真正跑生成要调 LLM。这里用源码断言守住每个调用点的第二参:
//   · 用户主动生成(jobs / revise / 私有 chat)→ 跟「发起人」走;
//   · 会持久化且经 /api/public 公开的共享元数据(概览 / 来源导读)→ 传 null,谁都不注入。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("生成任务:每个 generate* 都把发起人 memberId 传下去", () => {
  const src = read("lib/jobs.ts");
  // memberId 取自 job.user_id(发起这次生成的人),而非笔记本所有者。
  assert.match(src, /const memberId = job\.user_id/, "runArtifactJob 须从 job.user_id 取 memberId");
  // 10 个生成器调用 + 1 处定义 = 至少 11 次出现;任一调用漏传都会跌破。
  const hits = src.match(/memberId/g) ?? [];
  assert.ok(hits.length >= 11, `jobs.ts 出现 memberId ${hits.length} 次,应 ≥11(10 个生成器调用 + 定义)`);
  // 逐个生成器点名,确保没有哪个被漏掉。
  for (const fn of [
    "generateAudioOverview",
    "generateVideoOverview",
    "generateInfographic",
    "generateSlides",
    "generateExcalidraw",
    "generateCustomReport",
    "generateFlashcards",
    "generateQuiz",
    "generateMindmap",
    "generateReport",
  ]) {
    // 从该函数调用处到下一个分号之间必须出现 memberId。
    const re = new RegExp(`${fn}\\([\\s\\S]*?memberId[\\s\\S]*?\\)`);
    assert.match(src, re, `jobs.ts 调用 ${fn} 时须传 memberId`);
  }
});

test("就地修订:revise 把发起人 g.id 传给 generateSlides", () => {
  const src = read("app/api/studio/[id]/revise/route.ts");
  assert.match(src, /generateSlides\([\s\S]*?memberId:\s*g\.id[\s\S]*?\)/, "revise 须传 memberId: g.id");
});

test("私有对话:chat 跟当前用户 g.id 走", () => {
  const src = read("app/api/notebooks/[id]/chat/route.ts");
  assert.match(src, /getNotebookDirective\(notebookId,\s*g\.id\)/, "私有 chat 须传 g.id");
});

test("共享/公开持久化产物:一律传 null,不注入任何人记忆", () => {
  // 这些路径生成的内容会落库,并经 /api/public/[id] 不鉴权返回 —— 注入任何个人记忆都是泄露。
  const shared = [
    "app/api/notes/[id]/to-source/route.ts",
    "app/api/studio/[id]/to-source/route.ts",
    "app/api/notebooks/[id]/notes/convert-all/route.ts",
  ];
  for (const rel of shared) {
    const src = read(rel);
    assert.match(
      src,
      /getNotebookDirective\([^)]*,\s*null\s*\)/,
      `${rel} 的 getNotebookDirective 须传 null`
    );
    // 反向守卫:这些文件里不应出现把所有者/某人记忆带进公开产物的隐式回退。
    assert.doesNotMatch(
      src,
      /getNotebookDirective\(\s*[A-Za-z][\w.]*\s*\)/,
      `${rel} 不应有省略第二参(隐式回退所有者)的 getNotebookDirective 调用`
    );
  }
  // 用户来源导读/概览是公开元数据,现在连 notebook chat_instructions
  // 也不再进请求(比“传 null 但仍拼 notebook directive”更彻底)。
  const sourceRoute = read("app/api/notebooks/[id]/sources/route.ts");
  assert.doesNotMatch(sourceRoute, /getNotebookDirective/);
  // 重复 URL 重抓到的新版正文不得污染旧来源的导读；必须只读 DB 真源。
  assert.match(sourceRoute, /generateSourceGuide\(persisted\.title, persisted\.content\)/);
  const overviewRoute = read("app/api/notebooks/[id]/overview/route.ts");
  assert.doesNotMatch(overviewRoute, /getNotebookDirective/);
  assert.match(overviewRoute, /generateNotebookOverview\([\s\S]*ready\.map/);
});

test("公开分享关闭匿名 AI 对话，不再存在个人记忆或免费 Token 后门", () => {
  const src = read("app/api/public/[id]/chat/route.ts");
  assert.match(src, /code:\s*"read_only"/);
  assert.doesNotMatch(src, /getNotebookDirective|getOpenAI|retrieve\(/);
});

test("生成库:不再有省略 memberId 的隐式所有者回退", () => {
  // 五个生成库的每个 getNotebookDirective 调用都必须带第二参(opts?.memberId)。
  for (const rel of ["lib/studio.ts", "lib/audio.ts", "lib/video.ts", "lib/slides.ts", "lib/excalidraw.ts", "lib/infographic.ts"]) {
    const src = read(rel);
    assert.doesNotMatch(
      src,
      /getNotebookDirective\(\s*notebookId\s*\)/,
      `${rel} 不应再有 getNotebookDirective(notebookId) 这种省略 memberId 的调用`
    );
  }
});
