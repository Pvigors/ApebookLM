import { createHash } from "node:crypto";
import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";
import { userFromRequest } from "@/lib/auth";
import {
  claimUserModelConfigTest,
  consumeAuthRateLimit,
  getUserModelConfig,
  setUserModelConfigTestResult,
} from "@/lib/db";
import { isModelProviderId, modelProviderPreset } from "@/lib/model-provider-catalog";
import { sameOriginError } from "@/lib/request-origin";
import { decryptUserModelApiKey } from "@/lib/user-model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const NO_STORE = { "Cache-Control": "no-store" };

/** 兼容 Next Node 适配器：真实空 POST 也可能带一个最终为空的 ReadableStream。 */
async function requestHasBytes(req: NextRequest): Promise<boolean> {
  const declared = req.headers.get("content-length")?.trim() ?? "";
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 0)) return true;
  if (!req.body) return false;
  const reader = req.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("body read timeout")), 1_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (result.done) return false;
      if (result.value?.byteLength) {
        await reader.cancel("body not allowed").catch(() => {});
        return true;
      }
    }
  } catch {
    await reader.cancel("body read failed").catch(() => {});
    return true;
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}

type TestCode =
  | "ok"
  | "key_invalid"
  | "model_unavailable"
  | "rate_limited"
  | "timeout"
  | "request_failed";

function classify(error: unknown): { code: TestCode; status: number } {
  const status = Number((error as { status?: unknown })?.status ?? 0);
  const name = String((error as { name?: unknown })?.name ?? "");
  // 这里的 401/403 来自第三方供应商，不代表猿笔记会话失效；对客户端回 422，
  // 避免全局鉴权守卫误弹“登录已过期”。
  if (status === 401 || status === 403) return { code: "key_invalid", status: 422 };
  if (status === 404 || status === 400 || status === 422) return { code: "model_unavailable", status: 422 };
  if (status === 429) return { code: "rate_limited", status: 429 };
  if (name === "AbortError" || name === "TimeoutError") return { code: "timeout", status: 504 };
  return { code: "request_failed", status: 502 };
}

const CLIENT_MESSAGES: Record<TestCode, string> = {
  ok: "连接成功",
  key_invalid: "API Key 无效或无权访问该接口",
  model_unavailable: "模型不可用，请核对模型名称",
  rate_limited: "供应商请求过于频繁，请稍后再试",
  timeout: "供应商连接超时，请稍后再试",
  request_failed: "供应商连接失败，请稍后再试",
};

function invalidProbeResponse(): Error & { status: number } {
  return Object.assign(new Error("model capability probe failed"), { status: 422 });
}

export async function POST(req: NextRequest) {
  const originError = sameOriginError(req);
  if (originError) return originError;
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401, headers: NO_STORE });
  if (await requestHasBytes(req)) {
    return NextResponse.json(
      { error: "连接测试不接受请求内容", code: "invalid_body" },
      { status: 400, headers: NO_STORE }
    );
  }
  const bucket = createHash("sha256").update(`model-config-test:${user.id}`).digest("hex");
  const limit = await consumeAuthRateLimit(bucket, 10, 60 * 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "连接测试过于频繁，请稍后再试", code: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limit.retryAfter) } }
    );
  }
  const current = await getUserModelConfig(user.id);
  if (!current || !isModelProviderId(current.provider_id)) {
    return NextResponse.json(
      { error: "请先保存模型配置", code: "config_missing" },
      { status: 404, headers: NO_STORE }
    );
  }
  const row = await claimUserModelConfigTest(user.id, Number(current.revision));
  if (!row) {
    return NextResponse.json(
      { error: "配置已停用、已变更或正在测试", code: "test_conflict" },
      { status: 409, headers: NO_STORE }
    );
  }
  let result: { code: TestCode; status: number } = { code: "request_failed", status: 502 };
  try {
    const apiKey = decryptUserModelApiKey(row);
    const preset = modelProviderPreset(row.provider_id as keyof typeof import("@/lib/model-provider-catalog").MODEL_PROVIDER_CATALOG);
    const client = new OpenAI({
      apiKey,
      baseURL: preset.baseUrl,
      maxRetries: 0,
      timeout: 30_000,
      fetch: globalThis.fetch,
    });
    // 按「模型 + 能力」去重：同一模型兼任聊天和视觉时仍要分别验证 JSON 与图片，
    // 不能用一次视觉成功冒充全部能力成功。
    const targets: Array<{ model: string; vision: boolean }> = [];
    const seenTargets = new Set<string>();
    const addTarget = (rawModel: string, vision: boolean) => {
      const model = rawModel.trim();
      const key = `${model}\u0000${vision ? "vision" : "json"}`;
      if (!model || seenTargets.has(key)) return;
      seenTargets.add(key);
      targets.push({ model, vision });
    };
    addTarget(row.chat_model, false);
    addTarget(row.research_model, false);
    addTarget(row.vision_model, true);
    // 64×64 白色 RGB PNG；满足聚合供应商中 Qwen 视觉模型双边至少
    // 56px 的输入限制，并通过 libpng/Sharp 完整像素解码。
    const probePixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAS0lEQVRo3u3PMQ0AAAwDoPo33UrYvQQckD4XAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAYHLAMpT0sLy/XNzAAAAAElFTkSuQmCC";
    await Promise.all(targets.map(async (target) => {
      const completion = await client.chat.completions.create({
        model: target.model,
        messages: target.vision
          ? [{
              role: "user",
              content: [
                { type: "text", text: "Describe this image in one word." },
                { type: "image_url", image_url: { url: probePixel } },
              ],
            }]
          : [{ role: "user", content: "Return one valid JSON object with an ok boolean." }],
        ...(target.vision ? {} : { response_format: { type: "json_object" as const } }),
        // Kimi 现役模型始终推理，且采样参数为供应商固定值；其他
        // 供应商也不统一接受 temperature=0，因此探针不发送温度参数。
        ...(row.provider_id === "kimi" && /^kimi-k3(?:$|[-.])/i.test(target.model)
          ? { max_completion_tokens: 1024, reasoning_effort: "low" as const }
          : { max_tokens: 512 }),
        ...(row.provider_id === "kimi" && /^kimi-k2\.6(?:$|[-.])/i.test(target.model)
          ? { thinking: { type: "disabled" as const } }
          : {}),
      });
      const content = completion.choices[0]?.message?.content?.trim() ?? "";
      if (!content) throw invalidProbeResponse();
      if (!target.vision) {
        try {
          const parsed = JSON.parse(content) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw invalidProbeResponse();
          }
        } catch (error) {
          if ((error as { status?: unknown })?.status === 422) throw error;
          throw invalidProbeResponse();
        }
      }
    }));
    result = { code: "ok", status: 200 };
  } catch (error) {
    result = classify(error);
  }
  const updated = await setUserModelConfigTestResult(
    user.id,
    Number(row.revision),
    result.code === "ok",
    result.code
  );
  if (!updated) {
    return NextResponse.json(
      { error: "测试期间配置已变更，请重新测试", code: "test_conflict" },
      { status: 409, headers: NO_STORE }
    );
  }
  if (result.code !== "ok") {
    return NextResponse.json(
      { ok: false, error: CLIENT_MESSAGES[result.code], code: result.code },
      { status: result.status, headers: NO_STORE }
    );
  }
  return NextResponse.json(
    { ok: true, message: CLIENT_MESSAGES.ok, enabled: true, testedAt: updated.last_tested_at },
    { headers: NO_STORE }
  );
}
