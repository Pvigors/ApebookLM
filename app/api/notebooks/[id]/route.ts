import { NextRequest, NextResponse } from "next/server";
import {
  deleteNotebook,
  getNotebook,
  getNotebookAccess,
  listMessages,
  listSources,
  renameNotebook,
  setNotebookCoverImage,
  setNotebookEmoji,
  setNotebookFeatured,
  setNotebookPublic,
  setNotebookSettings,
} from "@/lib/db";
import { requireAccess, userFromRequest } from "@/lib/auth";
import { recordEvent } from "@/lib/activity";
import { rateLimit, tooMany } from "@/lib/ratelimit";
import { adminRoleOf, requireRole } from "@/lib/admin";
import type { User } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await userFromRequest(req);
  if (!user || !(await getNotebookAccess(id, user.id))) {
    return NextResponse.json({ error: "无权访问" }, { status: 403 });
  }
  const notebook = await getNotebook(id);
  if (!notebook) return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });
  return NextResponse.json({
    notebook,
    sources: await listSources(id),
    messages: await listMessages(id),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const g = await requireAccess(req, id, true);
  if (g instanceof NextResponse) return g;
  // 洪水:每次 rename 都写 activity_log、cover_image 每次可推 600KB 进 DB。
  // editor 协作者可高频微改灌爆审计表。按用户+笔记本限速。
  const lim = rateLimit(`nb-mutate:${g.id}:${id}`, 20, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  const body = await req.json().catch(() => ({}));
  // 在任何普通字段落库前先完成 featured 的高权预检，避免同一 PATCH 先改标题/公开
  // 状态、再因管理 Cookie 或 Origin 失败而返回错误，形成部分成功。
  let featuredActor: User | null = null;
  if (typeof body.featured === "boolean" && adminRoleOf(g) !== null) {
    const admin = await requireRole(req, "featured", { write: true });
    if (admin instanceof NextResponse) return admin;
    featuredActor = admin;
  }
  if (typeof body.title === "string" && body.title.trim()) {
    await renameNotebook(id, body.title);
    await recordEvent({
      actorId: g.id,
      actorKind: "user",
      action: "notebook.rename",
      targetType: "notebook",
      targetId: id,
      notebookId: id,
      meta: { title: body.title.trim() },
    });
  }
  // 审查修复:公开/取消公开是分享管理动作,只有所有者可操作(此前 editor 协作者
  // 也能单方面切换,与「协作者管理归所有者」的既有边界不一致)。
  if (typeof body.public === "boolean" && (await getNotebookAccess(id, g.id)) === "owner") {
    await setNotebookPublic(id, body.public);
    await recordEvent({
      actorId: g.id,
      actorKind: "user",
      action: body.public ? "notebook.public_on" : "notebook.public_off",
      targetType: "notebook",
      targetId: id,
      notebookId: id,
    });
  }
  // M1:精选只能由管理员设置。此前 editor 协作者可一次 PATCH {public,featured}
  // 把笔记本推上精选画廊(listFeaturedNotebooks 条件 featured=1 AND public=1),
  // 绕过管理员策展。非管理员的 featured 字段一律忽略。
  // 系统管理员还必须持独立管理会话；不能只凭普通 nb_session 绕过后台认证。
  if (typeof body.featured === "boolean" && featuredActor) {
    await setNotebookFeatured(id, { featured: body.featured });
    await recordEvent({
      actorId: featuredActor.id,
      actorKind: "admin",
      action: body.featured ? "notebook.featured_on" : "notebook.featured_off",
      targetType: "notebook",
      targetId: id,
      notebookId: id,
    });
  }
  if (typeof body.emoji === "string" && body.emoji.trim()) {
    await setNotebookEmoji(id, body.emoji.trim());
  }
  if ("cover_image" in body) {
    // data: URL (set) or null (clear); cap size so a huge image can't bloat the row
    const img =
      typeof body.cover_image === "string" && body.cover_image.startsWith("data:image/")
        ? body.cover_image.slice(0, 600_000)
        : null;
    await setNotebookCoverImage(id, img);
  }
  const settingKeys = [
    "chat_style",
    "chat_instructions",
    "response_length",
    "output_language",
  ] as const;
  if (settingKeys.some((k) => k in body)) {
    await setNotebookSettings(id, {
      chat_style: typeof body.chat_style === "string" ? body.chat_style : undefined,
      chat_instructions:
        typeof body.chat_instructions === "string" ? body.chat_instructions : undefined,
      response_length:
        typeof body.response_length === "string" ? body.response_length : undefined,
      output_language:
        typeof body.output_language === "string" ? body.output_language : undefined,
    });
  }
  return NextResponse.json({ notebook: await getNotebook(id) });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const lim = rateLimit(`nb-mutate:${user.id}:${id}`, 20, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  if ((await getNotebookAccess(id, user.id)) !== "owner") {
    return NextResponse.json({ error: "只有所有者可以删除笔记本" }, { status: 403 });
  }
  const nb = await getNotebook(id);
  await deleteNotebook(id);
  await recordEvent({
    actorId: user.id,
    actorKind: "user",
    action: "notebook.delete",
    targetType: "notebook",
    targetId: id,
    notebookId: id,
    meta: { title: nb?.title },
  });
  return NextResponse.json({ ok: true });
}
