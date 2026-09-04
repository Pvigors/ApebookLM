import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/admin";
import { creditLedgerEarliestTs, creditStatsByOp, creditStatsByDay, creditTopUsers, tokenStatsByModel } from "@/lib/db";
import {
  BREAK_EVEN_CNY_PER_CREDIT,
  CREDIT_COSTS,
  STUDIO_CREDIT_COSTS,
  creditOpLabel,
  isCreditAcquisitionOp,
  OP_LABELS,
} from "@/lib/credits";
import { getCreditConfig } from "@/lib/credits-config";
import { getPool } from "@/lib/pg";
import { aggregateCreditOperations, creditCostAllocation } from "@/lib/admin-credit-cost";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 仅允许现役计价项；正则白名单会把不存在的键写进 DB，也曾漏掉 cad_rebuild。 */
const CREDIT_KEYS = new Set([
  ...Object.keys(CREDIT_COSTS).map((op) => `credit.cost.${op}`),
  ...Object.keys(STUDIO_CREDIT_COSTS).map((kind) => `credit.studio.${kind}`),
  "credit.anchor",
]);
const MAX_CREDITS_PER_ACTION = 1_000_000;
const MAX_ANCHOR_CNY = 100;

function validCreditSetting(key: string, raw: unknown): boolean {
  const value = String(raw ?? "").trim();
  if (value === "") return true; // 空串 = 删除覆盖
  if (key === "credit.anchor") {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return false;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 && n <= MAX_ANCHOR_CNY;
  }
  if (!/^\d+$/.test(value)) return false;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_CREDITS_PER_ACTION;
}

/** 积分对账:积分消耗(credit_ledger)× 模型成本(ai_calls×单次阶梯价)。
 *  credit.anchor 是经营目标成本；真正亏损按最低净收入盈亏线判断。
 *  说明:成本按模型聚合(ai_calls 无 per-op 通道),per-op 成本为按积分占比的分摊估算。 */
export async function GET(req: NextRequest) {
  const g = await requireRole(req, "credits");
  if (g instanceof NextResponse) return g;
  const days = Math.min(30, Math.max(1, parseInt(req.nextUrl.searchParams.get("days") || "7", 10) || 7));
  const cc = await getCreditConfig(); // 代码默认 + 后台覆盖后的当前生效权重

  const rawByOp = (await creditStatsByOp(days)).filter((r) => !isCreditAcquisitionOp(r.op));
  const groupedByOp = aggregateCreditOperations(rawByOp);
  const byOp = groupedByOp.map((r) => ({ ...r, label: creditOpLabel(r.op) }));
  const byDay = await creditStatsByDay(Math.min(days, 14));
  const topUsers = await creditTopUsers(days);
  // 成本窗口起点对齐账本最早一笔:账本启用前的历史调用不参与对账,否则每积分成本虚高。
  const ledgerStart = (await creditLedgerEarliestTs()) ?? undefined;
  const byModel = (await tokenStatsByModel(Math.min(days, 7), ledgerStart)).map((m) => ({
    ...m,
    costCNY: Math.round((Number(m.cost_micros) / 1_000_000) * 10000) / 10000,
  }));

  // 管理员赠送/邀请奖励是积分发行，不是消费；不能用负数冲掉成本分母。
  const totalCredits = groupedByOp.reduce((s, r) => s + r.credits, 0);
  const totalCostCNY = Math.round(byModel.reduce((s, m) => s + m.costCNY, 0) * 10000) / 10000;
  // 每积分实际成本(¥)。注意:ai_calls 只留 7 天,days>7 时成本窗口为 7 天,
  // 分母取同 7 天窗口的积分数保持口径一致。
  const costWindowDays = Math.min(days, 7);
  const costWindowRows = days <= 7
    ? groupedByOp
    : aggregateCreditOperations(
        (await creditStatsByOp(7)).filter((r) => !isCreditAcquisitionOp(r.op))
      );
  const allocation = creditCostAllocation(costWindowRows, totalCostCNY);
  const costPerCredit = allocation.costPerCredit;

  // 按积分占比把总成本分摊到 op(近似,标注 estimated)。
  const opWithCost = byOp.map((r) => ({
    ...r,
    estCostCNY: allocation.estimatedByOp.get(r.op) ?? null,
  }));

  return NextResponse.json({
    days,
    anchorCNY: cc.anchorCNY,
    breakEvenCNY: BREAK_EVEN_CNY_PER_CREDIT,
    totalCredits,
    totalCostCNY,
    costPerCredit,
    costCalculable: allocation.calculable,
    costWindowDays,
    aboveTarget: costPerCredit != null && costPerCredit > cc.anchorCNY,
    losing: costPerCredit != null && costPerCredit > BREAK_EVEN_CNY_PER_CREDIT,
    byOp: opWithCost,
    byDay,
    byModel,
    topUsers,
    // 当前用量权重（含后台覆盖后的生效值）；key = 可编辑的 setting 键。
    priceTable: [
      ...Object.entries(cc.costs).map(([op, credits]) => ({ key: `credit.cost.${op}`, op, label: OP_LABELS[op] ?? op, credits })),
      ...Object.entries(cc.studio).map(([k, credits]) => ({
        key: `credit.studio.${k}`,
        op: `studio:${k}`,
        label: OP_LABELS[`studio:${k}`] ?? k,
        credits,
      })),
    ],
  });
}

/** PUT body: { set: {"credit.cost.chat":"2", "credit.anchor":"0.05", ...} } —— 空串 = 删覆盖回落默认。 */
export async function PUT(req: NextRequest) {
  const g = await requireRole(req, "credits", { write: true });
  if (g instanceof NextResponse) return g;
  const body = (await req.json().catch(() => ({}))) as { set?: Record<string, unknown> };
  const entries = Object.entries(body.set ?? {});
  if (!entries.length) {
    return NextResponse.json({ ok: false, error: "没有可保存的积分配置" }, { status: 400 });
  }
  const invalidKeys = entries
    .filter(([key, raw]) => !CREDIT_KEYS.has(key) || !validCreditSetting(key, raw))
    .map(([key]) => key);
  if (invalidKeys.length) {
    return NextResponse.json(
      { ok: false, error: `积分配置包含无效值：${invalidKeys.join("、")}`, invalidKeys },
      { status: 400 }
    );
  }

  const applied: string[] = [];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const now = Date.now();
    for (const [key, raw] of entries) {
      const value = String(raw ?? "").trim();
      if (value === "") {
        await client.query("DELETE FROM app_settings WHERE key = $1", [key]);
        applied.push(`-${key}`);
        continue;
      }
      await client.query(
        `INSERT INTO app_settings (key, value, updated_at, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(key) DO UPDATE
           SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
        [key, value, now, g.id]
      );
      applied.push(key);
    }
    // 权重配置与审计同成同败；不能让接口报失败时已有部分配置悄悄生效。
    await client.query(
      `INSERT INTO activity_log (ts, actor_id, actor_kind, action, target_type, meta)
       VALUES ($1, $2, 'admin', 'admin.credits_update', 'setting', $3)`,
      [now, g.id, JSON.stringify({ applied })]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true, applied, config: await getCreditConfig() });
}
