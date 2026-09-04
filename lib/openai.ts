import OpenAI from "openai";
import { getSettingsByPrefix, logAiCall } from "./db";
import { recordAiTokenUsage } from "./ai-usage-context";
import { internalProcessorBaseUrl } from "./extraction/config";
import { currentUserModelRuntime } from "./ai-provider-context";
import type { ModelProviderId } from "./model-provider-catalog";

// ---------------------------------------------------------------------------
// 供应商配置:后台(app_settings 的 provider.* 键)优先,回退 .env,再回退默认。
// 客户端按「配置指纹」缓存 —— 后台改配置后下一次调用自动重建,无需重启。
// ---------------------------------------------------------------------------

export type ProviderConfig = {
  primary: { key: string; baseUrl: string; chatModel: string; visionModel: string };
  fallback: { key: string; baseUrl: string; chatModel: string; visionModel: string } | null;
  gateway: {
    key: string;
    baseUrl: string;
    chatModel: string;
    visionModel: string;
    timeoutMs: number;
    emergencyDirect: boolean;
  } | null;
};

async function fromDb(): Promise<Record<string, string>> {
  try {
    return await getSettingsByPrefix("provider.");
  } catch (error) {
    // app_settings 可能保存“强制网关/禁止直连”策略。读取失败时回落
    // env 会绕过 Virtual Key 预算和模型白名单，因此必须 fail closed。
    console.error("[ai] 模型服务配置读取失败", {
      code: String((error as { code?: unknown })?.code || "unknown").slice(0, 32),
    });
    throw new Error("模型服务配置暂时无法读取");
  }
}

export async function resolveProviderConfig(
  opts: { allowInvalidGateway?: boolean } = {}
): Promise<ProviderConfig> {
  const s = await fromDb();
  const primary = {
    key: s["provider.primary.key"] || process.env.OPENAI_API_KEY || "",
    baseUrl:
      s["provider.primary.baseUrl"] ||
      process.env.OPENAI_BASE_URL ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    chatModel:
      s["provider.primary.chatModel"] || process.env.OPENAI_CHAT_MODEL || "qwen-plus",
    visionModel:
      s["provider.primary.visionModel"] ||
      process.env.OPENAI_VISION_MODEL ||
      "qwen-vl-plus",
  };
  const fbKey = s["provider.fallback.key"] || process.env.FALLBACK_API_KEY || "";
  const fbBase = s["provider.fallback.baseUrl"] || process.env.FALLBACK_BASE_URL || "";
  const fallback =
    fbKey && fbBase
      ? {
          key: fbKey,
          baseUrl: fbBase,
          chatModel:
            s["provider.fallback.chatModel"] ||
            process.env.FALLBACK_CHAT_MODEL ||
            "moonshot-v1-32k",
          visionModel:
            s["provider.fallback.visionModel"] ||
            process.env.FALLBACK_VISION_MODEL ||
            "moonshot-v1-32k-vision-preview",
        }
      : null;
  // LiteLLM 是可选内网网关。DB 的显式 "0" 必须覆盖 env 的 "1"，不能用 ||。
  const gatewayEnabledRaw = s["provider.gateway.enabled"] ?? process.env.LITELLM_ENABLED ?? "0";
  const gatewayEnabled = /^(1|true|on)$/i.test(gatewayEnabledRaw.trim());
  let gateway: ProviderConfig["gateway"] = null;
  if (gatewayEnabled) {
    const rawBase = (s["provider.gateway.baseUrl"] ?? process.env.LITELLM_BASE_URL ?? "").trim();
    const key = (s["provider.gateway.key"] ?? process.env.LITELLM_API_KEY ?? "").trim();
    if ((!rawBase || !key) && opts.allowInvalidGateway) return { primary, fallback, gateway: null };
    if (!rawBase || !key) throw new Error("LiteLLM 网关已启用但 Base URL / Virtual Key 未配置完整");
    let normalizedBase: string;
    try {
      normalizedBase = internalProcessorBaseUrl(rawBase, "LiteLLM");
    } catch (error) {
      if (opts.allowInvalidGateway) return { primary, fallback, gateway: null };
      throw error;
    }
    const timeoutValue = Number(s["provider.gateway.timeoutMs"] ?? process.env.LITELLM_TIMEOUT_MS ?? 240_000);
    const timeoutMs = Number.isInteger(timeoutValue) && timeoutValue >= 5_000 && timeoutValue <= 290_000
      ? timeoutValue
      : 240_000;
    const chatModel = (s["provider.gateway.chatModel"] ?? process.env.LITELLM_CHAT_MODEL ?? "apebook-chat").trim();
    const visionModel = (s["provider.gateway.visionModel"] ?? process.env.LITELLM_VISION_MODEL ?? "apebook-vision").trim();
    if (![chatModel, visionModel].every((value) => /^[\w./:-]{1,128}$/.test(value))) {
      if (opts.allowInvalidGateway) return { primary, fallback, gateway: null };
      throw new Error("LiteLLM 网关模型别名无效");
    }
    const base = normalizedBase.replace(/\/+$/, "");
    gateway = {
      key,
      baseUrl: /\/v1$/i.test(base) ? base : `${base}/v1`,
      chatModel,
      visionModel,
      timeoutMs,
      emergencyDirect: /^(1|true|on)$/i.test(
        (s["provider.gateway.emergencyDirect"] ?? process.env.LITELLM_EMERGENCY_DIRECT ?? "0").trim()
      ),
    };
  }
  return { primary, fallback, gateway };
}

