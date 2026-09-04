import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { requireRole } from "@/lib/admin";
import { getSettingsByPrefix } from "@/lib/db";
import { resolveProviderConfig } from "@/lib/openai";
import { internalProcessorBaseUrl } from "@/lib/extraction/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { target: "gateway" | "primary" | "fallback" | "minimax" | "tavily" | "bocha" } → 连通性测试 */
export async function POST(req: NextRequest) {
  const g = await requireRole(req, "providers", { write: true });
  if (g instanceof NextResponse) return g;
  const { target } = (await req.json().catch(() => ({}))) as { target?: string };
  const t0 = Date.now();
  try {
    if (target === "gateway") {
      const settings = await getSettingsByPrefix("provider.gateway.");
      const rawBase = settings["provider.gateway.baseUrl"] || process.env.LITELLM_BASE_URL || "";
      const key = settings["provider.gateway.key"] || process.env.LITELLM_API_KEY || "";
      const chatModel = settings["provider.gateway.chatModel"] || process.env.LITELLM_CHAT_MODEL || "apebook-chat";
      const visionModel = settings["provider.gateway.visionModel"] || process.env.LITELLM_VISION_MODEL || "apebook-vision";
      if (!rawBase || !key) return NextResponse.json({ ok: false, error: "未配置网关 Base URL / Virtual Key" });
      const root = internalProcessorBaseUrl(rawBase, "LiteLLM").replace(/\/v1$/i, "");
      const headers = { Authorization: `Bearer ${key}` };
      const ready = await fetch(`${root}/health/readiness`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!ready.ok) return NextResponse.json({ ok: false, status: ready.status, error: "网关 readiness 未通过" });
      const modelsResponse = await fetch(`${root}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      const models = (await modelsResponse.json().catch(() => ({}))) as { data?: { id?: string }[] };
      const ids = new Set((models.data || []).map((item) => item.id).filter(Boolean));
      const missing = [chatModel, visionModel].filter((model) => !ids.has(model));
      if (!modelsResponse.ok || missing.length) {
        return NextResponse.json({ ok: false, status: modelsResponse.status, error: `网关缺少模型别名:${missing.join("、")}` });
      }
      const baseURL = `${root}/v1`;
      const client = new OpenAI({ apiKey: key, baseURL, maxRetries: 0, timeout: 15_000 });
      const result = await client.chat.completions.create({
        model: chatModel,
        max_tokens: 4,
        messages: [{ role: "user", content: "ping" }],
      });
      return NextResponse.json({
        ok: true,
        ms: Date.now() - t0,
        model: result.model || chatModel,
        aliases: [chatModel, visionModel],
      });
    }
    if (target === "primary" || target === "fallback") {
      const cfg = await resolveProviderConfig();
      const p = target === "primary" ? cfg.primary : cfg.fallback;
      if (!p) return NextResponse.json({ ok: false, error: "未配置备用接口" });
      const client = new OpenAI({ apiKey: p.key, baseURL: p.baseUrl, maxRetries: 0, timeout: 15000 });
      const res = await client.chat.completions.create({
        model: p.chatModel,
        max_tokens: 4,
        messages: [{ role: "user", content: "ping" }],
      });
      return NextResponse.json({
        ok: true,
        ms: Date.now() - t0,
        model: p.chatModel,
        reply: res.choices[0]?.message?.content?.slice(0, 20) ?? "",
      });
    }
    if (target === "minimax") {
      // 与实际产音频一致:DB 优先回退 env,且探活打生产同域名 api.minimaxi.com。
      const s = await getSettingsByPrefix("tts.");
      const key = s["tts.minimax.key"] || process.env.MINIMAX_API_KEY || "";
      const group = s["tts.minimax.groupId"] || process.env.MINIMAX_GROUP_ID || "";
      if (!key || !group) return NextResponse.json({ ok: false, error: "未配置 MiniMax key/groupId" });
      const r = await fetch(`https://api.minimaxi.com/v1/get_voice?GroupId=${group}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ voice_type: "system" }),
        signal: AbortSignal.timeout(15000),
      });
      return NextResponse.json({ ok: r.ok, ms: Date.now() - t0, status: r.status });
    }
    if (target === "tavily") {
      const s = await getSettingsByPrefix("search.");
      const key = s["search.tavily.key"] || process.env.TAVILY_API_KEY || "";
      if (!key) return NextResponse.json({ ok: false, error: "未配置 Tavily key" });
      // /usage 只验证鉴权与连通性，不消耗一次搜索额度。
      const r = await fetch("https://api.tavily.com/usage", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      const data = (await r.json().catch(() => ({}))) as {
        key?: { usage?: number; limit?: number };
      };
      const usage = Number(data.key?.usage);
      const limit = Number(data.key?.limit);
      const detail = r.ok && Number.isFinite(usage) && Number.isFinite(limit)
        ? `Key 额度 ${usage}/${limit}`
        : undefined;
      return NextResponse.json({ ok: r.ok, ms: Date.now() - t0, status: r.status, detail });
    }
    if (target === "bocha") {
      const s = await getSettingsByPrefix("search.");
      const key = s["search.bocha.key"] || process.env.BOCHA_API_KEY || "";
      if (!key) return NextResponse.json({ ok: false, error: "未配置博查 key" });
      const r = await fetch("https://api.bochaai.com/v1/web-search", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "ping", count: 1 }),
        signal: AbortSignal.timeout(15000),
      });
      return NextResponse.json({ ok: r.ok, ms: Date.now() - t0, status: r.status });
    }
    return NextResponse.json({ ok: false, error: "未知目标" }, { status: 400 });
  } catch (e) {
    const status = (e as { status?: number })?.status;
    const msg = (e instanceof Error ? e.message : String(e))
      .replace(/(?:sk|tvly)-[\w-]+/g, "key-***")
      .slice(0, 160);
    return NextResponse.json({ ok: false, ms: Date.now() - t0, status: status ?? null, error: msg });
  }
}
