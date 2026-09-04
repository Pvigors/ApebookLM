import { NextRequest, NextResponse } from "next/server";
import { consumeDailyQuota, getNotebook, getNotebookAccess, getNotebookOverviewEpoch, listSources, quotaExceededMessage, refundGuardedCreditsWithRetry, setNotebookOverviewAndSettleCharge } from "@/lib/db";
import { generateNotebookOverview } from "@/lib/rag";
import { requireAccess } from "@/lib/auth";
import { creditCostForOp } from "@/lib/credits-config";
import { rateLimit, tooMany } from "@/lib/ratelimit";
import { hasUsageAccess } from "@/lib/membership";
import { withUserModelRuntime } from "@/lib/ai-provider-context";
import { resolveUserModelRuntimeForNotebook, snapshotModelProviderRef, UserModelConfigError } from "@/lib/user-model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 勾选来源只是改变聊天取材范围，不是主动发起 AI 生成。子集概览只组合已通过
 * 事实门的 source.summary：无模型调用、无扣分，也没有多实例缓存/单航班问题。
 */
function deterministicScopedOverview(
  sources: Array<{ title: string; summary: string }>
): { summary: string; suggested_questions: string[] } {
  const safeTitle = (title: string) => title
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_{}[\]()#+.!|>~-])/g, "\\$1")
    .trim();
  const summary = sources
    .map((source) => `**${safeTitle(source.title)}**\n${source.summary.trim()}`)
    .join("\n\n");
  const suggested = sources
    .slice(0, 3)
    .map((source) => `${source.title.trim().slice(0, 80)}的核心观点和证据是什么？`);
  suggested.push(
    sources.length === 1
      ? "这份来源中有哪些关键步骤、限制或易错点？"
      : "这些来源在关键结论上有哪些相同点和差异？"
  );
  return { summary, suggested_questions: [...new Set(suggested)].slice(0, 4) };
}