/** 兼容旧调用方:主聊天/视觉模型名(占位符/时效敏感检测用)。resolveProviderConfig
 *  现为异步(db 读取),而这两个 const 在模块加载时求值,无法 await;且 getOpenAI()
 *  每次调用都会按当前 db 配置覆盖 body.model,故这里只需一个不触库的默认值(env→默认)。 */
export const CHAT_MODEL: string = process.env.OPENAI_CHAT_MODEL || "qwen-plus";
export const VISION_MODEL: string =
  process.env.OPENAI_VISION_MODEL || "qwen-vl-plus";

let cache: {
  fp: string;
  cfg: ProviderConfig;
  primary: OpenAI | null;
  fallback: OpenAI | null;
  gateway: OpenAI | null;
} | null = null;

async function clients(): Promise<{
  cfg: ProviderConfig;
  primary: OpenAI | null;
  fallback: OpenAI | null;
  gateway: OpenAI | null;
}> {
  const cfg = await resolveProviderConfig();
  const fp = JSON.stringify(cfg);
  if (!cache || cache.fp !== fp) {
    if (!cfg.primary.key && !cfg.gateway) {
      throw new Error(
        "未配置主模型 API Key:请在 后台管理 → API 配置 中填写,或设置 OPENAI_API_KEY。"
      );
    }
    cache = {
      fp,
      cfg,
      primary: cfg.primary.key
        ? new OpenAI({ apiKey: cfg.primary.key, baseURL: cfg.primary.baseUrl, maxRetries: 3 })
        : null,
      fallback: cfg.fallback
        ? new OpenAI({ apiKey: cfg.fallback.key, baseURL: cfg.fallback.baseUrl, maxRetries: 2 })
        : null,
      // 网关内部负责供应商路由；SDK 不再叠加重试，防指数放大到任务硬超时。
      gateway: cfg.gateway
        ? new OpenAI({
            apiKey: cfg.gateway.key,
            baseURL: cfg.gateway.baseUrl,
            maxRetries: 0,
            timeout: cfg.gateway.timeoutMs,
          })
        : null,
    };
  }
  return cache;
}

function isAbortError(e: unknown): boolean {
  const name = (e as { name?: string })?.name || "";
  const msg = e instanceof Error ? e.message : String(e);
  return name === "AbortError" || name === "TimeoutError" || /aborted|request was aborted/i.test(msg);
}

/** Retry on the fallback provider for rate-limit / server / network errors. */
function shouldFallback(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || isAbortError(e)) return false;
  const status = (e as { status?: number })?.status;
  return status === 429 || status === undefined || (typeof status === "number" && status >= 500);
}

/** LiteLLM 只有“网关进程不可达”才允许紧急直连；鉴权、限流、模型错误和超时都不旁路预算。 */
function gatewayUnavailable(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || isAbortError(e)) return false;
  if ((e as { status?: number })?.status != null) return false;
  const cause = (e as { cause?: unknown })?.cause;
  const code = String((e as { code?: unknown })?.code || (cause as { code?: unknown })?.code || "");
  const msg = [
    e instanceof Error ? e.message : String(e),
    cause instanceof Error ? cause.message : String(cause || ""),
    code,
  ].join(" ");
  // 只放行明确发生在连接建立前的错误。ECONNRESET/socket hang up/fetch failed
  // 可能发生在网关已收到并转发请求之后，旁路会造成双重生成/双计费。
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|getaddrinfo|connection refused/i.test(msg);
}

