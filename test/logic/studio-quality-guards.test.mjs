import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  extractTimelineEvidence,
  renderTimelineEvidence,
  timelineDateTokens,
  timelineSourceBody,
} from "../../lib/timeline.ts";
import { reportFromCorpus } from "../../lib/studio.ts";
import { VOICE_PRESETS } from "../../components/studio-shared.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, ROOT), "utf8");

test("时间轴不把章节号、标准号、文件名年份或元数据当事件日期", () => {
  assert.deepEqual(timelineDateTokens("4.2.3 GB/T 35295-2017 TC609-5-2025-04"), []);
  for (const falseDate of [
    "年度报告-2025-04.pdf 项目背景与范围说明",
    "ISO/IEC 27001:2022 规定了安全要求",
    "Q/ABC 123-2025 规定了分类方法",
    "项目共收集2025个样本并完成清洗",
    "Office 2021 支持该功能",
    "Last updated: 2025-04-01，页面完成更新",
    "发布日期：2025年4月1日，文档正式发布",
    "创建时间：2025年4月1日，系统完成建档",
    "文件编号：2025-04，项目组启动评审。",
    "文件名：2025-04，项目组启动评审。",
    "文号：2025-04，项目正式上线。",
    "Document ID 2025-04, the project launched.",
    "本页更新于2025年4月1日，项目正式上线。",
    "数据抓取于2025年4月1日，项目正式上线。",
    "批次号：2025-04 项目正式启动。",
    "合同号：2025-04 项目正式启动。",
    "Batch 2025-04 project launched.",
    "批次号：2025年4月 项目正式启动。",
    "合同号：2025年4月 项目正式启动。",
    "Batch：2025年4月 project launched.",
    "文件版本：2025年4月 项目上线。",
    "上海市发布《行动方案（2023—2025年）》，提出配套要求。",
    "《2025年工作要点》正式发布。",
    "2025年版标准正式发布。",
    "标准的2025年版正式发布。",
    "公司发布2025年度报告。",
    "2025年度报告正式发布。",
    "2023—2025年行动计划正式发布。",
    "Document No. 2025-04 project launched.",
    "Reference 2025-04 project launched.",
    "The document was last modified in 2025 before the project launched.",
    "This page was published in 2025 before the project launched.",
    "The page was updated in 2025 before the initiative started.",
    "本文修改于2025年后项目启动。",
    "文档创建于2025年后项目启动。",
    "页面发布于2025年后项目启动。",
  ]) assert.deepEqual(extractTimelineEvidence(falseDate), [], falseDate);
  const evidence = extractTimelineEvidence(
    "1898年，机构正式成立。项目组于2024年提出试点方案，2025年实施并完成首轮验收。\n2023—2025年，团队持续开展试运行。更新时间2025年1月；2025.04.01 项目正式上线。"
  );
  assert.deepEqual(evidence.map((item) => [item.date, item.event]), [
    ["1898年", "机构正式成立。"],
    ["2024年", "项目组提出试点方案"],
    ["2025年", "实施并完成首轮验收。"],
    ["2023—2025年", "团队持续开展试运行。"],
    ["2025.04.01", "项目正式上线。"],
  ]);
  assert.deepEqual(extractTimelineEvidence("2025-02-31 项目启动。"), []);
  assert.deepEqual(
    extractTimelineEvidence("Project launched in 2025-04.").map((item) => [item.date, item.event]),
    [["2025-04", "Project launched."]]
  );
  assert.deepEqual(
    extractTimelineEvidence("The policy was published in 2025.").map((item) => [item.date, item.event]),
    [["2025", "The policy was published."]]
  );
  assert.deepEqual(
    extractTimelineEvidence("《政策》于2025年发布。").map((item) => [item.date, item.event]),
    [["2025年", "《政策》发布。"]]
  );
  const paired = extractTimelineEvidence(
    "项目提出于2024年，实施于2025年。2024年提出并于2025年实施。"
  );
  assert.deepEqual(
    paired.map((item) => [item.date, item.event]),
    [
      ["2024年", "项目提出"],
      ["2025年", "实施。"],
      ["2024年", "提出"],
    ]
  );
});

test("时间轴无正文日期时诚实返回，不让来源标题日期穿透", async () => {
  const corpus = "# TC609-5-2025-04《质量评测规范》\n4.2.3 规定应综合判断内容特征，正文没有事件日期。";
  assert.deepEqual(timelineDateTokens(timelineSourceBody(corpus)), []);
  const report = await reportFromCorpus(corpus, "timeline", { verify: false });
  assert.match(report.title, /来源无明确日期/);
  assert.match(report.content, /无法据此生成可靠时间线/);
  assert.doesNotMatch(report.content, /2025年4月/);
});

