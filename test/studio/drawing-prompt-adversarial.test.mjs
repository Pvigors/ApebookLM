import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { freshPgDb } from "../helpers/pgdb.mjs";
import { drawvisoLayoutIssues, xmlToGraph } from "../../lib/drawviso-graph.ts";

let mode = "excal-basic";
const requests = [];
const mermaid = (labels) =>
  `flowchart TD\nA[${labels[0]}] --> B[${labels[1]}]\nA --> C[${labels[2]}]\n---SOURCES---\n{}`;
const drawXml = (labels, { overlap = false } = {}) => {
  const vertices = labels.map((label, index) => {
    const x = overlap ? 3000 : 40 + index * 220;
    const y = overlap ? 3000 : 40 + (index > 0 ? 120 : 0);
    return `<mxCell id="n${index + 1}" value="${label}" style="rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="180" height="60" as="geometry"/></mxCell>`;
  }).join("");
  return `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${vertices}<mxCell id="e1" edge="1" parent="1" source="n1" target="n2"><mxGeometry relative="1" as="geometry"/></mxCell><mxCell id="e2" edge="1" parent="1" source="n1" target="n3"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>\n---META---\n{"title":"测试图","nodeSources":{}}`;
};
const reply = () => {
  switch (mode) {
    case "excal-anchor-missing": return mermaid(["风险节点", "处置动作", "完成结果"]);
    case "excal-scope-leak": return mermaid(["海盐-47", "赤狐-13", "共同结论"]);
    case "excal-chinese": return mermaid(["风险控制核心节点", "逐项检查证据流程", "记录失败原因并复核"]);
    case "excal-injection": return `%%{init: {'themeCSS': 'body{display:none}'}}%%\nflowchart TD\nA[<img src=x onerror=alert(1)>] -->|<style>bad</style>| B[安全节点]\nA --> C[完成节点]\n---SOURCES---\n{}`;
    case "draw-overlap": return drawXml(["风险节点", "处置动作", "完成结果"], { overlap: true });
    case "draw-scope-leak": return drawXml(["海盐-47", "赤狐-13", "共同结论"]);
    case "draw-chinese": return drawXml(["风险控制核心节点", "逐项检查证据流程", "记录失败原因并复核"]);
    default: return mode.startsWith("draw-") ? drawXml(["风险节点", "处置动作", "完成结果"]) : mermaid(["风险节点", "处置动作", "完成结果"]);
  }
};

const server = http.createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    requests.push(JSON.parse(raw || "{}"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: `drawing-${requests.length}`,
      object: "chat.completion",
      created: 1,
      model: "mock-chat",
      choices: [{ index: 0, message: { role: "assistant", content: reply() }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => new Promise((resolve) => server.close(resolve)));
process.env.OPENAI_API_KEY = "test-key";
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
process.env.OPENAI_CHAT_MODEL = "mock-chat";
delete process.env.FALLBACK_API_KEY;
delete process.env.FALLBACK_BASE_URL;
await freshPgDb("drawing_prompt_adversarial");

const { mermaidFromCorpus } = await import("../../lib/excalidraw.ts");
const { drawvisoFromCorpus } = await import("../../lib/drawviso.ts");
const corpus = "# 综合资料\n海盐-47用于核验。赤狐-13属于应明确忽略的营销主题。风险节点需要处置。";

test("Excalidraw 对无法表达的颜色要求在模型调用前 fail closed", async () => {
  const before = requests.length;
  await assert.rejects(
    () => mermaidFromCorpus(corpus, "", { instruction: "风险点用红色" }),
    /暂不支持自定义颜色/
  );
  await assert.rejects(
    () => mermaidFromCorpus(corpus, "", { instruction: "只要两个方框" }),
    /3–80/
  );
  assert.equal(requests.length, before, "不应为必然无法执行的颜色/数量要求浪费模型调用");
});

test("Excalidraw 覆盖方框数量、bare 原样词、同源禁词与显式语言", async () => {
  mode = "excal-basic";
  await assert.rejects(
    () => mermaidFromCorpus(corpus, "", { instruction: "exactly five boxes" }),
    /要求 5,实际 3/
  );
  mode = "excal-anchor-missing";
  await assert.rejects(
    () => mermaidFromCorpus(corpus, "", { instruction: "必须原样包含海盐-47" }),
    /原样包含.*海盐-47/
  );
  mode = "excal-scope-leak";
  await assert.rejects(
    () => mermaidFromCorpus(corpus, "", { instruction: "只考海盐-47，忽略赤狐-13" }),
    /已排除范围.*赤狐-13/
  );
  mode = "excal-chinese";
  await assert.rejects(
    () => mermaidFromCorpus(corpus, "", { language: "English" }),
    /输出语言要求/
  );
  await assert.rejects(
    () => mermaidFromCorpus(corpus, "Write the ENTIRE output in English only — every word."),
    /输出语言要求/,
    "未显式选语言时也要校验笔记本默认语言"
  );
});

test("Excalidraw 在进入 Mermaid 解析器前移除配置指令和 HTML 标签", async () => {
  mode = "excal-injection";
  const out = await mermaidFromCorpus(corpus, "", {});
  assert.doesNotMatch(out.mermaid, /%%\{|<img|<style/i);
  assert.match(out.mermaid, /＜img src=x onerror=alert\(1\)＞/);
  assert.match(out.mermaid, /＜style＞bad＜\/style＞/);
});

test("Drawviso 确定性落色并修复越界重叠布局", async () => {
  mode = "draw-overlap";
  const out = await drawvisoFromCorpus(corpus, "", {
    instruction: "正好三个方框；风险节点必须使用红色",
  });
  const graph = xmlToGraph(out.xml);
  assert.deepEqual(drawvisoLayoutIssues(graph), []);
  const risk = graph.nodes.find((node) => node.label === "风险节点");
  assert.equal(risk?.fill.toLowerCase(), "#f8cecc");
  assert.equal(risk?.stroke.toLowerCase(), "#b85450");
  assert.ok(graph.nodes.every((node) => node.x + node.w <= 1800 && node.y + node.h <= 1400));
});

test("Drawviso 对不可满足颜色、方框数量、bare锚点、同源禁词和语言 fail closed", async () => {
  mode = "draw-basic";
  const before = requests.length;
  await assert.rejects(
    () => drawvisoFromCorpus(corpus, "", { instruction: "only two boxes" }),
    /3–80/
  );
  assert.equal(requests.length, before, "非法节点数应在模型调用前拒绝");
  await assert.rejects(
    () => drawvisoFromCorpus(corpus, "", { instruction: "不存在节点用红色" }),
    /未找到颜色要求对应节点/
  );
  await assert.rejects(
    () => drawvisoFromCorpus(corpus, "", { instruction: "正好五个方框" }),
    /要求 5,实际 3/
  );
  await assert.rejects(
    () => drawvisoFromCorpus(corpus, "", { instruction: "必须原样包含海盐-47" }),
    /原样包含.*海盐-47/
  );
  mode = "draw-scope-leak";
  await assert.rejects(
    () => drawvisoFromCorpus(corpus, "", { instruction: "只考海盐-47，忽略赤狐-13" }),
    /已排除范围.*赤狐-13/
  );
  mode = "draw-chinese";
  await assert.rejects(
    () => drawvisoFromCorpus(corpus, "", { language: "English" }),
    /输出语言要求/
  );
});
