import { NextRequest, NextResponse } from "next/server";
import { adminRoleOf, canAccess, requireRole } from "@/lib/admin";
import { aiCallSeries, getUsageStats, getSettingsByPrefix } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { listEvents } from "@/lib/activity";
import { resolveProviderConfig } from "@/lib/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const g = await requireRole(req, "overview");
  if (g instanceof NextResponse) return g;
  const pool = getPool();
  const one = async (sql: string, ...args: unknown[]) =>
    Number(((await pool.query(sql, args)).rows[0] as { n: number } | undefined)?.n ?? 0);

  const now = Date.now();
  const dayAgo = now - 86400_000;
  const day2Ago = now - 2 * 86400_000;
  const counts = {
    users: await one("SELECT COUNT(*) n FROM users"),
    notebooks: await one("SELECT COUNT(*) n FROM notebooks"),
    sources: await one("SELECT COUNT(*) n FROM sources WHERE origin IS NULL OR origin NOT LIKE 'note:%'"),
    notes: await one("SELECT COUNT(*) n FROM notes"),
    outputs: await one("SELECT COUNT(*) n FROM studio_outputs"),
    activeUsers7d: await one("SELECT COUNT(*) n FROM users WHERE last_seen > $1", now - 7 * 86400_000),
  };

  // 环比:近 24h 新增相对「昨日总量」的增幅(累计型指标),给 KPI 卡的 ↑↓%。
  const new24h = (t: string) => one(`SELECT COUNT(*) n FROM ${t} WHERE created_at > $1`, dayAgo);
  const growth = (total: number, added: number) => {
    const prev = total - added;
    return prev > 0 ? (added / prev) * 100 : added > 0 ? 100 : 0;
  };
  // 7 日「每日新增」迷你序列(KPI 卡 sparkline)。
  const dailyNew = async (t: string, days = 7): Promise<number[]> => {
    const start = now - days * 86400_000;
    const rows = (
      await pool.query(
        `SELECT CAST((created_at - $1) / 86400000 AS INT) d, COUNT(*) n
         FROM ${t} WHERE created_at >= $1 GROUP BY d`,
        [start]
      )
    ).rows as { d: number; n: number }[];
    const arr = Array(days).fill(0);
    for (const r of rows) if (r.d >= 0 && r.d < days) arr[r.d] = Number(r.n);
    return arr;
  };
  const calls24h = {
    total: await one("SELECT COUNT(*) n FROM ai_calls WHERE ts > $1", dayAgo),
    errors: await one("SELECT COUNT(*) n FROM ai_calls WHERE ts > $1 AND ok = 0", dayAgo),
    fallback: await one("SELECT COUNT(*) n FROM ai_calls WHERE ts > $1 AND provider='fallback'", dayAgo),
    p95: (
      await pool.query("SELECT ms FROM ai_calls WHERE ts > $1 AND ok = 1 ORDER BY ms", [dayAgo])
    ).rows as { ms: number }[],
  };
  const msArr = calls24h.p95.map((r) => r.ms);
  const pct = (p: number) =>
    msArr.length ? msArr[Math.min(msArr.length - 1, Math.floor((p / 100) * msArr.length))] : 0;

  // 前一个 24h 窗口(24–48h 前),用于调用量 / 成功率 / p95 的环比。
  const prevCalls = await one("SELECT COUNT(*) n FROM ai_calls WHERE ts > $1 AND ts <= $2", day2Ago, dayAgo);
  const prevErrors = await one("SELECT COUNT(*) n FROM ai_calls WHERE ts > $1 AND ts <= $2 AND ok = 0", day2Ago, dayAgo);
  const prevMs = (
    (await pool.query("SELECT ms FROM ai_calls WHERE ts > $1 AND ts <= $2 AND ok = 1 ORDER BY ms", [day2Ago, dayAgo]))
      .rows as { ms: number }[]
  ).map((r) => r.ms);
  const prevP95 = prevMs.length ? prevMs[Math.min(prevMs.length - 1, Math.floor(0.95 * prevMs.length))] : 0;
  // 成功率环比仅在两个窗口都有调用时才可比;任一窗口零调用则不显示 delta(避免把零流量误算成「成功率上升」)。
  const successPp =
    calls24h.total > 0 && prevCalls > 0
      ? ((calls24h.total - calls24h.errors) / calls24h.total - (prevCalls - prevErrors) / prevCalls) * 100
      : 0;

  const deltas = {
    users: growth(counts.users, await new24h("users")),
    notebooks: growth(counts.notebooks, await new24h("notebooks")),
    sources: growth(counts.sources, await one("SELECT COUNT(*) n FROM sources WHERE created_at > $1 AND (origin IS NULL OR origin NOT LIKE 'note:%')", dayAgo)),
    outputs: growth(counts.outputs, await new24h("studio_outputs")),
    calls: prevCalls > 0 ? ((calls24h.total - prevCalls) / prevCalls) * 100 : 0,
    successPp,
    p95Ms: pct(95) - prevP95,
  };
  const callSeries = await aiCallSeries(24);
  // 累计趋势(单调上行,平滑好看):由每日新增 + 当前总量反推 7 日累计。
  const cumul = async (t: string, total: number): Promise<number[]> => {
    const dn = await dailyNew(t);
    let acc = total - dn.reduce((a, b) => a + b, 0);
    return dn.map((n) => (acc += n));
  };
  const spark = {
    users: await cumul("users", counts.users),
    notebooks: await cumul("notebooks", counts.notebooks),
    sources: await cumul("sources", counts.sources),
    outputs: await cumul("studio_outputs", counts.outputs),
    calls: callSeries.map((s) => s.total),
  };

  const jobs = (
    await pool.query("SELECT status, COUNT(*) n FROM jobs WHERE created_at > $1 GROUP BY status", [dayAgo])
  ).rows as { status: string; n: number }[];
  const outputsByKind = (
    await pool.query("SELECT kind, COUNT(*) n FROM studio_outputs GROUP BY kind ORDER BY n DESC")
  ).rows as { kind: string; n: number }[];
  const recentErrors = (
    await pool.query("SELECT ts, provider, model, status, error FROM ai_calls WHERE ok = 0 ORDER BY ts DESC LIMIT 5")
  ).rows;

  // 答案反馈(此前只写不读):点赞/点踩计数 + 最近被点踩的回答。
  const feedback = {
    up: await one("SELECT COUNT(*) n FROM messages WHERE feedback = 'up'"),
    down: await one("SELECT COUNT(*) n FROM messages WHERE feedback = 'down'"),
  };
  const role = adminRoleOf(g);
  const recentDownRows = (
    await pool.query(
      `SELECT m.notebook_id, m.content, m.created_at, n.title
       FROM messages m LEFT JOIN notebooks n ON n.id = m.notebook_id
       WHERE m.feedback = 'down' ORDER BY m.created_at DESC LIMIT 5`
    )
  ).rows as Array<{ notebook_id: string; content: string; created_at: number; title: string | null }>;
  // 安全审计员监督数量、对象和时刻即可；回答正文属于用户私有内容，不能从总览旁路泄露。
  const recentDown = role === "auditor"
    ? recentDownRows.map(({ content: _content, ...row }) => row)
    : recentDownRows;
  // 总览对 operator 开放，但活动审计模块明确只允许 super/auditor。
  // 不能因为“最近动态”卡片复用数据就从总览旁路泄露审计记录。
  const recentActivity = role && canAccess(role, "audit") ? await listEvents({ limit: 8 }) : [];

  // PostgreSQL 是唯一数据库真源；旧 SQLite 文件即使残留也不能冒充现役库大小。
  const dbSize = await one("SELECT pg_database_size(current_database()) n");
  const cfg = await resolveProviderConfig({ allowInvalidGateway: true });
  const gatewaySettings = await getSettingsByPrefix("provider.gateway.");
  const gatewayEnabled = /^(1|true|on)$/i.test(
    gatewaySettings["provider.gateway.enabled"] ?? process.env.LITELLM_ENABLED ?? "0"
  );

  // API Key 用量 + 月度配额预警(避免额度用尽)。预算存 app_settings 的 quota.<provider>.tokens,
  // 0 = 不限额(不预警)。用量取近 30 天 token 总数(usage_daily 长期汇总,不随 7 天明细清理而丢失)。
  const usageStats = await getUsageStats(30);
  const qs = await getSettingsByPrefix("quota.");
  const budgetOf = (p: string) => Math.max(0, parseInt(qs[`quota.${p}.tokens`] || "0", 10) || 0);
  const usage = (["primary", "fallback", "gateway"] as const).map((p) => {
    const used = usageStats.byProvider[p]?.tokens ?? 0;
    const calls = usageStats.byProvider[p]?.calls ?? 0;
    const budget = budgetOf(p);
    const ratio = budget > 0 ? used / budget : 0;
    const level = budget <= 0 ? "none" : ratio >= 1 ? "over" : ratio >= 0.8 ? "warn" : "ok";
    return { provider: p, used, calls, budget, ratio, level };
  });

  return NextResponse.json({
    counts,
    calls24h: { total: calls24h.total, errors: calls24h.errors, fallback: calls24h.fallback, p50: pct(50), p95: pct(95) },
    jobs,
    outputsByKind,
    recentErrors,
    feedback,
    recentDown,
    recentActivity,
    deltas,
    spark,
    series: callSeries,
    usage: { days: usageStats.days, providers: usage },
    dbSize,
    provider: {
      primaryBase: cfg.primary.baseUrl,
      primaryModel: cfg.primary.chatModel,
      fallbackBase: cfg.fallback?.baseUrl ?? null,
      gatewayBase: gatewayEnabled
        ? gatewaySettings["provider.gateway.baseUrl"] ?? process.env.LITELLM_BASE_URL ?? null
        : null,
      gatewayModel: gatewaySettings["provider.gateway.chatModel"] ?? process.env.LITELLM_CHAT_MODEL ?? "apebook-chat",
    },
    uptimeSec: Math.floor(process.uptime()),
  });
}