test("时间轴由结构化证据确定性渲染，模型无权改写日期、事件或来源", () => {
  const report = renderTimelineEvidence([
    {
      evidenceId: "s1:2",
      sourceId: "s1",
      sourceTitle: "行动方案",
      date: "2025年",
      sortKey: 20250101,
      excerpt: "2025年实施并完成验收。",
      event: "实施并完成验收。",
    },
    {
      evidenceId: "s1:1",
      sourceId: "s1",
      sourceTitle: "行动方案",
      date: "2024年",
      sortKey: 20240101,
      excerpt: "2024年提出试点方案。",
      event: "提出试点方案。",
    },
  ]);
  assert.match(report.content, /2024年[^\n]*提出试点方案[^\n]*行动方案/);
  assert.match(report.content, /2025年[^\n]*实施并完成验收[^\n]*行动方案/);
  assert.ok(report.content.indexOf("2024年") < report.content.indexOf("2025年"));
  assert.doesNotMatch(report.content, /虚构事件|其他来源/);
  const studio = read("lib/studio.ts");
  const corpusSource = read("lib/corpus.ts");
  const chatRoute = read("app/api/notebooks/[id]/chat/route.ts");
  assert.match(studio, /kind === "timeline"[\s\S]*buildTimelineEvidence/);
  assert.match(studio, /return renderTimelineEvidence\(evidence\)/);
  assert.match(corpusSource, /extractTimelineEvidence\(content/);
  assert.doesNotMatch(studio, /unsupportedTimelineDates/);
  assert.match(chatRoute, /skillId === "timeline"[\s\S]*buildTimelineEvidence/);
  assert.match(chatRoute, /renderTimelineEvidence\(evidence,\s*\{\s*includeCitationMarkers:\s*true\s*\}\)/);
  assert.match(chatRoute, /groundChatAnswerCitations\(full, timelineChunks\)/);
  assert.doesNotMatch(
    chatRoute.match(/if \(skillId === "timeline"\)[\s\S]*?return;\n\s*}/)?.[0] ?? "",
    /addMessage\(notebookId,\s*"assistant",\s*full,\s*\[\]\)|type:\s*"done"[^}]*citations:\s*\[\]/,
    "有时间线证据时不能再固定保存或返回空引用"
  );
});

test("测验先解析语义特征，具体解析留在制品内而非泄漏客户端提示词", () => {
  const server = read("lib/studio.ts");
  const client = read("components/Studio.tsx");
  assert.match(server, /silently PARSE sectioned source text into semantic features/);
  assert.match(server, /NEVER use a bare multi-level clause\/heading number/);
  assert.match(server, /maskQuizSectionReferences/);
  assert.match(server, /USER-PROVIDED AUTHORING CONSTRAINTS ARE NOT QUIZ SUBJECT MATTER/);
  assert.match(server, /name the semantic criterion being tested/);
  assert.doesNotMatch(client, /请做“具体解析”/);
  assert.doesNotMatch(client, /askText\s*=/);
  assert.match(client, /analysisIdx/);
  assert.match(client, /analysisCompleteFor/);
  assert.match(client, /q\.options\.every/);
  assert.match(client, /具体解析/);
  assert.match(client, /判定标准、选项对照与易错点/);
  assert.match(server, /function hasSectionReference/);
  assert.match(server, /normalize\("NFKC"\)/);
  assert.match(server, /function strictAnswerIndex/);
  assert.match(server, /function validateQuizItem/);
  assert.match(server, /QUIZ_GROUNDING_AUDIT/);
});

