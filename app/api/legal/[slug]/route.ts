import { NextRequest, NextResponse } from "next/server";
import { getLegalDoc, type LegalSlug } from "@/lib/legal";
import { reqMeta } from "@/lib/activity";
import { rateLimit, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 公开:用户协议 / 隐私政策正文(后台可覆盖)。供设置弹窗右栏内联渲染。
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (slug !== "agreement" && slug !== "privacy") {
    return NextResponse.json({ error: "未找到" }, { status: 404 });
  }
  // 271 行原创中文法律文书,匿名可抓 → 按 IP 限流,挡批量抄走(正常一次只读一份)。
  const ip = reqMeta(req).ip || "unknown";
  const lim = rateLimit(`legal:${ip}`, 30, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  return NextResponse.json({ doc: await getLegalDoc(slug as LegalSlug) });
}
