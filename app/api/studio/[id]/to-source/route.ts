import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import {
  createSource,
  finalizeSource,
  findSourceByContentHash,
  getSource,
  getStudioOutput,
  listSources,
  markStudioOutputConverted,
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
import { outputToMarkdown } from "@/lib/output-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Convert a generated studio output into a first-class source
 *  (chunked, embedded, citable) — the artifact-side twin of
 *  /api/notes/[id]/to-source. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const out = await getStudioOutput(id);
  if (!out) return NextResponse.json({ error: "制品不存在" }, { status: 404 });
  const g = await requireAccess(req, out.notebook_id, true);
  if (g instanceof NextResponse) return g;

  // 类型闸:画板(excalidraw=Excalidraw 元素 JSON)/ Drawviso(drawviso=mxGraph XML)
  // 存的都是「图形结构」而非可读文本,outputToMarkdown 没有对应分支 → 会把**原始
  // JSON/XML** 当正文入库,RAG 检索到 `"type":"rectangle"` / `<mxCell …>` 之类垃圾块、
  // 生成被带偏(与已修的「URL 当正文」同类污染)。前端已对这类置灰,但直接打接口
  // 能绕过 —— 服务端兜底拒绝。
  if (["excalidraw", "drawviso", "cad"].includes(out.kind)) {
    return NextResponse.json({ error: "该制品不支持转为来源" }, { status: 400 });
  }

  // 幂等:已转过来源就不再重复建(DB 层兜底,不只靠前端置灰)。
  if (out.converted_to_source) {
    return NextResponse.json({ alreadyConverted: true }, { status: 200 });
  }

  const text = outputToMarkdown(out.kind, out.content);
  if (!text.trim()) {
    return NextResponse.json(
      { error: "该制品没有可转为来源的文本内容。" },
      { status: 400 }
    );
  }

  // 审查修复①:与 notes/to-source 同口径 —— 过内容判重,命中即幂等返回。
  const contentHash = createHash("sha256").update(text).digest("hex");
  const existing = await findSourceByContentHash(out.notebook_id, contentHash);
  if (existing) {
    await markStudioOutputConverted(out.id);
    return NextResponse.json({ source: existing, duplicate: true }, { status: 200 });
  }

  const source = await createSource(out.notebook_id, (out.title || "未命名").slice(0, 200), "text");
  await setSourceContentHash(source.id, contentHash);
  try {
    await ingestSource(source.id, out.notebook_id, text, { authored: true });
  } catch (err) {
    // 审查修复②:摄取失败不标记 converted,允许用户重试(此前先标记后摄取,失败即永久锁死)。
    await finalizeSource(source.id, { status: "error", error: (err as Error).message });
    return NextResponse.json({ source: await getSource(source.id) }, { status: 201 });
  }
  await markStudioOutputConverted(out.id);

  // 导读/概览会持久化并经 /api/public 公开返回 —— 传 null,不注入任何人的私人记忆。
  const directive = await getNotebookDirective(out.notebook_id, null);
  try {
    const guide = await generateSourceGuide(out.title, text, directive);
    if (guide.summary || guide.key_topics.length) {
      await setSourceGuide(source.id, guide.summary, guide.key_topics);
    }
    const ready = (await listSources(out.notebook_id)).filter((s) => s.status === "ready");
    const overview = await generateNotebookOverview(
      ready.map((s) => ({ title: s.title, summary: s.summary })),
      directive
    );
    if (overview.summary || overview.suggested_questions.length) {
      await setNotebookOverview(out.notebook_id, overview.summary, overview.suggested_questions);
    }
  } catch {
    /* enrichment is best-effort */
  }

  return NextResponse.json({ source: await getSource(source.id) }, { status: 201 });
}
