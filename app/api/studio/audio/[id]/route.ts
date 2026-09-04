import { NextRequest, NextResponse } from "next/server";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { AUDIO_DIR } from "@/lib/audio";
import { ossEnabled, signedGetUrl } from "@/lib/oss";
import { readOssKeySidecar } from "@/lib/media-store";
import { getStudioOutput } from "@/lib/db";
import { requireNotebookRead } from "@/lib/auth";
import { reqMeta } from "@/lib/activity";
import { rateLimit, rateLimitNotebook, tooMany } from "@/lib/ratelimit";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stream a generated audio-overview mp3 by studio-output id. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Guard against path traversal — ids are UUIDs.
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    return new Response("Bad id", { status: 400 });
  }
  // H1/F1:按归属鉴权(公开笔记本放行),此前任何人凭 UUID 即可下载他人私有产物。
  const out = await getStudioOutput(id);
  if (!out) return NextResponse.json({ error: "音频制品不存在" }, { status: 404 });
  const g = await requireNotebookRead(req, out.notebook_id);
  if (g !== true) return g;
  // 静态产物洪水:公开笔记本的 outputId 可枚举,拿到即可无限拉带宽/连接。
  // 按 output+IP 限速(Range/重复请求都计数),并叠加笔记本级熔断(多 IP 军队打单本子先断)。
  const ip = reqMeta(req).ip || "unknown";
  const perIp = rateLimit(`studio-audio:${id}:${ip}`, 120, 60_000);
  if (!perIp.ok) return tooMany(perIp.retryAfter);
  const nbLim = rateLimitNotebook("studio-asset", out.notebook_id, 600, 60_000);
  if (!nbLim.ok) return tooMany(nbLim.retryAfter);
  // OSS 卸载:鉴权+限速全过后,若本产物已上传 OSS(存在旁标)且 OSS 已配置,
  // 302 到预签名 URL 让读者直连 OSS(带宽卸到 OSS)。签名 URL 只在鉴权通过后签发。
  // OSS 未配置 / 无旁标 → readOssKeySidecar 返回 null → 落到下方读本地(现状)。
  if (ossEnabled()) {
    const ossKey = await readOssKeySidecar(path.join(AUDIO_DIR, id));
    if (ossKey) return NextResponse.redirect(signedGetUrl(ossKey), 302);
  }
  const file = path.join(AUDIO_DIR, `${id}.mp3`);
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const stream = Readable.toWeb(createReadStream(file)) as WebReadableStream<Uint8Array>;
  return new Response(stream as unknown as BodyInit, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(size),
      // F1:鉴权资源不进可重放缓存。
      "Cache-Control": "private, no-store",
    },
  });
}
