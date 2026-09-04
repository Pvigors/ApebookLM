import { NextRequest, NextResponse } from "next/server";
import { createNote, deleteAllNotes, getNotebook, listNotes, removeAllNoteShadows } from "@/lib/db";
import { requireAccess } from "@/lib/auth";
import { recordEvent } from "@/lib/activity";
import { rateLimit, tooMany } from "@/lib/ratelimit";
import { syncNoteShadow } from "@/lib/note-rag";
import type { NoteKind } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const g = await requireAccess(req, id);
  if (g instanceof NextResponse) return g;
  return NextResponse.json({ notes: await listNotes(id) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const g = await requireAccess(req, id, true);
  if (g instanceof NextResponse) return g;
  // 洪水:每次创建都 fire-and-forget 一次 syncNoteShadow(真嵌入调用),无限流可撑库
  // 并饿死全局嵌入锁。按用户+笔记本维度限速。
  const lim = rateLimit(`note-write:${g.id}:${id}`, 20, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  if (!(await getNotebook(id))) {
    return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const content = typeof body.content === "string" ? body.content : "";
  // 内容硬上限:防协作者塞超大 blob 撑爆 DB,且 syncNoteShadow 会 walk 全文 + 加载笔记本时
  // 逐条读全文 → OOM。1MB 对齐来源 MAX_TEXT_CHARS。
  if (content.length > 1_000_000) {
    return NextResponse.json({ error: "笔记内容过长" }, { status: 413 });
  }
  const title = typeof body.title === "string" ? body.title : "";
  const kind: NoteKind =
    body.kind === "chat" || body.kind === "report" ? body.kind : "manual";
  const note = await createNote(id, title.slice(0, 200), content, kind);
  void syncNoteShadow(note.id); // 后台把笔记同步进 RAG(影子来源),不阻塞响应
  await recordEvent({
    actorId: g.id,
    actorKind: "user",
    action: "note.create",
    targetType: "note",
    targetId: note.id,
    notebookId: id,
    meta: { title: note.title, kind },
  });
  return NextResponse.json({ note }, { status: 201 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const g = await requireAccess(req, id, true);
  if (g instanceof NextResponse) return g;
  await removeAllNoteShadows(id); // 连同笔记的影子来源一并清理
  await deleteAllNotes(id);
  return NextResponse.json({ ok: true });
}
