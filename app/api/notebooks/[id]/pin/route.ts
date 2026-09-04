import { NextRequest, NextResponse } from "next/server";
import { requireAccess } from "@/lib/auth";
import { getNotebook, setNotebookPinned } from "@/lib/db";
import { recordEvent } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 置顶 / 取消置顶笔记本。每用户至多置顶一个;仅所有者可操作。 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await requireAccess(req, id, true);
  if (g instanceof NextResponse) return g;
  const nb = await getNotebook(id);
  if (!nb) return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });
  if (nb.user_id !== g.id) return NextResponse.json({ error: "仅所有者可置顶" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const pinned = !!body.pinned;
  await setNotebookPinned(id, pinned);
  await recordEvent({
    actorId: g.id,
    actorKind: "user",
    action: pinned ? "notebook.pin" : "notebook.unpin",
    targetType: "notebook",
    targetId: id,
  });
  return NextResponse.json({ ok: true, pinned });
}
