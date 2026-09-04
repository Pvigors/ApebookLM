import { NextRequest, NextResponse } from "next/server";
import { userFromRequest } from "@/lib/auth";
import { listNotifications, countUnreadNotifications, markNotificationsRead } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 当前用户的消息列表 + 未读数。 */
export async function GET(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json({
    notifications: await listNotifications(user.id),
    unread: await countUnreadNotifications(user.id),
  });
}

/** 标记已读:{all:true} 全部已读;{ids:[...]} 标记指定几条。 */
export async function PATCH(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.filter((s: unknown) => typeof s === "string") : undefined;
  // 审查修复:非 all 请求必须携带至少一个有效 id。此前空/全非法 ids 会落进
  // markNotificationsRead 的「不传 = 全部已读」分支,把用户全部未读误标已读。
  if (!body.all && (!ids || ids.length === 0)) {
    return NextResponse.json({ error: "缺少要标记的通知 id" }, { status: 400 });
  }
  await markNotificationsRead(user.id, body.all ? undefined : ids);
  return NextResponse.json({ unread: await countUnreadNotifications(user.id) });
}
