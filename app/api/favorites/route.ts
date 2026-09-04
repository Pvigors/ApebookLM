import { NextRequest, NextResponse } from "next/server";
import { userFromRequest } from "@/lib/auth";
import { addFavorite, removeFavorite, getNotebook, setFavoriteSeen, setFavoriteMuted } from "@/lib/db";
import { recordEvent, reqMeta } from "@/lib/activity";
import { rateLimit, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 收藏/订阅仅针对「精选笔记本」(公开 + featured)。POST 订阅 / DELETE 退订 /
// PATCH 推进已读游标或免打扰,body: { notebookId, seen?, muted? }。
// (P0-5:补齐此前审计点名的零埋点零限流缺口,并承载订阅游标。)
async function readBody(req: NextRequest): Promise<{ notebookId: string | null; seen?: boolean; muted?: boolean }> {
  try {
    const b = await req.json();
    const id = typeof b?.notebookId === "string" ? b.notebookId.trim() : "";
    return { notebookId: id || null, seen: b?.seen === true, muted: typeof b?.muted === "boolean" ? b.muted : undefined };
  } catch {
    return { notebookId: null };
  }
}

export async function POST(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "登录后可订阅" }, { status: 401 });
  const lim = rateLimit(`feed-sub:${user.id}`, 20, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  const { notebookId } = await readBody(req);
  if (!notebookId) return NextResponse.json({ error: "缺少 notebookId" }, { status: 400 });
  // 只能订阅公开的精选笔记本(防止收藏任意/私有笔记本)。
  const nb = await getNotebook(notebookId);
  if (!nb || !nb.public || !nb.featured) {
    return NextResponse.json({ error: "只能订阅精选笔记本" }, { status: 400 });
  }
  // addFavorite 会把 last_seen_at 初始化为订阅时刻(订阅前的历史不算未读)。
  await addFavorite(user.id, notebookId, Date.now());
  const meta = reqMeta(req);
  await recordEvent({
    actorId: user.id, actorKind: "user", action: "feed.subscribe",
    targetType: "notebook", targetId: notebookId, notebookId, ip: meta.ip, ua: meta.ua,
  });
  return NextResponse.json({ ok: true, favorited: true });
}

export async function DELETE(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "登录后可订阅" }, { status: 401 });
  const lim = rateLimit(`feed-sub:${user.id}`, 20, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  const { notebookId } = await readBody(req);
  if (!notebookId) return NextResponse.json({ error: "缺少 notebookId" }, { status: 400 });
  await removeFavorite(user.id, notebookId);
  const meta = reqMeta(req);
  await recordEvent({
    actorId: user.id, actorKind: "user", action: "feed.unsubscribe",
    targetType: "notebook", targetId: notebookId, notebookId, ip: meta.ip, ua: meta.ua,
  });
  return NextResponse.json({ ok: true, favorited: false });
}

/** 订阅态维护:seen=true 推进已读游标(打开智库工作台时【显式】调用,绝非 GET 副作用,
 *  防后台标签自动 refetch 误标已读);muted 切换免打扰(保留未读徽章,不进铃铛)。 */
export async function PATCH(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const lim = rateLimit(`feed-seen:${user.id}`, 60, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  const { notebookId, seen, muted } = await readBody(req);
  if (!notebookId) return NextResponse.json({ error: "缺少 notebookId" }, { status: 400 });
  if (seen) await setFavoriteSeen(user.id, notebookId, Date.now());
  if (muted !== undefined) {
    await setFavoriteMuted(user.id, notebookId, muted);
    await recordEvent({
      actorId: user.id, actorKind: "user", action: "feed.mute",
      targetType: "notebook", targetId: notebookId, notebookId, meta: { muted },
    });
  }
  return NextResponse.json({ ok: true });
}
