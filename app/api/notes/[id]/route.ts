import { NextRequest, NextResponse } from "next/server";
import { deleteNote, getNote, updateNote } from "@/lib/db";
import { requireAccess } from "@/lib/auth";
import { rateLimit, tooMany } from "@/lib/ratelimit";
import { syncNoteShadow, removeNoteShadow } from "@/lib/note-rag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const note = await getNote(id);
  if (!note) return NextResponse.json({ error: "笔记不存在" }, { status: 404 });
  const g = await requireAccess(req, note.notebook_id, true);
  if (g instanceof NextResponse) return g;
  // 洪水:内容变更会 fire-and-forget 重建影子来源(真嵌入调用)。按用户+笔记本限速。
  const lim = rateLimit(`note-write:${g.id}:${note.notebook_id}`, 20, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  const body = await req.json().catch(() => ({}));
  const content = typeof body.content === "string" ? body.content : undefined;
  if (content !== undefined && content.length > 1_000_000) {
    return NextResponse.json({ error: "笔记内容过长" }, { status: 413 });
  }
  await updateNote(id, {
    title: typeof body.title === "string" ? body.title.slice(0, 200) : undefined,
    content,
  });
  void syncNoteShadow(id); // 内容变了 → 重建影子来源,保持 RAG 与笔记一致
  return NextResponse.json({ note: await getNote(id) });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const note = await getNote(id);
  if (!note) return NextResponse.json({ ok: true });
  const g = await requireAccess(req, note.notebook_id, true);
  if (g instanceof NextResponse) return g;
  removeNoteShadow(id); // 先清影子来源,避免孤儿
  await deleteNote(id);
  return NextResponse.json({ ok: true });
}
