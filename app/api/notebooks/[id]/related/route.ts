import { NextRequest, NextResponse } from "next/server";
import { requireAccess } from "@/lib/auth";
import { getNote, getSource } from "@/lib/db";
import { findRelated, findRelatedAcross } from "@/lib/related";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET ?sourceId=… | ?noteId=…  → 同笔记本内相关来源/笔记(被动重新发现)。
 * 附带 &cross=1 时,再返回**本人其它笔记本**里相关的项(跨本被动再发现)。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const g = await requireAccess(req, id);
  if (g instanceof NextResponse) return g;
  const sp = req.nextUrl.searchParams;
  const sourceId = sp.get("sourceId") || undefined;
  const noteId = sp.get("noteId") || undefined;
  const wantCross = sp.get("cross") === "1";
  if (!sourceId && !noteId) return NextResponse.json({ related: [], crossRelated: [] });
  // 校验 ref 确属本笔记本:requireAccess 只 gate 了 URL 的 notebook,没校验 source/note 归属。
  // 否则攻击者可拿他人的 source/note 文本当跨本检索的「查询种子」(种子预言机)。
  if (sourceId && (await getSource(sourceId))?.notebook_id !== id)
    return NextResponse.json({ related: [], crossRelated: [] });
  if (noteId && (await getNote(noteId))?.notebook_id !== id)
    return NextResponse.json({ related: [], crossRelated: [] });
  try {
    // cross=1 时只算跨本:面板用第①个(无 cross)请求拿本笔记本结果,避免重复跑 findRelated。
    const related = wantCross ? [] : await findRelated(id, { sourceId, noteId }, 4);
    // 跨本范围用**鉴权后的真实用户** g.id 限定(仅本人 owner/协作的本子);
    // 客户端无法越权指定他人的 userId。
    const crossRelated = wantCross ? await findRelatedAcross(g.id, id, { sourceId, noteId }, 4) : [];
    return NextResponse.json({ related, crossRelated });
  } catch {
    return NextResponse.json({ related: [], crossRelated: [] });
  }
}
