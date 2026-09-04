import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import sharp from "sharp";
import { freshPgDb } from "../helpers/pgdb.mjs";

process.env.PUBLIC_ORIGIN = "http://localhost";
process.env.MODEL_API_CONFIG_SECRET = "11".repeat(32);
delete process.env.MODEL_API_CONFIG_PREVIOUS_SECRET;

const db = await freshPgDb("user_model_config");
const { getPool } = await import("../../lib/pg.ts");
const { NextRequest } = await import("next/server");
const configRoute = await import("../../app/api/model-config/route.ts");
const testRoute = await import("../../app/api/model-config/test/route.ts");
const modelConfig = await import("../../lib/user-model-config.ts");
const providerContext = await import("../../lib/ai-provider-context.ts");
const { getOpenAI, CHAT_MODEL, requestBodyForUserProvider } = await import("../../lib/openai.ts");

const userA = await db.createUserByPhone("139" + "20001001", "接口用户甲");
const userB = await db.createUserByPhone("139" + "20001002", "接口用户乙");
const matrixUser = await db.createUserByPhone("139" + "20001003", "供应商矩阵用户");
const sessionA = await db.createSession(userA.id);
const sessionB = await db.createSession(userB.id);
const sessionMatrix = await db.createSession(matrixUser.id);
const keyA = "canary-user-a-secret-123456";
const keyB = "canary-user-b-secret-987654";

