import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import {
  createSource,
  finalizeSource,
  findSourceByContentHash,
  getNote,
  getSource,
  listSources,
  markNoteConverted,
  setNotebookOverview,
  setSourceContentHash,
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
import { removeNoteShadow } from "@/lib/note-rag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Convert a saved note into a first-class source (chunked, embedded, citable). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const note = await getNote(id);
  if (!note) return NextResponse.json({ error: "笔记不存在" }, { status: 404 });
  const g = await requireAccess(req, note.notebook_id, true);
  if (g instanceof NextResponse) return g;

  // 幂等:已转过来源就不再重复建(DB 层兜底,不只靠前端置灰)。
  if (note.converted_to_source) {
    return NextResponse.json({ alreadyConverted: true }, { status: 200 });
  }

  const text = lexicalJsonToText(note.content);
  // Don't create a broken source from an empty note — fail fast & cleanly.
  if (!text.trim()) {
    return NextResponse.json(
      { error: "笔记内容为空,无法转为来源。" },
      { status: 400 }
    );
  }
  // 审查修复①:转来源同样过内容判重(此前完全绕过 content_hash,与直接添加文本的
  // 判重口径漂移)。命中已存在来源时,笔记视作已转换并撤影子,避免同内容双份检索。
  const contentHash = createHash("sha256").update(text).digest("hex");
  const existing = await findSourceByContentHash(note.notebook_id, contentHash);
  if (existing) {
    await markNoteConverted(note.id);
    removeNoteShadow(note.id);
    return NextResponse.json({ source: existing, duplicate: true }, { status: 200 });
  }

  const source = await createSource(note.notebook_id, note.title.slice(0, 200), "text");
  await setSourceContentHash(source.id, contentHash);
  try {
    await ingestSource(source.id, note.notebook_id, text, { authored: true });
  } catch (err) {
    // 审查修复②:摄取失败不标记 converted、不删影子(此前先标记后摄取,失败即
    // 永久锁死:笔记再也转不了、内容还退出了 RAG —— 与 convert-all 的顺序漂移)。
    await finalizeSource(source.id, { status: "error", error: (err as Error).message });
    return NextResponse.json({ source: await getSource(source.id) }, { status: 201 });
  }
  // 摄取成功才落「已转换」标记并撤掉隐藏影子,避免同内容被检索两次。
  await markNoteConverted(note.id);
  removeNoteShadow(note.id);

  // 导读/概览会持久化并经 /api/public 公开返回 —— 传 null,不注入任何人的私人记忆。
  const directive = await getNotebookDirective(note.notebook_id, null);
  try {
    const guide = await generateSourceGuide(note.title, text, directive);
    if (guide.summary || guide.key_topics.length) {
      await setSourceGuide(source.id, guide.summary, guide.key_topics);
    }
    const ready = (await listSources(note.notebook_id)).filter((s) => s.status === "ready");
    const overview = await generateNotebookOverview(
      ready.map((s) => ({ title: s.title, summary: s.summary })),
      directive
    );
    if (overview.summary || overview.suggested_questions.length) {
      await setNotebookOverview(note.notebook_id, overview.summary, overview.suggested_questions);
    }
  } catch {
    /* enrichment is best-effort */
  }

  return NextResponse.json({ source: await getSource(source.id) }, { status: 201 });
}
