import { NextRequest, NextResponse } from "next/server";
import { consumeDailyQuota, getNotebook, getStudioOutput, quotaExceededMessage, refundCreditsWithRetry, updateStudioOutput } from "@/lib/db";
import { requireAccess } from "@/lib/auth";
import { rateLimit, tooMany } from "@/lib/ratelimit";
import { creditCostForOp } from "@/lib/credits-config";
import { generateSlides, resolveDeckRevisionConfig, reviseSlide, type Deck } from "@/lib/slides";
import { withUserModelRuntime } from "@/lib/ai-provider-context";
import { resolveUserModelRuntimeForNotebook, snapshotModelProviderRef, UserModelConfigError } from "@/lib/user-model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST { instruction } —— 就地按新要求重新生成这份演示文稿(沿用原取材与模版)。 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const out = await getStudioOutput(id);
  if (!out) return NextResponse.json({ error: "制品不存在" }, { status: 404 });
  const g = await requireAccess(req, out.notebook_id, true);
  if (g instanceof NextResponse) return g;
  // 洪水:revise 是真实 CHAT_MODEL 生成,单用户把整套积分集中一分钟并发发出会打满
  // 上游 TPM/QPS 挤掉其他人。补速率闸(与 overview/chat 同口径)。
  const lim = rateLimit(`revise:${g.id}`, 5, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  if (out.kind !== "slides") {
    return NextResponse.json({ error: "暂只支持演示文稿的就地修改" }, { status: 400 });
  }
  const notebook = await getNotebook(out.notebook_id);
  if (!notebook) return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 4000) : "";
  if (!instruction) return NextResponse.json({ error: "请描述要怎么改" }, { status: 400 });
  // 指定了 slideIndex → 只改这一页;否则整份按要求重生成。
  const slideIndex =
    typeof body.slideIndex === "number" && Number.isInteger(body.slideIndex) && body.slideIndex >= 0
      ? body.slideIndex
      : null;

  // 沿用原制品的取材(data.sourceIds)与模版(content.theme)。
  let sourceIds: string[] | undefined;
  let dataWatermark: boolean | undefined;
  let dataLanguage: string | undefined;
  try {
    const d = JSON.parse(out.data || "{}") as {
      sourceIds?: unknown;
      watermark?: unknown;
      generation?: { language?: unknown };
    };
    if (Array.isArray(d.sourceIds)) sourceIds = d.sourceIds.filter((s): s is string => typeof s === "string");
    if (typeof d.watermark === "boolean") dataWatermark = d.watermark;
    if (typeof d.generation?.language === "string") dataLanguage = d.generation.language;
  } catch {
    /* 无 data 旁路 → 用全部就绪来源(generateSlides 内部回退) */
  }
  let storedDeck: Deck | null = null;
  try {
    storedDeck = JSON.parse(out.content || "{}") as Deck;
  } catch {
    /* 解析失败 → 默认模版 */
  }
  const { theme, watermark, language } = resolveDeckRevisionConfig(storedDeck, {
    watermark: dataWatermark,
    language: dataLanguage,
  });

  // 指定单页时先校验该页存在(解析原 deck)—— 校验不过不该走到扣分。
  let deck: Deck | null = null;
  if (slideIndex != null) {
    deck = storedDeck;
    if (!deck || !Array.isArray(deck.slides) || !deck.slides[slideIndex]) {
      return NextResponse.json({ error: "幻灯片不存在,请刷新后重试。" }, { status: 400 });
    }
  }

  // M6/L4:修订也是真实模型生成 —— 受当日额度约束。审查修复:配额+计量原子化。
  // 公平性:挪到 instruction/slideIndex 等参数校验之后,参数不合法不扣分。
  const reviseCost = await creditCostForOp("revise"); // 后台可调价
  let modelRuntime: Awaited<ReturnType<typeof resolveUserModelRuntimeForNotebook>>;
  try {
    const modelRef = await snapshotModelProviderRef(g.id, notebook);
    modelRuntime = await resolveUserModelRuntimeForNotebook(g.id, notebook, modelRef);
  } catch (error) {
    if (error instanceof UserModelConfigError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    throw error;
  }
  const quota = await consumeDailyQuota(g, "revise", reviseCost);
  if (quota.over) {
    return NextResponse.json(
      {
        error: quotaExceededMessage(quota, reviseCost),
        code: "quota",
      },
      { status: 429 }
    );
  }

  try {
    const r = await withUserModelRuntime(modelRuntime, async () => {
      if (slideIndex != null && deck) {
        return reviseSlide(out.notebook_id, sourceIds, deck, slideIndex, instruction, language);
      }
      // 记忆跟「发起修订的人」(g)走,而非笔记本所有者。
      return generateSlides(out.notebook_id, sourceIds, {
          instruction,
          theme,
          language,
          watermark,
          memberId: g.id,
        });
    });
    await updateStudioOutput(id, { content: r.content, title: r.title });
    return NextResponse.json({ content: r.content, title: r.title });
  } catch (e) {
    // 修订失败(无产物)→ 退还本次扣的积分,口径与 lib/jobs.ts runOne 的 catch 一致。
    try {
      await refundCreditsWithRetry(g.id, "revise", reviseCost, quota.ledgerId);
    } catch (re) {
      console.warn("[revise] 积分退回失败（忽略）:", re);
    }
    const msg = e instanceof Error ? e.message : String(e);
    const status = (e as { status?: number })?.status;
    const friendly =
      status === 429 || /rate limit|TPM|quota/i.test(msg)
        ? "模型接口限流,请等待约 1 分钟后重试。"
        : /[一-鿿]/.test(msg)
        ? msg.slice(0, 120)
        : "修改失败,请重试。";
    return NextResponse.json({ error: friendly }, { status: 500 });
  }
}
