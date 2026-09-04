import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("langgraph_litellm");

let gateway;
let direct;
let gatewayBase = "";
let directBase = "";
let gatewayMode = "success";
let gatewayCalls = 0;
let directCalls = 0;

function completion(model, content = "ok") {
  return JSON.stringify({
    id: "cmpl-test",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  });
}

before(async () => {
  gateway = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") return res.writeHead(404).end();
    gatewayCalls += 1;
    if (gatewayMode === "delay") {
      const timer = setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(completion("dashscope/qwen-plus"));
        }
      }, 2_000);
      req.on("close", () => clearTimeout(timer));
      return;
    }
    if (gatewayMode === "rate") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error", code: "rate_limit" } }));
      return;
    }
    if (gatewayMode.startsWith("status:")) {
      const status = Number(gatewayMode.split(":")[1]);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `gateway ${status}`, type: "gateway_error" } }));
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (gatewayMode === "reset-after-body") {
        req.socket.destroy();
        return;
      }
      if (gatewayMode === "stream-break") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({
          id: "chunk-test",
          object: "chat.completion.chunk",
          created: 1,
          model: "dashscope/qwen-plus",
          choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
        })}\n\n`);
        setTimeout(() => res.socket?.destroy(), 15);
        return;
      }
      const body = JSON.parse(raw || "{}");
      assert.equal(req.headers.authorization, "Bearer virtual-key");
      assert.equal(body.model, "apebook-chat");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(completion("dashscope/qwen-plus", "gateway"));
    });
  });
  direct = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") return res.writeHead(404).end();
    directCalls += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(completion("qwen-plus", "direct"));
    });
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => direct.listen(0, "127.0.0.1", resolve));
  gatewayBase = `http://127.0.0.1:${gateway.address().port}`;
  directBase = `http://127.0.0.1:${direct.address().port}/v1`;
  process.env.OPENAI_API_KEY = "direct-key";
  process.env.OPENAI_BASE_URL = directBase;
  process.env.OPENAI_CHAT_MODEL = "qwen-plus";
  delete process.env.FALLBACK_API_KEY;
  delete process.env.FALLBACK_BASE_URL;
  process.env.LITELLM_ENABLED = "1";
  process.env.LITELLM_BASE_URL = gatewayBase;
  process.env.LITELLM_API_KEY = "virtual-key";
  process.env.LITELLM_CHAT_MODEL = "apebook-chat";
  process.env.LITELLM_VISION_MODEL = "apebook-vision";
});

after(async () => {
  for (const key of [
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_CHAT_MODEL",
    "LITELLM_ENABLED", "LITELLM_BASE_URL", "LITELLM_API_KEY",
    "LITELLM_CHAT_MODEL", "LITELLM_VISION_MODEL", "LITELLM_EMERGENCY_DIRECT",
  ]) delete process.env[key];
  await new Promise((resolve) => gateway.close(resolve));
  await new Promise((resolve) => direct.close(resolve));
});

test("LangGraph.js 测验工作流按四阶段运行并输出可审计元数据", async () => {
  const { runQuizGenerationGraph } = await import("../../lib/quiz-workflow.ts");
  const phases = [];
  const result = await runQuizGenerationGraph({
    requestHash: "a".repeat(64),
    onPhase: (phase) => phases.push(phase),
    generate: async () => ({
      title: "图工作流测验",
      content: JSON.stringify({ questions: [{ q: "问题" }] }),
    }),
  });
  assert.deepEqual(phases, ["prepare", "generate", "verify", "complete"]);
  assert.equal(result.questionCount, 1);
  assert.equal(result.workflow.engine, "langgraphjs");
  assert.equal(result.workflow.version, 1);
});

test("LangGraph.js 在 signal 已取消时不进入昂贵生成节点", async () => {
  const { runQuizGenerationGraph } = await import("../../lib/quiz-workflow.ts");
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let calls = 0;
  await assert.rejects(
    runQuizGenerationGraph({
      requestHash: "b".repeat(64),
      signal: controller.signal,
      generate: async () => { calls += 1; return { title: "x", content: "{}" }; },
    }),
    /cancelled/
  );
  assert.equal(calls, 0);
});

