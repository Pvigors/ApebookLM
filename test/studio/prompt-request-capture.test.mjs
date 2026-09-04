import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { freshPgDb } from "../helpers/pgdb.mjs";

const requests = [];
let behaviorMode = "valid";
const replyFor = (body) => {
  const system = String(body?.messages?.[0]?.content ?? "");
  if (/audio brief|scripting a .*host/i.test(system)) {
    const count = behaviorMode === "audio-short" ? 2 : 4;
    return JSON.stringify({ language: "zh", title: "海盐播客", turns: Array.from({ length: count }, (_, i) => ({ speaker: "A", text: `第${i + 1}段讲清海盐-47。` })) });
  }
  if (/video overview/i.test(system)) {
    const count = behaviorMode === "video-short" ? 2 : 5;
    return JSON.stringify({ language: "zh", title: "海盐视频", slides: Array.from({ length: count }, (_, i) => ({ title: `第${i + 1}页`, bullets: ["海盐-47"], narration: `这一页解释海盐-47的第${i + 1}个来源事实。` })) });
  }
  if (/infographic POSTER/i.test(system)) {
    const count = behaviorMode === "infographic-short" ? 2 : 4;
    return JSON.stringify({ language: "zh", title: "海盐图解", subtitle: "来源摘要", blocks: Array.from({ length: count }, (_, i) => ({ type: "points", title: `模块${i + 1}`, items: [{ label: "海盐-47", text: "来源事实" }, { label: "应用", text: "具体场景" }] })), takeaway: "海盐-47" });
  }
  if (/presentation designer/i.test(system)) {
    const count = behaviorMode === "slides-wrong-count" ? 2 : 1;
    return JSON.stringify({ language: "zh", title: "海盐演示", slides: Array.from({ length: count }, (_, i) => ({ layout: "bullets", title: `海盐-47-${i + 1}`, bullets: ["海盐-47是来源中的核验锚点"] })) });
  }
  if (/Xiaohongshu\/RED/i.test(system)) {
    const count = behaviorMode === "xhs-short" ? 2 : 4;
    return JSON.stringify({ title: "海盐卡组", cover: { hook: "别错过", title: "海盐-47", sub: "来源知识" }, cards: Array.from({ length: count }, (_, i) => ({ heading: `要点${i + 1}`, points: ["海盐-47", "来源事实"] })), outro: { summary: "海盐-47", cta: "收藏复习" } });
  }
  if (/Create study flashcards/i.test(system)) {
    const count = behaviorMode === "flashcards-short" ? 2 : 4;
    return JSON.stringify({ title: "海盐闪卡", cards: Array.from({ length: count }, (_, i) => ({ front: `问题${i + 1}`, back: `海盐-47答案${i + 1}` })) });
  }
  if (/multiple-choice quiz/i.test(system)) {
    const types = ["recall", "recall", "application", "rationale"];
    const stems = ["海盐-47是什么？", "来源中的核验锚点是什么？", "如果要核验结果，应选择哪个锚点？", "为什么海盐-47适合作为核验锚点？"];
    return JSON.stringify({ title: "海盐测验", questions: [1, 2, 3, 4].map((n, i) => ({ type: types[i], q: stems[i], options: ["海盐-47", "选项乙", "选项丙", "选项丁"], answer: 0, explanations: ["海盐-47符合来源定义", "选项乙不符合来源条件", "选项丙混淆了适用范围", "选项丁不满足来源步骤"], hint: "回想来源锚点", source: "蓝源" })) });
  }
  if (/act as a data analyst/i.test(system)) {
    return "标题: 海盐数据表\n\n**海盐指标**\n| 指标 | 内容 |\n|---|---|\n| 核验锚点 | 海盐-47 |\n| 来源 | 蓝源事实 |";
  }
  if (/Excalidraw-ready Mermaid/i.test(system)) {
    return 'flowchart TD\nA[海盐-47] --> B[来源事实]\nA --> C[应用场景]\n---SOURCES---\n{"海盐-47":"蓝源","来源事实":"蓝源","应用场景":"蓝源"}';
  }
  if (/mxGraphModel/i.test(system)) {
    return '<mxGraphModel dx="800" dy="600" grid="0" page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n1" value="海盐-47" style="rounded=1;whiteSpace=wrap;html=0;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="180" height="60" as="geometry"/></mxCell><mxCell id="n2" value="来源事实" style="rounded=1;whiteSpace=wrap;html=0;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1"><mxGeometry x="260" y="160" width="180" height="60" as="geometry"/></mxCell><mxCell id="n3" value="应用场景" style="rounded=1;whiteSpace=wrap;html=0;fillColor=#ffe6cc;strokeColor=#d79b00;" vertex="1" parent="1"><mxGeometry x="480" y="160" width="180" height="60" as="geometry"/></mxCell><mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=0;" edge="1" parent="1" source="n1" target="n2"><mxGeometry relative="1" as="geometry"/></mxCell><mxCell id="e2" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=0;" edge="1" parent="1" source="n1" target="n3"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>\n---META---\n{"title":"海盐图","nodeSources":{"海盐-47":"蓝源","来源事实":"蓝源","应用场景":"蓝源"}}';
  }
  if (/mind map/i.test(system)) {
    return "# 海盐知识\n## 核心\n### 定义\n- 海盐-47\n## 应用\n### 场景\n- 具体事实";
  }
  if (behaviorMode === "report-missing" && /write a briefing/i.test(system)) return "标题: 核验流程简报\n\n执行摘要：来源中给出了一个明确核验锚点，用于检查生成结果。\n本文涵盖：锚点定义、核验流程和适用边界。\n## 锚点定义\n该锚点用于检查来源事实，帮助读者确认内容范围。\n## 核验流程\n先确认目标，再检查证据，最后记录结论。\n## 分歧与局限\n来源没有提供核验流程以外的其它结论。";
  if (/create a study guide/i.test(system)) return "标题: 海盐学习指南\n\n## 核心概念与定义\n海盐-47是来源中的核验锚点。\n## 操作流程与步骤\n确认目标、检查证据、记录结论。\n## 常见误区\n不要跳过证据检查。\n## 适用场景与选择\n适合核验来源事实。\n## 复习问题与答案\n海盐-47是什么？它是核验锚点。";
  if (/write a briefing/i.test(system)) return "标题: 海盐核验简报\n\n执行摘要：海盐-47是来源中的核验锚点，用于检查生成结果。\n本文涵盖：锚点定义、核验流程与局限。\n## 锚点定义\n海盐-47用于核验来源事实，帮助读者确认内容范围。\n## 核验流程\n先确认目标，再检查证据，最后记录结论。\n## 分歧与局限\n来源没有提供超出核验流程的其他结论。";
  if (/generate 8-12 FAQ/i.test(system)) return `标题: 海盐常见问答\n\n${Array.from({length:8},(_,i)=>`${i+1}. 海盐-47核验问题${i+1}？\n答：依据来源执行目标确认、证据检查与结论记录。`).join("\n")}`;
  if (/structured outline \/ table of contents/i.test(system)) return "标题: 海盐目录\n\n- 海盐-47核验\n  - 目标确认：明确本次核验范围\n  - 证据检查：逐项对应来源事实\n  - 结论记录：保存检查结果\n- 应用范围\n  - 来源事实复核：确保生成内容能够回到来源\n  - 结果交接：保留后续处理所需记录";
  if (/engaging, well-structured blog/i.test(system)) return "标题: 海盐核验方法\n\n海盐-47为什么值得关注？它让来源核验拥有明确锚点。\n## 从目标开始\n先确认目标范围，再决定需要检查的来源证据。\n## 用证据收束\n逐项检查证据并记录结论，避免加入来源没有的信息。\n## 结语\n把海盐-47作为核验锚点，可以让结果回到来源。";
  return "标题: 海盐专题\n\n## 核心结论\n\n海盐-47是来源中明确给出的核验锚点。本报告围绕它说明适用范围、操作步骤、边界条件和具体应用，并保留所有来源支持的事实细节，供读者直接复核和执行。";
};

