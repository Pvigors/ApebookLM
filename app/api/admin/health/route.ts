import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { requireRole } from "@/lib/admin";
import { getSettingsByPrefix } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { resolveProviderConfig } from "@/lib/openai";
import { recordEvent } from "@/lib/activity";
import { cadRuntimeHealth } from "@/lib/cad";
import { text2cadRuntimeHealth } from "@/lib/text2cad";
import { crawl4aiConfig, doclingConfig, internalProcessorBaseUrl } from "@/lib/extraction/config";
import { resolveWorkerGates } from "@/lib/worker-gates";
import { cadWorkerHeartbeatReady } from "@/lib/cad-worker-heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// 一键全依赖体检:并行探测主备模型、文档/网页解析、搜索、TTS、数据库、
// 通用/CAD worker、CAD 基础内核、Text2CAD 与磁盘空间。每项独立 try/catch + 8s 超时,
// 一项挂不影响其余。部分探测有真实调用成本
// (会消耗 token),仅供后台手动触发,不做自动轮询。
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 8000;

type Check = { name: string; ok: boolean; ms: number; detail: string };

/** 单项探测:计时 + 超时兜底 + 错误脱敏(key 不落日志/响应)。 */
async function probe(name: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<Check> {
  const t0 = Date.now();
  try {
    const r = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("超时(8s)")), TIMEOUT_MS)),
    ]);
    return { name, ok: r.ok, ms: Date.now() - t0, detail: r.detail };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e))
      .replace(/(?:sk|tvly)-[\w-]+/g, "key-***")
      .slice(0, 160);
    return { name, ok: false, ms: Date.now() - t0, detail: msg || "未知错误" };
  }
}

/** OpenAI 兼容接口连通性:max_tokens=4 的最小 ping(与 providers/test 同款)。 */
async function pingChat(p: { key: string; baseUrl: string; chatModel: string }) {
  const client = new OpenAI({ apiKey: p.key, baseURL: p.baseUrl, maxRetries: 0, timeout: TIMEOUT_MS });
  await client.chat.completions.create({
    model: p.chatModel,
    max_tokens: 4,
    messages: [{ role: "user", content: "ping" }],
  });
  return { ok: true, detail: p.chatModel };
}

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + " GB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(0) + " MB";
  return Math.round(n / 1024) + " KB";
}

