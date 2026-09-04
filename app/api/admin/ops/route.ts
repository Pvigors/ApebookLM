import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/admin";
import { JOB_STALE_MS, getSettingsByPrefix, requeueFailedJobAsSponsored, sweepStaleJobs } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { kickWorker } from "@/lib/jobs";
import { recordEvent, purgeEvents } from "@/lib/activity";
import { maskSecret, isSecretKey } from "@/lib/mask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { action, jobId? }
 *  actions: retry_job | clear_stuck | purge_logs | vacuum | export_settings */
export async function POST(req: NextRequest) {
  // 先鉴权再解析请求体，避免匿名/普通用户用超大或慢请求体消耗管理端资源。
  // monitor write 是 retry_job 的最小权限；其余动作在识别 action 后再收紧到 ops write。
  const monitorAdmin = await requireRole(req, "monitor", { write: true });
  if (monitorAdmin instanceof NextResponse) return monitorAdmin;
  const body = (await req.json().catch(() => ({}))) as { action?: string; jobId?: string };
  let g = monitorAdmin;
  if (body.action !== "retry_job") {
    const opsAdmin = await requireRole(req, "ops", { write: true });
    if (opsAdmin instanceof NextResponse) return opsAdmin;
    g = opsAdmin;
  }
  const pool = getPool();

  switch (body.action) {
    case "retry_job": {
      if (!body.jobId) return NextResponse.json({ error: "缺少 jobId" }, { status: 400 });
      const retried = await requeueFailedJobAsSponsored(body.jobId);
      if (retried.status === "not_found") {
        return NextResponse.json({ error: "任务不存在" }, { status: 404 });
      }
      if (retried.status === "params_invalid") {
        return NextResponse.json({ error: "任务参数损坏,无法重试" }, { status: 422 });
      }
      if (retried.status === "retry_limit") {
        return NextResponse.json({ error: "该任务已人工重试过一次，请先排查失败原因" }, { status: 409 });
      }
      if (retried.status === "not_retryable") {
        return NextResponse.json({ error: "仅失败任务可人工重试；已取消任务不会被复活" }, { status: 409 });
      }
      kickWorker();
      const job = retried.job;
      await recordEvent({ actorId: g.id, actorKind: "admin", action: "admin.retry_job", targetType: "job", targetId: body.jobId, notebookId: job.notebook_id, meta: { kind: job.kind, reusedJob: true } });
      return NextResponse.json({ ok: true, newJobId: job.id, reused: true });
    }
    case "clear_stuck": {
      // 与 worker 的现役孤儿恢复完全同源：只处理超过 JOB_STALE_MS 无心跳的 running，
      // 先按 run_attempt CAS 重排，重试耗尽才终判失败并进入积分退回 outbox。queued 只是排队久，
      // 在全局单 worker 下完全可能超过阈值，绝不能当成卡死任务误杀。
      const recovered = await sweepStaleJobs();
      await recordEvent({
        actorId: g.id,
        actorKind: "admin",
        action: "admin.clear_stuck",
        meta: { recovered, staleMs: JOB_STALE_MS },
      });
      return NextResponse.json({ ok: true, recovered, staleMs: JOB_STALE_MS });
    }
    case "purge_logs": {
      const r = await pool.query("DELETE FROM ai_calls WHERE ts < $1", [Date.now() - 7 * 86400_000]);
      // 审计记录保留更久(用户/匿名/系统活动 90 天);管理操作 admin.* 长期保留(purgeEvents 已排除)。
      const aud = await purgeEvents(Date.now() - 90 * 86400_000);
      await recordEvent({ actorId: g.id, actorKind: "admin", action: "admin.purge_logs", meta: { deleted: r.rowCount, audit: aud } });
      return NextResponse.json({ ok: true, deleted: r.rowCount, audit: aud });
    }
    case "vacuum": {
      await pool.query("VACUUM");
      await recordEvent({ actorId: g.id, actorKind: "admin", action: "admin.vacuum" });
      return NextResponse.json({ ok: true });
    }
    case "export_settings": {
      const all = await getSettingsByPrefix("");
      const masked = Object.fromEntries(
        Object.entries(all).map(([k, v]) => [k, isSecretKey(k) ? maskSecret(v) : v])
      );
      // 导出全量配置属敏感动作,与其它 ops 动作一致记审计。
      await recordEvent({ actorId: g.id, actorKind: "admin", action: "admin.export_settings", targetType: "setting", meta: { keys: Object.keys(all).length } });
      return NextResponse.json({ ok: true, settings: masked });
    }
    default:
      return NextResponse.json({ error: "未知动作" }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  const g = await requireRole(req, "ops");
  if (g instanceof NextResponse) return g;
  const pool = getPool();
  const stuck = Number(
    (
      (await pool.query(
        "SELECT COUNT(*) n FROM jobs WHERE status = 'running' AND updated_at < $1",
        [Date.now() - JOB_STALE_MS]
      )).rows[0] as { n: number }
    ).n
  );
  const logRows = Number(
    ((await pool.query("SELECT COUNT(*) n FROM ai_calls")).rows[0] as { n: number }).n
  );
  const databaseSize = Number(
    ((await pool.query("SELECT pg_database_size(current_database()) n")).rows[0] as { n: number }).n
  );
  return NextResponse.json({
    database: {
      engine: "PostgreSQL",
      sizeBytes: databaseSize,
    },
    backup: {
      mode: "external",
      inApp: false,
      database: "scripts/backup.sh 通过 pg_dump 生成数据库备份",
      media: "媒体文件由运维脚本同步到 OSS/外部备份存储",
    },
    stuck,
    staleMs: JOB_STALE_MS,
    logRows,
  });
}
