import { NextRequest, NextResponse } from "next/server";
import { userFromRequest } from "@/lib/auth";
import { getLedgerPage } from "@/lib/db";
import { creditOpLabel } from "@/lib/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** op → 中文明细。退回行 refund:<op> 显示为「积分退回 · X」；未知 op 原样回退。 */
const detailOf = creditOpLabel;

/** GET ?type=all|acquired|consumed&before=<id> → 积分用量分页(设置内「积分用量」表)。
 *  change 已反号：消耗为负、入账（赠送/退回）为正，直接给前端显示。
 *  detail 拼上笔记本名(note)。历史余额不再用当前权益档倒推，避免调整后改写过去。 */
export async function GET(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const type = (["all", "acquired", "consumed"] as const).find((t) => t === sp.get("type")) ?? "all";
  const beforeId = Number(sp.get("before")) || undefined;

  const { entries, hasMore } = await getLedgerPage(user.id, { type, limit: 20, beforeId });
  return NextResponse.json({
    entries: entries.map((e) => ({
      id: e.id,
      detail: e.note ? `${detailOf(e.op)} · ${e.note}` : detailOf(e.op),
      type: e.credits < 0 ? "acquired" : "consumed",
      change: -e.credits, // 台账消耗记正/入账记负 → 展示反号
      ts: e.ts,
      // 旧账本没有完整权益快照，无法给出可信“操作后余额”，明确返回 null。
      balance: null,
    })),
    hasMore,
  });
}
