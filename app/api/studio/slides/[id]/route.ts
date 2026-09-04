import { NextRequest, NextResponse } from "next/server";
import { getStudioOutput } from "@/lib/db";
import { requireNotebookRead } from "@/lib/auth";
import { buildPptx } from "@/lib/pptx";
import type { Deck } from "@/lib/slides";
import { downloadRequiresWatermark } from "@/lib/download-entitlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Build and download a .pptx for a slide-deck studio output. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const out = await getStudioOutput(id);
  if (!out || out.kind !== "slides") {
    return NextResponse.json({ error: "幻灯片不存在" }, { status: 404 });
  }
  // F2:按归属鉴权(公开笔记本放行),此前仅校验 kind → 凭 UUID 可下载他人全文 PPT。
  const g = await requireNotebookRead(req, out.notebook_id);
  if (g !== true) return g;
  let deck: Deck;
  try {
    deck = JSON.parse(out.content) as Deck;
  } catch {
    return NextResponse.json({ error: "幻灯片数据无效" }, { status: 500 });
  }
  if (!deck?.slides?.length) {
    return NextResponse.json({ error: "幻灯片内容为空" }, { status: 400 });
  }

  // 下载权益按当前用户判定：匿名/非会员保留，三档有效会员下载历史稿也去水印。
  const buf = await buildPptx({
    ...deck,
    watermark: await downloadRequiresWatermark(req),
  });
  // ASCII-safe fallback name + RFC 5987 UTF-8 name for non-Latin titles.
  const safe = (out.title || "slides").replace(/[^\w.-]+/g, "_").slice(0, 60) || "slides";
  const utf8 = encodeURIComponent(`${out.title || "slides"}.pptx`);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Content-Disposition": `attachment; filename="${safe}.pptx"; filename*=UTF-8''${utf8}`,
      "Content-Length": String(buf.length),
      "Cache-Control": "no-store",
    },
  });
}
