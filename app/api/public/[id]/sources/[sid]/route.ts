import { NextRequest, NextResponse } from "next/server";
import { getNotebook, getSource, listSourceSections } from "@/lib/db";
import { reqMeta } from "@/lib/activity";
import { rateLimit, rateLimitNotebook, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 分享页阅读器最多展示的正文长度 —— 截断防超大来源撑爆响应。上限须覆盖论文级
// 全文(摄取上限 FEED_MAX_RAW_CHARS=10 万字):50KB 时代报告后半的章节锚点全在
// 截断区外,双栏目录静默丢一半节(实锤)。120K 文本 gzip 后 ~40KB,可承受。
const MAX_PUBLIC_CONTENT = 120_000;

/** 公开笔记本单个来源的只读正文(供分享页引用高亮定位)。
 *  仅当笔记本 public 且该来源属于它才返回;只暴露 title/content/type,不泄漏其它字段。 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sid: string }> }
) {
  const { id, sid } = await params;
  // 每 sid 返回 ≤50KB 原文,匿名可达 → 按 IP + 笔记本级限流,挡「遍历 sid 把整本来源抱走」。
  const ip = reqMeta(req).ip || "unknown";
  const ipLim = rateLimit(`public-src:${ip}`, 120, 60_000);
  if (!ipLim.ok) return tooMany(ipLim.retryAfter);
  const nbLim = rateLimitNotebook("public-src", id, 400, 60_000);
  if (!nbLim.ok) return tooMany(nbLim.retryAfter);
  const notebook = await getNotebook(id);
  if (!notebook || !notebook.public) {
    return NextResponse.json({ error: "笔记本不存在或未公开" }, { status: 404 });
  }
  const source = await getSource(sid);
  if (!source || source.notebook_id !== id) {
    return NextResponse.json({ error: "来源不存在" }, { status: 404 });
  }
  // PDF 直链源:前端直接内嵌原版 PDF(排版/图表/公式无损),提取文本仅作检索/引用。
  const origin = source.origin ?? null;
  const isPdf = !!origin && /\.pdf(\?|$)/i.test(origin);
  return NextResponse.json({
    title: source.title,
    content: (source.content || "").slice(0, MAX_PUBLIC_CONTENT),
    type: source.type,
    origin,
    is_pdf: isPdf,
    // 章节目录(方案 E 双栏阅读器):节标题 + 锚点文本,前端据此切割正文;未打标 → []。
    sections: await listSourceSections(sid),
  });
}