function request(path, { method = "GET", session = sessionA, origin = "http://localhost", body } = {}) {
  const headers = { cookie: `nb_session=${session}` };
  if (origin != null) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function save(session, providerId, chatModel, visionModel, apiKey, researchModel) {
  return configRoute.PUT(request("/api/model-config", {
    method: "PUT",
    session,
    body: {
      providerId,
      chatModel,
      visionModel,
      apiKey,
      ...(researchModel === undefined ? {} : { researchModel }),
    },
  }));
}

function completionResponse(model, content = "pong") {
  return new Response(JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("配置 API 要求登录、严格同源并拒绝任意 Base URL", async () => {
  const anonymous = await configRoute.GET(request("/api/model-config", { session: "missing" }));
  assert.equal(anonymous.status, 401);

  const noOrigin = await configRoute.PUT(request("/api/model-config", {
    method: "PUT",
    origin: null,
    body: { providerId: "dashscope", chatModel: "qwen-plus", visionModel: "qwen-vl-plus", apiKey: keyA },
  }));
  assert.equal(noOrigin.status, 403);

  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCount += 1; return completionResponse("never"); };
  try {
    const injected = await configRoute.PUT(request("/api/model-config", {
      method: "PUT",
      body: {
        providerId: "dashscope",
        chatModel: "qwen-plus",
        visionModel: "qwen-vl-plus",
        apiKey: keyA,
        baseUrl: "http://169.254.169.254/latest/meta-data",
      },
    }));
    assert.equal(injected.status, 400);
    assert.equal((await injected.json()).code, "unknown_field");
    assert.equal(fetchCount, 0, "被拒地址不得触发任何网络连接");

    const unsupportedVision = await configRoute.PUT(request("/api/model-config", {
      method: "PUT",
      body: {
        providerId: "deepseek",
        chatModel: "deepseek-v4-flash",
        visionModel: "fake-vision",
        researchModel: "deepseek-v4-pro",
        apiKey: keyA,
      },
    }));
    assert.equal(unsupportedVision.status, 400, "仅文本供应商不能绕过 UI 配置视觉模型");
    assert.match((await unsupportedVision.json()).error, /不支持视觉模型/);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("密钥以 AES-GCM 密文保存，研究模型兼容旧客户端且 GET 只返回末四位提示", async () => {
  const response = await save(sessionA, "dashscope", "qwen-plus", "qwen-vl-plus", keyA, "qwen-max");
  assert.equal(response.status, 200);
  let row = await db.getUserModelConfig(userA.id);
  assert.ok(row);
  assert.equal(row.enabled, 0, "保存后必须先测试，不能直接启用");
  assert.equal(row.tested_revision, 0);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(keyA));
  assert.equal(modelConfig.decryptUserModelApiKey(row), keyA);
  assert.equal(row.research_model, "qwen-max");
  const createdAt = row.created_at;
  const revisionAfterInsert = Number(row.revision);

  const legacyUpdate = await configRoute.PUT(request("/api/model-config", {
    method: "PUT",
    body: { providerId: "dashscope", chatModel: "qwen-plus", visionModel: "qwen-vl-plus" },
  }));
  assert.equal(legacyUpdate.status, 200);
  row = await db.getUserModelConfig(userA.id);
  assert.equal(row.research_model, "qwen-max", "旧客户端省略字段时必须保留研究模型");
  assert.equal(row.created_at, createdAt, "更新不得重写首次创建时间");
  assert.equal(Number(row.revision), revisionAfterInsert + 1);
  assert.equal(modelConfig.decryptUserModelApiKey(row), keyA, "二次 CAS 后密文参数位必须仍可解密");

  const explicitClear = await configRoute.PUT(request("/api/model-config", {
    method: "PUT",
    body: { providerId: "dashscope", chatModel: "qwen-plus", visionModel: "qwen-vl-plus", researchModel: "" },
  }));
  assert.equal(explicitClear.status, 200);
  assert.equal((await db.getUserModelConfig(userA.id)).research_model, "", "显式空串才清除研究模型");
  assert.equal((await configRoute.PUT(request("/api/model-config", {
    method: "PUT",
    body: { providerId: "dashscope", chatModel: "qwen-plus", visionModel: "qwen-vl-plus", researchModel: "qwen-max" },
  }))).status, 200);

  const switchedWithoutKey = await configRoute.PUT(request("/api/model-config", {
    method: "PUT",
    body: { providerId: "openai", chatModel: "gpt-4.1-mini", visionModel: "gpt-4.1-mini" },
  }));
  assert.equal(switchedWithoutKey.status, 400, "切换供应商不得复用上一家的密钥");
  assert.match((await switchedWithoutKey.json()).error, /必须输入.*新 API Key/);
  assert.equal((await db.getUserModelConfig(userA.id)).provider_id, "dashscope");

  const read = await configRoute.GET(request("/api/model-config"));
  assert.equal(read.status, 200);
  const payload = await read.json();
  assert.deepEqual(
    payload.providers.map((provider) => provider.id),
    ["dashscope", "openai", "openrouter", "deepseek", "kimi", "zhipu", "xai", "siliconflow"],
    "供应商目录必须保持稳定顺序并返回全部安全预设"
  );
  for (const provider of payload.providers) {
    assert.ok(provider.description.length >= 24, `${provider.id} 说明不得退化为过短标签`);
    assert.doesNotMatch(provider.description, /[\r\n]/, `${provider.id} 说明必须是单行文案`);
  }
  const zhipuPreset = payload.providers.find((provider) => provider.id === "zhipu");
  const siliconflowPreset = payload.providers.find((provider) => provider.id === "siliconflow");
  assert.deepEqual(zhipuPreset?.recommendedModelsByRole?.vision, ["glm-5v-turbo"]);
  assert.deepEqual(
    siliconflowPreset?.recommendedModelsByRole?.vision,
    ["Qwen/Qwen3.6-27B", "Qwen/Qwen3.6-35B-A3B"],
    "视觉用途不得推荐纯文本 DeepSeek 模型"
  );
  assert.equal(payload.config.keyHint, `••••${keyA.slice(-4)}`);
  assert.equal(payload.config.researchModel, "qwen-max");
  assert.equal(payload.config.apiKey, undefined);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(keyA));

  const currentMaster = process.env.MODEL_API_CONFIG_SECRET;
  delete process.env.MODEL_API_CONFIG_SECRET;
  process.env.MODEL_API_CONFIG_PREVIOUS_SECRET = currentMaster;
  assert.equal(modelConfig.modelConfigEncryptionReady(), false, "旧主密钥只能解密，不能承担新加密");
  const previousOnly = await configRoute.PUT(request("/api/model-config", {
    method: "PUT",
    body: { providerId: "dashscope", chatModel: "qwen-plus", visionModel: "qwen-vl-plus" },
  }));
  assert.equal(previousOnly.status, 503);
  process.env.MODEL_API_CONFIG_SECRET = currentMaster;
  delete process.env.MODEL_API_CONFIG_PREVIOUS_SECRET;
});

test("连接测试只请求固定供应商地址，成功后原子启用", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init?.headers ?? (typeof input === "string" ? undefined : input.headers));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({
      url,
      authorization: headers.get("authorization"),
      model: body.model,
      responseFormat: body.response_format,
      messages: body.messages,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      maxCompletionTokens: body.max_completion_tokens,
      reasoningEffort: body.reasoning_effort,
      thinking: body.thinking,
    });
    if (headers.get("authorization") === "Bearer invalid-api-key-1234") {
      return new Response(JSON.stringify({ error: { message: "invalid key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    if (body.model === "missing-vision-model") {
      return new Response(JSON.stringify({ error: { message: "model not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const content = body.model === "non-json-model"
      ? "pong"
      : body.response_format?.type === "json_object"
        ? '{"ok":true}'
        : "white";
    return completionResponse(body.model || "qwen-plus", content);
  };
  try {
    const response = await testRoute.POST(request("/api/model-config/test", { method: "POST" }));
    assert.equal(response.status, 200);
    assert.equal(calls.length, 3, "对话、研究与视觉模型都必须通过测试");
    assert.equal(calls[0].url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    assert.equal(calls[0].authorization, `Bearer ${keyA}`);
    assert.equal(calls[0].model, "qwen-plus");
    assert.equal(calls[0].responseFormat?.type, "json_object", "对话模型必须验证 JSON 能力");
    assert.equal(calls[1].model, "qwen-max");
    assert.equal(calls[1].responseFormat?.type, "json_object", "研究模型必须验证 JSON 能力");
    assert.equal(calls[2].model, "qwen-vl-plus");
    assert.equal(calls[2].messages?.[0]?.content?.[1]?.type, "image_url", "视觉模型必须真实执行多模态探测");
    assert.ok(calls.every((call) => call.temperature === undefined), "跨供应商探针不得强制 temperature=0");
    const probeUrl = calls[2].messages[0].content[1].image_url.url;
    assert.match(probeUrl, /^data:image\/png;base64,/);
    const decodedProbe = await sharp(Buffer.from(probeUrl.split(",", 2)[1], "base64"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual(
      {
        width: decodedProbe.info.width,
        height: decodedProbe.info.height,
        firstPixel: [...decodedProbe.data.subarray(0, 3)],
      },
      { width: 64, height: 64, firstPixel: [255, 255, 255] },
      "视觉探针必须通过真实像素解码，不能只伪造 PNG 元数据"
    );
    const row = await db.getUserModelConfig(userA.id);
    assert.equal(row.enabled, 1);
    assert.equal(row.tested_revision, row.revision);

    const providerMatrix = [
      {
        id: "kimi",
        chat: "kimi-k3",
        vision: "kimi-k3",
        research: "kimi-k3",
        endpoint: "https://api.moonshot.cn/v1/chat/completions",
        kimiK3: true,
      },
      {
        id: "kimi",
        chat: "kimi-k2.6",
        vision: "kimi-k2.6",
        research: "kimi-k2.6",
        endpoint: "https://api.moonshot.cn/v1/chat/completions",
        kimiK3: false,
      },
      {
        id: "zhipu",
        chat: "glm-4.7-flash",
        vision: "glm-5v-turbo",
        research: "glm-5.2",
        endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      },
      {
        id: "xai",
        chat: "grok-4.6",
        vision: "grok-4.6",
        research: "grok-4.6",
        endpoint: "https://api.x.ai/v1/chat/completions",
      },
      {
        id: "siliconflow",
        chat: "Qwen/Qwen3.6-27B",
        vision: "Qwen/Qwen3.6-27B",
        research: "deepseek-ai/DeepSeek-V4-Pro",
        endpoint: "https://api.siliconflow.cn/v1/chat/completions",
      },
    ];
    for (const candidate of providerMatrix) {
      calls.length = 0;
      const saved = await configRoute.PUT(request("/api/model-config", {
        method: "PUT",
        session: sessionMatrix,
        body: {
          providerId: candidate.id,
          chatModel: candidate.chat,
          visionModel: candidate.vision,
          researchModel: candidate.research,
          apiKey: keyA,
        },
      }));
      assert.equal(saved.status, 200, `${candidate.id} 预设必须可保存`);
      const tested = await testRoute.POST(request("/api/model-config/test", { method: "POST", session: sessionMatrix }));
      assert.equal(tested.status, 200, `${candidate.id} 预设必须通过完整能力探针`);
      assert.ok(calls.length >= 2, `${candidate.id} 必须分别验证结构化输出与视觉能力`);
      assert.ok(calls.every((call) => call.url === candidate.endpoint), `${candidate.id} 只能访问固定官方端点`);
      assert.ok(calls.every((call) => call.temperature === undefined), `${candidate.id} 探针不得发送不兼容的温度参数`);
      if (candidate.kimiK3) {
        assert.ok(calls.every((call) => call.maxCompletionTokens === 1024));
        assert.ok(calls.every((call) => call.reasoningEffort === "low"));
      } else {
        assert.ok(calls.every((call) => call.maxTokens === 512));
        if (candidate.id === "kimi") {
          assert.ok(calls.every((call) => call.reasoningEffort === undefined), "Kimi 非 K3 模型不得收到 K3 专用参数");
          assert.ok(calls.every((call) => call.thinking?.type === "disabled"), "Kimi K2.6 探针应关闭思考以避免短输出被截断");
        }
      }
    }

    const badVision = await configRoute.PUT(request("/api/model-config", {
      method: "PUT",
      body: { providerId: "dashscope", chatModel: "qwen-plus", visionModel: "missing-vision-model" },
    }));
    assert.equal(badVision.status, 200);
    const failed = await testRoute.POST(request("/api/model-config/test", { method: "POST" }));
    assert.equal(failed.status, 422);
    assert.equal((await db.getUserModelConfig(userA.id)).enabled, 0, "视觉模型失败不得启用整套配置");

    assert.equal((await configRoute.PUT(request("/api/model-config", {
      method: "PUT",
      body: { providerId: "dashscope", chatModel: "qwen-plus", visionModel: "qwen-vl-plus" },
    }))).status, 200);
    assert.equal((await testRoute.POST(request("/api/model-config/test", { method: "POST" }))).status, 200);

    assert.equal((await configRoute.PUT(request("/api/model-config", {
      method: "PUT",
      body: {
        providerId: "dashscope",
        chatModel: "non-json-model",
        visionModel: "",
        researchModel: "",
      },
    }))).status, 200);
    const nonJson = await testRoute.POST(request("/api/model-config/test", { method: "POST" }));
    assert.equal(nonJson.status, 422, "HTTP 200 但正文不是 JSON 时不得假报能力通过");
    assert.equal((await nonJson.json()).code, "model_unavailable");

    assert.equal((await configRoute.PUT(request("/api/model-config", {
      method: "PUT",
      body: {
        providerId: "dashscope",
        chatModel: "qwen-plus",
        visionModel: "qwen-vl-plus",
        researchModel: "qwen-max",
        apiKey: "invalid-" + "api-key-1234",
      },
    }))).status, 200);
    const invalidKey = await testRoute.POST(request("/api/model-config/test", { method: "POST" }));
    assert.equal(invalidKey.status, 422, "第三方密钥无效不得冒充猿笔记会话 401");
    assert.equal((await invalidKey.json()).code, "key_invalid");

    assert.equal((await configRoute.PUT(request("/api/model-config", {
      method: "PUT",
      body: {
        providerId: "dashscope",
        chatModel: "qwen-plus",
        visionModel: "qwen-vl-plus",
        apiKey: keyA,
      },
    }))).status, 200);
    assert.equal((await testRoute.POST(request("/api/model-config/test", { method: "POST" }))).status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("两用户并发调用严格隔离密钥与对话/研究模型，个人接口不走平台缓存", async () => {
  assert.equal((await save(sessionB, "openai", "gpt-user-b", "gpt-user-b", keyB, "gpt-research-b")).status, 200);
  const originalFetch = globalThis.fetch;
  const testCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init?.headers ?? (typeof input === "string" ? undefined : input.headers));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    testCalls.push({
      url,
      authorization: headers.get("authorization"),
      model: body.model,
      responseFormat: body.response_format,
      messages: body.messages,
      temperature: body.temperature,
    });
    return completionResponse(
      body.model,
      body.response_format?.type === "json_object" ? '{"ok":true}' : "white"
    );
  };
  try {
    assert.equal((await testRoute.POST(request("/api/model-config/test", { method: "POST", session: sessionB }))).status, 200);
    const sharedRoleCalls = testCalls.filter((call) => call.model === "gpt-user-b");
    assert.equal(sharedRoleCalls.length, 2, "同一模型兼任对话和视觉时必须分别验证两种能力");
    assert.ok(sharedRoleCalls.some((call) => call.responseFormat?.type === "json_object"));
    assert.ok(sharedRoleCalls.some((call) => call.messages?.[0]?.content?.[1]?.type === "image_url"));
    testCalls.length = 0;
    const refA = await modelConfig.snapshotUserModelProviderRef(userA.id);
    const refB = await modelConfig.snapshotUserModelProviderRef(userB.id);
    const [runtimeA, runtimeB] = await Promise.all([
      modelConfig.resolveUserModelRuntime(userA.id, refA),
      modelConfig.resolveUserModelRuntime(userB.id, refB),
    ]);
    const privateNotebook = await db.createNotebook(userA.id, "个人接口边界", "📓");
    const privateRef = await modelConfig.snapshotModelProviderRef(userA.id, privateNotebook);
    assert.equal(privateRef.mode, "user");
    await db.addCollaborator(privateNotebook.id, userB.id, "editor");
    assert.deepEqual(
      await modelConfig.snapshotModelProviderRef(userA.id, privateNotebook),
      { mode: "platform" },
      "存在协作者的私有笔记本也必须走平台"
    );
    await assert.rejects(
      () => modelConfig.resolveUserModelRuntimeForNotebook(userA.id, privateNotebook, privateRef),
      (error) => error?.code === "config_stale"
    );
    await providerContext.withUserModelRuntime(runtimeA, async () => {
      assert.equal(providerContext.currentUserModelRuntime()?.userId, userA.id);
      await providerContext.withUserModelRuntime(null, async () => {
        assert.equal(providerContext.currentUserModelRuntime(), undefined, "显式平台边界必须清空外层个人配置");
      });
      assert.equal(providerContext.currentUserModelRuntime()?.userId, userA.id);
    });
    await Promise.all([
      providerContext.withUserModelRuntime(runtimeA, () => getOpenAI().chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: "a" }],
      })),
      providerContext.withUserModelRuntime(runtimeB, () => getOpenAI().chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: "b" }],
      })),
      providerContext.withUserModelRuntime({ ...runtimeA, requestClass: "research" }, () => getOpenAI().chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: "research-a" }],
      })),
      providerContext.withUserModelRuntime({ ...runtimeB, requestClass: "research" }, () => getOpenAI().chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: "research-b" }],
      })),
    ]);
    assert.deepEqual(
      testCalls.map((call) => [call.url, call.authorization, call.model]).sort((a, b) => a[2].localeCompare(b[2])),
      [
        ["https://api.openai.com/v1/chat/completions", `Bearer ${keyB}`, "gpt-user-b"],
        ["https://api.openai.com/v1/chat/completions", `Bearer ${keyB}`, "gpt-research-b"],
        ["https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", `Bearer ${keyA}`, "qwen-plus"],
        ["https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", `Bearer ${keyA}`, "qwen-max"],
      ].sort((a, b) => a[2].localeCompare(b[2]))
    );
    await assert.rejects(
      () => providerContext.withUserModelRuntime({ ...runtimeA, visionModel: "" }, () => getOpenAI().chat.completions.create({
        model: "qwen-vl-plus",
        messages: [{ role: "user", content: "vision" }],
      })),
      (error) => error?.code === "vision_unavailable",
      "删除视觉配置后必须在外呼前给出明确错误"
    );
    testCalls.length = 0;
    await providerContext.withUserModelRuntime({ ...runtimeA, researchModel: "", requestClass: "research" }, () => getOpenAI().chat.completions.create({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "fallback-chat" }],
    }));
    assert.equal(testCalls[0].model, "qwen-plus", "未配置研究模型时必须回落对话模型");
    const byokCosts = await getPool().query("SELECT provider,cost_micros FROM ai_calls WHERE provider LIKE 'byok:%'");
    assert.ok(byokCosts.rows.length >= 2);
    assert.ok(byokCosts.rows.every((row) => Number(row.cost_micros) === 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("密文篡改和任务版本漂移均在外呼前失败", async () => {
  const row = await db.getUserModelConfig(userA.id);
  assert.ok(row);
  const frozen = { mode: "user", providerId: row.provider_id, revision: Number(row.revision) };
  await getPool().query("UPDATE user_model_configs SET key_tag=$2 WHERE user_id=$1", [userA.id, "AAAA"]);
  await assert.rejects(
    () => modelConfig.resolveUserModelRuntime(userA.id, frozen),
    (error) => error?.code === "key_invalid"
  );
  await getPool().query("UPDATE user_model_configs SET enabled=0 WHERE user_id=$1", [userA.id]);
  await assert.rejects(
    () => modelConfig.resolveUserModelRuntime(userA.id, frozen),
    (error) => error?.code === "config_stale"
  );
});

test("客户端入口已替换为模型 API 配置且无密钥持久化", () => {
  const settings = fs.readFileSync(new URL("../../components/SettingsMenu.tsx", import.meta.url), "utf8");
  const panel = fs.readFileSync(new URL("../../components/ModelApiSettings.tsx", import.meta.url), "utf8");
  const openai = fs.readFileSync(new URL("../../lib/openai.ts", import.meta.url), "utf8");
  const discover = fs.readFileSync(new URL("../../app/api/discover/route.ts", import.meta.url), "utf8");
  const tester = fs.readFileSync(new URL("../../app/api/model-config/test/route.ts", import.meta.url), "utf8");
  const catalog = fs.readFileSync(new URL("../../lib/model-provider-catalog.ts", import.meta.url), "utf8");
  assert.match(settings, /模型 API 配置/);
  assert.match(settings, /w-\[min\(94vw,1040px\)\]/, "设置弹窗必须保持原有统一固定宽度");
  assert.doesNotMatch(settings, /sec === "model" \? "w-/, "模型配置不得再单独改变弹窗宽度");
  assert.match(panel, /"确认"/);
  assert.doesNotMatch(panel, /测试会依次验证|仅本人私有且未协作/);
  assert.doesNotMatch(panel, /选择供应商，输入一个 Key，再为不同用途选择模型/);
  assert.doesNotMatch(panel, /快速配置|MODEL_API_CONFIG_SECRET/);
  assert.doesNotMatch(panel, />盾</, "API Key 安全说明不再显示图标");
  assert.match(panel, /data-provider-strip/);
  assert.match(panel, /data-provider-scroll-viewport/);
  assert.match(panel, /snap-start scroll-mx-1\.5 rounded-xl border-2/, "供应商选中态必须使用卡片内部边框");
  assert.doesNotMatch(panel, /selected \? "ring-2 ring-accent/, "向外扩张的 ring 会被滚动视口裁切");
  assert.match(panel, /focus-visible:outline-offset-\[-2px\]/, "键盘焦点轮廓也必须收在卡片内部");
  assert.match(panel, /aria-label="向左滚动供应商"/);
  assert.match(panel, /aria-label="向右滚动供应商"/);
  assert.match(panel, /scrollBy\(\{/);
  assert.match(panel, /left: strip\.scrollLeft > 1/, "只要未回到真实左边界，左箭头就必须可用");
  assert.match(panel, /selected === strip\.firstElementChild[\s\S]{0,120}scrollTo\(\{ left: 0 \}\)/, "首卡选中时必须强制回到零偏移");
  assert.match(panel, /const gutter = 6/);
  assert.match(panel, /strip\.getBoundingClientRect\(\)[\s\S]{0,120}selected\.getBoundingClientRect\(\)/, "自动露出选中卡必须使用同一视口坐标系");
  assert.match(panel, /relative flex snap-x snap-mandatory scroll-px-1\.5/, "滚动视口必须为首末卡保留安全边距");
  assert.doesNotMatch(panel, /data-provider-strip[\s\S]{0,180}-mx-1/, "供应商首卡不得被负边距裁切");
  assert.doesNotMatch(panel, /安全目录|固定安全目录/, "供应商区不再显示安全目录标签");
  assert.match(panel, /truncate whitespace-nowrap text-\[12px\] text-muted/, "供应商说明必须保持单行");
  assert.match(panel, /默认 2 个/);
  assert.match(panel, /data-model-config-stack/, "API Key 与模型配置必须固定为上下结构");
  const stackClass = panel.match(/data-model-config-stack className="([^"]+)"/)?.[1] ?? "";
  assert.match(stackClass, /\bgrid-cols-1\b/);
  assert.doesNotMatch(stackClass, /\b(?:sm|md|lg|xl|2xl):grid-cols-2\b/, "宽屏也不得恢复左右并排");
  assert.equal((panel.match(/data-model-config-shell/g) ?? []).length, 1, "API Key、模型与操作必须共用唯一外框");
  assert.match(panel, /data-model-config-key/);
  assert.match(panel, /data-model-config-models/);
  const shellStart = panel.indexOf("data-model-config-shell");
  const shellEnd = panel.indexOf("</section>", shellStart);
  const shell = panel.slice(shellStart, shellEnd);
  assert.match(shell, /data-model-config-footer/, "底部操作必须收口在同一配置框内");
  assert.doesNotMatch(panel, /已添加当前供应商支持的全部用途/, "全用途已配置时不得保留占位块");
  assert.doesNotMatch(panel, /min-\[820px\]:flex-1/, "配置内容不得用弹性高度把底栏顶到窗口底部");
  assert.match(panel, /max-\[480px\]:grid-cols-\[minmax\(0,1fr\)_28px\]/, "极窄屏的用途和模型必须改为两行，不得挤压模型名");
  assert.doesNotMatch(panel, /min-h-\[258px\]|mt-auto pt-4/, "上下卡片必须按内容自然收缩，不能保留大块空白");
  assert.match(panel, /data-model-config-footer/, "范围说明、测试状态与操作必须收口到同一底栏");
  assert.match(panel, /researchModel/);
  assert.match(panel, /operationRef/);
  assert.match(panel, /name="model-api-key"[\s\S]{0,160}autoComplete="off"/);
  assert.match(panel, /chooseProvider[\s\S]{0,260}setApiKey\(""\)/);
  assert.doesNotMatch(panel, /localStorage|sessionStorage|<datalist|<select/);
  assert.match(openai, /maxRetries: 0/);
  assert.match(openai, /byok:/);
  assert.match(openai, /requestClass === "research"[\s\S]{0,120}researchModel/);
  const kimiBody = requestBodyForUserProvider({
    model: "placeholder",
    stream: true,
    temperature: 0.7,
    top_p: 0.9,
    presence_penalty: 0.2,
    frequency_penalty: 0.1,
  }, "kimi-k3", "kimi");
  assert.equal(kimiBody.model, "kimi-k3");
  assert.equal(kimiBody.temperature, undefined);
  assert.equal(kimiBody.top_p, undefined);
  assert.equal(kimiBody.presence_penalty, undefined);
  assert.equal(kimiBody.frequency_penalty, undefined);
  assert.equal(kimiBody.stream_options?.include_usage, true, "Kimi 参数归一不得破坏流式 Token 计量");
  assert.equal(kimiBody.reasoning_effort, "low", "Kimi K3 默认使用低推理强度");
  const kimi26Body = requestBodyForUserProvider({ temperature: 0.7, reasoning_effort: "high" }, "kimi-k2.6", "kimi");
  assert.equal(kimi26Body.temperature, undefined);
  assert.equal(kimi26Body.reasoning_effort, undefined);
  assert.deepEqual(kimi26Body.thinking, { type: "disabled" });
  const deterministicGlm = requestBodyForUserProvider({ temperature: 0 }, "glm-4.7-flash", "zhipu");
  assert.equal(deterministicGlm.temperature, undefined);
  assert.equal(deterministicGlm.do_sample, false, "智谱应把确定性请求转为官方 do_sample=false");
  assert.equal(requestBodyForUserProvider({ temperature: 0.3 }, "glm-4.7-flash", "zhipu").temperature, 0.3);
  assert.equal(requestBodyForUserProvider({ temperature: 0 }, "grok-4.6", "xai").temperature, 0);
  assert.match(discover, /modelRuntime && mode === "deep"/);
  assert.match(tester, /response_format:[\s\S]{0,80}json_object/);
  assert.match(tester, /image_url/);
  assert.match(tester, /max_completion_tokens: 1024/);
  assert.match(tester, /max_tokens: 512/);
  assert.match(tester, /maxDuration = 45/);
  assert.match(tester, /timeout: 30_000/);
  assert.match(catalog, /deepseek-v4-flash/);
  assert.match(catalog, /deepseek-v4-pro/);
  for (const providerId of ["kimi", "zhipu", "xai", "siliconflow"]) {
    assert.match(catalog, new RegExp(`\\b${providerId}:`), `目录必须包含 ${providerId}`);
  }
  assert.doesNotMatch(catalog, /minimax|gemini-3\./i, "结构化输出协议未适配前不得暴露不兼容供应商");
  assert.doesNotMatch(catalog, /deepseek-chat|deepseek-reasoner/);
});
