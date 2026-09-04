import { NextRequest, NextResponse } from "next/server";
import { randomTopic, quickDiscover, deepResearch } from "@/lib/discover";
import { requireMember } from "@/lib/auth";
import { recordEvent, reqMeta } from "@/lib/activity";
import { consumeDailyQuota, quotaExceededMessage, refundCreditsWithRetry } from "@/lib/db";
import { creditCostForOp } from "@/lib/credits-config";
import { rateLimit } from "@/lib/ratelimit";
import { withUserModelRuntime } from "@/lib/ai-provider-context";
import { resolveUserModelRuntime, snapshotUserModelProviderRef, UserModelConfigError } from "@/lib/user-model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 深度搜索要多轮检索+抓取+综合,耗时更长,给足时间。
export const maxDuration = 120;

/** Discover sources: web search for a topic, returning candidate links. 需登录。 */
export async function POST(req: NextRequest) {
  const user = await requireMember(req);
  if (user instanceof NextResponse) return user;
  // 限流:改用 lib/ratelimit 的 sweep 版(此前内联 Map 无过期清理,单调增长),
  // 并加 IP 维度(此前只按 user.id,同账号多机共享令牌各得满额)。
  const ip = reqMeta(req).ip || "unknown";
  const lim = rateLimit(`discover:${user.id}:${ip}`, 20, 60_000);
  if (!lim.ok) {
    return NextResponse.json({ error: "搜索过于频繁,请稍后再试" }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  let query = typeof body.query === "string" ? body.query.trim() : "";
  const mode: "fast" | "deep" = body.mode === "deep" ? "deep" : "fast";
  // 发现/深度研究会调用模型和外部搜索：按资源差异扣分（快 5 / 深 20），
  // 配额+扣分在事务内原子完成。先判 mode 再扣,避免深档按快档少收。
  const op = mode === "deep" ? ("discover:deep" as const) : ("discover:fast" as const);
  let modelRuntime: Awaited<ReturnType<typeof resolveUserModelRuntime>>;
  try {
    const modelRef = await snapshotUserModelProviderRef(user.id);
    modelRuntime = await resolveUserModelRuntime(user.id, modelRef);
  } catch (error) {
    if (error instanceof UserModelConfigError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    throw error;
  }
  const discoverCost = await creditCostForOp(op); // 后台可调价
  const quota = await consumeDailyQuota(user, op, discoverCost);
  if (quota.over) {
    return NextResponse.json(
      {
        error: quotaExceededMessage(quota, discoverCost),
        code: "quota",
      },
      { status: 429 }
    );
  }
  try {
    // randomTopic 也在 try 里:扣分之后的任何失败路径都走 catch 退分。
    // 独立研究模型只用于深度研究；快速发现继续使用对话模型，避免普通搜索
    // 意外切到更慢、更贵的研究模型。
    const researchRuntime = modelRuntime && mode === "deep"
      ? { ...modelRuntime, requestClass: "research" as const }
      : modelRuntime;
    const discovery = await withUserModelRuntime(researchRuntime, async () => {
      if (body.curious || !query) query = await randomTopic();
      // 计量已在 consumeDailyQuota 内原子完成。
      // fast = 规划(改写+时效)→ 并行检索 → 低质过滤/去重 → 带日期精排(见 quickDiscover)。
      return mode === "deep" ? deepResearch(query) : quickDiscover(query, 8);
    });
    const { summary, results } = discovery;
    // 深度报告的引用编号对应综合前的完整来源池，不能用已重排/截断的
    // results 数组反推；快速搜索没有报告引用，显式回空数组保持响应稳定。
    const references = "references" in discovery ? discovery.references : [];
    recordEvent({
      actorId: user.id,
      actorKind: "user",
      action: "discover.search",
      meta: { query, mode, results: results.length },
      ...reqMeta(req),
    });
    return NextResponse.json({ query, summary, results, references, mode });
  } catch (err) {
    // 搜索失败(无结果产出)→ 退还本次扣的积分,op 与扣费一致(discover:fast/deep),
    // 口径同 lib/jobs.ts runOne 的失败退分。
    try {
      await refundCreditsWithRetry(user.id, op, discoverCost, quota.ledgerId);
    } catch (re) {
      console.warn("[discover] 积分退回失败（忽略）:", re);
    }
    // 错误脱敏：原始 err 只落 console（可能带上游 baseUrl / 搜索供应商域名），
    // 面向客户端只回通用中文文案。
    console.error("[discover] 搜索失败:", err);
    return NextResponse.json({ error: "搜索失败,请稍后重试" }, { status: 500 });
  }
}
