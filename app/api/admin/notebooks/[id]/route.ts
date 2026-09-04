import { NextRequest, NextResponse } from "next/server";
import { adminRoleOf, requireRole } from "@/lib/admin";
import {
  deleteNote,
  deleteSource,
  deleteStudioOutput,
  getNote,
  getNotebook,
  getSource,
  getStudioOutput,
  listCollaborators,
  listNotes,
  listSources,
  listStudioOutputs,
} from "@/lib/db";
import { getPool } from "@/lib/pg";
import { recordEvent } from "@/lib/activity";
import { removeNoteShadow } from "@/lib/note-rag";
import { deleteOutputMedia } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maskPhone = (phone: string | null | undefined) =>
  phone ? `${phone.slice(0, 3)}****${phone.slice(-2)}` : null;
const maskEmail = (email: string | null | undefined) => {
  if (!email) return null;
  const at = email.indexOf("@");
  return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : "****";
};

/** 单个笔记本的后台明细:来源 / 笔记 / 制品 / 协作者 / 最近消息。 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const g = await requireRole(req, "users");
  if (g instanceof NextResponse) return g;
  const { id } = await params;
  const notebook = await getNotebook(id);
  if (!notebook) return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });
  const pool = getPool();
  const owner = notebook.user_id
    ? ((await pool.query("SELECT name FROM users WHERE id = $1", [notebook.user_id])).rows[0] as
        | { name: string }
        | undefined)?.name ?? null
    : null;
  const messages = (
    await pool.query(
      "SELECT id, role, content, created_at FROM messages WHERE notebook_id = $1 ORDER BY created_at DESC LIMIT 30",
      [id]
    )
  ).rows;
  const [sources, notes, outputs, collaborators] = await Promise.all([
    listSources(id),
    listNotes(id),
    listStudioOutputs(id),
    listCollaborators(id),
  ]);
  const auditor = adminRoleOf(g) === "auditor";
  return NextResponse.json({
    notebook: auditor
      ? {
          id: notebook.id,
          title: notebook.title,
          emoji: notebook.emoji,
          public: notebook.public,
          featured: notebook.featured,
          created_at: notebook.created_at,
          owner,
        }
      : { ...notebook, owner },
    sources: auditor
      ? sources.map((source) => ({
          id: source.id,
          title: source.title,
          type: source.type,
          status: source.status,
          char_count: source.char_count,
          chunk_count: source.chunk_count,
          created_at: source.created_at,
        }))
      : sources,
    notes: auditor
      ? notes.map(({ id: noteId, title, kind, created_at }) => ({ id: noteId, title, kind, created_at }))
      : notes,
    outputs: auditor
      ? outputs.map((output) => ({
          id: output.id,
          kind: output.kind,
          title: output.title,
          status: output.status,
          created_at: output.created_at,
        }))
      : outputs,
    collaborators: auditor
      ? collaborators.map((collaborator) => ({
          ...collaborator,
          phone: maskPhone(collaborator.phone),
          email: maskEmail(collaborator.email),
        }))
      : collaborators,
    messages: auditor
      ? messages.map((message: { id: string; role: string; created_at: number }) => ({
          id: message.id,
          role: message.role,
          created_at: message.created_at,
        }))
      : messages,
  });
}

/** 删除笔记本内的单条来源 / 笔记 / 制品。 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const g = await requireRole(req, "users", { write: true });
  if (g instanceof NextResponse) return g;
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as { action?: string; itemId?: string };
  if (!b.itemId) return NextResponse.json({ error: "缺少 itemId" }, { status: 400 });
  const admin = { actorId: g.id, actorKind: "admin" as const, notebookId: id };

  // 归属校验:itemId 必须属于 URL 的笔记本,防止跨笔记本误删 / 越权删除(IDOR)。
  switch (b.action) {
    case "delete_source": {
      const s = await getSource(b.itemId);
      if (!s || s.notebook_id !== id) return NextResponse.json({ error: "来源不存在或不属于此笔记本" }, { status: 404 });
      await deleteSource(b.itemId);
      await recordEvent({ ...admin, action: "admin.source_delete", targetType: "source", targetId: b.itemId });
      return NextResponse.json({ ok: true });
    }
    case "delete_note": {
      const n = await getNote(b.itemId);
      if (!n || n.notebook_id !== id) return NextResponse.json({ error: "笔记不存在或不属于此笔记本" }, { status: 404 });
      await removeNoteShadow(b.itemId); // 先清影子来源(须在删笔记行之前),避免孤儿仍被检索
      await deleteNote(b.itemId);
      await recordEvent({ ...admin, action: "admin.note_delete", targetType: "note", targetId: b.itemId });
      return NextResponse.json({ ok: true });
    }
    case "delete_output": {
      const o = await getStudioOutput(b.itemId);
      if (!o || o.notebook_id !== id) return NextResponse.json({ error: "制品不存在或不属于此笔记本" }, { status: 404 });
      await deleteStudioOutput(b.itemId);
      await deleteOutputMedia(b.itemId); // 清理落盘媒体,避免孤儿文件
      await recordEvent({ ...admin, action: "admin.output_delete", targetType: "output", targetId: b.itemId });
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: "未知动作" }, { status: 400 });
  }
}
