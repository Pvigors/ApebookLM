import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/admin";
import { getPlansConfig } from "@/lib/plans-config";
import { PLANS, MANAGED_ENTITLEMENT_TIERS, PLAN_OVERRIDE_FIELDS, validPlanOverrideValue } from "@/lib/plans";
import { getPool } from "@/lib/pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// free 是安全哨兵，trial 是固定注册赠送；后台只能编辑可管理的三档权益。
const TIERS = [...MANAGED_ENTITLEMENT_TIERS] as string[];
const LOCKED_TIERS = PLANS.filter((plan) => !TIERS.includes(plan.id)).map((plan) => plan.id);
const FIELDS: readonly string[] = PLAN_OVERRIDE_FIELDS;
const managedPlanViews = () => getPlansConfig();
/** 仅允许 plan.<tier>.<field>(白名单),防越权写任意 setting。 */
const allowed = (k: string): boolean => {
  const [p, tier, field] = k.split(".");
  return p === "plan" && TIERS.includes(tier) && FIELDS.includes(field);
};

export async function GET(req: NextRequest) {
  const g = await requireRole(req, "plans");
  if (g instanceof NextResponse) return g;
  // plans = 代码默认叠加后台覆盖后的当前生效值;fields = 可编辑字段清单(供前端渲染)。
  return NextResponse.json({ plans: await managedPlanViews(), fields: FIELDS, lockedTiers: LOCKED_TIERS });
}

/** PUT body: { set: {"plan.starter.dailyLimit": "40", ...} } —— 空串 = 删除覆盖。 */
export async function PUT(req: NextRequest) {
  const g = await requireRole(req, "plans", { write: true });
  if (g instanceof NextResponse) return g;
  const body = (await req.json().catch(() => ({}))) as { set?: Record<string, unknown> };
  const entries = Object.entries(body.set ?? {});
  if (!entries.length) {
    return NextResponse.json({ ok: false, error: "没有可保存的权益配置" }, { status: 400 });
  }
  const invalidKeys = entries.flatMap(([key, raw]) => {
    if (!allowed(key)) return [key];
    const value = String(raw ?? "").trim();
    if (value === "") return [];
    const field = key.split(".")[2];
    return /^-?\d+$/.test(value) && validPlanOverrideValue(field, Number(value)) ? [] : [key];
  });
  // 先整批校验再落库，避免前几项已保存、后一项静默跳过的部分成功。
  if (invalidKeys.length) {
    return NextResponse.json(
      { ok: false, error: `权益配置包含无效值：${invalidKeys.join("、")}`, invalidKeys },
      { status: 400 }
    );
  }
  const applied: string[] = [];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const now = Date.now();
    for (const [k, raw] of entries) {
      const s = String(raw ?? "").trim();
      if (s === "") {
        // 清空 = 撤销覆盖，该字段回落 lib/plans 代码默认。
        await client.query("DELETE FROM app_settings WHERE key = $1", [k]);
        applied.push(`-${k}`);
        continue;
      }
      await client.query(
        `INSERT INTO app_settings (key, value, updated_at, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(key) DO UPDATE
           SET value = excluded.value,
               updated_at = excluded.updated_at,
               updated_by = excluded.updated_by`,
        [k, s, now, g.id]
      );
      applied.push(k);
    }
    // 权益配置写入与审计同一事务，不允许出现部分生效的中间态。
    await client.query(
      `INSERT INTO activity_log
         (ts, actor_id, actor_kind, action, target_type, meta)
       VALUES ($1, $2, 'admin', 'admin.plans_update', 'setting', $3)`,
      [now, g.id, JSON.stringify({ applied })]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true, applied, plans: await managedPlanViews() });
}
