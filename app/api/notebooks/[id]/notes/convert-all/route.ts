import { NextRequest, NextResponse } from "next/server";
import {
  createSource,
  finalizeSource,
  getNotebook,
  getSource,
  listNotes,
  listSources,
  markNoteConverted,
  removeAllNoteShadows,
  setNotebookOverview,
  setSourceGuide,
} from "@/lib/db";
import {
  generateNotebookOverview,
  generateSourceGuide,
  ingestSource,
} from "@/lib/rag";
import { getNotebookDirective } from "@/lib/settings";
import { requireAccess } from "@/lib/auth";
import { lexicalJsonToText } from "@/lib/output-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Combine all of a notebook's notes into a single citable source. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const g = await requireAccess(req, id, true);
  if (g instanceof NextResponse) return g;
  if (!(await getNotebook(id))) {
    return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });
  }
  // 只合并尚未转过来源的笔记 —— 避免对同一批笔记反复合并出多条重复来源。
  const notes = (await listNotes(id)).filter((n) => !n.converted_to_source);
  if (notes.length === 0) {
    return NextResponse.json({ error: "没有可转换的笔记" }, { status: 400 });
  }

  const title = `笔记合集 (${notes.length})`;
  // Notes edited in the rich editor are stored as Lexical state JSON — flatten
  // each to text before combining, or the source would ingest raw JSON.
  const content = notes
    .map((n) => `## ${n.title}\n\n${lexicalJsonToText(n.content)}`)
    .join("\n\n---\n\n");

  const source = await createSource(id, title, "text");
  // 笔记已合并成这一条正式来源 → 清掉各笔记的隐藏影子,避免同内容被检索两次。
  await removeAllNoteShadows(id);
  try {
    await ingestSource(source.id, id, content, { authored: true });
  } catch (err) {
    await finalizeSource(source.id, { status: "error", error: (err as Error).message });
    return NextResponse.json({ source: await getSource(source.id) }, { status: 201 });
  }

  // 合并成功 → 把这些笔记标为「已转入来源」(和单条 to-source 行为一致,前端随之置灰)。
  for (const n of notes) await markNoteConverted(n.id);

  // 导读/概览会持久化并经 /api/public 公开返回 —— 传 null,不注入任何人的私人记忆。
  const directive = await getNotebookDirective(id, null);
  try {
    const guide = await generateSourceGuide(title, content, directive);
    if (guide.summary || guide.key_topics.length) {
      await setSourceGuide(source.id, guide.summary, guide.key_topics);
    }
    const ready = (await listSources(id)).filter((s) => s.status === "ready");
    const overview = await generateNotebookOverview(
      ready.map((s) => ({ title: s.title, summary: s.summary })),
      directive
    );
    if (overview.summary || overview.suggested_questions.length) {
      await setNotebookOverview(id, overview.summary, overview.suggested_questions);
    }
  } catch {
    /* enrichment best-effort */
  }

  return NextResponse.json({ source: await getSource(source.id) }, { status: 201 });
}