function errBrief(e: unknown): { status: number | null; msg: string } {
  const status = (e as { status?: number })?.status ?? null;
  const raw = e instanceof Error ? e.message : String(e);
  return { status, msg: raw.replace(/sk-[A-Za-z0-9-_]+/g, "sk-***").slice(0, 200) };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type CreateBody = { model?: string; [k: string]: any };

type CompletionUsage = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
};

function completionUsage(value: any): CompletionUsage | undefined {
  const usage = value?.usage;
  return usage && typeof usage === "object" ? usage : undefined;
}

function isAsyncIterable(value: any): value is AsyncIterable<any> {
  return value != null && typeof value[Symbol.asyncIterator] === "function";
}

/**
 * 流式响应只有最后一个 chunk 才带 usage。把计量和成功日志绑定到“流被完整
 * 消费”这一事实，避免拿到 HTTP 响应头就把中途断流误记成成功、0 Token。
 */
export function observeCompletionStream(
  source: AsyncIterable<any>,
  hooks: {
    onComplete: (usage: { tokensIn: number; tokensOut: number }) => void | Promise<void>;
    onFailure: (
      error: unknown,
      usage: { tokensIn: number; tokensOut: number }
    ) => void | Promise<void>;
    mapError?: (error: unknown) => unknown;
  }
): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      let tokensIn = 0;
      let tokensOut = 0;
      let completed = false;
      let failureReported = false;
      try {
        for await (const chunk of source) {
          const usage = completionUsage(chunk);
          if (usage) {
            // DashScope/OpenAI 的最后一块给累计值，不应逐块相加。
            tokensIn = Math.max(tokensIn, Math.round(Number(usage.prompt_tokens) || 0));
            tokensOut = Math.max(tokensOut, Math.round(Number(usage.completion_tokens) || 0));
          }
          yield chunk;
        }
        completed = true;
        await hooks.onComplete({ tokensIn, tokensOut });
      } catch (error) {
        failureReported = true;
        const safeError = hooks.mapError ? hooks.mapError(error) : error;
        await hooks.onFailure(safeError, { tokensIn, tokensOut });
        throw safeError;
      } finally {
        if (!completed && !failureReported) {
          const aborted = new Error("stream_aborted");
          await hooks.onFailure(hooks.mapError ? hooks.mapError(aborted) : aborted, { tokensIn, tokensOut });
        }
      }
    },
  };
}

function meteredCompletionStream(
  source: AsyncIterable<any>,
  meta: { ts: number; provider: string; model: string; mapError?: (error: unknown) => unknown }
): AsyncIterable<any> {
  let resolvedModel = meta.model;
  const trackModel: AsyncIterable<any> = {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of source) {
        if (typeof chunk?.model === "string" && chunk.model.trim()) resolvedModel = chunk.model;
        yield chunk;
      }
    },
  };
  return observeCompletionStream(trackModel, {
    mapError: meta.mapError,
    async onComplete({ tokensIn, tokensOut }) {
      recordAiTokenUsage(tokensIn, tokensOut);
      await logAiCall({
        ts: meta.ts,
        provider: meta.provider,
        model: resolvedModel,
        ms: Date.now() - meta.ts,
        ok: 1,
        status: null,
        error: null,
        tokensIn,
        tokensOut,
      });
    },
    async onFailure(error, { tokensIn, tokensOut }) {
      const brief = errBrief(error);
      await logAiCall({
        ts: meta.ts,
        provider: meta.provider,
        model: resolvedModel,
        ms: Date.now() - meta.ts,
        ok: 0,
        status: brief.status,
        error: brief.msg,
        tokensIn,
        tokensOut,
      });
    },
  });
}

export type UserModelRequestCode =
  | "key_invalid"
  | "model_unavailable"
  | "rate_limited"
  | "timeout"
  | "request_failed"
  | "vision_unavailable";

