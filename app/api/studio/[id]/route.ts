import { NextRequest, NextResponse } from "next/server";
import { deleteStudioOutput, getStudioOutput, updateStudioOutput } from "@/lib/db";
import { requireAccess } from "@/lib/auth";
import { deleteOutputMedia } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 制品内容硬上限:此前 PATCH 不限长,任意编辑者可写入数百 MB 到 studio_outputs.content,
// 之后每次 GET /api/notebooks/[id] 都 SELECT * 把整行读进内存 → 所有者与协作者请求 OOM/卡死。
const MAX_CONTENT = 2_000_000;

/** PATCH { content?, title? } — persist an edited artifact (e.g. mind map). */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const out = await getStudioOutput(id);
  if (!out) return NextResponse.json({ error: "制品不存在" }, { status: 404 });
  const g = await requireAccess(req, out.notebook_id, true);
  if (g instanceof NextResponse) return g;
  const body = await req.json().catch(() => ({}));
  const content = typeof body.content === "string" ? body.content : undefined;
  if (out.kind === "cad" && content !== undefined) {
    return NextResponse.json(
      { error: "CAD 规格不可直接覆盖；参数变更需要生成新的受控版本" },
      { status: 400 }
    );
  }
  if (content !== undefined && content.length > MAX_CONTENT) {
    return NextResponse.json({ error: "内容过大" }, { status: 413 });
  }
  await updateStudioOutput(id, {
    content,
    title: typeof body.title === "string" ? body.title.slice(0, 200) : undefined,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const out = await getStudioOutput(id);
  if (!out) return NextResponse.json({ ok: true });
  const g = await requireAccess(req, out.notebook_id, true);
  if (g instanceof NextResponse) return g;
  await deleteStudioOutput(id);
  // Best-effort cleanup of any generated media for this output (mp3/mp4/png/pptx).
  await deleteOutputMedia(id);
  return NextResponse.json({ ok: true });
}