test("LangGraph.js 生成中取消会终止节点，不进入 verify/complete", async () => {
  const { runQuizGenerationGraph } = await import("../../lib/quiz-workflow.ts");
  const controller = new AbortController();
  const phases = [];
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const running = runQuizGenerationGraph({
    requestHash: "c".repeat(64),
    signal: controller.signal,
    onPhase: (phase) => phases.push(phase),
    generate: async () => {
      startedResolve();
      await new Promise((resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
      return { title: "x", content: "{}" };
    },
  });
  await started;
  controller.abort(new Error("cancelled_during_generation"));
  await assert.rejects(running, /cancelled_during_generation/);
  assert.deepEqual(phases, ["prepare", "generate"]);
});

test("LangGraph.js 阶段栅栏失权时不启动生成器", async () => {
  const { runQuizGenerationGraph } = await import("../../lib/quiz-workflow.ts");
  let calls = 0;
  await assert.rejects(
    runQuizGenerationGraph({
      requestHash: "d".repeat(64),
      onPhase: async () => { throw new Error("run_attempt_lost"); },
      generate: async () => { calls += 1; return { title: "x", content: "{}" }; },
    }),
    /run_attempt_lost/
  );
  assert.equal(calls, 0);
});

test("LiteLLM 开启时先走网关 alias，并记录网关返回的实际模型", async () => {
  gatewayMode = "success";
  gatewayCalls = 0;
  directCalls = 0;
  process.env.LITELLM_EMERGENCY_DIRECT = "0";
  const { getOpenAI } = await import("../../lib/openai.ts");
  const result = await getOpenAI().chat.completions.create({
    model: "legacy-chat",
    messages: [{ role: "user", content: "ping" }],
  });
  assert.equal(result.choices[0].message.content, "gateway");
  assert.equal(result.model, "dashscope/qwen-plus");
  assert.equal(gatewayCalls, 1);
  assert.equal(directCalls, 0);
  const logged = await db.listAiCalls({ provider: "gateway", okOnly: "ok", limit: 1 });
  assert.equal(logged[0]?.model, "dashscope/qwen-plus");
  assert.equal(logged[0]?.tokens_in, 3);
  assert.equal(logged[0]?.tokens_out, 2);
  const usage = await db.getUsageStats(30);
  assert.ok(usage.byProvider.gateway.tokens >= 5);
});

test("LiteLLM 只配置 Virtual Key 也能独立运行", async () => {
  gatewayMode = "success";
  gatewayCalls = 0;
  directCalls = 0;
  const directKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.LITELLM_EMERGENCY_DIRECT = "0";
  try {
    const { getOpenAI } = await import("../../lib/openai.ts");
    const result = await getOpenAI().chat.completions.create({
      model: "legacy-chat",
      messages: [{ role: "user", content: "gateway-only" }],
    });
    assert.equal(result.choices[0].message.content, "gateway");
    assert.equal(gatewayCalls, 1);
    assert.equal(directCalls, 0);
  } finally {
    process.env.OPENAI_API_KEY = directKey;
  }
});

test("LiteLLM 429 不得绕过网关预算进入直连", async () => {
  gatewayMode = "rate";
  gatewayCalls = 0;
  directCalls = 0;
  process.env.LITELLM_EMERGENCY_DIRECT = "1";
  const { getOpenAI } = await import("../../lib/openai.ts");
  await assert.rejects(
    getOpenAI().chat.completions.create({
      model: "legacy-chat",
      messages: [{ role: "user", content: "ping" }],
    }),
    (error) => error?.status === 429
  );
  assert.equal(gatewayCalls, 1);
  assert.equal(directCalls, 0);
});

test("LiteLLM HTTP 错误矩阵均禁止紧急旁路", async () => {
  process.env.LITELLM_EMERGENCY_DIRECT = "1";
  const { getOpenAI } = await import("../../lib/openai.ts");
  for (const status of [400, 401, 403, 404, 500]) {
    gatewayMode = `status:${status}`;
    directCalls = 0;
    await assert.rejects(
      getOpenAI().chat.completions.create({
        model: "legacy-chat",
        messages: [{ role: "user", content: `status-${status}` }],
      }),
      (error) => error?.status === status
    );
    assert.equal(directCalls, 0, `HTTP ${status} 不得直连`);
  }
});

test("LiteLLM 网关收到请求后连接重置不得双重生成", async () => {
  gatewayMode = "reset-after-body";
  directCalls = 0;
  process.env.LITELLM_EMERGENCY_DIRECT = "1";
  const { getOpenAI } = await import("../../lib/openai.ts");
  await assert.rejects(getOpenAI().chat.completions.create({
    model: "legacy-chat",
    messages: [{ role: "user", content: "reset" }],
  }));
  assert.equal(directCalls, 0);
});

test("LiteLLM 已开始的流中断不得旁路", async () => {
  gatewayMode = "stream-break";
  directCalls = 0;
  process.env.LITELLM_EMERGENCY_DIRECT = "1";
  const { getOpenAI } = await import("../../lib/openai.ts");
  const stream = await getOpenAI().chat.completions.create({
    model: "legacy-chat",
    stream: true,
    messages: [{ role: "user", content: "stream" }],
  });
  let chunks = 0;
  await assert.rejects(async () => {
    for await (const _chunk of stream) chunks += 1;
  });
  assert.equal(chunks, 1);
  assert.equal(directCalls, 0);
});

test("LiteLLM 明确 ECONNREFUSED 且开关开启时允许一次紧急直连", async () => {
  const unavailable = http.createServer();
  await new Promise((resolve) => unavailable.listen(0, "127.0.0.1", resolve));
  const address = unavailable.address();
  await new Promise((resolve) => unavailable.close(resolve));
  const original = process.env.LITELLM_BASE_URL;
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.LITELLM_EMERGENCY_DIRECT = "1";
  directCalls = 0;
  try {
    const { getOpenAI } = await import("../../lib/openai.ts");
    const result = await getOpenAI().chat.completions.create({
      model: "legacy-chat",
      messages: [{ role: "user", content: "emergency" }],
    });
    assert.equal(result.choices[0].message.content, "direct");
    assert.equal(directCalls, 1);
  } finally {
    process.env.LITELLM_BASE_URL = original;
  }
});

test("LiteLLM 流程被取消时不触发紧急直连", async () => {
  gatewayMode = "delay";
  gatewayCalls = 0;
  directCalls = 0;
  process.env.LITELLM_EMERGENCY_DIRECT = "1";
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("user_cancelled")), 30);
  const { getOpenAI } = await import("../../lib/openai.ts");
  await assert.rejects(
    getOpenAI().chat.completions.create({
      model: "legacy-chat",
      messages: [{ role: "user", content: "ping" }],
    }, { signal: controller.signal }),
    /cancel|abort/i
  );
  assert.equal(gatewayCalls, 1);
  assert.equal(directCalls, 0);
});

test("网关策略读库失败时 fail closed，不回落 env 直连", async () => {
  const { getPool } = await import("../../lib/pg.ts");
  const pool = getPool();
  gatewayCalls = 0;
  directCalls = 0;
  await pool.query("ALTER TABLE app_settings RENAME TO app_settings_unavailable");
  try {
    const { getOpenAI } = await import("../../lib/openai.ts");
    await assert.rejects(
      getOpenAI().chat.completions.create({
        model: "legacy-chat",
        messages: [{ role: "user", content: "policy-db-down" }],
      }),
      /配置暂时无法读取/
    );
    assert.equal(gatewayCalls, 0);
    assert.equal(directCalls, 0);
  } finally {
    await pool.query("ALTER TABLE app_settings_unavailable RENAME TO app_settings");
  }
});

test("DB 显式关闭 LiteLLM 能覆盖环境变量开启", async () => {
  const { resolveProviderConfig } = await import("../../lib/openai.ts");
  await db.setSetting("provider.gateway.enabled", "0", "test");
  assert.equal((await resolveProviderConfig()).gateway, null);
  await db.deleteSetting("provider.gateway.enabled");
});