export async function POST(req: NextRequest) {
  const g = await requireRole(req, "monitor", { write: true });
  if (g instanceof NextResponse) return g;

  const cfg = await resolveProviderConfig({ allowInvalidGateway: true });
  const tts = await getSettingsByPrefix("tts.");
  const search = await getSettingsByPrefix("search.");
  const gateway = await getSettingsByPrefix("provider.gateway.");
  const jobSettings = await getSettingsByPrefix("jobs.");

  const checks = await Promise.all([
    // ---- 主接口 ----
    probe("主接口", async () => {
      if (!cfg.primary.key) {
        return cfg.gateway
          ? { ok: true, detail: "网关模式未配置直连,跳过" }
          : { ok: false, detail: "主接口未配置" };
      }
      return pingChat(cfg.primary);
    }),

    // ---- 备用接口(未配置则跳过,不算故障)----
    probe("备用接口", async () => {
      if (!cfg.fallback) return { ok: true, detail: "未配置,跳过" };
      return pingChat(cfg.fallback);
    }),

    // ---- LiteLLM 内网网关（readiness + alias，无真实生成成本）----
    probe("内网模型网关", async () => {
      const enabled = /^(1|true|on)$/i.test(
        gateway["provider.gateway.enabled"] ?? process.env.LITELLM_ENABLED ?? "0"
      );
      if (!enabled) return { ok: true, detail: "未启用,跳过" };
      const rawBase = gateway["provider.gateway.baseUrl"] || process.env.LITELLM_BASE_URL || "";
      const key = gateway["provider.gateway.key"] || process.env.LITELLM_API_KEY || "";
      const chat = gateway["provider.gateway.chatModel"] || process.env.LITELLM_CHAT_MODEL || "apebook-chat";
      const vision = gateway["provider.gateway.visionModel"] || process.env.LITELLM_VISION_MODEL || "apebook-vision";
      if (!rawBase || !key) return { ok: false, detail: "已启用但配置不完整" };
      const root = internalProcessorBaseUrl(rawBase, "LiteLLM").replace(/\/v1$/i, "");
      const headers = { Authorization: `Bearer ${key}` };
      const ready = await fetch(`${root}/health/readiness`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!ready.ok) return { ok: false, detail: `readiness HTTP ${ready.status}` };
      const response = await fetch(`${root}/v1/models`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const payload = (await response.json().catch(() => ({}))) as { data?: { id?: string }[] };
      const ids = new Set((payload.data || []).map((item) => item.id).filter(Boolean));
      const missing = [chat, vision].filter((model) => !ids.has(model));
      return {
        ok: response.ok && !missing.length,
        detail: missing.length ? `缺少别名:${missing.join("、")}` : `readiness 正常 · ${chat}/${vision}`,
      };
    }),

    // ---- Docling 文档解析 sidecar ----
    probe("Docling 文档解析", async () => {
      const config = doclingConfig();
      if (config.mode === "off") return { ok: true, detail: "未启用,跳过" };
      if (!config.url) return { ok: false, detail: "已启用但未配置地址" };
      const base = internalProcessorBaseUrl(config.url, "Docling");
      const response = await fetch(`${base}/ready`, {
        headers: config.apiKey ? { "X-Api-Key": config.apiKey } : {},
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { ok: response.ok, detail: response.ok ? `${config.mode} · ${config.version}` : `HTTP ${response.status}` };
    }),

    // ---- Crawl4AI 网页正文 sidecar ----
    probe("Crawl4AI 网页正文", async () => {
      const config = crawl4aiConfig();
      if (config.mode === "off") return { ok: true, detail: "未启用,跳过" };
      if (!config.url) return { ok: false, detail: "已启用但未配置地址" };
      const base = internalProcessorBaseUrl(config.url, "Crawl4AI");
      const response = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false, detail: `health HTTP ${response.status}` };
      const auth = await fetch(`${base}/hooks/info`, {
        headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return {
        ok: auth.ok,
        detail: auth.ok ? `${config.mode} · ${config.version} · 鉴权正常` : `鉴权探针 HTTP ${auth.status}`,
      };
    }),

    // ---- Tavily 主搜索（usage 端点不消耗搜索额度）----
    probe("Tavily 主搜索", async () => {
      const key = search["search.tavily.key"] || process.env.TAVILY_API_KEY || "";
      if (!key) return { ok: true, detail: "未配置,跳过" };
      const r = await fetch("https://api.tavily.com/usage", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = (await r.json().catch(() => ({}))) as {
        key?: { usage?: number; limit?: number };
      };
      const usage = Number(data.key?.usage);
      const limit = Number(data.key?.limit);
      const quota = r.ok && Number.isFinite(usage) && Number.isFinite(limit)
        ? ` · Key 额度 ${usage}/${limit}`
        : "";
      return { ok: r.ok, detail: `HTTP ${r.status}${quota}` };
    }),

    // ---- 博查补充搜索 ----
    probe("博查补充搜索", async () => {
      const key = search["search.bocha.key"] || process.env.BOCHA_API_KEY || "";
      if (!key) return { ok: true, detail: "未配置,跳过" };
      const r = await fetch("https://api.bochaai.com/v1/web-search", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "ping", count: 1 }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { ok: r.ok, detail: `HTTP ${r.status}` };
    }),

    // ---- MiniMax TTS(与实际产音频一致:DB 优先回退 env,打生产同域名)----
    probe("MiniMax TTS", async () => {
      const key = tts["tts.minimax.key"] || process.env.MINIMAX_API_KEY || "";
      const group = tts["tts.minimax.groupId"] || process.env.MINIMAX_GROUP_ID || "";
      if (!key || !group) return { ok: true, detail: "未配置,跳过" };
      const r = await fetch(`https://api.minimaxi.com/v1/get_voice?GroupId=${group}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ voice_type: "system" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { ok: r.ok, detail: `HTTP ${r.status}` };
    }),

    // ---- 数据库:一读 + 临时表写删 ----
    probe("数据库", async () => {
      // pg 临时表是会话级(绑定单个连接),故从池借同一 client 完成建表/写/删,避免跨连接失联。
      const client = await getPool().connect();
      try {
        // 探测专用短语句超时(5s < 探测 race 的 8s):DB 半死时卡住的查询会在服务端被 cancel、
        // query reject、finally 及时 release 归还连接,避免「体检超时后连接不还」逐步耗尽池
        // (反而把 DB 故障放大成整池耗尽)。
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = 5000");
        await client.query("SELECT 1");
        await client.query("CREATE TEMP TABLE IF NOT EXISTS __health_probe (v INTEGER)");
        await client.query("INSERT INTO __health_probe (v) VALUES (1)");
        await client.query("DROP TABLE IF EXISTS __health_probe");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      return { ok: true, detail: "读写正常" };
    }),

    // ---- 通用 worker：running 心跳失联才算故障；关闭 worker 后的 queued 是合法积压 ----
    probe("通用任务 worker", async () => {
      const pool = getPool();
      const staleRunning = Number(
        (
          (await pool.query(
            "SELECT COUNT(*) n FROM jobs WHERE kind<>'cad' AND status='running' AND updated_at < $1",
            [Date.now() - 4 * 60_000]
          )).rows[0] as { n: number }
        ).n
      );
      const rows = (
        await pool.query(
          "SELECT status, COUNT(*) n FROM jobs WHERE kind<>'cad' AND status IN ('queued','running') GROUP BY status"
        )
      ).rows as { status: string; n: number }[];
      const queued = Number(rows.find((r) => r.status === "queued")?.n ?? 0);
      const running = Number(rows.find((r) => r.status === "running")?.n ?? 0);
      const gates = resolveWorkerGates(jobSettings);
      if (staleRunning > 0) return { ok: false, detail: `运行任务失联 ${staleRunning} 个(超过 4 分钟无心跳)` };
      return {
        ok: true,
        detail: `领取 ${gates.general ? "开启" : "关闭"} · 排队 ${queued} / 运行 ${running}`,
      };
    }),

    // ---- CAD 独立 worker：不能用 Web 容器的 CAD=0 环境闸推断，必须读 DB 原生 FreeCAD 心跳 ----
    probe("CAD 独立 worker", async () => {
      if (
        process.env.NBLM_WORKER_ENABLED === "0"
        || jobSettings["jobs.worker_v2_enabled"] === "0"
        || jobSettings["jobs.cad_worker_enabled"] === "0"
      ) {
        return { ok: true, detail: "领取闸已关闭,跳过" };
      }
      const pool = getPool();
      const [heartbeat, rows, staleResult] = await Promise.all([
        cadWorkerHeartbeatReady(true),
        pool.query("SELECT status,COUNT(*) n FROM jobs WHERE kind='cad' AND status IN ('queued','running') GROUP BY status"),
        pool.query(
          "SELECT COUNT(*) n FROM jobs WHERE kind='cad' AND status='running' AND updated_at < $1",
          [Date.now() - 4 * 60_000]
        ),
      ]);
      const staleRunning = Number((staleResult.rows[0] as { n?: number } | undefined)?.n ?? 0);
      if (staleRunning > 0) return { ok: false, detail: `CAD 运行任务失联 ${staleRunning} 个(超过 4 分钟无心跳)` };
      if (!heartbeat.ok) return { ok: false, detail: heartbeat.error };
      const queueRows = rows.rows as { status: string; n: number }[];
      const queued = Number(queueRows.find((row) => row.status === "queued")?.n ?? 0);
      const running = Number(queueRows.find((row) => row.status === "running")?.n ?? 0);
      return { ok: true, detail: `FreeCAD 心跳正常 · 排队 ${queued} / 运行 ${running}` };
    }),

    // ---- 基础 CAD：受控模板与 STEP/STL 输出运行时 ----
    probe("CAD 基础内核", async () => {
      const health = await cadRuntimeHealth();
      return health.ok
        ? { ok: true, detail: "受控工人与 Open CASCADE/WASM 已就绪" }
        : { ok: false, detail: health.error };
    }),

    // ---- Text2CAD：自动/自由参数化主路径必须单独探测，不能用基础内核假绿 ----
    probe("Text2CAD 参数化链", async () => {
      const health = await text2cadRuntimeHealth();
      return health.ok
        ? { ok: true, detail: "参数化命令、几何工人与文件校验已就绪" }
        : { ok: false, detail: health.error };
    }),

    // ---- 磁盘:.data 所在盘剩余空间,<1GB 告警;取不到则跳过 ----
    probe("磁盘空间", async () => {
      const dataDir = path.dirname(
        process.env.NBLM_DB_PATH || path.join(process.cwd(), ".data", "apebooklm.db")
      );
      let st: fs.StatsFsBase<number> | null = null;
      try {
        st = fs.statfsSync(dataDir);
      } catch {
        try {
          st = fs.statfsSync(process.cwd());
        } catch {
          /* noop */
        }
      }
      if (!st) return { ok: true, detail: "无法检测,跳过" };
      const free = st.bsize * st.bavail;
      const ok = free >= 1 << 30;
      return { ok, detail: ok ? `剩余 ${fmtBytes(free)}` : `剩余 ${fmtBytes(free)},不足 1GB` };
    }),
  ]);

  await recordEvent({
    actorId: g.id,
    actorKind: "admin",
    action: "admin.health_check",
    meta: { fails: checks.filter((c) => !c.ok).length, total: checks.length },
  });

  return NextResponse.json({ checks });
}
