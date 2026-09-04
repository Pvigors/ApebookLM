import { NextRequest, NextResponse } from "next/server";
import { checkNotebookQuota, createNotebookWithLimit, NotebookLimitError, listNotebooks } from "@/lib/db";
import { requireMember, userFromRequest } from "@/lib/auth";
import { recordEvent } from "@/lib/activity";
import { rateLimit, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json({ notebooks: await listNotebooks(user.id) });
}

export async function POST(req: NextRequest) {
  const user = await requireMember(req);
  if (user instanceof NextResponse) return user;
  // 洪水：部分权益 maxNotebooks=-1 无总量上限，配额挡不住分钟级脚本刷建（表暴涨 +
  // 每条 activity_log)。补分钟级速率闸。
  const lim = rateLimit(`nb-create:${user.id}`, 5, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  // M10:按套餐强制笔记本数量上限(此前服务端不校验,可脚本无限创建)。
  const nbQuota = await checkNotebookQuota(user);
  if (nbQuota.over) {
    return NextResponse.json(
      { error: `已达当前权益的笔记本上限(${nbQuota.limit} 个)，如需调整请联系管理员` },
      { status: 403 }
    );
  }
  const body = await req.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title : "Untitled notebook";
  const emoji = typeof body.emoji === "string" ? body.emoji : "📓";
  // 上面的 checkNotebookQuota 是快速 UI 预检;真正裁决用原子的 createNotebookWithLimit
  // (锁用户行+计数+插入同一事务),堵死并发 burst 绕过数量上限(check-then-act)。
  let notebook;
  try {
    notebook = await createNotebookWithLimit(user.id, title, emoji, nbQuota.limit);
  } catch (e) {
    if (e instanceof NotebookLimitError) {
      return NextResponse.json(
        { error: `已达当前权益的笔记本上限(${e.limit} 个)，如需调整请联系管理员` },
        { status: 403 }
      );
    }
    throw e;
  }
  await recordEvent({
    actorId: user.id,
    actorKind: "user",
    action: "notebook.create",
    targetType: "notebook",
    targetId: notebook.id,
    notebookId: notebook.id,
    meta: { title: notebook.title },
  });
  return NextResponse.json({ notebook }, { status: 201 });
}