const server = http.createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    const content = replyFor(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: `mock-${requests.length}`,
      object: "chat.completion",
      created: 1,
      model: "mock-chat",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => new Promise((resolve) => server.close(resolve)));
const address = server.address();
process.env.OPENAI_API_KEY = "test-key";
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
process.env.OPENAI_CHAT_MODEL = "mock-chat";
delete process.env.FALLBACK_API_KEY;
delete process.env.FALLBACK_BASE_URL;
await freshPgDb("studio_prompt_capture");

const studio = await import("../../lib/studio.ts");
const audio = await import("../../lib/audio.ts");
const video = await import("../../lib/video.ts");
const infographic = await import("../../lib/infographic.ts");
const slides = await import("../../lib/slides.ts");
const excalidraw = await import("../../lib/excalidraw.ts");
const xhs = await import("../../lib/xhs.ts");
const drawviso = await import("../../lib/drawviso.ts");

const corpus = "# 蓝源\n海盐-47是来源中明确存在的核验锚点。它用于验证生成要求是否真正传入最终模型请求。";
const transportSentinel = "PROMPT-TRANSPORT-ZHUQUE-8127";
const instruction = `必须原样包含「海盐-47」；生成侧传输哨兵 ${transportSentinel}`;

test("真实 SDK 请求捕获：17 类模型生成器都把用户要求送到最终模型请求", async () => {
  requests.length = 0;
  for (const kind of ["study_guide", "briefing", "faq", "toc", "blog", "table"]) {
    await studio.reportFromCorpus(corpus, kind, { instruction, verify: false });
  }
  await studio.mindmapFromCorpus(corpus, studio.genHintText({ instruction }));
  await audio.dialogueFromCorpus(corpus, "", { format: "brief", length: "shorter", focus: instruction, verify: false });
  await video.deckFromCorpus(corpus, "", { focus: instruction, verify: false });
  await infographic.generateSpecFromCorpus(corpus, `\n额外要求:${instruction}`, "", instruction);
  await slides.slidesFromCorpus(corpus, "", { instruction: `只需要一页；${instruction}`, verify: false });
  await excalidraw.mermaidFromCorpus(corpus, "", { instruction: `正好3个节点；${instruction}` });
  await xhs.generateDeckFromCorpus(corpus, `\n额外要求:${instruction}`, 4, instruction);
  await studio.flashcardsFromCorpus(corpus, "", { count: 4, instruction, verify: false });
  await studio.quizFromCorpus(corpus, "", { count: 4, instruction, verify: false });
  await studio.customReportFromCorpus(corpus, instruction, "", { verify: false });
  await drawviso.drawvisoFromCorpus(corpus, "", { instruction: `正好3个节点；${instruction}` });

  assert.equal(requests.length, 17);
  assert.doesNotMatch(corpus, new RegExp(transportSentinel), "传输哨兵不得从来源语料获得假阳性");
  for (const [index, request] of requests.entries()) {
    const finalPayload = JSON.stringify(request.messages);
    assert.match(finalPayload, new RegExp(transportSentinel), `第 ${index + 1} 个生成器最终请求缺少用户要求`);
  }
});