test("测验真模型脚本不依赖旧 SQLite，并覆盖 UI 题量与难度矩阵", () => {
  const script = read("scripts/quiz-realrun.mts");
  assert.doesNotMatch(script, /getDb\(|\.prepare\(/);
  assert.match(script, /quizFromCorpus/);
  assert.match(script, /6,10,15/);
  assert.match(script, /easy,medium,hard/);
  assert.match(script, /--quick/);
});

test("概览/测验存笔记必须等真实结果，测验保留完整解析与生成配置", () => {
  const home = read("components/HomeClient.tsx");
  const studio = read("components/Studio.tsx");
  assert.match(home, /const ok = await onSaveNote\(summary\)/);
  assert.match(home, /onQuizSaveNote=\{async \(t, c\) => !!\(await addNote/);
  assert.match(studio, /const ok = await onSaveNote\(output\.title, asNote\(\)\)/);
  assert.match(studio, /逐项解析:/);
  assert.match(studio, /q\.hint \? `💡 提示:/);
  assert.match(studio, /sourceTitles\(q\)\.length \? `来源:/);
  assert.match(studio, /sourceTitles\(q\)\.join\("、"\)/);
  assert.match(studio, /questionTypeLabel\(q\.type\) \? `题型:/);
  assert.match(studio, /recall: "记忆"/);
  assert.match(studio, /raw\.generation/);
  assert.match(studio, /含补充说明/);
});

test("来源导读响应后执行使用 after + 有界重试 + DB 租约恢复", () => {
  const route = read("app/api/notebooks/[id]/sources/route.ts");
  assert.match(route, /import \{ after, NextRequest, NextResponse \} from "next\/server"/);
  assert.match(route, /ENRICH_RETRY_DELAYS_MS = \[0, 500, 1_500\]/);
  assert.match(route, /action: "source\.enrich_failed"/);
  assert.match(route, /claimSourceEnrichment\(sourceId\)/);
  assert.match(route, /scheduleSourceRecovery\(id, g\.id\)/);
  assert.match(route, /generateSourceGuide\(persisted\.title, persisted\.content\)/);
  assert.doesNotMatch(route, /void enrichAfterIngest/);
});

test("MiniMax 使用高自然度模型，并安全降级到离线系统语音", () => {
  const tts = read("lib/tts.ts");
  const audio = read("lib/audio.ts");
  const packageJson = read("package.json");
  const dockerfile = read("Dockerfile");
  assert.match(tts, /model: "speech-2\.8-hd"/);
  assert.match(tts, /language_boost: "auto"/);
  assert.match(tts, /sample_rate: 32000, bitrate: 128000/);
  assert.match(tts, /const renderAll = async/);
  assert.match(tts, /minimax episode failed, restarting with system voice/);
  assert.match(tts, /run\("espeak-ng"/);
  assert.doesNotMatch(tts, /edge-tts|MsEdgeTTS|OUTPUT_FORMAT/);
  assert.doesNotMatch(packageJson, /msedge-tts|crypto-browserify|"elliptic"/);
  assert.match(dockerfile, /ffmpeg espeak-ng chromium/);
  assert.match(tts, /const preferredEngine = requestedEngine/);
  assert.match(audio, /preferredEngine === "minimax" && engine !== "minimax"/);
  assert.match(audio, /BRAND_OUTRO_PROFILE = "speech-2\.8-hd-wise-women-v1"/);
  for (const oldId of ["female-yujie", "male-qn-jingying", "audiobook_male_1", "presenter_female", "presenter_male", "English_Trustworth_Man"]) {
    assert.doesNotMatch(`${tts}\n${read("components/studio-shared.ts")}`, new RegExp(oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const allowed = new Set([
    "Chinese (Mandarin)_Wise_Women",
    "Chinese (Mandarin)_Gentleman",
    "Chinese (Mandarin)_Warm_Bestie",
    "Chinese (Mandarin)_Sincere_Adult",
    "Chinese (Mandarin)_Radio_Host",
    "Chinese (Mandarin)_News_Anchor",
    "Chinese (Mandarin)_Male_Announcer",
    "English_Graceful_Lady",
    "English_Trustworthy_Man",
    "English_Gentle-voiced_man",
  ]);
  for (const preset of VOICE_PRESETS) {
    for (const pair of Object.values(preset.voices)) {
      for (const voice of pair ?? []) assert.ok(allowed.has(voice), `${preset.key}: ${voice}`);
    }
  }
  assert.doesNotMatch(read("components/studio-shared.ts"), /English_Whispering_girl/);
});

test("Sheet 页签和思维导图都有可发现的横向导航", () => {
  const table = read("components/TableSheet.tsx");
  const css = read("app/globals.css");
  const mindmap = read("components/MindMapEditor.tsx");
  assert.match(table, /工作表标签，可横向滚动查看全部 Sheet/);
  assert.match(table, /tabStrip\.scrollLeft = Math\.max/);
  assert.match(table, /new MutationObserver/);
  assert.match(table, /has-sheet-scroll-controls/);
  assert.match(table, /table-sheet-scroll-controls/);
  assert.match(table, /addEventListener\("input", guardLiveEditorInput, true\)/);
  assert.match(table, /sanitizeSpreadsheetEditorInput\(target\)/);
  assert.match(table, /removeEventListener\("input", guardLiveEditorInput, true\)/);
  assert.match(css, /\.x-spreadsheet-bottombar[\s\S]*overflow: hidden !important/);
  assert.match(css, /\.table-sheet-scroll-button/);
  assert.match(mindmap, /panHorizontally/);
  assert.match(mindmap, /const remaining = direction > 0/);
  assert.match(mindmap, /disabled=\{!panAvailability\.left\}/);
  assert.match(mindmap, /geometryEvents = \["move", "scale", "expandNode", "operation"\]/);
  assert.match(mindmap, /const lowerBound = Math\.min/);
  assert.match(mindmap, /aria-label="横向平移思维导图"/);
  assert.match(mindmap, /查看思维导图左侧/);
  assert.match(mindmap, /查看思维导图右侧/);
});

test("显式取消全部来源后前后端均拒绝静默回退到全部来源", () => {
  const home = read("components/HomeClient.tsx");
  const route = read("app/api/notebooks/[id]/studio/route.ts");
  assert.match(home, /selectedSourceIds=\{selectedIds\}/);
  assert.match(home, /hasSources=\{selectedIds\.length > 0\}/);
  assert.doesNotMatch(home, /selectedIds\.length \? selectedIds : readySourceIds/);
  assert.match(route, /Array\.isArray\(body\.sourceIds\) && !sourceIds\?\.length/);
  assert.match(route, /请至少勾选一个来源后再生成/);
});
