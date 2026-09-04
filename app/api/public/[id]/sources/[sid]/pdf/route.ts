import { NextRequest, NextResponse } from "next/server";
import { getNotebook, getSource } from "@/lib/db";
import { ssrfSafeFetch } from "@/lib/ssrf";
import { reqMeta } from "@/lib/activity";
import { rateLimit, rateLimitNotebook, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PDF 内嵌代理:公开来源若是 PDF 直链,前端要内嵌原版(排版/图表无损),但源站
 *  (RAND 等)常带 Content-Disposition: attachment 强制下载 → iframe 黑屏。这里代取
 *  并改写为 inline + application/pdf,让浏览器内联渲染。
 *  安全:仅公开笔记本、sid 映射固定 origin(不接受任意 URL,无 SSRF 面)、按 IP+笔记本
 *  限流(挡开放代理滥用)、ssrfSafeFetch 拒私网 + 25MB 上限。 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sid: string }> }
) {
  const { id, sid } = await params;
  const ip = reqMeta(req).ip || "unknown";
  const ipLim = rateLimit(`public-pdf:${ip}`, 60, 60_000);
  if (!ipLim.ok) return tooMany(ipLim.retryAfter);
  const nbLim = rateLimitNotebook("public-pdf", id, 200, 60_000);
  if (!nbLim.ok) return tooMany(nbLim.retryAfter);

  const notebook = await getNotebook(id);
  if (!notebook || !notebook.public) {
    return NextResponse.json({ error: "笔记本不存在或未公开" }, { status: 404 });
  }
  const source = await getSource(sid);
  if (!source || source.notebook_id !== id) {
    return NextResponse.json({ error: "来源不存在" }, { status: 404 });
  }
  const origin = source.origin ?? "";
  if (!/\.pdf(\?|$)/i.test(origin)) {
    return NextResponse.json({ error: "该来源不是 PDF" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await ssrfSafeFetch(
      origin,
      {
        headers: {
          // 完整桌面 Chrome UA:RAND 等源站对精简 UA 返 403(实核抓取用的就是它)。
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Accept: "application/pdf,*/*",
        },
      },
      { maxBytes: 25 * 1024 * 1024 }
    );
  } catch {
    return NextResponse.json({ error: "无法获取原版 PDF" }, { status: 502 });
  }
  if (!res.ok) return NextResponse.json({ error: `源站返回 ${res.status}` }, { status: 502 });

  const buf = await res.arrayBuffer();
  // 魔数校验:源站给 attachment 的 content-type 常不可信,按 %PDF- 头确认真是 PDF。
  const magic = new Uint8Array(buf.slice(0, 5));
  const isPdf = "%PDF-".split("").every((c, i) => magic[i] === c.charCodeAt(0));
  if (!isPdf) return NextResponse.json({ error: "源站未返回 PDF(可能已下线或改版)" }, { status: 502 });

  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline", // 覆盖源站的 attachment,让浏览器内联渲染
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
