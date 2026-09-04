import { NextRequest, NextResponse } from "next/server";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { VIDEO_DIR } from "@/lib/video";
import { ossEnabled, signedGetUrl } from "@/lib/oss";
import { readOssKeySidecar } from "@/lib/media-store";
import { getStudioOutput } from "@/lib/db";
import { requireNotebookRead } from "@/lib/auth";
import { reqMeta } from "@/lib/activity";
import { rateLimit, rateLimitNotebook, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stream a generated video-overview mp4 by studio-output id, with Range support. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) return new Response("Bad id", { status: 400 });

  // H1/F1:按归属鉴权(公开笔记本放行)。
  const out = await getStudioOutput(id);
  if (!out) return NextResponse.json({ error: "制品不存在" }, { status: 404 });
  const g = await requireNotebookRead(req, out.notebook_id);
  if (g !== true) return g;

  // 静态产物洪水:按 output+IP 限速(Range 分段请求也计数),叠加笔记本级熔断。
  const ip = reqMeta(req).ip || "unknown";
  const perIp = rateLimit(`studio-video:${id}:${ip}`, 120, 60_000);
  if (!perIp.ok) return tooMany(perIp.retryAfter);
  const nbLim = rateLimitNotebook("studio-asset", out.notebook_id, 600, 60_000);
  if (!nbLim.ok) return tooMany(nbLim.retryAfter);

  // OSS 卸载:鉴权+限速全过后,若已上传 OSS(有旁标)且 OSS 已配置,302 到预签名 URL。
  // 整请求重定向后浏览器会对 OSS 直接重发 Range 请求(OSS 原生支持 Range),故 Range
  // 分支无需特殊处理。OSS 未配置 / 无旁标 → null → 落到下方本地流(现状,含 Range)。
  if (ossEnabled()) {
    const ossKey = await readOssKeySidecar(path.join(VIDEO_DIR, id));
    if (ossKey) return NextResponse.redirect(signedGetUrl(ossKey), 302);
  }

  const file = path.join(VIDEO_DIR, `${id}.mp4`);
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const range = req.headers.get("range");
  const toWeb = (s: NodeJS.ReadableStream) =>
    Readable.toWeb(s as Readable) as WebReadableStream<Uint8Array>;

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (start >= size || end >= size) {
      return new Response("Range not satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const stream = createReadStream(file, { start, end });
    return new Response(toWeb(stream) as unknown as BodyInit, {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
      },
    });
  }

  return new Response(toWeb(createReadStream(file)) as unknown as BodyInit, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      // F1:鉴权资源不进可重放缓存。
      "Cache-Control": "private, no-store",
    },
  });
}