/**
 * (Re)generate the notebook overview (summary + suggested questions).
 * If `sourceIds` is provided, the overview is scoped to just those sources and
 * is NOT persisted (it's an ephemeral, selection-scoped view). With no
 * `sourceIds`, it covers all ready sources and is persisted as the canonical
 * notebook overview.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const g = await requireAccess(req, id);
  if (g instanceof NextResponse) return g;
  const ovNb = await getNotebook(id);
  if (!ovNb) {
    return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const sourceIds = Array.isArray(body.sourceIds)
    ? (body.sourceIds.filter((s: unknown) => typeof s === "string") as string[])
    : undefined;

  let ready = (await listSources(id)).filter((s) => s.status === "ready");
  if (sourceIds) {
    const requested = new Set(sourceIds);
    ready = ready.filter((s) => requested.has(s.id));
    if (ready.length !== requested.size) {
      return NextResponse.json(
        { error: `${requested.size - ready.length} 个所选来源不存在或尚未就绪` },
        { status: 400 }
      );
    }
  }
  // 在限流/扣分前 fail closed:概览生成器只看标题+导读,空列表或全部
  // 导读未就绪时没有任何可供模型忠实概括的正文,不应先扣分再收到空 JSON。
  const usableReady = ready.filter(
    (source) => source.title?.trim() && typeof source.summary === "string" && source.summary.trim()
  );
  if (!ready.length || usableReady.length !== ready.length) {
    const pendingCount = ready.length - usableReady.length;
    return NextResponse.json(
      {
        error: !ready.length
          ? "请先选择至少一个有效来源"
          : `${pendingCount} 个来源的导读尚未就绪，请稍后再生成概览`,
      },
      { status: 400 }
    );
  }
  ready = usableReady;

  // Home 会在勾选范围改变时自动请求子集概览。必须在会员/扣分门之前
  // 返回确定性结果，否则“只是勾选聊天来源”会静默消耗积分。
  if (sourceIds) {
    return NextResponse.json(deterministicScopedOverview(
      ready.map((source) => ({ title: source.title, summary: String(source.summary) }))
    ));
  }

  // viewer 不能覆写共享概览；仅查看时同样返回已核验导读的确定性组合，
  // 不为一个无法持久的临时结果扣分。
  const role = await getNotebookAccess(id, g.id);
  if (role === "viewer") {
    return NextResponse.json(deterministicScopedOverview(
      ready.map((source) => ({ title: source.title, summary: String(source.summary) }))
    ));
  }

  if (!hasUsageAccess(g)) {
    return NextResponse.json(
      { error: "积分不足，可通过邀请活动获取积分或联系管理员补充", code: "quota" },
      { status: 429 }
    );
  }

  const sourceSnapshot = ready.map((source) => ({
    id: source.id,
    title: source.title,
    fetchedAt: Number(source.fetched_at ?? 0),
    summary: String(source.summary ?? ""),
  }));
  let modelRuntime: Awaited<ReturnType<typeof resolveUserModelRuntimeForNotebook>>;
  try {
    const modelRef = await snapshotModelProviderRef(g.id, ovNb);
    modelRuntime = await resolveUserModelRuntimeForNotebook(g.id, ovNb, modelRef);
  } catch (error) {
    if (error instanceof UserModelConfigError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    throw error;
  }
  const overviewEpoch = await getNotebookOverviewEpoch(id);

  // M6 收口:概览也是真实模型调用。加每用户限流 + 计量,堵住绕开 chat/studio
  // 配额闸门、靠反复 POST 概览无限调模型的旁路。
  const lim = rateLimit(`overview:${g.id}`, 20, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  // 审查修复:与 chat/studio/revise 同口径的当日配额闸门 + 原子计量。
  // 概览会产生真实模型成本，统一由本次发起者扣分；协作者不能成为免费旁路。
  const overviewCost = await creditCostForOp("overview"); // 后台可调价
  let creditLedgerId: number | undefined;
  const quota = await consumeDailyQuota(g, "overview", overviewCost, ovNb.title, {
    refundAfterMs: 2 * 60_000,
    requestId: `overview:${id}`,
  });
  if (quota.over) {
    return NextResponse.json(
      {
        error: quotaExceededMessage(quota, overviewCost),
        code: "quota",
      },
      { status: 429 }
    );
  }
  creditLedgerId = quota.ledgerId;

  try {
    // 概览是会经 /api/public 公开的共享元数据,生成器只接收经验证的
    // 来源标题+导读,不读笔记本 chat_instructions/成员偏好。
    const overview = await withUserModelRuntime(modelRuntime, () =>
      generateNotebookOverview(ready.map((s) => ({ title: s.title, summary: s.summary })))
    );
    // 计量已在 consumeDailyQuota 内原子完成。
    // Only persist the canonical (all-source) overview — and only for owner/editor:
    // 只读协作者(viewer)可查看临时概览,但不可覆写笔记本级共享概览。
    // 生成器已对空 JSON/不完整结构 fail closed;这里仍保留非空落库守卫,
    // 避免任何未来兼容分支把已有概览覆盖为空。
    if (overview.summary?.trim() || overview.suggested_questions.length) {
      await setNotebookOverviewAndSettleCharge(
        id,
        overview.summary,
        overview.suggested_questions,
        creditLedgerId,
        sourceSnapshot,
        overviewEpoch
      );
    } else {
      throw new Error("概览结果为空");
    }
    return NextResponse.json({
      summary: overview.summary,
      suggested_questions: overview.suggested_questions,
    });
  } catch (err) {
    // 生成失败(无产物)→ 退还本次扣的积分,口径与 lib/jobs.ts runOne 的 catch 一致。
    // 协作者路径本就没扣分,无需(也不能)退。
    try {
      await refundGuardedCreditsWithRetry(g.id, "overview", overviewCost, creditLedgerId);
    } catch (re) {
      console.warn("[overview] 积分退回失败（已入持久 outbox）:", re);
    }
    console.error("[overview] 生成失败:", err);
    return NextResponse.json({ error: "概览生成失败,请稍后重试。" }, { status: 500 });
  }
}
