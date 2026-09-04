import { NextRequest, NextResponse } from "next/server";
import { getMessageNotebookId, setMessageFeedback } from "@/lib/db";
import { requireAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH { feedback: "up" | "down" | null } — thumbs feedback on an answer. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const notebookId = await getMessageNotebookId(id);
  if (!notebookId) return NextResponse.json({ error: "消息不存在" }, { status: 404 });
  const g = await requireAccess(req, notebookId, true);
  if (g instanceof NextResponse) return g;
  const body = await req.json().catch(() => ({}));
  const fb = body.feedback;
  await setMessageFeedback(id, fb === "up" || fb === "down" ? fb : null);
  return NextResponse.json({ ok: true });
}