test("模型忽略可判定 Prompt 时不得保存为成功制品", async () => {
  const cases = [
    ["audio-short", () => audio.dialogueFromCorpus(corpus, "", { format: "brief", length: "shorter", focus: instruction, verify: false }), /生成播客对话失败/],
    ["video-short", () => video.deckFromCorpus(corpus, "", { focus: instruction, verify: false }), /生成视频脚本失败/],
    ["infographic-short", () => infographic.generateSpecFromCorpus(corpus, `\n额外要求:${instruction}`, "", instruction), /生成信息图失败/],
    ["xhs-short", () => xhs.generateDeckFromCorpus(corpus, `\n额外要求:${instruction}`, 4, instruction), /生成小红书卡组失败/],
    ["flashcards-short", () => studio.flashcardsFromCorpus(corpus, "", { count: 4, instruction }), /生成闪卡失败/],
    ["report-missing", () => studio.reportFromCorpus(corpus, "briefing", { instruction, verify: false }), /缺少原样措辞|质量门禁/],
  ];
  try {
    for (const [mode, run, expected] of cases) {
      behaviorMode = mode;
      await assert.rejects(run, expected, `${mode} 未被 Prompt 行为门禁拦截`);
    }
    behaviorMode = "slides-wrong-count";
    const repairedSlides = await slides.slidesFromCorpus(corpus, "", {
      instruction: `只需要一页；${instruction}`,
      verify: false,
    });
    assert.equal(repairedSlides.slides.length, 1, "PPT 超出用户页数时应确定性收敛到要求数量");
  } finally {
    behaviorMode = "valid";
  }
});
