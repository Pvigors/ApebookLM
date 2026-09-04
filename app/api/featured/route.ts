import { NextRequest, NextResponse } from "next/server";
import { listFeaturedNotebooks, listFavoriteIds, lastContentByNotebook, unreadByNotebook, listAllFeedChannels } from "@/lib/db";
import { userFromRequest } from "@/lib/auth";
import { reqMeta } from "@/lib/activity";
import { rateLimit, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public: the curated "精选笔记本" gallery. Visible to everyone, no owner scoping.
// 登录用户额外附带 favorited 标记(用于卡片收藏态 + 「精选笔记本」tab 展示我收藏的)。
export async function GET(req: NextRequest) {
  // 匿名可达且是「抱走精选全站资产」的枚举起点 → 按 IP 限流(60/min,正常浏览宽裕)。
  const ip = reqMeta(req).ip || "unknown";
  const lim = rateLimit(`featured:${ip}`, 60, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  const user = await userFromRequest(req);
  const favIds = user ? await listFavoriteIds(user.id) : new Set<string>();
  // 订阅态(P0-5):last_content_at=各启用频道最近真的抓到新内容;unread=登录订阅者
  // 「ingested 且晚于我的 last_seen 游标」的篇数(诚实性③:徽章数=点进去看得到的篇数)。
  const lastContent = await lastContentByNotebook();
  const unread = user ? await unreadByNotebook(user.id) : new Map<string, number>();
  // R1 诚实性⑤「铃=真的会响」:订阅铃只挂有启用频道的智库,静态策展保持「收藏」语义 ——
  // 上轮把两者压进同一个比特,23 张静态卡挂着永不响的订阅铃(第一性审查 critical)。
  const feedNbs = new Set((await listAllFeedChannels()).filter((c) => c.enabled).map((c) => c.notebook_id));
  const notebooks = (await listFeaturedNotebooks()).map((n) => ({
    id: n.id,
    title: n.title,
    emoji: n.emoji,
    summary: n.editorial_note ?? n.summary ?? null, // 编者按优先,过渡期回退旧 summary(迁移三件套②)
    created_at: n.created_at,
    source_count: n.source_count ?? 0,
    cover: n.cover ?? null,
    publisher: n.publisher ?? null,
    publisher_avatar: n.publisher_avatar ?? null,
    category: n.featured_category ?? null,
    favorited: favIds.has(n.id),
    has_feed: feedNbs.has(n.id),
    last_content_at: lastContent.get(n.id) ?? 0,
    unread: unread.get(n.id) ?? 0,
  }));
  return NextResponse.json({ notebooks });
}
