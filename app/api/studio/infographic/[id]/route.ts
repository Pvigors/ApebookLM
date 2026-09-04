import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { INFOGRAPHIC_DIR } from "@/lib/infographic";
import { ossEnabled, signedGetUrl } from "@/lib/oss";
import { readOssKeySidecar } from "@/lib/media-store";
import { getStudioOutput } from "@/lib/db";
import { requireNotebookRead } from "@/lib/auth";
import { reqMeta } from "@/lib/activity";
import { rateLimit, rateLimitNotebook, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serve a generated infographic PNG by studio-output id. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    return new Response("Bad id", { status: 400 });
  }
  // H1/F1:按归属鉴权(公开笔记本放行)。
  const out = await getStudioOutput(id);
  if (!out) return NextResponse.json({ error: "制品不存在" }, { status: 404 });
  const g = await requireNotebookRead(req, out.notebook_id);
  if (g !== true) return g;
  // 静态产物洪水:按 output+IP 限速,叠加笔记本级熔断。
  const ip = reqMeta(req).ip || "unknown";
  const perIp = rateLimit(`studio-infographic:${id}:${ip}`, 120, 60_000);
  if (!perIp.ok) return tooMany(perIp.retryAfter);
  const nbLim = rateLimitNotebook("studio-asset", out.notebook_id, 600, 60_000);
  if (!nbLim.ok) return tooMany(nbLim.retryAfter);
  // OSS 卸载:鉴权+限速全过后,若已上传 OSS(有旁标)且 OSS 已配置,302 到预签名 URL。
  // 未配置 / 无旁标 → null → 落到下方读本地(现状)。
  if (ossEnabled()) {
    const ossKey = await readOssKeySidecar(path.join(INFOGRAPHIC_DIR, id));
    if (ossKey) return NextResponse.redirect(signedGetUrl(ossKey), 302);
  }
  let buf: Buffer;
  try {
    buf = await readFile(path.join(INFOGRAPHIC_DIR, `${id}.png`));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(buf.length),
      // F1:鉴权资源不进可重放缓存。
      "Cache-Control": "private, no-store",
    },
  });
}
