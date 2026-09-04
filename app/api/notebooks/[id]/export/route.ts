import { NextRequest, NextResponse } from "next/server";
import { getNotebook, listNotes, listSources, listStudioOutputs } from "@/lib/db";
import { requireNotebookRead, userFromRequest } from "@/lib/auth";
import { buildNotebookExportZip } from "@/lib/obsidian";
import { reqMeta } from "@/lib/activity";
import { rateLimit, rateLimitNotebook, rateLimitGlobal, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 导出整本为 Markdown 压缩包(Obsidian 友好):笔记/ + 智能笔记/ + 来源清单.md,
 *  每个文件带 frontmatter,解压即可放进任意 vault。按笔记本归属鉴权(公开本放行)。 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const nb = await getNotebook(id);
  if (!nb) return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });
  const g = await requireNotebookRead(req, id);
  if (g !== true) return g;

  // 导出=重操作(打整本 zip)且公开本对匿名放行 → 三层限流,堵「/api/featured 枚举 id →
  // 脚本批量 curl export 把精选全站资产成套抱走」。IP 10/h、单本 30/h、全站 300/h。
  const ip = reqMeta(req).ip || "unknown";
  const ipLim = rateLimit(`nb-export:${ip}`, 10, 3600_000);
  if (!ipLim.ok) return tooMany(ipLim.retryAfter);
  const nbLim = rateLimitNotebook("export", id, 30, 3600_000);
  if (!nbLim.ok) return tooMany(nbLim.retryAfter);
  const gLim = rateLimitGlobal("export", 300, 3600_000);
  if (!gLim.ok) return tooMany(gLim.retryAfter);

  // 追溯:公开笔记本也可能有登录用户导出;拿到 user.id 传下去派生指纹(仅落 hash)。
  const exporter = await userFromRequest(req);
  const [notes, outputs, sources] = await Promise.all([
    listNotes(id),
    listStudioOutputs(id),
    listSources(id),
  ]);
  const buf = await buildNotebookExportZip({
    notebookTitle: nb.title || "笔记本",
    notes,
    outputs,
    sources,
    exporterId: exporter?.id ?? null,
  });
  const safe = (nb.title || "notebook").replace(/[^\w.-]+/g, "_").slice(0, 60) || "notebook";
  const utf8 = encodeURIComponent(`${nb.title || "笔记本"}-Markdown.zip`);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safe}.zip"; filename*=UTF-8''${utf8}`,
      "Content-Length": String(buf.length),
      "Cache-Control": "no-store",
    },
  });
}
