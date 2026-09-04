import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/admin";
import { listFeedback, setFeedbackStatus } from "@/lib/db";
import { recordEvent } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const g = await requireRole(req, "feedback");
  if (g instanceof NextResponse) return g;
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") || "all";
  const limit = Math.min(100, Number(sp.get("limit")) || 50);
  const offset = Math.max(0, Number(sp.get("offset")) || 0);
  const { rows, total } = await listFeedback({ status, limit, offset });
  return NextResponse.json({ rows, total });
}

export async function PATCH(req: NextRequest) {
  const g = await requireRole(req, "feedback", { write: true });
  if (g instanceof NextResponse) return g;
  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  const status = body.status === "resolved" ? "resolved" : "open";
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  if (!(await setFeedbackStatus(id, status, g.id))) return NextResponse.json({ error: "未找到反馈" }, { status: 404 });
  await recordEvent({
    actorId: g.id,
    actorKind: "admin",
    action: "admin.feedback_status",
    targetType: "feedback",
    targetId: id,
    meta: { status },
  });
  return NextResponse.json({ ok: true });
}
