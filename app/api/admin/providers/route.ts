import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/admin";
import { getSettingsByPrefix } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { resolveProviderConfig } from "@/lib/openai";
import { maskSecret as mask, isSecretKey } from "@/lib/mask";
import { internalProcessorBaseUrl } from "@/lib/extraction/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 可在后台管理的全部配置键(provider.* 之外是各扩展服务)。 */
const EXT_KEYS = [
  "tts.engine",
  "tts.minimax.key",
  "tts.minimax.groupId",
  "aippt.key",
  "search.tavily.key", // Tavily 主搜索；失败或结果不足时才启用其余补充池
  "search.bocha.key",
  "search.zhipu.key", // 智谱 web-search-pro:多池并行第二源(国内直连)
  "search.serper.key", // Serper:Google 真池子代理(质量天花板)
] as const;

const PROVIDER_KEYS = [
  "provider.primary.baseUrl",
  "provider.primary.key",
  "provider.primary.chatModel",
  "provider.primary.visionModel",
  "provider.fallback.baseUrl",
  "provider.fallback.key",
  "provider.fallback.chatModel",
  "provider.fallback.visionModel",
  "provider.gateway.enabled",
  "provider.gateway.baseUrl",
  "provider.gateway.key",
  "provider.gateway.chatModel",
  "provider.gateway.visionModel",
  "provider.gateway.timeoutMs",
  "provider.gateway.emergencyDirect",
] as const;

function extEnvValue(key: (typeof EXT_KEYS)[number]): string {
  if (key === "tts.engine") return process.env.TTS_ENGINE || "auto";
  if (key === "tts.minimax.key") return process.env.MINIMAX_API_KEY || "";
  if (key === "tts.minimax.groupId") return process.env.MINIMAX_GROUP_ID || "";
  if (key === "aippt.key") return process.env.AIPPT_API_KEY || "";
  if (key === "search.tavily.key") return process.env.TAVILY_API_KEY || "";
  if (key === "search.bocha.key") return process.env.BOCHA_API_KEY || "";
  if (key === "search.zhipu.key") return process.env.ZHIPU_SEARCH_KEY || "";
  if (key === "search.serper.key") return process.env.SERPER_API_KEY || "";
  return "";
}

export async function GET(req: NextRequest) {
  const g = await requireRole(req, "providers");
  if (g instanceof NextResponse) return g;
  const [cfg, db] = await Promise.all([
    resolveProviderConfig({ allowInvalidGateway: true }),
    getSettingsByPrefix(""),
  ]);
  const fromDb = (k: string) => k in db;
  const gatewayEnabledRaw = db["provider.gateway.enabled"] ?? process.env.LITELLM_ENABLED ?? "0";
  const gatewayKey = db["provider.gateway.key"] ?? process.env.LITELLM_API_KEY ?? "";
  return NextResponse.json({
    primary: {
      baseUrl: cfg.primary.baseUrl,
      chatModel: cfg.primary.chatModel,
      visionModel: cfg.primary.visionModel,
      keyMasked: mask(cfg.primary.key),
      keySource: fromDb("provider.primary.key") ? "db" : cfg.primary.key ? "env" : "none",
    },
    fallback: cfg.fallback
      ? {
          baseUrl: cfg.fallback.baseUrl,
          chatModel: cfg.fallback.chatModel,
          visionModel: cfg.fallback.visionModel,
          keyMasked: mask(cfg.fallback.key),
          keySource: fromDb("provider.fallback.key") ? "db" : "env",
        }
      : null,
    gateway: {
      enabled: /^(1|true|on)$/i.test(gatewayEnabledRaw),
      baseUrl: db["provider.gateway.baseUrl"] ?? process.env.LITELLM_BASE_URL ?? "",
      chatModel: db["provider.gateway.chatModel"] ?? process.env.LITELLM_CHAT_MODEL ?? "apebook-chat",
      visionModel: db["provider.gateway.visionModel"] ?? process.env.LITELLM_VISION_MODEL ?? "apebook-vision",
      timeoutMs: db["provider.gateway.timeoutMs"] ?? process.env.LITELLM_TIMEOUT_MS ?? "240000",
      emergencyDirect: /^(1|true|on)$/i.test(
        db["provider.gateway.emergencyDirect"] ?? process.env.LITELLM_EMERGENCY_DIRECT ?? "0"
      ),
      keyMasked: mask(gatewayKey),
      keySource: fromDb("provider.gateway.key") ? "db" : gatewayKey ? "env" : "none",
    },
    ext: Object.fromEntries(
      // 脱敏判定与 export_settings 共用 isSecretKey,避免两个端点漂移。
      EXT_KEYS.map((k) => [
        k,
        isSecretKey(k)
          ? mask(db[k] ?? extEnvValue(k))
          : db[k] ?? extEnvValue(k),
      ])
    ),
    extSource: Object.fromEntries(
      EXT_KEYS.map((k) => [k, fromDb(k) ? "db" : extEnvValue(k) ? "env" : "none"])
    ),
    // 月度 token 预算(0/空 = 不限额、不预警)。
    quota: {
      primary: db["quota.primary.tokens"] ?? "",
      fallback: db["quota.fallback.tokens"] ?? "",
      gateway: db["quota.gateway.tokens"] ?? "",
    },
  });
}

