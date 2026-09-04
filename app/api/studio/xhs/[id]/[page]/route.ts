import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { XHS_DIR } from "@/lib/xhs";
import { ossEnabled, signedGetUrl } from "@/lib/oss";
import { readOssKeySidecar } from "@/lib/media-store";
import { getStudioOutput } from "@/lib/db";
import { requireNotebookRead } from "@/lib/auth";
import { reqMeta } from "@/lib/activity";
import { rateLimit, rateLimitNotebook, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serve one xiaohongshu-card PNG by studio-output id + page index (0-based). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; page: string }> }
) {
  const { id, page } = await params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    return new Response("Bad id", { status: 400 });
  }
  // 页码只认 0-99 的整数字面(拒绝 "07"/"1e2" 之类,防路径花活)。
  if (!/^(0|[1-9][0-9]?)$/.test(page)) {
    return new Response("Bad page", { status: 400 });
  }
  // 按归属鉴权(公开笔记本放行),与信息图同款。
  const out = await getStudioOutput(id);
  if (!out) return NextResponse.json({ error: "制品不存在" }, { status: 404 });
  const g = await requireNotebookRead(req, out.notebook_id);
  if (g !== true) return g;
  // 静态产物洪水:按 output+IP 限速(不含 page —— 逐页翻共享同一预算,防 0-99 逐页刷放大),
  // 叠加笔记本级熔断。
  const ip = reqMeta(req).ip || "unknown";
  const perIp = rateLimit(`studio-xhs:${id}:${ip}`, 120, 60_000);
  if (!perIp.ok) return tooMany(perIp.retryAfter);
  const nbLim = rateLimitNotebook("studio-asset", out.notebook_id, 600, 60_000);
  if (!nbLim.ok) return tooMany(nbLim.retryAfter);
  // OSS 卸载:鉴权+限速全过后,若整组已上传 OSS(组级旁标存前缀)且 OSS 已配置,
  // 302 到本页(<prefix>/<page>.png)的预签名 URL。未配置 / 无旁标 → null → 读本地(现状)。
  if (ossEnabled()) {
    const prefix = await readOssKeySidecar(path.join(XHS_DIR, id));
    if (prefix) return NextResponse.redirect(signedGetUrl(`${prefix}/${page}.png`), 302);
  }
  let buf: Buffer;
  try {
    buf = await readFile(path.join(XHS_DIR, id, `${page}.png`));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(buf.length),
      // 鉴权资源不进可重放缓存(同信息图)。
      "Cache-Control": "private, no-store",
    },
  });
}
