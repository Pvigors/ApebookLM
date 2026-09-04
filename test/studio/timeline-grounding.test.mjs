import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("timeline_grounding");
const { buildTimelineCorpus, buildTimelineEvidence } = await import("../../lib/corpus.ts");
const { generateReport } = await import("../../lib/studio.ts");

async function readySource(notebookId, title, content, selected = true) {
  const source = await db.createSource(notebookId, title, "text");
  await db.finalizeSource(source.id, {
    status: "ready",
    content,
    char_count: content.length,
    chunk_count: 1,
  });
  await db.setSourceSelected(source.id, selected);
  return source;
}

test("时间线只扫描明确勾选来源的正文日期，不把文件名或标准号当事件", async () => {
  const user = await db.createUserByEmail("timeline-grounding@example.com", "时间线验收");
  const notebook = await db.createNotebook(user.id, "时间线来源验收", "🕒");
  const filenameOnly = await readySource(
    notebook.id,
    "TC609-5-2025-04《质量评测规范》",
    "4.2.3 分类要求说明数据集应按覆盖范围和使用对象进行判断。正文没有给出事件发生时间。"
  );
  const grounded = await readySource(
    notebook.id,
    "行动方案正文",
    "2024年7月，项目组发布第一版行动方案，明确了数据清洗和质量复核流程。随后进入试运行阶段。"
  );
  const foreignNotebook = await db.createNotebook(user.id, "另一本", "📕");
  const foreign = await readySource(
    foreignNotebook.id,
    "其他笔记本来源",
    "2027年5月，其他团队启动不相关项目。",
    true
  );
  await readySource(
    notebook.id,
    "未勾选来源",
    "2026年3月，团队宣布上线另一套平台。该事件不应进入当前时间线。",
    false
  );

  const explicit = await buildTimelineCorpus(notebook.id, [filenameOnly.id, grounded.id, foreign.id]);
  assert.match(explicit, /# 行动方案正文/);
  assert.match(explicit, /2024年7月/);
  assert.doesNotMatch(explicit, /2025年4月|2025-04|质量评测规范/);
  assert.doesNotMatch(explicit, /2026年3月|未勾选来源/);
  assert.doesNotMatch(explicit, /2027年5月|其他笔记本来源/);

  const structured = await buildTimelineEvidence(notebook.id, [filenameOnly.id, grounded.id, foreign.id]);
  assert.deepEqual(structured.map((item) => item.sourceId), [grounded.id]);
  assert.deepEqual(structured.map((item) => item.date), ["2024年7月"]);
  assert.ok(structured[0].evidenceId.startsWith(`${grounded.id}:`));

  const selected = await buildTimelineCorpus(notebook.id);
  assert.match(selected, /2024年7月/);
  assert.doesNotMatch(selected, /2026年3月|未勾选来源/);
  assert.equal(await buildTimelineCorpus(notebook.id, []), "");

  const report = await generateReport(notebook.id, "timeline", [grounded.id]);
  assert.match(report.content, /2024年7月[^\n]*发布第一版行动方案[^\n]*行动方案正文/);
  assert.doesNotMatch(report.content, /2025-04|2026年|2027年/);
  await assert.rejects(
    generateReport(notebook.id, "timeline", [filenameOnly.id]),
    /没有找到“明确日期 \+ 对应事件”/
  );
});
