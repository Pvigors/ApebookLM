import { NextRequest, NextResponse } from "next/server";
import { getNotebook, listNotes, listSources, listStudioOutputs, isFavorited, listFeedChannels, listFeedItems, countSubscribers, countRecentFreshFeedItems } from "@/lib/db";
import { userFromRequest } from "@/lib/auth";
import { reqMeta } from "@/lib/activity";
import { rateLimit, rateLimitNotebook, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public, read-only bundle for a shared notebook. 404 unless it is public. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // 洪水:force-dynamic + 无缓存,每请求 4 次 SQL。随机 query 可穿透 CDN 高频回源打满
  // sqlite 读锁。按 IP + 笔记本级双闸限流(?_=rand 变体也计数,因不按 query 分桶)。
  const ip = reqMeta(req).ip || "unknown";
  const perIp = rateLimit(`public-bundle:${id}:${ip}`, 120, 60_000);
  if (!perIp.ok) return tooMany(perIp.retryAfter);
  const nbLim = rateLimitNotebook("public-bundle", id, 600, 60_000);
  if (!nbLim.ok) return tooMany(nbLim.retryAfter);
  const notebook = await getNotebook(id);
  if (!notebook || !notebook.public) {
    return NextResponse.json({ error: "笔记本不存在或未公开" }, { status: 404 });
  }
  // 收藏态:登录用户看精选笔记本时,顶栏收藏按钮的初始态。
  const viewer = await userFromRequest(req);
  const favorited = viewer ? await isFavorited(viewer.id, id) : false;
  // R1 诚实性⑤⑥:订阅铃只挂真的会响的活频道(has_feed),断更/熔断对用户可见 ——
  // 「已订阅」一个源站失联 30 天的智库和一个安静的智库,在用户眼里不该一模一样。
  const feeds = (await listFeedChannels(id)).filter((c) => c.enabled);
  const feed = feeds.length
    ? {
        has: true,
        status: feeds.some((c) => c.status === "broken") ? "broken" : "active",
        last_content_at: Math.max(0, ...feeds.map((c) => c.last_content_at)),
        // 订阅动态条(右栏「更新简报」头部)—— 全部真实数据,回填不计入更新节奏。
        subscriber_count: await countSubscribers(id),
        fresh_28d: await countRecentFreshFeedItems(id, Date.now() - 28 * 86400_000),
      }
    : { has: false, status: null as string | null, last_content_at: 0, subscriber_count: 0, fresh_28d: 0 };
  // 频道条目时间线:source_id → 发布时间/回填身份/入库时间。左栏按时间轴分组的数据源;
  // 「新」标只给非回填的近期条目(诚实性①:回填的历史文章绝不冒充新文)。
  const itemMeta = new Map<string, { published_at: number | null; backfill: number; ingested_at: number | null }>();
  for (const c of feeds) {
    for (const it of await listFeedItems(c.id, 500)) {
      if (it.source_id) itemMeta.set(it.source_id, { published_at: it.published_at, backfill: it.backfill, ingested_at: it.ingested_at });
    }
  }
  const NEW_WINDOW_MS = 7 * 86400_000;
  // listSources returns metadata only (no raw source text). Studio outputs and
  // notes are the shareable artifacts of the notebook.
  return NextResponse.json({
    notebook: {
      id: notebook.id,
      title: notebook.title,
      emoji: notebook.emoji,
      summary: notebook.editorial_note ?? notebook.summary ?? null, // 编者按优先(迁移三件套②)
      suggested_questions: notebook.suggested_questions ?? [],
      created_at: notebook.created_at,
      source_count: notebook.source_count ?? 0,
      featured: !!notebook.featured,
      cover: notebook.cover ?? null,
      publisher: notebook.publisher ?? null,
      publisher_avatar: notebook.publisher_avatar ?? null,
      favorited,
      feed, // { has, status: 'active'|'broken'|null, last_content_at } —— 订阅铃/断更提示的数据源
    },
    sources: (await listSources(id)).map((s) => {
      const m = itemMeta.get(s.id);
      return {
        id: s.id,
        title: s.title,
        type: s.type,
        status: s.status,
        summary: s.summary ?? null,
        key_topics: s.key_topics ?? [],
        // 文件类型图标按扩展名(origin)判定;副标题「日期 · N 页」。
        origin: s.origin ?? null,
        pages: s.pages ?? 0,
        published_at: m?.published_at ?? null,
        is_new: !!m && !m.backfill && (m.ingested_at ?? 0) > Date.now() - NEW_WINDOW_MS,
      };
    }),
    notes: await listNotes(id),
    // CAD 首版只允许登录态协作者访问：原生规格、尺寸和制造文件不进入匿名公开响应。
    outputs: (await listStudioOutputs(id)).filter((output) => output.kind !== "cad"),
  });
}