/** PUT body: { set: {key: value, ...}, del: [key, ...] } — 整包校验、单事务提交。 */
export async function PUT(req: NextRequest) {
  const g = await requireRole(req, "providers", { write: true });
  if (g instanceof NextResponse) return g;
  const body = await req.json().catch(() => null) as unknown;
  const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  if (!isObject(body)) {
    return NextResponse.json({ error: "配置请求格式无效" }, { status: 400 });
  }
  const rawSet = body.set ?? {};
  const rawDel = body.del ?? [];
  if (!isObject(rawSet) || !Array.isArray(rawDel) || !rawDel.every((key) => typeof key === "string")) {
    return NextResponse.json({ error: "set 必须是对象，del 必须是字符串数组" }, { status: 400 });
  }
  const allowed = (key: string) =>
    (PROVIDER_KEYS as readonly string[]).includes(key) ||
    key === "quota.primary.tokens" ||
    key === "quota.fallback.tokens" ||
    key === "quota.gateway.tokens" ||
    (EXT_KEYS as readonly string[]).includes(key);
  const touched = [...Object.keys(rawSet), ...rawDel];
  const unknown = touched.find((key) => !allowed(key));
  if (unknown) {
    return NextResponse.json({ error: `不允许的配置键:${unknown}` }, { status: 400 });
  }
  const duplicates = rawDel.filter((key) => Object.prototype.hasOwnProperty.call(rawSet, key));
  if (duplicates.length) {
    return NextResponse.json({ error: `同一配置不能同时设置和删除:${duplicates[0]}` }, { status: 400 });
  }

  const normalizedSet: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(rawSet)) {
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      return NextResponse.json({ error: `${key} 必须是非空字符串；清除请使用 del` }, { status: 400 });
    }
    const value = rawValue.trim();
    if (
      (key === "provider.gateway.enabled" || key === "provider.gateway.emergencyDirect") &&
      !/^[01]$/.test(value)
    ) {
      return NextResponse.json({ error: `${key} 只接受 0 或 1` }, { status: 400 });
    }
    if (key === "provider.gateway.timeoutMs" && (!/^\d+$/.test(value) || Number(value) < 5000 || Number(value) > 290000)) {
      return NextResponse.json({ error: "网关超时需在 5000–290000ms 之间" }, { status: 400 });
    }
    if (key.startsWith("quota.") && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
      return NextResponse.json({ error: `${key} 必须是正整数` }, { status: 400 });
    }
    normalizedSet[key] = value;
  }

  const applied = [
    ...Object.keys(normalizedSet),
    ...rawDel.map((key) => `-${key}`),
  ];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('admin.providers.settings'))");
    const currentRows = (
      await client.query("SELECT key,value FROM app_settings")
    ).rows as Array<{ key: string; value: string }>;
    const proposed = Object.fromEntries(currentRows.map((row) => [row.key, row.value]));
    Object.assign(proposed, normalizedSet);
    for (const key of rawDel) delete proposed[key];
    const gatewayEnabled = /^(1|true|on)$/i.test(
      proposed["provider.gateway.enabled"] ?? process.env.LITELLM_ENABLED ?? "0"
    );
    if (gatewayEnabled) {
      const baseUrl = proposed["provider.gateway.baseUrl"] ?? process.env.LITELLM_BASE_URL ?? "";
      const key = proposed["provider.gateway.key"] ?? process.env.LITELLM_API_KEY ?? "";
      const chatModel = proposed["provider.gateway.chatModel"] ?? process.env.LITELLM_CHAT_MODEL ?? "";
      const visionModel = proposed["provider.gateway.visionModel"] ?? process.env.LITELLM_VISION_MODEL ?? "";
      try {
        internalProcessorBaseUrl(baseUrl, "LiteLLM");
      } catch (error) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: (error as Error).message }, { status: 400 });
      }
      if (!key) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "启用网关前请填写 Virtual Key" }, { status: 400 });
      }
      if (![chatModel, visionModel].every((value) => /^[\w./:-]{1,128}$/.test(value))) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "网关模型别名格式无效" }, { status: 400 });
      }
    }
    const now = Date.now();
    for (const [key, value] of Object.entries(normalizedSet)) {
      await client.query(
        `INSERT INTO app_settings(key,value,updated_at,updated_by) VALUES($1,$2,$3,$4)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
        [key, value, now, g.id]
      );
    }
    for (const key of rawDel) await client.query("DELETE FROM app_settings WHERE key=$1", [key]);
    if (applied.length) {
      await client.query(
        `INSERT INTO activity_log(ts,actor_id,actor_kind,action,target_type,meta)
         VALUES($1,$2,'admin','admin.settings_set','setting',$3)`,
        [now, g.id, JSON.stringify({ applied })]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true, applied });
}
