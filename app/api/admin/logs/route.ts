import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/admin";
import { aiCallSeries, getCadJobObservabilitySummary, getSettingsByPrefix, listAiCalls } from "@/lib/db";
import { cadWorkerHeartbeatReady } from "@/lib/cad-worker-heartbeat";
import { getPool } from "@/lib/pg";
import { resolveWorkerGates } from "@/lib/worker-gates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const g = await requireRole(req, "monitor");
  if (g instanceof NextResponse) return g;
  const sp = req.nextUrl.searchParams;
  const provider = sp.get("provider") || undefined;
  const ok = (sp.get("ok") as "ok" | "err" | null) || undefined;
  const pool = getPool();
  const [calls, jobsResult, queueResult, refundResult, jobSettings, series, cad, cadHeartbeat] = await Promise.all([
    listAiCalls({ limit: 120, provider, okOnly: ok ?? undefined }),
    pool.query(
      `SELECT j.id,j.kind,j.status,j.progress,j.error,j.created_at,j.updated_at,
              j.priority,j.run_attempt,j.credits_reserved,j.credits_final,j.tokens_in,j.tokens_out,
              j.started_at,j.finished_at,j.stage,j.stage_started_at,
              n.title AS notebook,u.name AS user_name,
              CASE WHEN j.kind='cad' OR j.lane='cad' THEN 'cad' ELSE 'general' END AS lane
         FROM jobs j
         LEFT JOIN notebooks n ON n.id=j.notebook_id
         LEFT JOIN users u ON u.id=j.user_id
        ORDER BY j.created_at DESC LIMIT 40`
    ),
    pool.query(
      `SELECT CASE WHEN kind='cad' THEN 'cad' ELSE 'general' END AS lane,status,COUNT(*) n
         FROM jobs WHERE status IN ('draft','queued','running','error')
        GROUP BY 1,2`
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE state='pending') pending,
              COUNT(*) FILTER (WHERE state='processing') processing
         FROM credit_refund_outbox`
    ),
    getSettingsByPrefix("jobs."),
    aiCallSeries(24, { provider, okOnly: ok ?? undefined }),
    getCadJobObservabilitySummary(Date.now() - 24 * 60 * 60_000),
    cadWorkerHeartbeatReady(true),
  ]);
  const queue = Object.fromEntries(
    ["general", "cad"].map((lane) => [lane, Object.fromEntries(
      queueResult.rows
        .filter((row) => row.lane === lane)
        .map((row) => [row.status, Number(row.n)])
    )])
  );
  const refundRow = refundResult.rows[0] as { pending?: number; processing?: number } | undefined;
  const workers = resolveWorkerGates(jobSettings);
  // 趋势图与调用日志同筛选(通道/结果)联动,避免「点了筛选趋势纹丝不动」的误导。
  return NextResponse.json({
    calls,
    jobs: jobsResult.rows,
    queue,
    // Web 与 CAD 是独立容器：通用车道看本 Web 的 owner/环境闸，
    // CAD 车道必须看独立 worker 在 DB 写入的原生 FreeCAD 新鲜心跳。
    workers: { general: workers.general, cad: cadHeartbeat.ok },
    refunds: {
      pending: Number(refundRow?.pending ?? 0),
      processing: Number(refundRow?.processing ?? 0),
    },
    series,
    cad,
  });
}