/** 用户接口错误只保留分类信息，绝不把上游正文、Base URL 或任意格式密钥带入日志。 */
export class UserModelRequestError extends Error {
  readonly code: UserModelRequestCode;
  readonly status: number | null;

  constructor(code: UserModelRequestCode, status: number | null = null) {
    const messages: Record<UserModelRequestCode, string> = {
      key_invalid: "个人模型 API Key 无效",
      model_unavailable: "个人模型名称不可用",
      rate_limited: "个人模型接口请求过于频繁",
      timeout: "个人模型接口连接超时",
      request_failed: "个人模型接口调用失败",
      vision_unavailable: "当前个人模型配置不支持图片理解",
    };
    super(messages[code]);
    this.name = "UserModelRequestError";
    this.code = code;
    this.status = status;
  }
}

function safeUserModelError(error: unknown): UserModelRequestError {
  if (error instanceof UserModelRequestError) return error;
  const statusValue = Number((error as { status?: unknown })?.status ?? 0);
  const status = Number.isInteger(statusValue) && statusValue > 0 ? statusValue : null;
  const name = String((error as { name?: unknown })?.name ?? "");
  if (status === 401 || status === 403) return new UserModelRequestError("key_invalid", status);
  if (status === 400 || status === 404 || status === 422) return new UserModelRequestError("model_unavailable", status);
  if (status === 429) return new UserModelRequestError("rate_limited", status);
  if (name === "AbortError" || name === "TimeoutError") return new UserModelRequestError("timeout", status);
  return new UserModelRequestError("request_failed", status);
}

function mergeAbortSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (!first) return second;
  if (!second || first === second) return first;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([first, second]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) abort();
  else {
    first.addEventListener("abort", abort, { once: true });
    second.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

export function requestBodyWithUsage(body: CreateBody, model: string): CreateBody {
  if (body.stream !== true) return { ...body, model };
  return {
    ...body,
    model,
    stream_options: {
      ...(body.stream_options && typeof body.stream_options === "object"
        ? body.stream_options
        : {}),
      include_usage: true,
    },
  };
}

/**
 * 个人模型使用统一 OpenAI 兼容请求，但部分供应商对采样参数有
 * 更严格的约束。只在个人接口边界做最小归一化，不改动平台模型路由。
 */
export function requestBodyForUserProvider(
  body: CreateBody,
  model: string,
  providerId: ModelProviderId
): CreateBody {
  const prepared = requestBodyWithUsage(body, model);
  if (providerId === "kimi") {
    const {
      temperature: _temperature,
      top_p: _topP,
      presence_penalty: _presencePenalty,
      frequency_penalty: _frequencyPenalty,
      ...compatible
    } = prepared;
    if (/^kimi-k3(?:$|[-.])/i.test(model)) {
      return {
        ...compatible,
        reasoning_effort: compatible.reasoning_effort ?? "low",
      };
    }
    if (/^kimi-k2\.6(?:$|[-.])/i.test(model)) {
      const { reasoning_effort: _reasoningEffort, ...withoutK3Params } = compatible;
      return {
        ...withoutK3Params,
        thinking: { type: "disabled" },
      };
    }
    return compatible;
  }
  if (providerId === "zhipu" && prepared.temperature === 0) {
    const { temperature: _temperature, ...compatible } = prepared;
    return { ...compatible, do_sample: false };
  }
  return prepared;
}

/**
 * OpenAI-like handle whose `chat.completions.create` transparently retries on
 * the fallback provider when the primary 429s / errors. 每次调用都会把
 * provider/model/耗时/结果写入 ai_calls(后台监控数据源)。
 */
export function getOpenAI() {
  return {
    chat: {
      completions: {
        create: async (body: CreateBody, options?: any): Promise<any> => {
          const userRuntime = currentUserModelRuntime();
          if (userRuntime) {
            const wantsVision =
              typeof body.model === "string" && /vision|vl|gemini.*vision/i.test(body.model);
            if (wantsVision && !userRuntime.visionModel) {
              throw new UserModelRequestError("vision_unavailable");
            }
            const model = wantsVision
              ? userRuntime.visionModel
              : userRuntime.requestClass === "research" && userRuntime.researchModel
                ? userRuntime.researchModel
                : userRuntime.chatModel;
            const provider = `byok:${userRuntime.providerId}`;
            const started = Date.now();
            const client = new OpenAI({
              apiKey: userRuntime.apiKey,
              baseURL: userRuntime.baseUrl,
              maxRetries: 0,
              timeout: 240_000,
              fetch: globalThis.fetch,
            });
            try {
              const userOptions = {
                ...(options ?? {}),
                signal: mergeAbortSignals(options?.signal, userRuntime.signal),
              };
              const res = await client.chat.completions.create(
                requestBodyForUserProvider(body, model, userRuntime.providerId) as any,
                userOptions
              );
              if (isAsyncIterable(res)) {
                return meteredCompletionStream(res, {
                  ts: started,
                  provider,
                  model,
                  mapError: safeUserModelError,
                });
              }
              const actualModel = typeof res?.model === "string" && res.model.trim()
                ? res.model
                : model;
              recordAiTokenUsage(res?.usage?.prompt_tokens, res?.usage?.completion_tokens);
              await logAiCall({
                ts: started,
                provider,
                model: actualModel,
                ms: Date.now() - started,
                ok: 1,
                status: null,
                error: null,
                tokensIn: res?.usage?.prompt_tokens,
                tokensOut: res?.usage?.completion_tokens,
              });
              return res;
            } catch (error) {
              const safeError = safeUserModelError(error);
              await logAiCall({
                ts: started,
                provider,
                model,
                ms: Date.now() - started,
                ok: 0,
                status: safeError.status,
                error: safeError.code,
              });
              throw safeError;
            }
          }
          const { cfg, primary, fallback, gateway } = await clients();
          // 调用方仍传旧模型名 —— 按「是否视觉模型」映射到当前配置。
          const wantsVision =
            typeof body.model === "string" && /vision|vl|gemini.*vision/i.test(body.model);
          const invoke = async (
            client: OpenAI,
            provider: "gateway" | "primary" | "fallback",
            model: string
          ): Promise<any> => {
            const started = Date.now();
            try {
              const res = await client.chat.completions.create(
                requestBodyWithUsage(body, model) as any,
                options
              );
              if (isAsyncIterable(res)) {
                return meteredCompletionStream(res, {
                  ts: started,
                  provider,
                  model,
                });
              }
              const actualModel = typeof res?.model === "string" && res.model.trim()
                ? res.model
                : model;
              recordAiTokenUsage(res?.usage?.prompt_tokens, res?.usage?.completion_tokens);
              await logAiCall({
                ts: started,
                provider,
                model: actualModel,
                ms: Date.now() - started,
                ok: 1,
                status: null,
                error: null,
                tokensIn: res?.usage?.prompt_tokens,
                tokensOut: res?.usage?.completion_tokens,
              });
              return res;
            } catch (error) {
              const brief = errBrief(error);
              await logAiCall({
                ts: started,
                provider,
                model,
                ms: Date.now() - started,
                ok: 0,
                status: brief.status,
                error: brief.msg,
              });
              throw error;
            }
          };

          if (gateway && cfg.gateway) {
            const gatewayModel = wantsVision ? cfg.gateway.visionModel : cfg.gateway.chatModel;
            try {
              return await invoke(gateway, "gateway", gatewayModel);
            } catch (error) {
              if (
                !cfg.gateway.emergencyDirect ||
                !gatewayUnavailable(error, options?.signal) ||
                !primary
              ) throw error;
              console.warn("[ai] LiteLLM 网关进程不可达，按显式开关进入紧急直连");
            }
          }

          if (!primary) {
            throw new Error("网关未启用或不可用，且未配置主模型直连 API Key");
          }
          const model = wantsVision ? cfg.primary.visionModel : cfg.primary.chatModel;
          try {
            return await invoke(primary, "primary", model);
          } catch (error) {
            if (!fallback || !cfg.fallback || !shouldFallback(error, options?.signal)) throw error;
            const brief = errBrief(error);
            console.warn(`[ai] primary ${brief.status ?? "err"} → falling back to ${cfg.fallback.baseUrl}`);
          }

          const fallbackModel = wantsVision ? cfg.fallback!.visionModel : cfg.fallback!.chatModel;
          return invoke(fallback!, "fallback", fallbackModel);
        },
      },
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// NOTE: embeddings stay local (lib/embed) — Kimi has no embeddings endpoint and
// switching providers must not invalidate existing chunk vectors.
