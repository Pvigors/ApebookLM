import { NextRequest, NextResponse } from "next/server";
import {
  addCollaborator,
  createNotification,
  getNotebook,
  getNotebookAccess,
  getUserByEmail,
  getUserByPhone,
  listCollaborators,
  removeCollaborator,
} from "@/lib/db";
import { requireAccess, requireMember, userFromRequest } from "@/lib/auth";
import { hasUsageAccess } from "@/lib/membership";
import { recordEvent, reqMeta } from "@/lib/activity";
import { rateLimit, tooMany } from "@/lib/ratelimit";
import { getEffectivePlanConfigForUser } from "@/lib/plans-config";

// 对已注册 / 未注册账号统一的「找不到」文案 —— 消除手机号/邮箱存在性枚举差异(ENUM-2)。
const NOT_FOUND_MSG = "未找到该账号,请确认对方已注册猿笔记后再邀请";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// List collaborators (any user with access).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const g = await requireAccess(req, id);
  if (g instanceof NextResponse) return g;
  // 审查修复:成员手机号/邮箱只对所有者返回(管理协作者需要),
  // 其他协作者(含 viewer)只见昵称/头像/角色,不泄露联系方式。
  const isOwner = (await getNotebookAccess(id, g.id)) === "owner";
  const collaborators = (await listCollaborators(id)).map((c) =>
    isOwner ? c : { ...c, phone: null, email: null }
  );
  return NextResponse.json({ collaborators });
}

async function requireOwner(req: NextRequest, notebookId: string) {
  const user = await requireMember(req);
  if (user instanceof NextResponse) return { error: user };
  if ((await getNotebookAccess(notebookId, user.id)) !== "owner") {
    return { error: NextResponse.json({ error: "只有所有者可以管理协作者" }, { status: 403 }) };
  }
  return { user };
}

// Add a collaborator by phone (owner only).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const o = await requireOwner(req, id);
  if ("error" in o) return o.error;
  // ENUM-2:限流邀请,削弱用账号存在性枚举(每 owner)。
  const lim = rateLimit(`collab-add:${o.user.id}`, 20, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  const body = await req.json().catch(() => ({}));
  const account =
    typeof body.account === "string"
      ? body.account.trim()
      : typeof body.phone === "string"
      ? body.phone.trim()
      : "";
  const role = body.role === "editor" ? "editor" : "viewer";

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  let target;
  if (account.includes("@")) {
    if (!EMAIL_RE.test(account)) {
      return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
    }
    // ENUM-1:仅可邀请已注册用户,不再凭邮箱凭空建号(此前 find-or-create 会污染用户表)。
    target = await getUserByEmail(account);
    if (!target) return NextResponse.json({ error: NOT_FOUND_MSG }, { status: 404 });
  } else if (/^\d{11}$/.test(account)) {
    target = await getUserByPhone(account);
    // ENUM-2:与邮箱分支统一文案,不再暴露「手机号是否注册」差异。
    if (!target) return NextResponse.json({ error: NOT_FOUND_MSG }, { status: 404 });
  } else {
    return NextResponse.json({ error: "请输入有效的邮箱或手机号" }, { status: 400 });
  }

  if (target.id === o.user.id || target.id === (await getNotebook(id))?.user_id) {
    return NextResponse.json({ error: "TA 已是所有者" }, { status: 400 });
  }
  // 护城河 3:按 owner 套餐档位拦协作者数(不含 owner)。
  // Pro 不含协作席位，Max=3，Ultra=-1。
  // 已是协作者视作幂等角色更新(不占新增名额);限额只挡真正的新增邀请。
  {
    const current = await listCollaborators(id);
    const alreadyIn = current.some((c) => c.id === target.id);
    if (!alreadyIn) {
      const limit = (await getEffectivePlanConfigForUser(o.user)).collaboratorLimit;
      if (limit === 0) {
        return NextResponse.json(
          { error: "当前权益不支持协作，如需调整请联系管理员" },
          { status: 403 }
        );
      }
      if (limit > 0 && current.length >= limit) {
        return NextResponse.json(
          { error: `本笔记本协作者已达当前权益上限(${limit} 人)，如需调整请联系管理员` },
          { status: 403 }
        );
      }
    }
  }
  await addCollaborator(id, target.id, role);
  await createNotification({
    userId: target.id,
    type: "collab",
    title: `${o.user.name || "有人"} 邀请你协作「${(await getNotebook(id))?.title ?? "笔记本"}」`,
    summary: role === "editor" ? "可编辑协作者" : "仅查看协作者",
    link: id,
  });
  await recordEvent({
    actorId: o.user.id,
    actorKind: "user",
    action: "collaborator.add",
    targetType: "user",
    targetId: target.id,
    notebookId: id,
    meta: { role, account },
  });
  return NextResponse.json({ collaborators: await listCollaborators(id) }, { status: 201 });
}

// Update a collaborator's role (owner only). Relies on addCollaborator's
// INSERT OR REPLACE to overwrite the role of an existing row.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const o = await requireOwner(req, id);
  if ("error" in o) return o.error;
  const body = await req.json().catch(() => ({}));
  const userId = typeof body.userId === "string" ? body.userId : "";
  const role = body.role === "editor" ? "editor" : "viewer";
  if (!userId) return NextResponse.json({ error: "缺少 userId" }, { status: 400 });
  if (!(await listCollaborators(id)).some((c) => c.id === userId)) {
    return NextResponse.json({ error: "对方不是协作者" }, { status: 404 });
  }
  await addCollaborator(id, userId, role);
  return NextResponse.json({ collaborators: await listCollaborators(id) });
}

// Remove a collaborator(owner),或协作者本人自助退出(E4:请求者==被删者且非所有者)。
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const userId = typeof body.userId === "string" ? body.userId : "";
  const me = await userFromRequest(req);
  if (!me) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const myAccess = await getNotebookAccess(id, me.id);
  // E4 自退分支:被邀请者「不想再看到这个本子」可以自己退出,不必求所有者移除。
  // owner 不走此分支(所有者不在协作表里,也不该「退出」自己的本子)。
  if (userId && userId === me.id && myAccess !== "owner") {
    if (!myAccess) {
      return NextResponse.json({ error: "你不是该笔记本的协作者" }, { status: 404 });
    }
    await removeCollaborator(id, me.id);
    await recordEvent({
      actorId: me.id,
      actorKind: "user",
      action: "collaborator.leave",
      targetType: "user",
      targetId: me.id,
      notebookId: id,
    });
    // 退出后已无访问权,不再回传协作者名单。
    return NextResponse.json({ ok: true });
  }
  if (myAccess !== "owner") {
    return NextResponse.json({ error: "只有所有者可以管理协作者" }, { status: 403 });
  }
  if (!hasUsageAccess(me)) {
    return NextResponse.json(
      { error: "积分不足，可通过邀请活动获取积分或联系管理员补充", code: "quota" },
      { status: 429 }
    );
  }
  await removeCollaborator(id, userId);
  await recordEvent({
    actorId: me.id,
    actorKind: "user",
    action: "collaborator.remove",
    targetType: "user",
    targetId: userId,
    notebookId: id,
  });
  return NextResponse.json({ collaborators: await listCollaborators(id) });
}
