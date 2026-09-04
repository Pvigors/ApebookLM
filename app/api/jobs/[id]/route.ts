import { NextRequest, NextResponse } from "next/server";
import { cancelJobAndQueueRefund, dismissFailedJob, getJob, getNotebookAccess, processCreditRefundOutbox } from "@/lib/db";
import { recordEvent, reqMeta } from "@/lib/activity";
import { userFromRequest } from "@/lib/auth";
import { cleanupProcessingJobOutputs } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  const user = await userFromRequest(req);
  if (!user || !(await getNotebookAccess(job.notebook_id, user.id))) {
    return NextResponse.json({ error: "无权访问" }, { status: 403 });
  }
  return NextResponse.json({ job });
}

/** 取消生成:仅任务属主可取消(比 GET 的笔记本访问权更严,协作者不能取消别人发起的生成)。
 *  queued/running → canceled 并退还本次扣的积分;已进终态返回 409。 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  const user = await userFromRequest(req);
  if (!user || job.user_id !== user.id) {
    return NextResponse.json({ error: "无权访问" }, { status: 403 });
  }
  if (req.nextUrl.searchParams.get("dismiss") === "1") {
    if (job.status !== "error" || !(await dismissFailedJob(id, user.id))) {
      return NextResponse.json({ error: "只能删除已失败的任务记录" }, { status: 409 });
    }
    void recordEvent({
      actorId: user.id,
      actorKind: "user",
      action: "job.dismiss",
      targetType: "job",
      targetId: id,
      notebookId: job.notebook_id,
      meta: { kind: job.kind, status: job.status },
      ...reqMeta(req),
    });
    return NextResponse.json({ ok: true });
  }
  // 条件更新兜住与 worker 收尾的竞态:没改到行 = 任务已 done/error/canceled → 409。
  if (!(await cancelJobAndQueueRefund(id))) {
    return NextResponse.json({ error: "任务已结束,无法取消" }, { status: 409 });
  }
  await processCreditRefundOutbox().catch((error) => {
    console.warn("[jobs] 取消后的积分退回已进入 outbox，将自动重试:", error);
  });
  await cleanupProcessingJobOutputs(id);
  recordEvent({
    actorId: user.id,
    actorKind: "user",
    action: "job.cancel",
    targetType: "job",
    targetId: id,
    notebookId: job.notebook_id,
    meta: { kind: job.kind, was: job.status },
    ...reqMeta(req),
  });
  return NextResponse.json({ job: await getJob(id) });
}
