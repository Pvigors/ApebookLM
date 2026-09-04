import { NextRequest, NextResponse } from "next/server";
import { adminRoleOf, canAccess, requireRole } from "@/lib/admin";
import { METRICS, METRIC_GROUPS, isMetricId, queryMetrics, type MetricId } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 数据工作台的取数接口。
 *
 * 和 /api/admin/analytics 的分工:那个是固定七段报表、一次全给;这个是按需取指标 ——
 * 画布上拖了哪几个就查哪几个,时间范围由前端定。两者共存,老页面不受影响。
 *
 *   GET ?catalog=1              → 指标目录(分组、口径说明、各自的回看上限)
 *   GET ?metrics=dau,crd&days=30 → 这几个指标的逐日序列
 */
export async function GET(req: NextRequest) {
  // 进门先过 analytics 模块授权(operator 可写、auditor 只读)。
  const g = await requireRole(req, "analytics");
  if (g instanceof NextResponse) return g;
  const role = adminRoleOf(g);
  if (!role) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });

  // 再按指标自己的归属模块筛一道 —— 工作台是一个页面,但画布上可以放金额、成本这类
  // 比普通分析更敏感的数,权限要跟着数据走而不是跟着页面走。
  const visible = (id: MetricId) => canAccess(role, METRICS[id].scope ?? "analytics");

  const sp = req.nextUrl.searchParams;

  if (sp.get("catalog")) {
    return NextResponse.json({
      groups: METRIC_GROUPS.map((grp) => ({
        id: grp.id,
        label: grp.label,
        metrics: grp.metrics.filter(visible).map((id) => {
          const m = METRICS[id];
          return { id: m.id, label: m.label, unit: m.unit, desc: m.desc, maxDays: m.maxDays ?? null, caveat: m.caveat ?? null };
        }),
      })).filter((grp) => grp.metrics.length),
    });
  }

  const raw = (sp.get("metrics") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ids = (raw.filter(isMetricId) as MetricId[]).filter(visible);
  if (!ids.length) {
    return NextResponse.json({ error: "metrics 参数为空、无效,或当前角色无权查看" }, { status: 400 });
  }
  // 画布一次最多 8 块,再多既看不过来也会拖慢响应。
  if (ids.length > 8) {
    return NextResponse.json({ error: "一次最多查询 8 个指标" }, { status: 400 });
  }

  const days = Number(sp.get("days") || 30);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return NextResponse.json({ error: "days 需在 1..365 之间" }, { status: 400 });
  }

  const data = await queryMetrics(ids, days);
  return NextResponse.json(data);
}
