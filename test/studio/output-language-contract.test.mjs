import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { freshPgDb } from "../helpers/pgdb.mjs";

let responseMode = "chinese";
const requests = [];
const replyFor = (body) => {
  const system = String(body?.messages?.[0]?.content ?? "");
  if (/audio brief|scripting a .*host/i.test(system)) {
    if (responseMode === "english-wrong-meta") return JSON.stringify({ language: "zh", title: "Source Review", turns: [1, 2, 3, 4].map((n) => ({ speaker: "A", text: `Segment ${n} explains the source review process and its practical use.` })) });
    return JSON.stringify({ language: "zh", title: "中文播客", turns: [1, 2, 3, 4].map((n) => ({ speaker: "A", text: `第${n}段说明海盐核验流程。` })) });
  }
  if (/video overview/i.test(system)) {
    if (responseMode === "english-wrong-meta") return JSON.stringify({ language: "zh", title: "Source Review Video", slides: [1, 2, 3, 4, 5].map((n) => ({ title: `Section ${n}`, bullets: ["Source evidence"], narration: "This section explains the source review process and its practical application." })) });
    return JSON.stringify({ language: "zh", title: "中文视频", slides: [1, 2, 3, 4, 5].map((n) => ({ title: `第${n}页`, bullets: ["海盐核验"], narration: "这一页用中文解释海盐核验流程及其应用。" })) });
  }
  if (/infographic POSTER/i.test(system)) {
    if (responseMode === "english-wrong-meta") return JSON.stringify({ language: "zh", title: "Source Review", subtitle: "A practical evidence workflow", blocks: [1, 2, 3, 4].map((n) => ({ type: "points", title: `Module ${n}`, items: [{ label: "Evidence", text: "Review the source facts" }, { label: "Action", text: "Record the next step" }] })), takeaway: "Keep every result traceable to its source" });
    return JSON.stringify({ language: "zh", title: "中文信息图", subtitle: "中文副标题", blocks: [1, 2, 3, 4].map((n) => ({ type: "points", title: `模块${n}`, items: [{ label: "海盐核验", text: "中文来源事实" }, { label: "应用场景", text: "中文操作说明" }] })), takeaway: "中文结论" });
  }
  if (/presentation designer/i.test(system)) {
    if (responseMode === "english-wrong-meta") return JSON.stringify({ language: "zh", title: "Source Review", slides: [{ layout: "bullets", title: "Evidence Workflow", bullets: ["Confirm the review target", "Record the supported conclusion"] }] });
    return JSON.stringify({ language: "zh", title: "中文演示", slides: [{ layout: "bullets", title: "海盐核验", bullets: ["中文来源事实", "中文应用场景"] }] });
  }
  if (/Xiaohongshu\/RED/i.test(system)) {
    if (responseMode === "english-wrong-meta") return JSON.stringify({ title: "Source Review Cards", cover: { hook: "Review evidence before publishing", title: "Source Review", sub: "A practical workflow" }, cards: [1, 2, 3, 4].map((n) => ({ heading: `Step ${n}`, points: ["Confirm the source fact", "Record a supported action"] })), outro: { summary: "Keep every result traceable" } });
    return JSON.stringify({ title: "中文卡组", cover: { hook: "中文钩子", title: "海盐核验", sub: "中文副题" }, cards: [1, 2, 3, 4].map((n) => ({ heading: `要点${n}`, points: ["中文来源事实", "中文应用说明"] })), outro: { summary: "中文总结", cta: "中文行动号召" } });
  }
  return "{}";
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
    res.end(JSON.stringify({ id: "mock-language", object: "chat.completion", created: 1, model: "mock-chat", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
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
await freshPgDb("output_language_contract");

const audio = await import("../../lib/audio.ts");
const video = await import("../../lib/video.ts");
const infographic = await import("../../lib/infographic.ts");
const slides = await import("../../lib/slides.ts");
const xhs = await import("../../lib/xhs.ts");
const corpus = "# 蓝源\n海盐核验流程包含目标、证据、结论和下一步，适用于产品复核。";

test("明显违背 English 的中文制品不能保存为成功输出", async () => {
  responseMode = "chinese";
  await assert.rejects(
    () => audio.dialogueFromCorpus(corpus, "", { format: "brief", length: "shorter", language: "English", verify: false }),
    /生成播客对话失败/
  );
  await assert.rejects(
    () => video.deckFromCorpus(corpus, "", { language: "English", verify: false }),
    /生成视频脚本失败/
  );
  await assert.rejects(
    () => infographic.generateSpecFromCorpus(corpus, "", "", undefined, "English"),
    /生成信息图失败/
  );
  await assert.rejects(
    () => slides.slidesFromCorpus(corpus, "", { instruction: "只需要一页", language: "English", verify: false }),
    /输出语言要求/
  );
  await assert.rejects(
    () => xhs.generateDeckFromCorpus(corpus, "", 4, undefined, "English"),
    /生成小红书卡组失败/
  );
});

test("可见文字合规时以生效语言覆盖模型错误 metadata，并识别笔记本默认 directive", async () => {
  responseMode = "english-wrong-meta";
  requests.length = 0;
  const a = await audio.dialogueFromCorpus(corpus, "", { format: "brief", length: "shorter", language: "English", verify: false });
  assert.equal(a.language, "English");
  const v = await video.deckFromCorpus(corpus, "", { language: "English", verify: false });
  assert.equal(v.language, "English");
  const i = await infographic.generateSpecFromCorpus(corpus, "", "", undefined, "English");
  assert.equal(i.language, "English");
  const s = await slides.slidesFromCorpus(corpus, "", { instruction: "只需要一页", language: "English", verify: false });
  assert.equal(s.language, "English");
  const x = await xhs.generateDeckFromCorpus(corpus, "", 4, undefined, "English");
  assert.match(x.title, /Source Review/);
  assert.match(x.outro.cta, /Save this post/);

  const notebookDefault = "Write the ENTIRE output in English only — every word.";
  const fromDefault = await audio.dialogueFromCorpus(
    corpus,
    notebookDefault,
    { format: "brief", length: "shorter", verify: false }
  );
  assert.equal(fromDefault.language, "English");
  assert.equal((await video.deckFromCorpus(corpus, notebookDefault, { verify: false })).language, "English");
  assert.equal((await infographic.generateSpecFromCorpus(corpus, notebookDefault)).language, "English");
  assert.equal((await slides.slidesFromCorpus(corpus, notebookDefault, { instruction: "只需要一页", verify: false })).language, "English");
  assert.match((await xhs.generateDeckFromCorpus(corpus, notebookDefault, 4)).outro.cta, /Save this post/);
  for (const marker of [/infographic POSTER/i, /Xiaohongshu\/RED/i]) {
    const request = requests.find((item) => marker.test(String(item.messages?.[0]?.content || "")));
    assert.match(JSON.stringify(request?.messages || []), /English/, `${marker} 最终请求必须携带显式语言`);
  }
});
